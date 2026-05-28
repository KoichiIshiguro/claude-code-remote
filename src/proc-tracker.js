'use strict';

// Tracks live `claude -p` subprocesses keyed by either a Claude session id
// (for existing sessions resumed via --resume) or a client-provided
// placeholder id (for sessions being created — rekeyed once Claude's init
// event reveals the assigned session id).

const procs = new Map();

function register(key, proc) {
  procs.set(key, proc);
  proc.on('close', () => {
    if (procs.get(key) === proc) procs.delete(key);
  });
}

function get(key) {
  return procs.get(key) || null;
}

function cancel(key) {
  const p = procs.get(key);
  if (!p) return false;
  try { p.kill('SIGTERM'); } catch {}
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

module.exports = { register, get, cancel, rekey, isRunning };
