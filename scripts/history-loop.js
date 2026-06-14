#!/usr/bin/env node
'use strict';

// Headless milestone-0.5 driver: prove the full shared-history loop.
//
//   node scripts/history-loop.js <conversationId> <agent> "<prompt>"
//
// Each invocation runs ONE turn with the chosen agent against the shared
// canonical conversation. Because every turn re-materializes a FRESH native
// session from canonical (not the agent's own prior session), any memory the
// agent shows MUST have travelled through canonical — that is the proof that
// canonical is the single source of truth and history is shared across agents.

const { runTurn } = require('../src/history-sync');

async function main() {
  const [conversationId, agent, prompt] = process.argv.slice(2);
  if (!conversationId || !agent || !prompt) {
    console.error('usage: history-loop.js <conversationId> <agent> "<prompt>"');
    process.exit(1);
  }
  const res = await runTurn({
    conversationId,
    agent,
    prompt,
    cwd: process.env.LOOP_CWD || process.cwd(),
  });
  console.log(JSON.stringify(res, null, 2));
}

main().catch((err) => { console.error(err.stack || err.message); process.exit(1); });
