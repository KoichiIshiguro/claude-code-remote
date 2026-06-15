'use strict';

// Canonical history store — the SINGLE source of truth for a shared
// conversation. Each conversation is one provider-neutral transcript persisted
// at data/history/<conversationId>.json. Native agent session files (Claude
// jsonl, Codex rollout) are disposable artifacts materialized from this; they
// are never the truth. See [[history-sync-keystone]].

const fs = require('fs');
const path = require('path');
const { makeTranscript } = require('../../codex-compiler/canonical');

const HISTORY_DIR = process.env.HISTORY_SYNC_DIR
  || path.join(__dirname, '..', '..', 'data', 'history');

function pathFor(conversationId) {
  return path.join(HISTORY_DIR, `${conversationId}.json`);
}

function load(conversationId, attrs = {}) {
  const file = pathFor(conversationId);
  if (fs.existsSync(file)) {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  }
  // Fresh conversation. The id is the stable conversation id; per-agent native
  // session ids live under providerIds and are (re)assigned per turn.
  return makeTranscript({
    id: conversationId,
    cwd: attrs.cwd || process.cwd(),
    title: attrs.title || '',
    sourceProvider: attrs.agent || '',
    providerIds: {},
    turns: [],
  });
}

// All persisted canonical conversations, each tagged with its file mtime (ms)
// as `_mtime` so callers can sort/display without re-stat'ing. Corrupt files are
// skipped rather than throwing. Used to surface shared sessions in the sidebar.
function list() {
  let files = [];
  try { files = fs.readdirSync(HISTORY_DIR); } catch { return []; }
  const out = [];
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    const fp = path.join(HISTORY_DIR, f);
    try {
      const t = JSON.parse(fs.readFileSync(fp, 'utf8'));
      t._mtime = fs.statSync(fp).mtimeMs;
      out.push(t);
    } catch { /* skip corrupt/partial */ }
  }
  return out;
}

function save(transcript) {
  fs.mkdirSync(HISTORY_DIR, { recursive: true });
  const file = pathFor(transcript.id);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(transcript, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, file);
  return file;
}

// Physically delete a canonical conversation. Returns true if a file was
// removed. Best-effort: a missing file is treated as already-gone (false).
function remove(conversationId) {
  try { fs.unlinkSync(pathFor(conversationId)); return true; }
  catch { return false; }
}

module.exports = { HISTORY_DIR, pathFor, load, list, save, remove };
