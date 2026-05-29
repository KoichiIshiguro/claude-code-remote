'use strict';

// Custom display names for sessions, keyed by sessionId.
// jsonl stays the source of truth for content; this is a thin overlay so a
// user-chosen name can override the ai-title / first-prompt preview.

const path = require('path');
const { readJson, writeJsonAtomic } = require('./atomic-json');
const { DATA_DIR } = require('./auth');

const NAME_FILE = path.join(DATA_DIR, 'session-names.json');

function load() {
  return readJson(NAME_FILE, {});
}

function save(obj) {
  writeJsonAtomic(NAME_FILE, obj);
}

function get(sessionId) {
  const m = load();
  return (m && typeof m[sessionId] === 'string') ? m[sessionId] : '';
}

function set(sessionId, name) {
  const m = load();
  const trimmed = (name || '').trim();
  if (trimmed) m[sessionId] = trimmed;
  else delete m[sessionId];   // empty name clears the override
  save(m);
}

function remove(sessionId) {
  const m = load();
  if (sessionId in m) { delete m[sessionId]; save(m); }
}

module.exports = { load, save, get, set, remove };
