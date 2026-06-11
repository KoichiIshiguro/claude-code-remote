'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const CLAUDE_PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');

// Claude CLI encodes every non-alphanumeric character of the absolute cwd to
// a single "-". Verified empirically against existing jsonl directories:
//   "/Volumes/sal-dev/foo"      → "-Volumes-sal-dev-foo"
//   "/Volumes/sal-dev/foo_bar"  → "-Volumes-sal-dev-foo-bar"   (underscore)
//   "/Users/.../Mobile Documents/com~apple~CloudDocs/..." → "...Mobile-Documents-com-apple-CloudDocs..."
//   "/Volumes/名称未設定/HIKSEMI" → "-Volumes-------HIKSEMI"   (non-ASCII)
// Only `/`-substitution was a long-standing bug: any folder containing `_`,
// `.`, space, `~`, or non-ASCII pointed at a directory that did not exist,
// so the session vanished from the sidebar.
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
// `"entrypoint":"sdk-cli"` (the value stamped on sessions started via
// `claude -p` / the Agent SDK — i.e. every session this server creates).
// The picker reads only the first `"entrypoint"` occurrence in the file's
// leading 64 KiB, so flipping it to `"cli"` makes our sessions appear in the
// native TUI picker without changing anything the CLI relies on at runtime
// (entrypoint is display metadata only). Verified against claude 2.1.156 by
// tracing `--debug` output: a byte-faithful copy differing only in this token
// flipped a session from "filtered out" to "visible".
const PICKER_SCAN_BYTES = 65536;
const SDK_ENTRYPOINT = '"entrypoint":"sdk-cli"';
const CLI_ENTRYPOINT = '"entrypoint":"cli"';

// Rewrite every `sdk-cli` entrypoint token to `cli`, in place. The picker only
// reads the first occurrence in the leading 64 KiB, so we peek that window to
// skip already-clean files cheaply; when a token is present we replace all of
// them for consistency (cheap, and robust if the leading record order changes
// across CLI versions). No-op + false if nothing to patch or on any I/O error.
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
      // Make sessions this server created visible in the native CLI picker.
      ensurePickerVisible(full);
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

// Slash-command plumbing that Claude CLI writes into the jsonl as fake
// user events. They should never appear in the chat view: caveat banners,
// the /<cmd> echo trio, captured stdout/stderr, and the synthetic
// "Continue from where you left off." kickoff after /compact.
function isMetaUserText(text) {
  if (!text) return false;
  const t = text.trim();
  if (/^<local-command-(caveat|stdout|stderr)>/i.test(t)) return true;
  if (/^<command-(name|message|args)>/i.test(t)) return true;
  if (t === 'Continue from where you left off.') return true;
  return false;
}

// A prompt with attachments is sent to claude as `path1\npath2\n\n<prompt>`
// (session-manager prepends the upload paths), so the jsonl user text carries
// those leading .upload-files paths. Split them back out: return the displayable
// prompt text plus the attachment basenames (the client rebuilds /attachment
// URLs from session + dir). Only leading consecutive path lines are consumed, so
// a path mentioned inside the actual prompt is left untouched.
function splitAttachments(text) {
  if (!text) return { text: '', images: [] };
  const lines = text.split('\n');
  const images = [];
  let i = 0;
  while (i < lines.length && /\/\.upload-files\/[^/]+$/.test(lines[i].trim())) {
    images.push(path.basename(lines[i].trim()));
    i++;
  }
  if (!images.length) return { text, images: [] };
  if (i < lines.length && lines[i].trim() === '') i++; // drop the blank separator
  return { text: lines.slice(i).join('\n'), images };
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
// `ai-title` event's title. Claude CLI auto-generates these for every session
// (TUI and `-p` alike) and refreshes them as the conversation evolves, so this
// gives us a free, always-current display name for sidebar rows.
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

// Cheap tail-scan: read the last `maxBytes` of a jsonl, walk lines backward,
// return the input-token total from the most recent assistant event with usage.
// Used by shouldAutoCompact() to avoid a full re-parse before every prompt.
// 256KB tail: enough to clear a large compact summary entry so the
// compact_boundary line just above it stays inside the window.
function getLastTokens(sessionId, directory, maxBytes = 262144) {
  const p = jsonlPathFor(sessionId, directory);
  let fd;
  try {
    const stat = fs.statSync(p);
    if (stat.size === 0) return null;
    const readSize = Math.min(stat.size, maxBytes);
    const buf = Buffer.alloc(readSize);
    fd = fs.openSync(p, 'r');
    fs.readSync(fd, buf, 0, readSize, stat.size - readSize);
    const lines = buf.toString('utf8').split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      const t = lines[i].trim();
      if (!t) continue;
      let e; try { e = JSON.parse(t); } catch { continue; }
      // Scanning from the end: whichever comes first wins. A compact_boundary
      // seen before any assistant usage means a /compact ran and no real turn
      // has happened since — its postTokens is the true current context size
      // (the pre-compact assistant usage further up is stale-large). If a real
      // turn ran after the compact, we hit its (already-small) usage first.
      if (e.type === 'system' && e.subtype === 'compact_boundary'
          && typeof e.compactMetadata?.postTokens === 'number') {
        return e.compactMetadata.postTokens;
      }
      if (e.type === 'assistant' && e.message?.usage) {
        const u = e.message.usage;
        return (u.input_tokens || 0)
             + (u.cache_read_input_tokens || 0)
             + (u.cache_creation_input_tokens || 0);
      }
    }
    return null;
  } catch {
    return null;
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

// Files worth surfacing inline in the chat as a preview (images) or download
// link (everything else): a Write/Edit target is a produced/updated artifact;
// image paths inside a Bash command catch screenshots (screencapture, headless
// browser, imagemagick, …). The client classifies by extension and resolves
// relative paths against the session directory. Computed here so the SAME data
// is available on reload (history) as during live streaming.
function artifactCandidates(name, input) {
  if (!input) return [];
  if (name === 'Write' || name === 'Edit' || name === 'MultiEdit') {
    return input.file_path ? [input.file_path] : [];
  }
  if (name === 'Bash' && typeof input.command === 'string') {
    const out = [];
    const re = /[~./][^\s'"`;|&)>]*\.(?:png|jpe?g|gif|webp|bmp|svg|avif)\b/gi;
    let m;
    while ((m = re.exec(input.command)) && out.length < 6) {
      if (!out.includes(m[0])) out.push(m[0]);
    }
    return out;
  }
  return [];
}

// Pure function: fold one jsonl event into the running history array.
// Returns the new history (does not mutate input). Unknown event types are
// passed through unchanged.
function applyEventToBlocks(history, event) {
  if (!event || typeof event !== 'object') return history;
  const ts = event.timestamp ? Date.parse(event.timestamp) : Date.now();

  if (event.type === 'user') {
    // A compaction writes its summary as an isCompactSummary user entry at the
    // exact point context was compacted. Surface it as a marker block so the
    // user can see "compacted here" on reload, instead of silently dropping it.
    if (event.isCompactSummary) return [...history, { type: 'compact', ts }];
    if (event.isMeta) return history;
    const content = event.message?.content;

    // Tool-result wrap: attach result to preceding assistant's tool block.
    if (Array.isArray(content) && content.some(c => c && c.type === 'tool_result')) {
      return attachToolResults(history, content);
    }

    const rawText = extractUserText(event.message);
    if (!rawText) return history;
    if (isMetaUserText(rawText)) return history;
    const { text, images } = splitAttachments(rawText);
    if (!text && !images.length) return history;
    return [...history, { type: 'user', text, images, ts }];
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
          artifacts: artifactCandidates(b.name, b.input),
        });
      }
    }
    if (!blocks.length) return history;
    // uuid lets the live stream dedupe against what we've already painted from
    // jsonl on a mid-stream re-attach (`claude -p` flushes its stream-json in a
    // late burst, so the same event can arrive from both paths). It must be the
    // per-event uuid, NOT message.id: one assistant message streams as multiple
    // events sharing one message.id (thinking, then text), and the stdout uuid
    // matches the jsonl uuid for the same event — so per-uuid dedup keeps every
    // block while still collapsing the re-attach duplicate.
    return [...history, { type: 'assistant', blocks, ts, uuid: event.uuid || null }];
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

// Trim a built history to the last `maxUserTurns` user messages plus the
// assistant/tool blocks that follow each of them. We must fold the WHOLE file
// first (tool_result attachment and lastTokens both depend on it) and only cut
// at the end. Cutting on a `user`-entry boundary keeps every assistant turn
// paired with the prompt that produced it. Returns { history, truncated }.
function trimToRecentTurns(history, maxUserTurns) {
  if (!maxUserTurns || maxUserTurns <= 0) return { history, truncated: false };
  const userIdx = [];
  for (let i = 0; i < history.length; i++) {
    if (history[i].type === 'user') userIdx.push(i);
  }
  if (userIdx.length <= maxUserTurns) return { history, truncated: false };
  const cut = userIdx[userIdx.length - maxUserTurns];
  return { history: history.slice(cut), truncated: true };
}

// Full re-read of a jsonl into Remote's history-blocks shape.
// Returns { history, lastTokens, exists, cwdMismatch, truncated }.
//  - cwdMismatch is set if the file's first event references a `cwd` that
//    disagrees with the expected directory. Defends against encoded-cwd
//    collisions like "/foo/bar-baz" vs "/foo-bar/baz".
//  - maxUserTurns caps the returned history to the last N user prompts (and
//    their replies). A long session is unscrollable anyway and shipping 6000+
//    blocks bloats the WS payload and DOM. 0/null = no cap.
function readHistory(sessionId, directory, maxUserTurns = 100) {
  const p = jsonlPathFor(sessionId, directory);
  let raw;
  try { raw = fs.readFileSync(p, 'utf8'); }
  catch { return { history: [], lastTokens: null, exists: false, cwdMismatch: false, truncated: false }; }

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
    } else if (e.type === 'system' && e.subtype === 'compact_boundary'
               && typeof e.compactMetadata?.postTokens === 'number') {
      // A /compact just shrank the context to postTokens. The pre-compact
      // assistant usage above is stale-large; adopt the real post-compact size.
      // A later real turn's usage (forward iteration → last write wins) will
      // override this once one runs.
      lastTokens = e.compactMetadata.postTokens;
    }
    history = applyEventToBlocks(history, e);
  }

  const { history: trimmed, truncated } = trimToRecentTurns(history, maxUserTurns);
  return { history: trimmed, lastTokens, exists: true, cwdMismatch, truncated };
}

// Tail-scan the last `maxBytes` of a jsonl and return the LAST non-empty
// parsed entry. Used when we need the uuid / parentUuid of the most recent
// assistant turn (e.g. for the AskUserQuestion intercept that appends a
// synthetic tool_result line).
function readTailEntry(sessionId, directory, maxBytes = 65536) {
  const p = jsonlPathFor(sessionId, directory);
  let fd;
  try {
    const stat = fs.statSync(p);
    if (stat.size === 0) return null;
    const readSize = Math.min(stat.size, maxBytes);
    const buf = Buffer.alloc(readSize);
    fd = fs.openSync(p, 'r');
    fs.readSync(fd, buf, 0, readSize, stat.size - readSize);
    const lines = buf.toString('utf8').split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      const t = lines[i].trim();
      if (!t) continue;
      try { return JSON.parse(t); } catch { continue; }
    }
    return null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch {}
  }
}

// Append a single jsonl entry. Newline added by us.
function appendJsonlLine(sessionId, directory, entry) {
  const p = jsonlPathFor(sessionId, directory);
  fs.appendFileSync(p, JSON.stringify(entry) + '\n', 'utf8');
}

module.exports = {
  encodedCwd, jsonlDirFor, jsonlPathFor,
  listJsonlsForProject, firstUserPreview, getLatestAiTitle, ensurePickerVisible,
  applyEventToBlocks, readHistory, getLastTokens,
  readTailEntry, appendJsonlLine,
  CLAUDE_PROJECTS_DIR,
};
