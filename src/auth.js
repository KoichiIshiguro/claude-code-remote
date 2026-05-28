'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcrypt');

const DATA_DIR = path.join(__dirname, '..', 'data');
const ADMIN_FILE = path.join(DATA_DIR, 'admin.json');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

// Tmp + rename so a crash mid-write can't leave a half-flushed file.
function writeJson(p, obj) {
  ensureDataDir();
  const tmp = `${p}.tmp.${process.pid}.${Date.now()}`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
    fs.renameSync(tmp, p);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch {}
    throw e;
  }
}

function loadOrCreateConfig() {
  const cfg = readJson(CONFIG_FILE) || {};
  if (!cfg.sessionSecret) {
    cfg.sessionSecret = crypto.randomBytes(32).toString('hex');
    writeJson(CONFIG_FILE, cfg);
  }
  return cfg;
}

function loadConfig() {
  return readJson(CONFIG_FILE) || {};
}

function saveConfig(patch) {
  const cfg = { ...loadConfig(), ...patch };
  writeJson(CONFIG_FILE, cfg);
  return cfg;
}

function loadAdmin() {
  return readJson(ADMIN_FILE);
}

function saveAdmin(username, password) {
  const passwordHash = bcrypt.hashSync(password, 10);
  writeJson(ADMIN_FILE, { username, passwordHash });
}

function isSetupComplete() {
  return !!loadAdmin();
}

let sessionMiddleware;

function setupAuth(app) {
  const cfg = loadOrCreateConfig();
  const sessionSecret = process.env.SESSION_SECRET || cfg.sessionSecret;

  sessionMiddleware = session({
    secret: sessionSecret,
    resave: false,
    saveUninitialized: false,
    cookie: {
      secure: process.env.NODE_ENV === 'production',
      httpOnly: true,
      maxAge: 30 * 24 * 60 * 60 * 1000,
      sameSite: 'lax',
    },
  });
  app.use(sessionMiddleware);

  // Mirror req.session.user → req.user so existing handlers keep working.
  app.use((req, res, next) => {
    if (req.session && req.session.user) req.user = req.session.user;
    next();
  });

  app.post('/auth/login', express.json(), (req, res) => {
    const { username, password } = req.body || {};
    if (!username || !password) {
      return res.status(400).json({ error: 'username and password required' });
    }
    const admin = loadAdmin();
    if (!admin) {
      return res.status(503).json({ error: 'Server not set up. Visit /setup first.' });
    }
    if (admin.username !== username || !bcrypt.compareSync(password, admin.passwordHash)) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    req.session.user = { username: admin.username };
    res.json({ ok: true, username: admin.username });
  });

  app.post('/auth/logout', (req, res) => {
    if (req.session) req.session.destroy(() => res.json({ ok: true }));
    else res.json({ ok: true });
  });
}

function requireAuth(req, res, next) {
  if (req.session && req.session.user) return next();
  if (req.accepts('html') && req.method === 'GET') return res.redirect('/login');
  return res.status(401).json({ error: 'Unauthorized' });
}

function authenticateUpgrade(req, cb) {
  const stub = { getHeader: () => undefined, setHeader: () => {}, end: () => {} };
  sessionMiddleware(req, stub, () => {
    cb(!!(req.session && req.session.user));
  });
}

module.exports = {
  setupAuth,
  requireAuth,
  authenticateUpgrade,
  isSetupComplete,
  saveAdmin,
  loadAdmin,
  loadConfig,
  saveConfig,
  DATA_DIR,
};
