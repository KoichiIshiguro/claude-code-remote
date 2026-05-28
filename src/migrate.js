'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const { DATA_DIR } = require('./auth');
const { readJson, writeJsonAtomic } = require('./atomic-json');

const PROJECTS_FILE = path.join(DATA_DIR, 'projects.json');
const ARCHIVE_FILE = path.join(DATA_DIR, 'archived.json');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const SESSIONS_FILE = path.join(DATA_DIR, 'sessions.json');

function isFirstBootOfNewVersion() {
  return !fs.existsSync(PROJECTS_FILE);
}

// One-shot migration from v1.1.x state to the jsonl-canonical model.
// Trigger: projects.json absent. Safe to re-run (no-op once projects.json
// exists). Old sessions.json is renamed to sessions.json.v1.bak as a safety
// net — it can be deleted manually a few versions later once trust is built.
function migrateIfNeeded() {
  if (!isFirstBootOfNewVersion()) return false;
  try {
    return doMigrate();
  } catch (err) {
    console.error('[migrate] failed (state untouched, will retry next boot):', err.message);
    return false;
  }
}

function doMigrate() {
  console.log('[migrate] v1.1.x → v1.2 begins');

  const oldConfig = readJson(CONFIG_FILE, {});
  const newConfig = {
    sessionSecret: oldConfig.sessionSecret || crypto.randomBytes(32).toString('hex'),
    accessRoot: oldConfig.baseDir ? path.resolve(oldConfig.baseDir) : null,
  };
  writeJsonAtomic(CONFIG_FILE, newConfig);
  console.log(`[migrate] config: accessRoot = ${newConfig.accessRoot ?? 'null (full access)'}`);

  const oldSessions = readJson(SESSIONS_FILE, []);
  const pathSet = new Set();
  for (const s of (Array.isArray(oldSessions) ? oldSessions : [])) {
    if (s && typeof s.directory === 'string') {
      try { pathSet.add(path.resolve(s.directory)); } catch { /* skip */ }
    }
  }
  if (oldConfig.baseDir) {
    try { pathSet.add(path.resolve(oldConfig.baseDir)); } catch { /* skip */ }
  }

  const projects = [...pathSet].map(p => ({
    id: uuidv4(),
    path: p,
    name: path.basename(p) || p,
    addedAt: new Date().toISOString(),
  }));
  writeJsonAtomic(PROJECTS_FILE, projects);
  console.log(`[migrate] projects: ${projects.length} entries`);

  writeJsonAtomic(ARCHIVE_FILE, []);

  if (fs.existsSync(SESSIONS_FILE)) {
    const bak = SESSIONS_FILE + '.v1.bak';
    if (!fs.existsSync(bak)) {
      fs.renameSync(SESSIONS_FILE, bak);
      console.log(`[migrate] sessions.json → sessions.json.v1.bak`);
    } else {
      console.log('[migrate] sessions.json.v1.bak already exists; leaving sessions.json in place');
    }
  }

  console.log('[migrate] done');
  return true;
}

module.exports = { migrateIfNeeded, isFirstBootOfNewVersion };
