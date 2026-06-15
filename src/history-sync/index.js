'use strict';

// history-sync orchestrator. A conversation is one canonical transcript; each
// turn the caller picks an agent INDEPENDENTLY (per-session/per-turn), the
// agent's native session is materialized from canonical, run, and its new turns
// ingested back. Neither agent owns the history — canonical does.

const store = require('./store');
const codexRuntime = require('./codex-runtime');
const claudeRuntime = require('./claude-runtime');
const {
  makeTurn,
  textPart,
  thinkingPart,
  toolCallPart,
  toolResultPart,
} = require('../../codex-compiler/canonical');
const path = require('path');

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

function partialTurnsFromLiveEvents({ agent, prompt, imagePaths = [], events = [], cancelled = false, error = null }) {
  const turns = [];
  const now = new Date().toISOString();
  const userParts = [];
  if (prompt) userParts.push(textPart(prompt));
  for (const p of imagePaths || []) {
    userParts.push({ type: 'image', basename: path.basename(p) });
  }
  if (userParts.length) {
    turns.push(makeTurn('user', userParts, {
      ts: now,
      providerMeta: { [agent]: { source: 'runtime_stream_fallback' } },
      meta: { incomplete: true, cancelled: !!cancelled, source: 'runtime_stream' },
    }));
  }

  const parts = [];
  const toolResults = [];
  for (const ev of events || []) {
    if (!ev || typeof ev !== 'object') continue;
    if (ev.type === 'assistant') {
      for (const blk of ev.message?.content || []) {
        if (!blk) continue;
        if (blk.type === 'text' && blk.text) parts.push(textPart(blk.text));
        else if (blk.type === 'thinking' && (blk.thinking || blk.text)) parts.push(thinkingPart(blk.thinking || blk.text));
        else if (blk.type === 'tool_use') parts.push(toolCallPart(blk.id, blk.name || 'tool', blk.input || {}, blk.name || 'tool'));
      }
    } else if (ev.type === 'tool') {
      const content = typeof ev.content === 'string' ? ev.content : JSON.stringify(ev.content || '');
      toolResults.push(toolResultPart(ev.tool_use_id, content, false));
    }
  }
  if (parts.length) {
    turns.push(makeTurn('assistant', parts, {
      ts: now,
      providerMeta: { [agent]: { source: 'runtime_stream_fallback' } },
      meta: {
        incomplete: true,
        cancelled: !!cancelled,
        source: 'runtime_stream',
        error: error ? String(error.message || error) : undefined,
      },
    }));
  }
  for (const result of toolResults) {
    turns.push(makeTurn('user', [result], {
      ts: now,
      providerMeta: { [agent]: { source: 'runtime_stream_fallback' } },
      meta: { incomplete: true, cancelled: !!cancelled, source: 'runtime_stream' },
    }));
  }
  return turns;
}

async function runTurn({ conversationId, agent, prompt, cwd, ...opts }) {
  const runtime = RUNTIMES[agent];
  if (!runtime) throw new Error(`Unknown agent: ${agent}`);
  const transcript = store.load(conversationId, { cwd, agent });
  const liveEvents = [];
  const callerOnLiveEvent = opts.onLiveEvent;
  const runtimeOpts = {
    cwd,
    ...opts,
    onLiveEvent: (event) => {
      liveEvents.push(event);
      if (typeof callerOnLiveEvent === 'function') callerOnLiveEvent(event);
    },
  };
  let added = [];
  let sessionId = '';
  try {
    const res = await runtime.turn(transcript, prompt, runtimeOpts);
    added = res.added || [];
    sessionId = res.sessionId;
  } catch (err) {
    const cancelled = typeof opts.isCancelled === 'function' ? !!opts.isCancelled() : false;
    const partial = partialTurnsFromLiveEvents({
      agent,
      prompt,
      imagePaths: opts.imagePaths || [],
      events: liveEvents,
      cancelled,
      error: err,
    });
    if (!partial.length || (!cancelled && !liveEvents.length)) throw err;
    transcript.turns.push(...partial);
    transcript.updatedAt = new Date().toISOString();
    added = partial;
  }
  if (!added.length && typeof opts.isCancelled === 'function' && opts.isCancelled()) {
    const partial = partialTurnsFromLiveEvents({
      agent,
      prompt,
      imagePaths: opts.imagePaths || [],
      events: liveEvents,
      cancelled: true,
    });
    if (partial.length) {
      transcript.turns.push(...partial);
      transcript.updatedAt = new Date().toISOString();
      added = partial;
    }
  }
  // A model/effort picker update can save meta.selection while the agent process
  // is running. Preserve the latest metadata instead of overwriting it with the
  // stale transcript snapshot loaded before the turn.
  try {
    const latest = store.load(conversationId, { cwd, agent });
    if (latest && latest.meta && typeof latest.meta === 'object') {
      transcript.meta = { ...(transcript.meta || {}), ...latest.meta };
    }
  } catch { /* best effort; normal save below remains authoritative for turns */ }
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

module.exports = { runTurn, store, partialTurnsFromLiveEvents };
