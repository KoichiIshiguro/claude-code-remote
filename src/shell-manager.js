'use strict';

// Persistent interactive shells, one tmux session per Claude session.
//
// tmux owns the persistence: we spawn a node-pty running `tmux new-session -A`
// (create-or-attach). Killing that pty just DETACHES the tmux client — the
// session, its shell, and scrollback live on in the tmux server, surviving the
// browser disconnect, the modal close, AND a restart of THIS node server (tmux
// is a separate daemon). Reopening spawns a fresh pty that re-attaches.
//
// Sessions are named `ccr-<sessionId>` so cleanup can find our zombies without
// touching the user's own tmux sessions.

const os = require('os');
const { execFileSync } = require('child_process');

// node-pty is a native module — tolerate it being absent (e.g. before
// `pnpm i`) so the rest of the server still boots; shell features just error.
let pty = null;
try { pty = require('node-pty'); } catch { /* not installed yet */ }

const TMUX = process.env.TMUX_PATH || '/opt/homebrew/bin/tmux';
const PREFIX = 'ccr-';

// tmux session names treat '.' and ':' specially; UUIDs are already safe but
// sanitize defensively for placeholder ids.
function tmuxName(sessionId) {
  return PREFIX + String(sessionId).replace(/[.:\s]/g, '-');
}

function hasPty() { return !!pty; }

// Spawn a pty attached to this session's tmux (creating it on first open).
function open(sessionId, directory, cols, rows) {
  if (!pty) throw new Error('node-pty is not installed — run `pnpm i` and restart the server');
  const name = tmuxName(sessionId);
  const cwd = directory || os.homedir();
  const args = ['new-session', '-A', '-s', name, '-c', cwd];
  return pty.spawn(TMUX, args, {
    name: 'xterm-256color',
    cols: cols || 80,
    rows: rows || 24,
    cwd,
    env: { ...process.env, TERM: 'xterm-256color' },
  });
}

// All live `ccr-*` tmux session names.
function listSessions() {
  try {
    const out = execFileSync(TMUX, ['list-sessions', '-F', '#{session_name}'], { encoding: 'utf8' });
    return out.split('\n').map(s => s.trim()).filter(s => s.startsWith(PREFIX));
  } catch {
    return []; // no tmux server running / no sessions
  }
}

// Kill every `ccr-*` tmux session whose Claude session id is NOT in keepIds
// (i.e. no longer shown anywhere in the GUI). Returns the names killed.
function cleanupOrphans(keepIds) {
  const keep = new Set((keepIds || []).map(tmuxName));
  const killed = [];
  for (const name of listSessions()) {
    if (keep.has(name)) continue;
    try { execFileSync(TMUX, ['kill-session', '-t', name]); killed.push(name); } catch { /* race */ }
  }
  return killed;
}

module.exports = { open, listSessions, cleanupOrphans, tmuxName, hasPty };
