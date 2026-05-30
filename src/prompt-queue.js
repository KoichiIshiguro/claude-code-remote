'use strict';

// In-memory, per-session prompt queue. The WS runner drains it as each
// `claude -p` turn finishes, so queued prompts fire even after the browser
// that sent them has disconnected. Deliberately NOT persisted: a server
// restart (or a cancel) wipes every queue, matching the agreed contract
// "stop / restart clears the queue".

let seq = 0;
const queues = new Map(); // key (sessionId | placeholderId) → [{ id, text, imagePaths }]

function enqueue(key, item) {
  if (!queues.has(key)) queues.set(key, []);
  const entry = { id: `q${++seq}`, text: item.text, imagePaths: item.imagePaths || [] };
  queues.get(key).push(entry);
  return entry;
}

function list(key) {
  const q = queues.get(key);
  return q ? q.slice() : [];
}

// Pull (and remove) everything queued for a key, so the runner can batch the
// accumulated prompts into a single turn.
function dequeueAll(key) {
  const q = queues.get(key);
  if (!q || !q.length) return [];
  queues.delete(key);
  return q;
}

function remove(key, id) {
  const q = queues.get(key);
  if (!q) return false;
  const i = q.findIndex(e => e.id === id);
  if (i === -1) return false;
  q.splice(i, 1);
  if (!q.length) queues.delete(key);
  return true;
}

function clear(key) {
  return queues.delete(key);
}

// Follow a placeholder→real session id rename so prompts queued before the
// first init event aren't stranded under the dead placeholder key.
function rekey(oldKey, newKey) {
  if (!oldKey || !newKey || oldKey === newKey) return;
  const q = queues.get(oldKey);
  if (!q) return;
  queues.delete(oldKey);
  const existing = queues.get(newKey);
  if (existing) existing.push(...q);
  else queues.set(newKey, q);
}

module.exports = { enqueue, list, dequeueAll, remove, clear, rekey };
