'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const CLAUDE_PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');

// Claude CLI's encoding: every "/" in the absolute cwd becomes "-".
// e.g. "/Volumes/sal-dev/foo" → "-Volumes-sal-dev-foo".
function encodedCwd(absPath) {
  return absPath.replace(/\//g, '-');
}

function jsonlDirFor(directory) {
  return path.join(CLAUDE_PROJECTS_DIR, encodedCwd(directory));
}

function jsonlPathFor(sessionId, directory) {
  return path.join(jsonlDirFor(directory), `${sessionId}.jsonl`);
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
      const st = fs.statSync(path.join(dir, f));
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

// Read up to maxBytes from the head of a jsonl and return the first user
// prompt's text — used as a row preview in the restore modal and sidebar.
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
      if (e.isCompactSummary) continue;
      const msg = e.message;
      let text = '';
      if (typeof msg === 'string') text = msg;
      else if (msg && typeof msg.content === 'string') text = msg.content;
      else if (msg && Array.isArray(msg.content)) {
        const b = msg.content.find(c => c && c.type === 'text');
        if (b) text = b.text || '';
      }
      if (text) return text.slice(0, 120);
    }
    return '';
  } catch {
    return '';
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch {}
  }
}

function toolTitle(name, input) {
  if (!input) return name;
  if (name === 'Bash') return (input.command || '').split('\n')[0].slice(0, 80) || name;
  if (['Read', 'Write', 'Edit', 'MultiEdit'].includes(name)) return input.file_path || name;
  if (name === 'LS') return input.path || name;
  try { return JSON.stringify(input).slice(0, 80); } catch { return name; }
}

// Pure function: fold one jsonl event into the running history array.
// Returns the new history (does not mutate input). Unknown event types are
// passed through unchanged.
function applyEventToBlocks(history, event) {
  if (!event || typeof event !== 'object') return history;
  const ts = event.timestamp ? Date.parse(event.timestamp) : Date.now();

  if (event.type === 'user') {
    if (event.isCompactSummary) return history;
    const content = event.message?.content;

    // Tool-result wrap: attach result to preceding assistant's tool block.
    if (Array.isArray(content) && content.some(c => c && c.type === 'tool_result')) {
      return attachToolResults(history, content);
    }

    let text = '';
    if (typeof content === 'string') {
      text = content;
    } else if (Array.isArray(content)) {
      const b = content.find(c => c && c.type === 'text');
      if (b) text = b.text || '';
    }
    if (!text) return history;
    return [...history, { type: 'user', text, ts }];
  }

  if (event.type === 'assistant') {
    const blocks = [];
    const content = event.message?.content || [];
    for (const b of content) {
      if (b.type === 'text') {
        blocks.push({ kind: 'text', text: b.text });
      } else if (b.type === 'thinking') {
        blocks.push({ kind: 'thinking', text: b.thinking });
      } else if (b.type === 'tool_use') {
        blocks.push({
          kind: 'tool',
          name: b.name,
          title: toolTitle(b.name, b.input),
          toolId: b.id,
          result: null,
        });
      }
    }
    if (!blocks.length) return history;
    return [...history, { type: 'assistant', blocks, ts }];
  }

  // attachment / system / mode / permission-mode / ai-title / last-prompt /
  // file-history-snapshot — not rendered in the conversation view.
  return history;
}

function attachToolResults(history, contentBlocks) {
  if (!history.length) return history;
  const last = history[history.length - 1];
  if (last.type !== 'assistant') return history;
  const newBlocks = last.blocks.map(blk => {
    if (blk.kind !== 'tool') return blk;
    const match = contentBlocks.find(c => c.type === 'tool_result' && c.tool_use_id === blk.toolId);
    if (!match) return blk;
    const c = match.content;
    let r = typeof c === 'string' ? c : JSON.stringify(c, null, 2);
    if (r.length > 4000) r = r.slice(0, 4000) + '\n…(truncated)';
    return { ...blk, result: r };
  });
  return [...history.slice(0, -1), { ...last, blocks: newBlocks }];
}

// Full re-read of a jsonl into Remote's history-blocks shape.
// Returns { history, lastTokens, exists, cwdMismatch }.
//  - cwdMismatch is set if the file's first event references a `cwd` that
//    disagrees with the expected directory. Defends against encoded-cwd
//    collisions like "/foo/bar-baz" vs "/foo-bar/baz".
function readHistory(sessionId, directory) {
  const p = jsonlPathFor(sessionId, directory);
  let raw;
  try { raw = fs.readFileSync(p, 'utf8'); }
  catch { return { history: [], lastTokens: null, exists: false, cwdMismatch: false }; }

  const lines = raw.split('\n');
  let history = [];
  let lastTokens = null;
  let cwdMismatch = false;
  let cwdChecked = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let e;
    try { e = JSON.parse(trimmed); } catch { continue; }

    if (!cwdChecked && typeof e.cwd === 'string') {
      cwdChecked = true;
      if (path.resolve(e.cwd) !== path.resolve(directory)) {
        cwdMismatch = true;
      }
    }

    if (e.type === 'assistant' && e.message?.usage) {
      const u = e.message.usage;
      lastTokens = (u.input_tokens || 0)
                 + (u.cache_read_input_tokens || 0)
                 + (u.cache_creation_input_tokens || 0);
    }
    history = applyEventToBlocks(history, e);
  }

  return { history, lastTokens, exists: true, cwdMismatch };
}

module.exports = {
  encodedCwd, jsonlDirFor, jsonlPathFor,
  listJsonlsForProject, firstUserPreview,
  applyEventToBlocks, readHistory,
  CLAUDE_PROJECTS_DIR,
};
