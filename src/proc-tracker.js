'use strict';

// Tracks live `claude -p` subprocesses keyed by either a Claude session id
// (for existing sessions resumed via --resume) or a client-provided
// placeholder id (for sessions being created — rekeyed once Claude's init
// event reveals the assigned session id).

const procs = new Map();

function register(key, proc) {
  procs.set(key, proc);
  proc.on('close', () => {
    // The proc may have been rekeyed (placeholder id → real session id) since
    // registration, so remove it by IDENTITY wherever it currently lives — not
    // by the captured `key`. Keying on the stale placeholder left the real-id
    // entry behind, so isRunning(realId) stayed true after a new session's first
    // turn finished → a stuck "Stop" / streaming state on reload or switch.
    for (const [k, v] of procs) if (v === proc) procs.delete(k);
  });
}

function get(key) {
  return procs.get(key) || null;
}

// Signal the child's whole process GROUP, not just its pid. Children are
// spawned `detached` (group leader), so `-pid` reaches sandbox-exec, the claude
// it wraps, and any tool subprocesses. Killing the lone sandbox-exec pid leaves
// claude orphaned and holding the stdout pipe open. SIGTERM first, then a
// SIGKILL backstop in case claude ignores SIGTERM mid-tool.
function killTree(p, signal) {
  if (!p) return;
  try {
    if (p.pid) process.kill(-p.pid, signal);
    else p.kill(signal);
  } catch {
    try { p.kill(signal); } catch {}
  }
}

function cancel(key) {
  const p = procs.get(key);
  if (!p) return false;
  killTree(p, 'SIGTERM');
  // Backstop: if it's still alive after 3s, force-kill. Guard on exit state so a
  // reused pid (after a clean exit) can't be signalled by mistake.
  const t = setTimeout(() => {
    if (p.exitCode === null && p.signalCode === null) killTree(p, 'SIGKILL');
  }, 3000);
  t.unref?.();
  procs.delete(key);
  return true;
}

function rekey(oldKey, newKey) {
  if (!oldKey || !newKey || oldKey === newKey) return;
  const p = procs.get(oldKey);
  if (!p) return;
  procs.delete(oldKey);
  procs.set(newKey, p);
}

function isRunning(key) {
  return procs.has(key);
}

// All keys with a live subprocess — used to tell whether any session in a
// given directory is mid-turn (so a branch switch can be refused).
function runningKeys() {
  return [...procs.keys()];
}

module.exports = { register, get, cancel, rekey, isRunning, runningKeys };
