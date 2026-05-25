'use strict';

require('dotenv').config();

const http = require('http');
const path = require('path');
const express = require('express');
const { WebSocketServer } = require('ws');
const multer = require('multer');
const { setupAuth, requireAuth, authenticateUpgrade } = require('./src/auth');
const { handleConnection } = require('./src/ws-handler');
const { flushPendingSave } = require('./src/session-manager');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

setupAuth(app);

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Image upload endpoint
const storage = multer.diskStorage({
  destination: path.join(__dirname, 'uploads'),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname) || '.png';
    cb(null, `${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`);
  },
});
const upload = multer({
  storage,
  limits: { fileSize: 20 * 1024 * 1024 }, // 20MB
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) cb(null, true);
    else cb(new Error('Only image files are allowed'));
  },
});

app.post('/upload', requireAuth, upload.array('images', 10), (req, res) => {
  const paths = req.files.map((f) => f.path);
  res.json({ paths });
});

// Lightweight auth probe — returns 200/401 with no redirect so the client
// can check session validity before opening a WebSocket (which can't surface
// the 401 from upgrade rejection in browsers).
app.get('/api/auth/status', (req, res) => {
  if (req.isAuthenticated && req.isAuthenticated()) {
    res.json({ authenticated: true, user: req.user?.username || null });
  } else {
    res.status(401).json({ authenticated: false });
  }
});

// Projects API (list/create subdirs under BASE_DIR)
const fs = require('fs');
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

// Page routes
app.get('/', requireAuth, (req, res) => res.redirect('/app'));
app.get('/app', requireAuth, (req, res) => res.sendFile(path.join(__dirname, 'public', 'app.html')));
app.get('/terminal', requireAuth, (req, res) => res.sendFile(path.join(__dirname, 'public', 'terminal.html')));
app.get('/login', (req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));

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
