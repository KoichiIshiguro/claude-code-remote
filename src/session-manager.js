'use strict';

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');

const sessions = new Map();
// sessionId → { proc, buffer, exited, currentTurn }
const processes = new Map();

const DATA_FILE = path.join(__dirname, '..', 'data', 'sessions.json');

// ── Persistence ──────────────────────────────────────────────────────────────

function loadSessions() {
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    const data = JSON.parse(raw);
    for (const s of data) {
      // After a restart all claude processes are gone, so any session that was
      // mid-stream when we exited has an interrupted currentEntry. Promote it
      // to history with an interrupted flag — the next prompt will respawn via
      // --resume and the user can say "continue".
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
    sessionId: null,     // claude conversation ID (for --resume after process death)
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
  teardownProcess(id);
  sessions.delete(id);
  saveSessions();
}

function updatePermissions(sessionId, allowedTools) {
  const s = sessions.get(sessionId);
  if (!s) return;
  s.allowedTools = allowedTools;
  saveSessions();
  // Permissions are passed as spawn args, so they only take effect on a fresh
  // process. Tear down the current one; the next prompt will respawn it.
  teardownProcess(sessionId, { cancelled: true });
}

// ── Long-lived claude process per session ────────────────────────────────────

function buildSpawnArgs(session) {
  const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose'];

  // `-p` mode (incl. stream-json) cannot return a tool_result, so any
  // AskUserQuestion call hangs from Claude's perspective and it self-cancels
  // with "質問キャンセルされました". Tell the model to ask in plain text instead.
  args.push('--append-system-prompt',
    'When you need to ask the user a question or offer choices, write the question as plain text in your reply and STOP your turn. List options as a numbered or bulleted list. Do NOT call the AskUserQuestion tool — this environment cannot return a tool result, so the question would silently fail.');

  if (session.allowedTools === null) {
    args.push('--dangerously-skip-permissions');
  } else if (Array.isArray(session.allowedTools) && session.allowedTools.length > 0) {
    args.push('--allowedTools', session.allowedTools.join(','));
  }
  // empty array = no tools allowed (no flag added)
  if (session.sessionId) args.push('--resume', session.sessionId);
  return args;
}

function ensureProcess(sessionId) {
  const existing = processes.get(sessionId);
  if (existing && !existing.exited) return existing;

  const session = sessions.get(sessionId);
  if (!session) throw new Error('Session not found');

  const args = buildSpawnArgs(session);
  const claudeBin = process.env.CLAUDE_PATH || 'claude';
  const proc = spawn(claudeBin, args, { cwd: session.directory, env: { ...process.env } });

  const ctx = { proc, buffer: '', exited: false, currentTurn: null };
  processes.set(sessionId, ctx);
  console.log(`[claude ${sessionId.slice(0, 8)}] spawned (pid=${proc.pid}, resume=${!!session.sessionId})`);

  proc.stdout.on('data', (chunk) => {
    ctx.buffer += chunk.toString();
    const lines = ctx.buffer.split('\n');
    ctx.buffer = lines.pop();
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let event;
      try { event = JSON.parse(trimmed); }
      catch { continue; }

      // Capture claude's session id on init so we can --resume next time.
      if (event.type === 'system' && event.subtype === 'init' && !session.sessionId) {
        session.sessionId = event.session_id;
        saveSessions();
      }

      if (ctx.currentTurn) ctx.currentTurn.push(event);
    }
  });

  proc.stderr.on('data', (chunk) => {
    const msg = chunk.toString().trim();
    if (msg) console.error(`[claude ${sessionId.slice(0, 8)}] ${msg}`);
  });

  proc.on('exit', (code, signal) => {
    ctx.exited = true;
    if (ctx.currentTurn) {
      // If we weren't already torn down (cancel/perm-update pushes cancelled
      // before kill), surface the unexpected exit as an error.
      if (signal !== 'SIGTERM' && code !== 0) {
        ctx.currentTurn.push({ type: 'error', message: `claude exited (code=${code}, signal=${signal})` });
      }
      ctx.currentTurn.end();
    }
    if (processes.get(sessionId) === ctx) processes.delete(sessionId);
    console.log(`[claude ${sessionId.slice(0, 8)}] exited (code=${code}, signal=${signal})`);
  });

  proc.on('error', (err) => {
    console.error(`[claude ${sessionId.slice(0, 8)}] spawn error:`, err.message);
    if (ctx.currentTurn) {
      ctx.currentTurn.push({ type: 'error', message: err.message });
      ctx.currentTurn.end();
    }
  });

  return ctx;
}

// Force-kill the long-lived process and remove it from the map immediately so
// the next prompt respawns a fresh one. Optionally push a cancelled event into
// the in-flight turn so the client sees a clean termination.
function teardownProcess(sessionId, { cancelled = false } = {}) {
  const ctx = processes.get(sessionId);
  if (!ctx) return false;
  if (cancelled && ctx.currentTurn) ctx.currentTurn.push({ type: 'cancelled' });
  processes.delete(sessionId);
  ctx.exited = true;
  try { ctx.proc.kill('SIGTERM'); } catch { /* already gone */ }
  return true;
}

function cancelRunning(sessionId) {
  const ctx = processes.get(sessionId);
  if (!ctx || !ctx.currentTurn) return false;
  return teardownProcess(sessionId, { cancelled: true });
}

function shutdownAllProcesses() {
  for (const sid of Array.from(processes.keys())) teardownProcess(sid);
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
  } else if (event.type === 'user') {
    // Tool results arrive wrapped in synthetic "user" events.
    for (const block of (event.message?.content || [])) {
      if (block.type === 'tool_result') {
        const toolBlock = e._tools[block.tool_use_id];
        if (toolBlock) {
          const c = block.content;
          const r = typeof c === 'string' ? c : JSON.stringify(c, null, 2);
          toolBlock.result = r.length > 4000 ? r.slice(0, 4000) + '\n…(truncated)' : r;
        }
      }
    }
  } else if (event.type === 'result') {
    e.cost = event.total_cost_usd ?? null;
  } else if (event.type === 'cancelled') {
    e.cancelled = true;
  } else if (event.type === 'error') {
    if (e._text) { e.blocks.push({ kind: 'text', text: e._text }); e._text = ''; }
    e.blocks.push({ kind: 'text', text: `[claude error] ${event.message}` });
  }
  // Persist in-flight state debounced so a hard restart preserves partial output.
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

// ── runPrompt: write to long-lived process stdin, yield events as they arrive ─

function createTurnQueue() {
  const items = [];
  const waiters = [];
  let ended = false;
  return {
    push(item) {
      if (ended) return;
      if (waiters.length) waiters.shift()({ value: item, done: false });
      else items.push(item);
    },
    end() {
      if (ended) return;
      ended = true;
      while (waiters.length) waiters.shift()({ value: undefined, done: true });
    },
    [Symbol.asyncIterator]() {
      return {
        next: () => {
          if (items.length) return Promise.resolve({ value: items.shift(), done: false });
          if (ended) return Promise.resolve({ value: undefined, done: true });
          return new Promise(r => waiters.push(r));
        }
      };
    }
  };
}

async function* runPrompt(sessionId, promptText, imagePaths = []) {
  const session = sessions.get(sessionId);
  if (!session) throw new Error('Session not found');

  const ctx = ensureProcess(sessionId);
  if (ctx.currentTurn) throw new Error('A turn is already in flight for this session');

  // Embed image paths in the user message text — claude's Read tool detects
  // absolute paths inline. No proprietary "attachment" field is needed.
  const content = imagePaths.length
    ? `${imagePaths.join('\n')}\n\n${promptText}`
    : promptText;

  const userMsg = { type: 'user', message: { role: 'user', content } };

  const queue = createTurnQueue();
  ctx.currentTurn = queue;

  try {
    ctx.proc.stdin.write(JSON.stringify(userMsg) + '\n');
  } catch (err) {
    ctx.currentTurn = null;
    throw err;
  }

  try {
    for await (const event of queue) {
      yield event;
      if (event.type === 'result' || event.type === 'cancelled' || event.type === 'error') break;
    }
  } finally {
    if (ctx.currentTurn === queue) ctx.currentTurn = null;
  }
}

// ── Init ─────────────────────────────────────────────────────────────────────

loadSessions();

module.exports = {
  createSession, getSession, listSessions, deleteSession,
  updatePermissions, cancelRunning, runPrompt,
  pushUserMessage, startAssistantEntry, feedEvent, finalizeEntry, getHistory,
  flushPendingSave, shutdownAllProcesses,
};
