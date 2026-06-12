'use strict';

// Scheduled (reserved) prompts — Gmail-style "send later". Unlike the live
// prompt queue (in-memory, wiped on restart by design), reservations are
// persisted to data/scheduled-prompts.json so a server restart doesn't lose
// them: the whole point is firing hours later, e.g. after a session-limit
// reset, with no browser attached.

const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const DATA_DIR = path.join(__dirname, '..', 'data');
const FILE = path.join(DATA_DIR, 'scheduled-prompts.json');

let items = (() => {
  try {
    const a = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    return Array.isArray(a) ? a.filter(i => i && typeof i.fireAt === 'number') : [];
  } catch { return []; }
})();

function save() {
  // Self-contained: data/ is gitignored so it's absent on a fresh clone. Create
  // it here rather than relying on another module's startup side effect, so a
  // reservation made before anything else touched data/ still persists.
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(items));
  } catch {}
}

// item: { sessionId, directory, text, imagePaths, fireAt(ms epoch) }
function add(item) {
  const entry = {
    id: uuidv4(),
    sessionId: item.sessionId,
    directory: item.directory,
    text: item.text || '',
    imagePaths: item.imagePaths || [],
    fireAt: item.fireAt,
  };
  items.push(entry);
  items.sort((a, b) => a.fireAt - b.fireAt);
  save();
  return entry;
}

function listFor(sessionId) {
  return items.filter(i => i.sessionId === sessionId);
}

function remove(sessionId, id) {
  const i = items.findIndex(e => e.sessionId === sessionId && e.id === id);
  if (i === -1) return false;
  items.splice(i, 1);
  save();
  return true;
}

// Pull (and delete) everything due at `now` for the caller to enqueue.
function takeDue(now) {
  const due = items.filter(i => i.fireAt <= now);
  if (due.length) {
    items = items.filter(i => i.fireAt > now);
    save();
  }
  return due;
}

// Follow a placeholder→real session id rename, same contract as prompt-queue.
function rekey(oldKey, newKey) {
  if (!oldKey || !newKey || oldKey === newKey) return;
  let changed = false;
  for (const i of items) {
    if (i.sessionId === oldKey) { i.sessionId = newKey; changed = true; }
  }
  if (changed) save();
}

module.exports = { add, listFor, remove, takeDue, rekey };
