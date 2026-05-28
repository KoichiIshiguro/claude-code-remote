'use strict';

require('dotenv').config();

const http = require('http');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { execSync } = require('child_process');
const express = require('express');
const { WebSocketServer } = require('ws');
const multer = require('multer');
const {
  setupAuth, requireAuth, authenticateUpgrade,
  isSetupComplete, saveAdmin, saveConfig, loadConfig,
} = require('./src/auth');
const { handleConnection } = require('./src/ws-handler');
const { flushPendingSave } = require('./src/session-manager');
const { migrateIfNeeded } = require('./src/migrate');
const projectsStore = require('./src/projects-store');

// Migrate v1.1.x → v1.2 data layout (no-op once projects.json exists).
// Must run before anything touches projects.json or sessions.json.
migrateIfNeeded();

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

setupAuth(app);

app.use(express.json());

// First-run gate: until an admin account exists, redirect HTML to /setup and
// reject API calls with 503 (except setup-related endpoints and static assets).
app.use((req, res, next) => {
  if (isSetupComplete()) return next();
  const allowed =
    req.path === '/setup' ||
    req.path === '/api/setup/probe' ||
    req.path === '/api/setup' ||
    req.path === '/style.css' ||
    req.path === '/manifest.json' ||
    req.path === '/sw.js' ||
    req.path.startsWith('/icons/');
  if (allowed) return next();
  if (req.method === 'GET' && req.accepts('html')) return res.redirect('/setup');
  return res.status(503).json({ error: 'Server not yet set up. Visit /setup' });
});

app.use(express.static(path.join(__dirname, 'public')));

// ── Setup (first-run) endpoints ───────────────────────────────────────────────
app.get('/setup', (req, res) => {
  if (isSetupComplete()) return res.redirect('/login');
  res.sendFile(path.join(__dirname, 'public', 'setup.html'));
});

app.get('/api/setup/probe', (req, res) => {
  if (isSetupComplete()) return res.status(403).json({ error: 'Setup already complete' });
  const homedir = os.homedir();
  const port = parseInt(process.env.PORT, 10) || 4000;
  let tailscale = { ok: false };
  try {
    const out = execSync('tailscale ip -4', { encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const ip = out.split(/\s+/)[0];
    if (ip && /^\d+\.\d+\.\d+\.\d+$/.test(ip)) tailscale = { ok: true, ip };
  } catch {}
  res.json({ needsSetup: true, homedir, port, tailscale });
});

app.post('/api/setup', async (req, res) => {
  if (isSetupComplete()) return res.status(403).json({ error: 'Setup already complete' });
  const { username, password, baseDir, accessRoot } = req.body || {};
  if (!username || !/^[a-zA-Z0-9_.\-]{1,64}$/.test(username)) {
    return res.status(400).json({ error: 'Invalid username (letters, digits, _.- only, max 64)' });
  }
  if (!password || password.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters' });
  }

  // accessRoot wins; otherwise treat legacy baseDir as the access scope. null
  // means full disk (Tailscale-only mode).
  let rootValue = null;
  const rawRoot = (accessRoot !== undefined) ? accessRoot : baseDir;
  if (rawRoot !== null && rawRoot !== undefined && String(rawRoot).trim()) {
    let dir = String(rawRoot).trim();
    if (dir.startsWith('~')) dir = path.join(os.homedir(), dir.slice(1));
    dir = path.resolve(dir);
    try { fs.mkdirSync(dir, { recursive: true }); }
    catch (e) { return res.status(400).json({ error: `Could not create folder: ${e.message}` }); }
    rootValue = dir;
  }

  saveAdmin(username, password);
  saveConfig({ accessRoot: rootValue });

  const port = parseInt(process.env.PORT, 10) || 4000;
  let accessUrl = `http://localhost:${port}`;
  try {
    const out = execSync('tailscale ip -4', { encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const ip = out.split(/\s+/)[0];
    if (ip && /^\d+\.\d+\.\d+\.\d+$/.test(ip)) accessUrl = `http://${ip}:${port}`;
  } catch {}

  let qrDataUrl = null;
  try {
    const QRCode = require('qrcode');
    qrDataUrl = await QRCode.toDataURL(accessUrl, { margin: 1, width: 440 });
  } catch (e) {
    console.warn('[setup] qr generation skipped:', e.message);
  }
  res.json({ ok: true, accessUrl, qrDataUrl });
});

// File upload endpoint — images, text, PDFs, anything Claude can read.
const storage = multer.diskStorage({
  destination: path.join(__dirname, 'uploads'),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname) || '';
    cb(null, `${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`);
  },
});
const upload = multer({
  storage,
  limits: { fileSize: 25 * 1024 * 1024 }, // 25MB
});

app.post('/upload', requireAuth, upload.array('images', 10), (req, res) => {
  const paths = req.files.map((f) => f.path);
  res.json({ paths });
});

// Lightweight auth probe — returns 200/401 with no redirect so the client
// can check session validity before opening a WebSocket.
app.get('/api/auth/status', (req, res) => {
  if (req.session && req.session.user) {
    res.json({ authenticated: true, user: req.session.user.username });
  } else {
    res.status(401).json({ authenticated: false });
  }
});

// Choose where /api/projects POST / import / clone should drop new folders
// when no explicit destination is given. Prefers accessRoot, else $HOME.
function defaultProjectParent() {
  return projectsStore.getAccessRoot() || os.homedir();
}

// Sandbox check shared by file-browser endpoints. Allows paths that sit under
// any registered project, OR (when no projects yet) under the configured
// access scope. Falls back to "deny" once a sandbox is in effect.
function sandboxedFsAllowed(absPath) {
  if (projectsStore.isAllowedPath(absPath)) return true;
  // Allow browsing inside accessRoot even before any project is registered —
  // needed for the folder picker. If accessRoot is null, full access.
  return projectsStore.isBrowseAllowed(absPath);
}

// Projects API. Now backed by data/projects.json instead of scanning a parent
// dir. Returns the legacy shape for old clients: { projects: [{name, path}], base }.
app.get('/api/projects', requireAuth, (req, res) => {
  const projects = projectsStore.loadProjects().map(p => ({ name: p.name, path: p.path, id: p.id }));
  res.json({ projects, base: projectsStore.getAccessRoot() });
});

app.post('/api/projects', requireAuth, (req, res) => {
  const { name, path: explicitPath } = req.body || {};
  if (explicitPath) {
    // New shape: register an existing path directly.
    try {
      const entry = projectsStore.addProject({ path: explicitPath, name });
      return res.json({ name: entry.name, path: entry.path, id: entry.id });
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }
  }
  if (!name || !/^[a-zA-Z0-9_\-. ]+$/.test(name)) {
    return res.status(400).json({ error: 'Invalid project name' });
  }
  const parent = defaultProjectParent();
  const projectPath = path.join(parent, name);
  if (!projectPath.startsWith(path.resolve(parent))) {
    return res.status(400).json({ error: 'Invalid path' });
  }
  try {
    fs.mkdirSync(projectPath, { recursive: true });
    const entry = projectsStore.addProject({ path: projectPath, name });
    res.json({ name: entry.name, path: entry.path, id: entry.id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Import a zipped project. Extracts into <accessRoot or $HOME>/<derived-name>/
// and registers it. Refuses zip-slip entries and existing targets.
const zipUpload = multer({
  storage: multer.diskStorage({
    destination: path.join(__dirname, 'uploads'),
    filename: (req, file, cb) => cb(null, `${Date.now()}-${Math.random().toString(36).slice(2)}.zip`),
  }),
  limits: { fileSize: 200 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'application/zip' || /\.zip$/i.test(file.originalname)) cb(null, true);
    else cb(new Error('Only .zip files are allowed'));
  },
});
app.post('/api/projects/import', requireAuth, zipUpload.single('zip'), (req, res) => {
  const parent = defaultProjectParent();
  if (!req.file) return res.status(400).json({ error: 'No zip uploaded' });

  const tmpZipPath = req.file.path;
  const cleanup = () => { try { fs.unlinkSync(tmpZipPath); } catch {} };

  const rawName = (req.file.originalname || 'imported').replace(/\.zip$/i, '');
  if (!/^[a-zA-Z0-9_\-. ]+$/.test(rawName)) {
    cleanup();
    return res.status(400).json({ error: 'Invalid project name derived from zip filename' });
  }
  const parentAbs = path.resolve(parent);
  const targetDir = path.join(parentAbs, rawName);
  if (!targetDir.startsWith(parentAbs + path.sep) && targetDir !== parentAbs) {
    cleanup();
    return res.status(400).json({ error: 'Invalid target path' });
  }
  if (fs.existsSync(targetDir)) {
    cleanup();
    return res.status(409).json({ error: `Project "${rawName}" already exists` });
  }

  try {
    const AdmZip = require('adm-zip');
    const zip = new AdmZip(tmpZipPath);
    const entries = zip.getEntries();

    for (const e of entries) {
      const entryName = e.entryName;
      const dest = path.resolve(targetDir, entryName);
      if (!dest.startsWith(path.resolve(targetDir) + path.sep) && dest !== path.resolve(targetDir)) {
        cleanup();
        return res.status(400).json({ error: `Unsafe entry path in zip: ${entryName}` });
      }
    }

    const topNames = new Set();
    for (const e of entries) {
      const top = e.entryName.split('/')[0];
      if (top) topNames.add(top);
    }
    const stripPrefix = topNames.size === 1 ? [...topNames][0] + '/' : null;

    fs.mkdirSync(targetDir, { recursive: true });
    for (const e of entries) {
      let rel = e.entryName;
      if (stripPrefix && rel.startsWith(stripPrefix)) rel = rel.slice(stripPrefix.length);
      if (!rel) continue;
      const outPath = path.join(targetDir, rel);
      if (e.isDirectory) {
        fs.mkdirSync(outPath, { recursive: true });
      } else {
        fs.mkdirSync(path.dirname(outPath), { recursive: true });
        fs.writeFileSync(outPath, e.getData());
      }
    }
    cleanup();
    const entry = projectsStore.addProject({ path: targetDir, name: rawName });
    res.json({ name: entry.name, path: entry.path, id: entry.id, entries: entries.length });
  } catch (err) {
    cleanup();
    try { fs.rmSync(targetDir, { recursive: true, force: true }); } catch {}
    res.status(500).json({ error: err.message });
  }
});

// Clone a remote repository into <accessRoot or $HOME>/<name>/ and register it.
app.post('/api/projects/clone', requireAuth, (req, res) => {
  const parent = defaultProjectParent();
  const parentAbs = path.resolve(parent);

  const { url, name: customName } = req.body || {};
  if (!url || typeof url !== 'string') return res.status(400).json({ error: 'url is required' });
  if (url.length > 1000) return res.status(400).json({ error: 'url is too long' });
  const urlOk =
    /^https?:\/\/[^\s'"`;|&<>]+$/i.test(url) ||
    /^git:\/\/[^\s'"`;|&<>]+$/i.test(url) ||
    /^ssh:\/\/[^\s'"`;|&<>]+$/i.test(url) ||
    /^[a-zA-Z0-9_.\-]+@[a-zA-Z0-9_.\-]+:[^\s'"`;|&<>]+$/.test(url);
  if (!urlOk) return res.status(400).json({ error: 'Unsupported or unsafe git url' });

  let name = customName;
  if (!name) {
    const m = url.match(/([^/:]+?)(?:\.git)?\/?$/);
    name = m ? m[1] : null;
  }
  if (!name || !/^[a-zA-Z0-9_\-.]+$/.test(name)) {
    return res.status(400).json({ error: 'Could not derive a valid folder name from URL; supply ?name=' });
  }
  const target = path.join(parentAbs, name);
  if (!target.startsWith(parentAbs + path.sep) && target !== parentAbs) {
    return res.status(400).json({ error: 'Invalid target path' });
  }
  if (fs.existsSync(target)) {
    return res.status(409).json({ error: `Project "${name}" already exists` });
  }

  const { spawn } = require('child_process');
  const proc = spawn('git', ['clone', '--', url, target], {
    cwd: parentAbs,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });

  let stderr = '';
  proc.stderr.on('data', (d) => { stderr += d.toString(); });

  const killTimer = setTimeout(() => { proc.kill('SIGTERM'); }, 5 * 60 * 1000);

  proc.on('close', (code) => {
    clearTimeout(killTimer);
    if (code === 0) {
      try {
        const entry = projectsStore.addProject({ path: target, name });
        res.json({ name: entry.name, path: entry.path, id: entry.id });
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    } else {
      try { fs.rmSync(target, { recursive: true, force: true }); } catch {}
      res.status(500).json({ error: stderr.trim() || `git exited with code ${code}` });
    }
  });
  proc.on('error', (err) => {
    clearTimeout(killTimer);
    res.status(500).json({ error: err.message });
  });
});

// File browser APIs — sandbox to registered projects + accessRoot.
app.get('/api/files', requireAuth, (req, res) => {
  const { dir } = req.query;
  if (!dir) return res.status(400).json({ error: 'dir is required' });
  const absDir = path.resolve(dir);
  if (!sandboxedFsAllowed(absDir)) {
    return res.status(403).json({ error: 'Access denied' });
  }
  try {
    const entries = fs.readdirSync(absDir, { withFileTypes: true });
    const items = entries
      .map(e => ({
        name: e.name,
        type: e.isDirectory() ? 'dir' : 'file',
        hidden: e.name.startsWith('.'),
      }))
      .sort((a, b) => {
        if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
    res.json({ items, dir: absDir, parent: path.dirname(absDir) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/file', requireAuth, (req, res) => {
  const { path: filePath } = req.query;
  if (!filePath) return res.status(400).json({ error: 'path is required' });
  const absPath = path.resolve(filePath);
  if (!projectsStore.isAllowedPath(absPath)) {
    return res.status(403).json({ error: 'Access denied' });
  }
  try {
    const stat = fs.statSync(absPath);
    if (stat.size > 512 * 1024) return res.json({ content: `[File too large: ${(stat.size/1024).toFixed(0)}KB]`, truncated: true });
    const content = fs.readFileSync(absPath, 'utf8');
    res.json({ content, size: stat.size });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/file/raw', requireAuth, (req, res) => {
  const { path: filePath } = req.query;
  if (!filePath) return res.status(400).send('path is required');
  const absPath = path.resolve(filePath);
  if (!projectsStore.isAllowedPath(absPath)) {
    return res.status(403).send('Access denied');
  }
  res.sendFile(absPath, (err) => {
    if (err && !res.headersSent) res.status(500).send(err.message);
  });
});

// Page routes
app.get('/', requireAuth, (req, res) => res.redirect('/app'));
app.get('/app', requireAuth, (req, res) => res.sendFile(path.join(__dirname, 'public', 'app.html')));
app.get('/terminal', requireAuth, (req, res) => res.sendFile(path.join(__dirname, 'public', 'terminal.html')));
app.get('/login', (req, res) => {
  if (req.session && req.session.user) return res.redirect('/app');
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

// Upgrade HTTP → WebSocket
server.on('upgrade', (req, socket, head) => {
  authenticateUpgrade(req, (authenticated) => {
    if (!authenticated) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  });
});

wss.on('connection', handleConnection);

const PORT = process.env.PORT || 4000;
server.listen(PORT, () => {
  console.log(`Claude Code Remote running at http://localhost:${PORT}`);
});

function shutdown(signal) {
  console.log(`[shutdown] ${signal} received`);
  try { flushPendingSave(); } catch (e) { console.error('[shutdown] flush failed:', e.message); }
  process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
