'use strict';

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');

const sessions = new Map();
const activeProcesses = new Map(); // sessionId → child process

const DATA_FILE = path.join(__dirname, '..', 'data', 'sessions.json');

// ── Persistence ──────────────────────────────────────────────────────────────

function loadSessions() {
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    const data = JSON.parse(raw);
    for (const s of data) {
      // If a session was streaming when we crashed/restarted, the child claude
      // process is gone but the partial response on disk is still useful.
      // Promote the interrupted currentEntry into history so the user can see
      // what was produced before the interrupt, and offer a "continue" hint.
      let history = s.history || [];
      if (s.currentEntry) {
        const flushed = flushPendingText(s.currentEntry);
        flushed.interrupted = true;
        history = [...history, flushed];
      }
      sessions.set(s.id, {
        ...s,
        history,
        createdAt: new Date(s.createdAt),
        lastActivity: new Date(s.lastActivity),
        streaming: false,
        currentEntry: null,
      });
    }
    console.log(`[sessions] Loaded ${data.length} session(s) from disk`);
  } catch { /* first run or corrupted */ }
}

// Build a clean (serializable, no _text/_tools) copy of currentEntry, flushing
// any in-progress text buffer into a final text block. Used for both persistence
// and for getHistory snapshots.
function flushPendingText(entry) {
  const blocks = [...entry.blocks];
  if (entry._text) blocks.push({ kind: 'text', text: entry._text });
  return {
    type: 'assistant',
    blocks,
    ts: entry.ts,
    cancelled: entry.cancelled,
    cost: entry.cost,
  };
}

// Debounced disk writes for high-frequency calls (e.g. from feedEvent).
let savePending = false;
let saveTimer = null;
function saveSessions() {
  try {
    const dir = path.dirname(DATA_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const data = Array.from(sessions.values()).map(s => ({
      id: s.id,
      directory: s.directory,
      createdAt: s.createdAt,
      lastActivity: s.lastActivity,
      sessionId: s.sessionId,
      history: s.history,
      allowedTools: s.allowedTools ?? null,
      // Persist in-flight response so a crash/restart loses no visible output.
      // Strip private _text/_tools — flushPendingText emits final blocks only.
      currentEntry: s.currentEntry ? flushPendingText(s.currentEntry) : null,
    }));
    fs.writeFileSync(DATA_FILE, JSON.stringify(data));
  } catch (e) { console.error('[sessions] save failed:', e.message); }
}

function saveSessionsSoon() {
  if (savePending) return;
  savePending = true;
  saveTimer = setTimeout(() => {
    savePending = false;
    saveTimer = null;
    saveSessions();
  }, 500);
}

// Cancel any pending debounced save and write current state synchronously.
// Called on process shutdown so the in-flight response isn't a few hundred ms
// behind the wire when we get killed.
function flushPendingSave() {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; savePending = false; }
  saveSessions();
}

// ── Session CRUD ─────────────────────────────────────────────────────────────

function createSession(directory) {
  const absDir = path.resolve(directory);
  if (!fs.existsSync(absDir)) throw new Error(`Directory does not exist: ${absDir}`);

  const baseDir = process.env.BASE_DIR;
  if (baseDir && !absDir.startsWith(path.resolve(baseDir))) {
    throw new Error(`Directory is outside allowed base: ${baseDir}`);
  }

  const id = uuidv4();
  sessions.set(id, {
    id,
    directory: absDir,
    createdAt: new Date(),
    lastActivity: new Date(),
    sessionId: null,     // claude conversation ID (for --resume)
    history: [],
    streaming: false,
    currentEntry: null,
    allowedTools: null,  // null = dangerously-skip-permissions; array = --allowedTools
  });
  saveSessions();
  return sessions.get(id);
}

function getSession(id) { return sessions.get(id) || null; }

function listSessions() {
  return Array.from(sessions.values()).map(({ id, directory, createdAt, lastActivity, streaming, allowedTools }) => ({
    id, directory, createdAt, lastActivity, streaming, allowedTools,
  }));
}

function deleteSession(id) {
  cancelRunning(id);
  sessions.delete(id);
  saveSessions();
}

function updatePermissions(sessionId, allowedTools) {
  const s = sessions.get(sessionId);
  if (!s) return;
  s.allowedTools = allowedTools; // null = all allowed; string[] = specific tools
  saveSessions();
}

function cancelRunning(sessionId) {
  const proc = activeProcesses.get(sessionId);
  if (proc) { proc.kill('SIGTERM'); activeProcesses.delete(sessionId); return true; }
  return false;
}

// ── History helpers ──────────────────────────────────────────────────────────

function pushUserMessage(sessionId, text, imageCount) {
  const s = sessions.get(sessionId);
  if (!s) return;
  s.history.push({ type: 'user', text, imageCount, ts: Date.now() });
  saveSessions();
}

function startAssistantEntry(sessionId) {
  const s = sessions.get(sessionId);
  if (!s) return;
  s.streaming = true;
  s.currentEntry = {
    type: 'assistant',
    blocks: [],
    _text: '',
    _tools: {},
    ts: Date.now(),
    cancelled: false,
    cost: null,
  };
}

function feedEvent(sessionId, event) {
  const s = sessions.get(sessionId);
  if (!s || !s.currentEntry) return;
  const e = s.currentEntry;

  if (event.type === 'assistant') {
    for (const block of (event.message?.content || [])) {
      if (block.type === 'text') {
        e._text += block.text;
      } else if (block.type === 'tool_use') {
        if (e._text) { e.blocks.push({ kind: 'text', text: e._text }); e._text = ''; }

        let toolBlock;
        if (block.name === 'AskUserQuestion') {
          // Render as interactive choice widget
          toolBlock = {
            kind: 'ask',
            question: block.input?.question || '',
            options: block.input?.options || [],
            toolId: block.id,
            result: null,
          };
        } else {
          const title = toolTitle(block.name, block.input);
          toolBlock = { kind: 'tool', name: block.name, title, result: null };
        }
        e._tools[block.id] = toolBlock;
        e.blocks.push(toolBlock);
      } else if (block.type === 'thinking') {
        if (e._text) { e.blocks.push({ kind: 'text', text: e._text }); e._text = ''; }
        e.blocks.push({ kind: 'thinking', text: block.thinking });
      }
    }
  } else if (event.type === 'tool') {
    const toolBlock = e._tools[event.tool_use_id];
    if (toolBlock) {
      const r = typeof event.content === 'string' ? event.content : JSON.stringify(event.content, null, 2);
      toolBlock.result = r.length > 4000 ? r.slice(0, 4000) + '\n…(truncated)' : r;
    }
  } else if (event.type === 'result') {
    e.cost = event.cost_usd ?? null;
  } else if (event.type === 'cancelled') {
    e.cancelled = true;
  }
  // Persist in-flight state so a hard restart (PM2 SIGKILL, crash) doesn't
  // lose the partial response. Debounced to keep file I/O reasonable.
  saveSessionsSoon();
}

function finalizeEntry(sessionId) {
  const s = sessions.get(sessionId);
  if (!s || !s.currentEntry) return;
  const e = s.currentEntry;
  if (e._text) { e.blocks.push({ kind: 'text', text: e._text }); }
  delete e._text; delete e._tools;
  s.history.push(e);
  s.currentEntry = null;
  s.streaming = false;
  s.lastActivity = new Date();
  // Cancel any debounced save — we're about to write fresh state synchronously.
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; savePending = false; }
  saveSessions();
}

function getHistory(sessionId) {
  const s = sessions.get(sessionId);
  if (!s) return null;
  let current = null;
  if (s.currentEntry) {
    current = {
      type: 'assistant',
      blocks: JSON.parse(JSON.stringify(s.currentEntry.blocks)),
      ts: s.currentEntry.ts,
      cancelled: s.currentEntry.cancelled,
      cost: s.currentEntry.cost,
    };
  }
  return { history: s.history, streaming: s.streaming, currentEntry: current, allowedTools: s.allowedTools };
}

function toolTitle(name, input) {
  if (!input) return name;
  if (name === 'Bash') return (input.command || '').split('\n')[0].slice(0, 80) || name;
  if (['Read', 'Write', 'Edit', 'MultiEdit'].includes(name)) return input.file_path || name;
  if (name === 'LS') return input.path || name;
  return JSON.stringify(input).slice(0, 80);
}

// ── runPrompt ────────────────────────────────────────────────────────────────

async function* runPrompt(sessionId, promptText, imagePaths = []) {
  const session = sessions.get(sessionId);
  if (!session) throw new Error('Session not found');

  // Claude Code reads images by detecting file paths in the prompt text itself.
  // There is no --image flag; embedding absolute paths is the documented way
  // to attach images in non-interactive (-p) mode.
  const finalPrompt = imagePaths.length
    ? `${imagePaths.join('\n')}\n\n${promptText}`
    : promptText;

  const args = ['-p', finalPrompt, '--output-format', 'stream-json', '--verbose'];

  if (session.allowedTools === null) {
    // null = unrestricted
    args.push('--dangerously-skip-permissions');
  } else if (Array.isArray(session.allowedTools) && session.allowedTools.length > 0) {
    args.push('--allowedTools', session.allowedTools.join(','));
  }
  // empty array = no tools allowed (no flag added)

  if (session.sessionId) args.push('--resume', session.sessionId);

  const claudeBin = process.env.CLAUDE_PATH || 'claude';
  const proc = spawn(claudeBin, args, { cwd: session.directory, env: { ...process.env } });
  activeProcesses.set(sessionId, proc);
  proc.on('close', () => activeProcesses.delete(sessionId));

  let buffer = '';

  try {
    for await (const chunk of proc.stdout) {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const event = JSON.parse(trimmed);
          if (event.type === 'system' && event.subtype === 'init' && !session.sessionId) {
            session.sessionId = event.session_id;
            saveSessions();
          }
          yield event;
        } catch { /* skip non-JSON */ }
      }
    }
  } catch { /* cancelled */ }

  if (buffer.trim()) {
    try { yield JSON.parse(buffer.trim()); } catch { /* ignore */ }
  }

  let stderr = '';
  for await (const chunk of proc.stderr) stderr += chunk.toString();
  await new Promise(r => proc.on('close', r));

  if (proc.signalCode === 'SIGTERM') {
    yield { type: 'cancelled' };
  } else if (proc.exitCode !== 0 && stderr) {
    yield { type: 'error', message: stderr.trim() };
  }
}

// Load persisted sessions at startup
loadSessions();

function getActiveProcesses() { return activeProcesses; }

module.exports = {
  createSession, getSession, listSessions, deleteSession,
  updatePermissions, cancelRunning, runPrompt,
  pushUserMessage, startAssistantEntry, feedEvent, finalizeEntry, getHistory,
  getActiveProcesses, flushPendingSave,
};
