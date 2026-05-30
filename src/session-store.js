'use strict';

// File-backed session store so login state survives server restarts.
//
// The previous setup used express-session's default MemoryStore, which lives
// only in process memory — every restart wiped all sessions, so the browser's
// still-valid cookie pointed at a session the server no longer knew about and
// every request came back 401. This mirrors an in-memory map to one JSON file
// with atomic writes. Single-user app → sessions are few and writes are rare,
// so no external store dependency is warranted.

const path = require('path');
const session = require('express-session');
const { readJson, writeJsonAtomic } = require('./atomic-json');

const Store = session.Store;

class FileSessionStore extends Store {
  constructor(filePath) {
    super();
    this.filePath = filePath;
    this.sessions = readJson(filePath, {}) || {};
    this._prune();
  }

  _expiry(sess) {
    const e = sess && sess.cookie && sess.cookie.expires;
    return e ? new Date(e).getTime() : null;
  }

  _prune() {
    const now = Date.now();
    let changed = false;
    for (const sid of Object.keys(this.sessions)) {
      const exp = this._expiry(this.sessions[sid]);
      if (exp !== null && exp <= now) { delete this.sessions[sid]; changed = true; }
    }
    if (changed) this._flush();
  }

  _flush() {
    try { writeJsonAtomic(this.filePath, this.sessions); } catch { /* best-effort */ }
  }

  get(sid, cb) {
    const sess = this.sessions[sid];
    if (!sess) return cb(null, null);
    const exp = this._expiry(sess);
    if (exp !== null && exp <= Date.now()) {
      delete this.sessions[sid]; this._flush();
      return cb(null, null);
    }
    cb(null, sess);
  }

  set(sid, sess, cb) {
    this.sessions[sid] = sess;
    this._flush();
    if (cb) cb(null);
  }

  destroy(sid, cb) {
    if (this.sessions[sid]) { delete this.sessions[sid]; this._flush(); }
    if (cb) cb(null);
  }

  // Keep-alive on unmodified requests. With rolling:false the expiry is fixed,
  // so just refresh the in-memory cookie and skip the disk write to avoid
  // write amplification on every request.
  touch(sid, sess, cb) {
    const cur = this.sessions[sid];
    if (cur) cur.cookie = sess.cookie;
    if (cb) cb(null);
  }

  all(cb) { cb(null, this.sessions); }
  length(cb) { cb(null, Object.keys(this.sessions).length); }
  clear(cb) { this.sessions = {}; this._flush(); if (cb) cb(null); }
}

module.exports = FileSessionStore;
