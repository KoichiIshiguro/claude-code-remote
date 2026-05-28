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

// Hydrate process.env from persisted config so values set during /setup take
// effect for the running process without a restart, and survive across restarts
// without needing a .env file.
const _cfg = loadConfig();
if (!process.env.BASE_DIR && _cfg.baseDir) process.env.BASE_DIR = _cfg.baseDir;

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

setupAuth(app);

app.use(express.json());

// First-run gate: until an admin account exists, redirect HTML traffic to /setup
// and reject API calls with 503 (except setup-related endpoints and static assets).
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
  const { username, password, baseDir } = req.body || {};
  if (!username || !/^[a-zA-Z0-9_.\-]{1,64}$/.test(username)) {
    return res.status(400).json({ error: 'Invalid username (letters, digits, _.- only, max 64)' });
  }
  if (!password || password.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters' });
  }
  if (!baseDir || typeof baseDir !== 'string') {
    return res.status(400).json({ error: 'Working folder is required' });
  }
  let dir = baseDir.trim();
  if (dir.startsWith('~')) dir = path.join(os.homedir(), dir.slice(1));
  dir = path.resolve(dir);
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (e) {
    return res.status(400).json({ error: `Could not create folder: ${e.message}` });
  }
  saveAdmin(username, password);
  saveConfig({ baseDir: dir });
  process.env.BASE_DIR = dir;

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
// Files are stored with a random name; original extension is preserved so
// Claude's Read tool can detect type from path.
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

// Field name is still "images" for backward compat with older clients.
app.post('/upload', requireAuth, upload.array('images', 10), (req, res) => {
  const paths = req.files.map((f) => f.path);
  res.json({ paths });
});

// Lightweight auth probe — returns 200/401 with no redirect so the client
// can check session validity before opening a WebSocket (which can't surface
// the 401 from upgrade rejection in browsers).
app.get('/api/auth/status', (req, res) => {
  if (req.session && req.session.user) {
    res.json({ authenticated: true, user: req.session.user.username });
  } else {
    res.status(401).json({ authenticated: false });
  }
});

// Projects API (list/create subdirs under BASE_DIR)
app.get('/api/projects', requireAuth, (req, res) => {
  const base = process.env.BASE_DIR;
  if (!base) return res.json({ projects: [] });
  try {
    const entries = fs.readdirSync(base, { withFileTypes: true });
    const projects = entries
      .filter(e => e.isDirectory())
      .map(e => ({ name: e.name, path: path.join(base, e.name) }))
      .sort((a, b) => a.name.localeCompare(b.name));
    res.json({ projects, base });
  } catch {
    res.json({ projects: [], base });
  }
});

// Import a zipped project. Accepts one .zip in field "zip", extracts into
// BASE_DIR/<filename-without-.zip>/. Refuses zip-slip (../) entries and
// existing target directories.
const zipUpload = multer({
  storage: multer.diskStorage({
    destination: path.join(__dirname, 'uploads'),
    filename: (req, file, cb) => cb(null, `${Date.now()}-${Math.random().toString(36).slice(2)}.zip`),
  }),
  limits: { fileSize: 200 * 1024 * 1024 }, // 200MB
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'application/zip' || /\.zip$/i.test(file.originalname)) cb(null, true);
    else cb(new Error('Only .zip files are allowed'));
  },
});
app.post('/api/projects/import', requireAuth, zipUpload.single('zip'), (req, res) => {
  const base = process.env.BASE_DIR;
  if (!base) return res.status(400).json({ error: 'BASE_DIR not configured' });
  if (!req.file) return res.status(400).json({ error: 'No zip uploaded' });

  const tmpZipPath = req.file.path;
  const cleanup = () => { try { fs.unlinkSync(tmpZipPath); } catch {} };

  // Derive target folder name from upload original filename (strip .zip).
  const rawName = (req.file.originalname || 'imported').replace(/\.zip$/i, '');
  if (!/^[a-zA-Z0-9_\-. ]+$/.test(rawName)) {
    cleanup();
    return res.status(400).json({ error: 'Invalid project name derived from zip filename' });
  }
  const baseAbs = path.resolve(base);
  const targetDir = path.join(baseAbs, rawName);
  if (!targetDir.startsWith(baseAbs + path.sep) && targetDir !== baseAbs) {
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

    // Zip-slip / absolute-path guard on every entry.
    for (const e of entries) {
      const entryName = e.entryName;
      const dest = path.resolve(targetDir, entryName);
      if (!dest.startsWith(path.resolve(targetDir) + path.sep) && dest !== path.resolve(targetDir)) {
        cleanup();
        return res.status(400).json({ error: `Unsafe entry path in zip: ${entryName}` });
      }
    }

    // If the zip wraps everything in a single top-level folder, strip that
    // folder so we don't end up with BASE_DIR/foo/foo/...
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
    res.json({ name: rawName, path: targetDir, entries: entries.length });
  } catch (err) {
    cleanup();
    // Best-effort rollback
    try { fs.rmSync(targetDir, { recursive: true, force: true }); } catch {}
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/projects', requireAuth, (req, res) => {
  const base = process.env.BASE_DIR;
  if (!base) return res.status(400).json({ error: 'BASE_DIR not configured' });
  const { name } = req.body;
  if (!name || !/^[a-zA-Z0-9_\-. ]+$/.test(name)) {
    return res.status(400).json({ error: 'Invalid project name' });
  }
  const projectPath = path.join(base, name);
  if (!projectPath.startsWith(path.resolve(base))) {
    return res.status(400).json({ error: 'Invalid path' });
  }
  try {
    fs.mkdirSync(projectPath, { recursive: true });
    res.json({ name, path: projectPath });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Clone a remote repository into BASE_DIR via `git clone`.
// Accepts: https://, git://, ssh://, or scp-form like git@host:user/repo(.git)
// Sanitization: we never pass the URL through a shell; spawn() with an array.
// We still reject obviously-bad characters as a belt-and-suspenders check.
app.post('/api/projects/clone', requireAuth, (req, res) => {
  const base = process.env.BASE_DIR;
  if (!base) return res.status(400).json({ error: 'BASE_DIR not configured' });
  const baseAbs = path.resolve(base);

  const { url, name: customName } = req.body || {};
  if (!url || typeof url !== 'string') return res.status(400).json({ error: 'url is required' });
  if (url.length > 1000) return res.status(400).json({ error: 'url is too long' });
  // Whitelist: https / http / git / ssh / scp-form (user@host:path)
  const urlOk =
    /^https?:\/\/[^\s'"`;|&<>]+$/i.test(url) ||
    /^git:\/\/[^\s'"`;|&<>]+$/i.test(url) ||
    /^ssh:\/\/[^\s'"`;|&<>]+$/i.test(url) ||
    /^[a-zA-Z0-9_.\-]+@[a-zA-Z0-9_.\-]+:[^\s'"`;|&<>]+$/.test(url);
  if (!urlOk) return res.status(400).json({ error: 'Unsupported or unsafe git url' });

  // Pick the folder name from the URL (last path segment, strip .git) unless
  // the caller passed one explicitly.
  let name = customName;
  if (!name) {
    const m = url.match(/([^/:]+?)(?:\.git)?\/?$/);
    name = m ? m[1] : null;
  }
  if (!name || !/^[a-zA-Z0-9_\-.]+$/.test(name)) {
    return res.status(400).json({ error: 'Could not derive a valid folder name from URL; supply ?name=' });
  }
  const target = path.join(baseAbs, name);
  if (!target.startsWith(baseAbs + path.sep) && target !== baseAbs) {
    return res.status(400).json({ error: 'Invalid target path' });
  }
  if (fs.existsSync(target)) {
    return res.status(409).json({ error: `Project "${name}" already exists` });
  }

  const { spawn } = require('child_process');
  // GIT_TERMINAL_PROMPT=0 so a private repo doesn't hang waiting for credentials.
  const proc = spawn('git', ['clone', '--', url, target], {
    cwd: baseAbs,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });

  let stderr = '';
  proc.stderr.on('data', (d) => { stderr += d.toString(); });

  // Hard timeout in case git hangs (e.g. SSH key prompt despite the env var).
  const killTimer = setTimeout(() => {
    proc.kill('SIGTERM');
  }, 5 * 60 * 1000);

  proc.on('close', (code) => {
    clearTimeout(killTimer);
    if (code === 0) {
      res.json({ name, path: target });
    } else {
      // Best-effort cleanup of half-cloned dirs
      try { fs.rmSync(target, { recursive: true, force: true }); } catch {}
      res.status(500).json({ error: stderr.trim() || `git exited with code ${code}` });
    }
  });
  proc.on('error', (err) => {
    clearTimeout(killTimer);
    res.status(500).json({ error: err.message });
  });
});

// File browser APIs
app.get('/api/files', requireAuth, (req, res) => {
  const { dir } = req.query;
  if (!dir) return res.status(400).json({ error: 'dir is required' });
  const absDir = path.resolve(dir);
  const baseDir = process.env.BASE_DIR;
  if (baseDir && !absDir.startsWith(path.resolve(baseDir))) {
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
  const baseDir = process.env.BASE_DIR;
  if (baseDir && !absPath.startsWith(path.resolve(baseDir))) {
    return res.status(403).json({ error: 'Access denied' });
  }
  try {
    const stat = fs.statSync(absPath);
    if (stat.size > 512 * 1024) return res.json({ content: `[File too large: ${(stat.size/1024).toFixed(0)}KB]`, truncated: true });
    const content = fs.readFileSync(absPath, 'utf8');
    res.json({ content, size: stat.size });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Raw file delivery — used by the file viewer for images, PDFs, etc.
// Restricted to BASE_DIR like /api/file.
app.get('/api/file/raw', requireAuth, (req, res) => {
  const { path: filePath } = req.query;
  if (!filePath) return res.status(400).send('path is required');
  const absPath = path.resolve(filePath);
  const baseDir = process.env.BASE_DIR;
  if (baseDir && !absPath.startsWith(path.resolve(baseDir))) {
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

// Upgrade HTTP → WebSocket, with session-based auth check
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

// On signal, flush any debounced in-flight state to disk so a hard restart
// (PM2 reload, container kill) preserves the latest partial response. We
// intentionally don't wait for child claude processes — they will be killed by
// the OS, but the disk state is enough to render the interrupted entry on
// reattach and lets the user say "continue" to resume via --resume.
function shutdown(signal) {
  console.log(`[shutdown] ${signal} received — flushing state`);
  try { flushPendingSave(); } catch (e) { console.error('[shutdown] flush failed:', e.message); }
  process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
