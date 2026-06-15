'use strict';

// In-memory snapshot of the CURRENTLY streaming turn per session. While a turn
// runs, its jsonl on disk isn't written yet, so a browser that reloads or
// switches project mid-turn has no way to recover the just-sent prompt or the
// assistant output so far (attach's readHistory only sees finalized turns).
// This bridges that gap: the runner records the prompt + every stream event
// here, and attach replays it. Cleared on stream_end once the jsonl is the
// authority. Like prompt-queue, deliberately NOT persisted across a server
// restart — a restart wipes every in-flight turn, matching the queue contract.

const turns = new Map(); // key (sessionId | placeholderId) → { prompt, images, compact, events: [] }

function begin(key, { prompt = '', images = [], compact = false, agent = '' } = {}) {
  turns.set(key, { prompt, images, compact: !!compact, agent, events: [], status: 'running', startedAt: Date.now() });
}

function record(key, event) {
  const t = turns.get(key);
  if (t) t.events.push(event);
}

function get(key) {
  return turns.get(key) || null;
}

function end(key) {
  turns.delete(key);
}

function markCancelling(key) {
  const t = turns.get(key);
  if (t) t.status = 'cancelling';
}

// Follow a placeholder→real session id rename so the in-flight turn survives the
// init event that resolves a brand-new session's real id.
function rekey(oldKey, newKey) {
  if (!oldKey || !newKey || oldKey === newKey) return;
  const t = turns.get(oldKey);
  if (!t) return;
  turns.delete(oldKey);
  turns.set(newKey, t);
}

module.exports = { begin, record, get, end, markCancelling, rekey };
