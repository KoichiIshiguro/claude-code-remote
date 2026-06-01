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
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

// node-pty exec()s a bundled `spawn-helper` binary for every pty it opens. Its
// install/postinstall script is what makes that helper executable — but pnpm
// blocks dependency build scripts by default, so the prebuilt helper stays at
// 0644 and EVERY spawn dies with "posix_spawnp failed.". Self-heal by adding the
// exec bit on load, independent of whether the build script ran. Idempotent.
function ensureSpawnHelperExecutable() {
  let root;
  try { root = path.dirname(require.resolve('node-pty/package.json')); }
  catch { return; }
  const candidates = [
    path.join(root, 'build', 'Release', 'spawn-helper'),
    path.join(root, 'prebuilds', `${process.platform}-${process.arch}`, 'spawn-helper'),
  ];
  for (const f of candidates) {
    try {
      const st = fs.statSync(f);
      if (!(st.mode & 0o111)) fs.chmodSync(f, st.mode | 0o755);
    } catch { /* absent or not writable — skip */ }
  }
}

// node-pty is a native module — tolerate it being absent (e.g. before
// `pnpm i`) so the rest of the server still boots; shell features just error.
let pty = null;
try { pty = require('node-pty'); ensureSpawnHelperExecutable(); } catch { /* not installed yet */ }

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
