'use strict';

require('dotenv').config();

const http = require('http');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { execSync, execFileSync } = require('child_process');
const express = require('express');
const { WebSocketServer } = require('ws');
const multer = require('multer');
const {
  setupAuth, requireAuth, authenticateUpgrade,
  isSetupComplete, saveAdmin, saveConfig, loadConfig,
  resetAdmin, ADMIN_FILE,
} = require('./src/auth');
const { handleConnection, getSlashCommands } = require('./src/ws-handler');
const { flushPendingSave } = require('./src/session-manager');
const { migrateIfNeeded } = require('./src/migrate');
const projectsStore = require('./src/projects-store');
const fsOps = require('./src/fs-ops');
const { ATTACH_DIR, sessionDir } = require('./src/attachments');

// One-shot CLI mode: `node server.js --reset-auth` wipes admin.json and
// exits, forcing /setup on the next normal start so the user can pick a
// fresh username/password if they forgot the old one.
if (process.argv.includes('--reset-auth')) {
  const { existed } = resetAdmin();
  if (existed) {
    console.log(`Removed ${ADMIN_FILE}.`);
    console.log('Next `node server.js` will redirect to /setup. Config + projects are kept.');
  } else {
    console.log(`No admin record at ${ADMIN_FILE}. Nothing to reset.`);
  }
  process.exit(0);
}

// Migrate v1.1.x → v1.2 data layout (no-op once projects.json exists).
// Must run before anything touches projects.json or sessions.json.
migrateIfNeeded();

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

setupAuth(app);

// 2 MB covers the 1 MB cap used by /api/file/write with comfortable headroom
// for JSON wrapping. Setup, prompts, and other endpoints stay well below this.
app.use(express.json({ limit: '2mb' }));

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

// Separate uploader for the FILES sidebar "drop into the working folder" flow.
// Stages files in uploads/ then the handler moves them into the chosen dir.
const fsUpload = multer({
  storage: multer.diskStorage({
    destination: path.join(__dirname, 'uploads'),
    filename: (req, file, cb) => cb(null, `${Date.now()}-${Math.random().toString(36).slice(2)}`),
  }),
  limits: { fileSize: 200 * 1024 * 1024 }, // 200MB — these are real project files, not just images
});

// Claude's vision pipeline doesn't accept HEIC/HEIF — iPhone screenshots and
// photos arrive in that format. Convert to JPEG synchronously here so the
// path we hand back is something Claude can actually open.
function convertHeicToJpeg(srcPath) {
  const dst = srcPath.replace(/\.(heic|heif)$/i, '') + '.jpg';
  const attempts = [
    () => execFileSync('sips', ['-s', 'format', 'jpeg', srcPath, '--out', dst], { stdio: 'ignore', timeout: 30000 }),
    () => execFileSync('heif-convert', ['-q', '90', srcPath, dst], { stdio: 'ignore', timeout: 30000 }),
    () => execFileSync('magick', [srcPath, dst], { stdio: 'ignore', timeout: 30000 }),
  ];
  for (const run of attempts) {
    try { run(); if (fs.existsSync(dst) && fs.statSync(dst).size > 0) { try { fs.unlinkSync(srcPath); } catch {} return dst; } } catch {}
  }
  return null;
}

app.post('/upload', requireAuth, upload.array('images', 10), (req, res) => {
  // The spawned `claude` is sandboxed to its session's project folder, so a file
  // sitting in the server-root uploads/ dir is unreadable to it. Move each
  // upload into <projectDir>/.upload-files/ (inside the sandbox) when the client
  // told us which project it's for and that path is an allowed project root.
  // Falls back to the staging uploads/ dir otherwise (best-effort).
  const reqDir = typeof req.body.directory === 'string' ? req.body.directory : '';
  let targetDir = null;
  if (reqDir && projectsStore.isAllowedPath(reqDir)) {
    targetDir = path.join(reqDir, '.upload-files');
    try { fs.mkdirSync(targetDir, { recursive: true }); }
    catch { targetDir = null; }
  }

  const paths = req.files.map((f) => {
    let p = f.path;
    if (/\.(heic|heif)$/i.test(p)) {
      const converted = convertHeicToJpeg(p);
      if (converted) p = converted;
      else console.warn(`[upload] HEIC conversion failed for ${p}; passing through`);
    }
    if (targetDir) {
      const dest = path.join(targetDir, path.basename(p));
      try { fs.renameSync(p, dest); p = dest; }
      catch {
        // Cross-device move (uploads/ and the project on different volumes) →
        // copy then remove the staging file.
        try { fs.copyFileSync(p, dest); fs.unlinkSync(p); p = dest; } catch {}
      }
    }
    return p;
  });
  res.json({ paths });
});

// Serve a prompt attachment for in-thread previews / the lightbox. Read-only and
// locked down: `name` is reduced to a basename (no traversal), `session` to a
// safe segment, and the only directories we ever read from are the per-session
// attachments store and — while a turn is still in flight, before the file has
// been moved — an ALLOWED project's .upload-files. Anything else is a 404.
app.get('/attachment', requireAuth, (req, res) => {
  const name = path.basename(String(req.query.name || ''));
  if (!name || name === '.' || name === '..') return res.status(400).end();
  const session = String(req.query.session || '');
  const dir = typeof req.query.dir === 'string' ? req.query.dir : '';

  const candidates = [];
  if (session) candidates.push(path.join(sessionDir(session), name));
  if (dir && projectsStore.isAllowedPath(dir)) {
    candidates.push(path.join(dir, '.upload-files', name));
  }
  for (const f of candidates) {
    try { if (fs.existsSync(f) && fs.statSync(f).isFile()) return res.sendFile(f); }
    catch {}
  }
  return res.status(404).end();
});

// Lightweight auth probe — returns 200/401 with no redirect so the client
// can check session validity before opening a WebSocket.
// App version (for the sidebar badge). Not sensitive — no auth needed.
app.get('/api/version', (req, res) => {
  res.json({ version: require('./package.json').version });
});

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
  const projects = projectsStore.loadProjects().map(p => ({ name: p.name, path: p.path, id: p.id, addedAt: p.addedAt }));
  res.json({ projects, base: projectsStore.getAccessRoot(), home: os.homedir() });
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

// Extensions we refuse to load into the textarea editor — binary payloads in
// a textarea is a footgun (garbled chars, lost bytes on save).
const BINARY_EXTS = new Set([
  'png','jpg','jpeg','gif','webp','bmp','ico','avif','heic',
  'pdf','zip','gz','tar','tgz','7z','rar','bz2','xz',
  'mp4','mp3','mov','avi','wav','m4a','webm','flac','ogg',
  'exe','dll','so','dylib','class','jar','war','o','obj','wasm','pyc',
  'doc','docx','xls','xlsx','ppt','pptx',
]);
function isBinaryExt(p) {
  const ext = (p.split('.').pop() || '').toLowerCase();
  return BINARY_EXTS.has(ext);
}
const FILE_READ_MAX = 1024 * 1024; // 1 MB

app.get('/api/file', requireAuth, (req, res) => {
  const { path: filePath } = req.query;
  if (!filePath) return res.status(400).json({ error: 'path is required' });
  const absPath = path.resolve(filePath);
  if (!sandboxedFsAllowed(absPath)) {
    return res.status(403).json({ error: 'Access denied' });
  }
  try {
    const stat = fs.statSync(absPath);
    if (stat.size > FILE_READ_MAX) return res.json({ content: `[File too large: ${(stat.size/1024).toFixed(0)}KB]`, truncated: true, size: stat.size });
    const content = fs.readFileSync(absPath, 'utf8');
    const editable = !isBinaryExt(absPath);
    res.json({ content, size: stat.size, editable });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Plain-text write. Personal-use scope, so no optimistic-concurrency check —
// trust the user not to fight Claude over the same file in the same instant.
app.post('/api/file/write', requireAuth, (req, res) => {
  const { path: filePath, content } = req.body || {};
  if (!filePath || typeof content !== 'string') {
    return res.status(400).json({ error: 'path and content are required' });
  }
  if (Buffer.byteLength(content, 'utf8') > FILE_READ_MAX) {
    return res.status(413).json({ error: `Content exceeds ${(FILE_READ_MAX/1024).toFixed(0)} KB limit` });
  }
  const absPath = path.resolve(filePath);
  if (!sandboxedFsAllowed(absPath)) {
    return res.status(403).json({ error: 'Access denied' });
  }
  if (isBinaryExt(absPath)) {
    return res.status(400).json({ error: 'Refusing to overwrite binary file as text' });
  }
  try {
    const st = fs.lstatSync(absPath);
    if (st.isSymbolicLink()) return res.status(400).json({ error: 'Refusing to write through symlink' });
    if (st.isDirectory()) return res.status(400).json({ error: 'Path is a directory' });
  } catch { /* file may not exist yet — that's fine */ }
  try {
    const dir = path.dirname(absPath);
    const tmp = path.join(dir, `.${path.basename(absPath)}.tmp.${process.pid}.${Date.now()}`);
    fs.writeFileSync(tmp, content, 'utf8');
    fs.renameSync(tmp, absPath);
    const stat = fs.statSync(absPath);
    res.json({ ok: true, size: stat.size });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/file/raw', requireAuth, (req, res) => {
  const { path: filePath, download } = req.query;
  if (!filePath) return res.status(400).send('path is required');
  const absPath = path.resolve(filePath);
  if (!sandboxedFsAllowed(absPath)) {
    return res.status(403).send('Access denied');
  }
  // download=1 forces a "Save as" instead of inline rendering (file DL button).
  const opts = download ? { headers: { 'Content-Disposition': `attachment; filename="${encodeURIComponent(path.basename(absPath))}"` } } : {};
  res.sendFile(absPath, opts, (err) => {
    if (err && !res.headersSent) res.status(500).send(err.message);
  });
});

// Stream a folder as a .zip download. Used by the FILES sidebar DL popup for
// directories (single files go through /api/file/raw?download=1).
app.get('/api/fs/download-zip', requireAuth, (req, res) => {
  const { path: dirPath } = req.query;
  if (!dirPath) return res.status(400).send('path is required');
  const absPath = path.resolve(dirPath);
  if (!sandboxedFsAllowed(absPath)) return res.status(403).send('Access denied');
  let st;
  try { st = fs.statSync(absPath); } catch { return res.status(404).send('Not found'); }
  if (!st.isDirectory()) return res.status(400).send('Not a directory');
  try {
    const AdmZip = require('adm-zip');
    const zip = new AdmZip();
    zip.addLocalFolder(absPath);
    const buf = zip.toBuffer();
    const name = (path.basename(absPath) || 'folder') + '.zip';
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(name)}"`);
    res.send(buf);
  } catch (err) {
    if (!res.headersSent) res.status(500).send(err.message);
  }
});

// Upload files straight into a working folder (FILES sidebar drag-and-drop).
// Unlike /upload (which stages prompt attachments in .upload-files/), this
// writes the dropped files directly into the currently-browsed directory.
app.post('/api/fs/upload', requireAuth, fsUpload.array('files', 50), (req, res) => {
  const reqDir = typeof req.body.dir === 'string' ? req.body.dir : '';
  if (!reqDir) return res.status(400).json({ error: 'dir is required' });
  const absDir = path.resolve(reqDir);
  if (!sandboxedFsAllowed(absDir)) return res.status(403).json({ error: 'Access denied' });
  let st;
  try { st = fs.statSync(absDir); } catch { return res.status(404).json({ error: 'directory does not exist' }); }
  if (!st.isDirectory()) return res.status(400).json({ error: 'destination is not a directory' });

  // Pick a non-colliding destination name: "report.pdf" → "report (1).pdf".
  const uniqueName = (orig) => {
    const base = path.basename(orig).replace(/[\/\\\0]/g, '_') || 'file';
    let candidate = base;
    if (!fs.existsSync(path.join(absDir, candidate))) return candidate;
    const ext = path.extname(base);
    const stem = base.slice(0, base.length - ext.length);
    for (let i = 1; i < 1000; i++) {
      candidate = `${stem} (${i})${ext}`;
      if (!fs.existsSync(path.join(absDir, candidate))) return candidate;
    }
    return `${stem}-${Date.now()}${ext}`;
  };

  const saved = [];
  for (const f of (req.files || [])) {
    const dest = path.join(absDir, uniqueName(f.originalname));
    try { fs.renameSync(f.path, dest); }
    catch {
      try { fs.copyFileSync(f.path, dest); fs.unlinkSync(f.path); }
      catch (e) { return res.status(500).json({ error: e.message }); }
    }
    saved.push(path.basename(dest));
  }
  res.json({ ok: true, saved });
});

// ── File-manager mutations ────────────────────────────────────────────────
// All guarded by src/fs-ops.js: write/delete targets must be inside a
// registered project (the sandbox); move/copy sources may be browse-allowed.
function fsOpHandler(fn) {
  return (req, res) => {
    try {
      const result = fn(req.body || {});
      res.json({ ok: true, result });
    } catch (e) {
      res.status(e.httpCode || 500).json({ error: e.message });
    }
  };
}

app.post('/api/fs/mkdir', requireAuth, fsOpHandler(
  ({ parent, name }) => fsOps.mkdir(parent, name)));

app.post('/api/fs/delete', requireAuth, fsOpHandler(
  ({ paths }) => fsOps.remove(paths)));

app.post('/api/fs/rename', requireAuth, fsOpHandler(
  ({ path: p, newName }) => fsOps.rename(p, newName)));

app.post('/api/fs/move', requireAuth, fsOpHandler(
  ({ sources, dest }) => fsOps.move(sources, dest)));

app.post('/api/fs/copy', requireAuth, fsOpHandler(
  ({ sources, dest }) => fsOps.copy(sources, dest)));

// App-wide settings. Only autoCompactThreshold for now — null/0 disables.
app.get('/api/settings', requireAuth, (req, res) => {
  const cfg = require('./src/auth').loadConfig();
  const sm = require('./src/session-manager');
  res.json({
    autoCompactThreshold: typeof cfg.autoCompactThreshold === 'number' ? cfg.autoCompactThreshold : null,
    autoCompactDefault: sm.AUTO_COMPACT_DEFAULT,
    model: typeof cfg.model === 'string' ? cfg.model : null,
    effort: typeof cfg.effort === 'string' ? cfg.effort : null,
    effortLevels: sm.EFFORT_LEVELS,
  });
});
// Slash commands valid in the `-p` environment, captured from the latest
// stream-json `init` event. The prompt box uses this to autocomplete `/…`.
app.get('/api/slash-commands', requireAuth, (req, res) => {
  res.json({ commands: getSlashCommands() });
});
app.post('/api/settings', requireAuth, (req, res) => {
  const sm = require('./src/session-manager');
  const { autoCompactThreshold, model, effort } = req.body || {};
  const patch = {};
  if (autoCompactThreshold === null) {
    patch.autoCompactThreshold = null;
  } else if (autoCompactThreshold === 0 || autoCompactThreshold === false) {
    patch.autoCompactThreshold = 0; // explicit disable
  } else if (typeof autoCompactThreshold === 'number' && Number.isFinite(autoCompactThreshold) && autoCompactThreshold > 0) {
    patch.autoCompactThreshold = Math.floor(autoCompactThreshold);
  } else if (autoCompactThreshold !== undefined) {
    return res.status(400).json({ error: 'autoCompactThreshold must be a positive integer, 0 (disable), or null (default)' });
  }
  // Model: null clears (use CLI default); a non-empty string is stored verbatim
  // (alias like "opus"/"sonnet" or a full id like "claude-opus-4-8").
  if (model === null) {
    patch.model = null;
  } else if (typeof model === 'string' && model.trim()) {
    patch.model = model.trim();
  } else if (model !== undefined) {
    return res.status(400).json({ error: 'model must be a non-empty string or null' });
  }
  // Effort: null clears; otherwise must be one of the CLI's accepted levels.
  if (effort === null) {
    patch.effort = null;
  } else if (typeof effort === 'string' && sm.EFFORT_LEVELS.includes(effort)) {
    patch.effort = effort;
  } else if (effort !== undefined) {
    return res.status(400).json({ error: `effort must be one of ${sm.EFFORT_LEVELS.join(', ')} or null` });
  }
  const { saveConfig } = require('./src/auth');
  saveConfig(patch);
  res.json({ ok: true });
});

// Page routes
app.get('/', requireAuth, (req, res) => res.redirect('/terminal'));
app.get('/terminal', requireAuth, (req, res) => {
  // No session in URL → try to land the user on the most-recent visible jsonl.
  // Falls through to the HTML (empty state, sidebar auto-opens) when none exist.
  if (!req.query.session) {
    try {
      const archived = new Set(require('./src/archive-store').load());
      const jsonlReader = require('./src/jsonl-reader');
      let best = null;
      for (const p of projectsStore.loadProjects()) {
        for (const s of jsonlReader.listJsonlsForProject(p.path)) {
          if (archived.has(s.sessionId)) continue;
          if (!best || s.mtime > best.mtime) best = s;
        }
      }
      if (best) return res.redirect(`/terminal?session=${best.sessionId}`);
    } catch { /* fall through to empty state */ }
  }
  res.sendFile(path.join(__dirname, 'public', 'terminal.html'));
});
app.get('/login', (req, res) => {
  if (req.session && req.session.user) return res.redirect('/terminal');
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
