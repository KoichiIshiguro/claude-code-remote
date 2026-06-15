'use strict';

// history-sync orchestrator. A conversation is one canonical transcript; each
// turn the caller picks an agent INDEPENDENTLY (per-session/per-turn), the
// agent's native session is materialized from canonical, run, and its new turns
// ingested back. Neither agent owns the history — canonical does.

const store = require('./store');
const codexRuntime = require('./codex-runtime');
const claudeRuntime = require('./claude-runtime');

const RUNTIMES = {
  codex: codexRuntime,
  claude: claudeRuntime,
};

function visibleAssistantText(turns) {
  return turns
    .filter((t) => t.role === 'assistant')
    .flatMap((t) => (t.parts || []).filter((p) => p.type === 'text').map((p) => p.text))
    .join('\n');
}

async function runTurn({ conversationId, agent, prompt, cwd, ...opts }) {
  const runtime = RUNTIMES[agent];
  if (!runtime) throw new Error(`Unknown agent: ${agent}`);
  const transcript = store.load(conversationId, { cwd, agent });
  const { added, sessionId } = await runtime.turn(transcript, prompt, { cwd, ...opts });
  store.save(transcript);
  return {
    conversationId,
    agent,
    sessionId,
    turns: added,
    addedTurns: added.length,
    totalTurns: transcript.turns.length,
    reply: visibleAssistantText(added),
  };
}

module.exports = { runTurn, store };
