'use strict';

// Split an ordered list of queued/due items into CONTIGUOUS runs of the same
// agent, so a single batched turn never mixes Claude and Codex. The runner then
// executes the segments sequentially:
//   [c,c,x,x,c] → [[c,c],[x,x],[c]]  → 3 turns: claude, codex, claude.
// Items with no/unknown agent normalize to 'claude' (the native default), so a
// native (non-shared) session collapses to a single segment — identical to the
// old "batch everything into one turn" behaviour.

function normAgent(a) { return a === 'codex' ? 'codex' : 'claude'; }

function segmentByAgent(items) {
  const segments = [];
  for (const it of items || []) {
    const agent = normAgent(it && it.agent);
    const last = segments[segments.length - 1];
    if (last && last.agent === agent) last.items.push(it);
    else segments.push({ agent, items: [it] });
  }
  return segments;
}

module.exports = { segmentByAgent, normAgent };
