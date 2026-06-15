'use strict';

// Read-only access to NATIVE Claude session jsonl files, used solely by the
// history import/export bridge (src/history-sync/port.js) to enumerate and
// preview importable sessions. v2 never runs or persists native sessions — they
// are import sources only — so this module does not parse transcripts for live
// display; it just lists files and pulls a title/preview for the import modal.

const fs = require('fs');
const path = require('path');
const os = require('os');

const CLAUDE_PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');

// Claude CLI encodes every non-alphanumeric character of the absolute cwd to
// a single "-". Verified empirically against existing jsonl directories:
//   "/Volumes/sal-dev/foo"      → "-Volumes-sal-dev-foo"
//   "/Volumes/sal-dev/foo_bar"  → "-Volumes-sal-dev-foo-bar"   (underscore)
//   "/Volumes/名称未設定/HIKSEMI" → "-Volumes-------HIKSEMI"   (non-ASCII)
function encodedCwd(absPath) {
  return absPath.replace(/[^a-zA-Z0-9]/g, '-');
}

function jsonlDirFor(directory) {
  return path.join(CLAUDE_PROJECTS_DIR, encodedCwd(directory));
}

function jsonlPathFor(sessionId, directory) {
  return path.join(jsonlDirFor(directory), `${sessionId}.jsonl`);
}

// Claude CLI's `/resume` picker hides any session whose transcript declares
// `"entrypoint":"sdk-cli"`. The picker reads only the first `"entrypoint"`
// occurrence in the file's leading 64 KiB, so flipping it to `"cli"` makes an
// exported session appear in the native TUI picker without changing anything the
// CLI relies on at runtime (entrypoint is display metadata only).
const PICKER_SCAN_BYTES = 65536;
const SDK_ENTRYPOINT = '"entrypoint":"sdk-cli"';
const CLI_ENTRYPOINT = '"entrypoint":"cli"';

// Rewrite every `sdk-cli` entrypoint token to `cli`, in place. No-op + false if
// nothing to patch or on any I/O error.
function ensurePickerVisible(filePath) {
  try {
    // Peek only the window the picker scans, to skip already-cli files cheaply.
    const fd = fs.openSync(filePath, 'r');
    let head;
    try {
      const n = Math.min(fs.fstatSync(fd).size, PICKER_SCAN_BYTES);
      if (n === 0) return false;
      const buf = Buffer.allocUnsafe(n);
      fs.readSync(fd, buf, 0, n, 0);
      head = buf.toString('utf8');
    } finally { fs.closeSync(fd); }

    if (!head.includes(SDK_ENTRYPOINT)) return false; // already cli / none

    const full = fs.readFileSync(filePath, 'utf8');
    if (!full.includes(SDK_ENTRYPOINT)) return false;
    fs.writeFileSync(filePath, full.split(SDK_ENTRYPOINT).join(CLI_ENTRYPOINT));
    return true;
  } catch { return false; }
}

function listJsonlsForProject(directory) {
  const dir = jsonlDirFor(directory);
  let files;
  try { files = fs.readdirSync(dir); }
  catch { return []; }
  const out = [];
  for (const f of files) {
    if (!f.endsWith('.jsonl')) continue;
    try {
      const full = path.join(dir, f);
      const st = fs.statSync(full);
      out.push({
        sessionId: f.slice(0, -'.jsonl'.length),
        mtime: st.mtimeMs,
        size: st.size,
      });
    } catch { /* skip unreadable */ }
  }
  out.sort((a, b) => b.mtime - a.mtime);
  return out;
}

// Slash-command plumbing that Claude CLI writes into the jsonl as fake user
// events — never a real first prompt, so skip them when choosing a preview.
function isMetaUserText(text) {
  if (!text) return false;
  const t = text.trim();
  if (/^<local-command-(caveat|stdout|stderr)>/i.test(t)) return true;
  if (/^<command-(name|message|args)>/i.test(t)) return true;
  if (t === 'Continue from where you left off.') return true;
  return false;
}

function extractUserText(message) {
  if (!message) return '';
  if (typeof message === 'string') return message;
  if (typeof message.content === 'string') return message.content;
  if (Array.isArray(message.content)) {
    const b = message.content.find(c => c && c.type === 'text');
    if (b) return b.text || '';
  }
  return '';
}

// Read up to maxBytes from the head of a jsonl and return the first real user
// prompt's text — used as a row preview in the import modal.
function firstUserPreview(sessionId, directory, maxBytes = 65536) {
  const p = jsonlPathFor(sessionId, directory);
  let fd;
  try {
    fd = fs.openSync(p, 'r');
    const buf = Buffer.alloc(maxBytes);
    const n = fs.readSync(fd, buf, 0, maxBytes, 0);
    const lines = buf.subarray(0, n).toString('utf8').split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let e;
      try { e = JSON.parse(trimmed); } catch { continue; }
      if (e.type !== 'user') continue;
      if (e.isMeta || e.isCompactSummary) continue;
      const text = extractUserText(e.message);
      if (text && !isMetaUserText(text)) return text.slice(0, 120);
    }
    return '';
  } catch {
    return '';
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch {}
  }
}

// Tail-scan the last `maxBytes` of a jsonl and return the most recent
// `ai-title` event's title — Claude CLI auto-generates these, giving a free
// display name for import-modal rows.
function getLatestAiTitle(sessionId, directory, maxBytes = 65536) {
  const p = jsonlPathFor(sessionId, directory);
  let fd;
  try {
    const stat = fs.statSync(p);
    if (stat.size === 0) return '';
    const readSize = Math.min(stat.size, maxBytes);
    const buf = Buffer.alloc(readSize);
    fd = fs.openSync(p, 'r');
    fs.readSync(fd, buf, 0, readSize, stat.size - readSize);
    const lines = buf.toString('utf8').split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      const t = lines[i].trim();
      if (!t) continue;
      let e; try { e = JSON.parse(t); } catch { continue; }
      if (e.type === 'ai-title' && e.aiTitle) return String(e.aiTitle);
    }
    return '';
  } catch {
    return '';
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch {}
  }
}

module.exports = {
  jsonlPathFor, listJsonlsForProject, ensurePickerVisible,
  firstUserPreview, getLatestAiTitle,
};
