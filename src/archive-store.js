'use strict';

const path = require('path');
const { readJson, writeJsonAtomic } = require('./atomic-json');
const { DATA_DIR } = require('./auth');

const ARCHIVE_FILE = path.join(DATA_DIR, 'archived.json');

function load() {
  return readJson(ARCHIVE_FILE, []);
}

function save(arr) {
  writeJsonAtomic(ARCHIVE_FILE, arr);
}

function isArchived(sessionId) {
  return load().includes(sessionId);
}

function archive(sessionId) {
  const arr = load();
  if (!arr.includes(sessionId)) {
    arr.push(sessionId);
    save(arr);
  }
}

function restore(sessionId) {
  const arr = load();
  const filtered = arr.filter(s => s !== sessionId);
  if (filtered.length !== arr.length) save(filtered);
}

function archiveMany(sessionIds) {
  const set = new Set(load());
  let changed = false;
  for (const sid of sessionIds) {
    if (!set.has(sid)) { set.add(sid); changed = true; }
  }
  if (changed) save([...set]);
}

module.exports = { load, save, isArchived, archive, restore, archiveMany };
