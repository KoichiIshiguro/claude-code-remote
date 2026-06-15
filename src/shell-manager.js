'use strict';

// Persistent interactive shells, one tmux session per Claude session.
//
// When tmux is available, tmux owns the persistence: we spawn a node-pty running
// `tmux new-session -A` (create-or-attach). Killing that pty just DETACHES the
// tmux client — the session, its shell, and scrollback live on in the tmux
// server, surviving the browser disconnect, the modal close, AND a restart of
// THIS node server (tmux is a separate daemon). Reopening spawns a fresh pty
// that re-attaches.
//
// When tmux is NOT available (Windows has no native tmux; some Linux/macOS hosts
// simply don't have it installed) we fall back to spawning the platform's
// default shell directly. That shell works fully, but with NO persistence: the
// session ends when its pty closes (browser disconnect / modal close / server
// restart), since there's no tmux daemon holding it.
//
// tmux sessions are named `ccr-<sessionId>` so cleanup can find our zombies
// without touching the user's own tmux sessions.

const os = require('os');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const IS_WINDOWS = process.platform === 'win32';

// node-pty exec()s a bundled `spawn-helper` binary for every pty it opens. Its
// install/postinstall script is what makes that helper executable — but pnpm
// blocks dependency build scripts by default, so the prebuilt helper stays at
// 0644 and EVERY spawn dies with "posix_spawnp failed.". Self-heal by adding the
// exec bit on load, independent of whether the build script ran. Idempotent.
// (POSIX-only; on Windows node-pty uses ConPTY and there's no spawn-helper.)
function ensureSpawnHelperExecutable() {
  if (IS_WINDOWS) return;
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

// Resolve a usable tmux binary once, at load. Order: explicit TMUX_PATH → PATH
// lookup (`which`) → well-known install dirs (PATH is often minimal under a
// service manager / launchd). null = no tmux on this host → plain-shell fallback.
function resolveTmux() {
  if (IS_WINDOWS) return null; // no native tmux on Windows
  const isExec = (p) => { try { fs.accessSync(p, fs.constants.X_OK); return true; } catch { return false; } };

  const envPath = process.env.TMUX_PATH;
  if (envPath && isExec(envPath)) return envPath;

  // Ask the login shell's PATH first — covers Homebrew (either arch), Nix, etc.
  try {
    const found = execFileSync('which', ['tmux'], { encoding: 'utf8' }).trim().split('\n')[0];
    if (found && isExec(found)) return found;
  } catch { /* `which` missing or tmux not on PATH */ }

  // Fall back to common locations for when PATH is stripped (launchd/systemd).
  const candidates = [
    '/opt/homebrew/bin/tmux', // Apple Silicon Homebrew
    '/usr/local/bin/tmux',    // Intel Homebrew / manual installs
    '/usr/bin/tmux',          // Linux distro package
    '/bin/tmux',
  ];
  for (const c of candidates) if (isExec(c)) return c;
  return null;
}

const TMUX = resolveTmux();
const HAS_TMUX = !!TMUX;
const PREFIX = 'ccr-';

// A pty whose environment has no UTF-8 locale (LANG/LC_* unset or set to C —
// common under launchd / systemd / PM2, which strip the user's locale) makes
// tmux and the shell fall back to the POSIX/C codeset and MANGLE multibyte I/O:
// Japanese/CJK and other 2-byte characters arrive stripped or broken. Inject a
// UTF-8 locale only when the host provides none, so the terminal handles 2-byte
// text regardless of how the server was launched. macOS always ships
// `en_US.UTF-8`; on Linux `C.UTF-8` is the broadly-available choice (`en_US.UTF-8`
// there needs locale-gen). LC_CTYPE is what tmux/ncurses read for the codeset.
function utf8LocaleEnv() {
  const isUtf8 = (v) => typeof v === 'string' && /utf-?8/i.test(v);
  if (isUtf8(process.env.LC_ALL) || isUtf8(process.env.LC_CTYPE) || isUtf8(process.env.LANG)) return {};
  const value = IS_WINDOWS ? null : (process.platform === 'darwin' ? 'en_US.UTF-8' : 'C.UTF-8');
  return value ? { LANG: process.env.LANG || value, LC_CTYPE: value } : {};
}

// The platform default shell for the no-tmux fallback path.
function defaultShell() {
  if (IS_WINDOWS) {
    // Prefer PowerShell; allow override, fall back to cmd via COMSPEC.
    const file = process.env.CCR_SHELL || 'powershell.exe';
    return { file, args: [] };
  }
  const file = process.env.CCR_SHELL || process.env.SHELL || '/bin/bash';
  return { file, args: ['-l'] };
}

// tmux session names treat '.' and ':' specially; UUIDs are already safe but
// sanitize defensively for placeholder ids.
function tmuxName(sessionId) {
  return PREFIX + String(sessionId).replace(/[.:\s]/g, '-');
}

function hasPty() { return !!pty; }
// True when shells survive disconnect/restart (tmux-backed). The UI can warn
// when false so users know a closed shell won't come back.
function hasPersistence() { return HAS_TMUX; }

// Spawn a pty for this session. With tmux: attach-or-create a named, persistent
// session. Without tmux: spawn the platform shell directly (no persistence).
function open(sessionId, directory, cols, rows) {
  if (!pty) throw new Error('node-pty is not installed — run `pnpm i` and restart the server');
  const cwd = directory || os.homedir();
  const base = {
    name: 'xterm-256color',
    cols: cols || 80,
    rows: rows || 24,
    cwd,
    env: { ...process.env, ...utf8LocaleEnv(), TERM: 'xterm-256color' },
  };
  if (HAS_TMUX) {
    const name = tmuxName(sessionId);
    return pty.spawn(TMUX, ['new-session', '-A', '-s', name, '-c', cwd], base);
  }
  const shell = defaultShell();
  return pty.spawn(shell.file, shell.args, base);
}

// All live `ccr-*` tmux session names. Empty when there's no tmux on this host.
function listSessions() {
  if (!HAS_TMUX) return [];
  try {
    const out = execFileSync(TMUX, ['list-sessions', '-F', '#{session_name}'], { encoding: 'utf8' });
    return out.split('\n').map(s => s.trim()).filter(s => s.startsWith(PREFIX));
  } catch {
    return []; // no tmux server running / no sessions
  }
}

// Kill every `ccr-*` tmux session whose Claude session id is NOT in keepIds
// (i.e. no longer shown anywhere in the GUI). Returns the names killed. No-op
// without tmux (the plain-shell fallback leaves no detached sessions to reap).
function cleanupOrphans(keepIds) {
  if (!HAS_TMUX) return [];
  const keep = new Set((keepIds || []).map(tmuxName));
  const killed = [];
  for (const name of listSessions()) {
    if (keep.has(name)) continue;
    try { execFileSync(TMUX, ['kill-session', '-t', name]); killed.push(name); } catch { /* race */ }
  }
  return killed;
}

module.exports = { open, listSessions, cleanupOrphans, tmuxName, hasPty, hasPersistence };
