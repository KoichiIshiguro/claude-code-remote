'use strict';

// Registry of non-Claude engine sessions, keyed by session id.
// Claude sessions are discovered from their jsonl files under
// ~/.claude/projects and need no registry; Codex stores its rollouts in a
// global date-tree (~/.codex/sessions/YYYY/MM/DD/) with no per-project
// grouping, so the app records here which Codex session belongs to which
// project directory. A session id present in this file is a Codex session;
// absent means Claude.

const path = require('path');
const { readJson, writeJsonAtomic } = require('./atomic-json');
const { DATA_DIR } = require('./auth');

const FILE = path.join(DATA_DIR, 'engine-sessions.json');

function load() {
  return readJson(FILE, {});
}

function save(obj) {
  writeJsonAtomic(FILE, obj);
}

// entry: { directory, createdAt, lastActivity, preview }
function register(sessionId, entry) {
  const m = load();
  m[sessionId] = { engine: 'codex', ...m[sessionId], ...entry };
  save(m);
}

function get(sessionId) {
  const m = load();
  return m[sessionId] || null;
}

function engineOf(sessionId) {
  const e = get(sessionId);
  return e ? (e.engine || 'codex') : null;
}

function touch(sessionId) {
  const m = load();
  if (m[sessionId]) { m[sessionId].lastActivity = Date.now(); save(m); }
}

function remove(sessionId) {
  const m = load();
  if (sessionId in m) { delete m[sessionId]; save(m); }
}

// [{ sessionId, directory, createdAt, lastActivity, preview }]
function list() {
  const m = load();
  return Object.entries(m).map(([sessionId, e]) => ({ sessionId, ...e }));
}

module.exports = { register, get, engineOf, touch, remove, list };
