'use strict';

// Persistent store for prompt attachments (images/files the user sent). During a
// turn the files live in <projectDir>/.upload-files/ so the sandboxed claude can
// read them; on turn end ws-handler MOVES them here, keyed by session, so they
// survive for later reference (reload, scroll-back) without cluttering the
// project's working dir. Served read-only via GET /attachment.

const path = require('path');

const ATTACH_DIR = path.join(__dirname, '..', 'attachments');

// Per-session folder. Session ids are uuids / claude session ids; sanitize to a
// safe single path segment so a crafted id can't escape the store.
function sessionDir(session) {
  const safe = String(session || '').replace(/[^a-zA-Z0-9._-]/g, '');
  return path.join(ATTACH_DIR, safe);
}

module.exports = { ATTACH_DIR, sessionDir };
