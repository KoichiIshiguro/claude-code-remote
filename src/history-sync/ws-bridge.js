'use strict';

// Bridge between the history-sync engine and the WebSocket UI. A "shared" (alpha)
// conversation is one canonical transcript whose id carries the `xsync_` prefix.
// Each turn the client picks an agent (claude|codex) INDEPENDENTLY; both feed the
// same canonical store, so the conversation is continued by either peer.
//
// The UI renderer only knows Claude's wire shapes (normalized history entries +
// `stream-json` events). Rather than touch the renderer, this bridge converts the
// provider-neutral canonical turns INTO those Claude shapes — so a Codex turn is
// indistinguishable from a Claude one on screen. That is the "equal peers" goal
// expressed at the presentation layer. See [[history-sync-keystone]].

const store = require('./store');
const { runTurn } = require('./index');
const { selectionForTranscript } = require('./selection');

const PREFIX = 'xsync_';

function isSyncId(id) {
  return typeof id === 'string' && id.startsWith(PREFIX);
}

function newSyncId() {
  return PREFIX + require('crypto').randomUUID();
}

// canonical turns → the normalized history entries the client's renderHistoryEntry
// expects: { type:'user', text, images } | { type:'assistant', uuid, blocks:[...] }.
// tool_result parts are merged into their matching tool_call card (same shape the
// jsonlReader produces for native Claude sessions).
function turnsToEntries(turns) {
  const entries = [];
  const toolBlockById = new Map();
  for (const turn of turns || []) {
    const parts = turn.parts || [];
    // A turn that carries ONLY tool_results is a continuation, not a new bubble:
    // fold the results into the cards already on screen.
    const onlyResults = parts.length > 0 && parts.every((p) => p.type === 'tool_result');
    if (turn.role === 'user' && !onlyResults) {
      const text = parts.filter((p) => p.type === 'text').map((p) => p.text).join('\n');
      const images = parts.filter((p) => p.type === 'image').map((p) => p.basename || '').filter(Boolean);
      if (text || images.length) entries.push({ type: 'user', text, images });
      continue;
    }
    if (onlyResults) {
      for (const p of parts) {
        const blk = toolBlockById.get(p.toolCallId);
        if (blk) blk.result = p.text || '';
      }
      continue;
    }
    if (turn.role === 'assistant') {
      const blocks = [];
      for (const p of parts) {
        if (p.type === 'text') blocks.push({ kind: 'text', text: p.text });
        else if (p.type === 'thinking') blocks.push({ kind: 'thinking', text: p.text });
        else if (p.type === 'tool_call') {
          const blk = { kind: 'tool', name: p.name || 'tool', title: p.display || p.name || '', result: null, artifacts: [] };
          if (p.id) toolBlockById.set(p.id, blk);
          blocks.push(blk);
        } else if (p.type === 'tool_result') {
          const blk = toolBlockById.get(p.toolCallId);
          if (blk) blk.result = p.text || '';
        }
      }
      // Which agent produced this turn — providerMeta is keyed by the runtime
      // (claude|codex) that ingested it. Used by the per-message footer.
      const agent = turn.providerMeta ? Object.keys(turn.providerMeta)[0] : '';
      if (blocks.length) {
        entries.push({
          type: 'assistant',
          uuid: turn.id,
          blocks,
          ts: turn.ts,
          agent,
          cancelled: !!turn.meta?.cancelled,
          incomplete: !!turn.meta?.incomplete,
        });
      }
    }
  }
  return entries;
}

// Snapshot for the `attach` response: normalized entries + the stored cwd.
function loadHistoryEntries(conversationId, cwd) {
  const t = store.load(conversationId, { cwd });
  return {
    entries: turnsToEntries(t.turns || []),
    directory: t.cwd || cwd || '',
    agent: (t.providerIds && Object.keys(t.providerIds)[0]) || '',
    selection: selectionForTranscript(t),
  };
}

function directoryFor(conversationId) {
  try {
    const t = store.load(conversationId, {});
    return t.cwd || '';
  } catch { return ''; }
}

// Run one shared turn with the chosen agent, emitting the reply as Claude-shaped
// stream events via onEvent so the existing live renderer paints it.
async function runSyncTurn({
  conversationId,
  agent,
  prompt,
  cwd,
  model,
  effort,
  imagePaths,
  processKey,
  onEvent,
  onCommit,
  isCancelled,
}) {
  let liveCount = 0;
  const res = await runTurn({
    conversationId,
    agent,
    prompt,
    cwd,
    model,
    effort,
    imagePaths,
    processKey,
    isCancelled,
    onLiveEvent: (event) => {
      liveCount += 1;
      if (typeof onEvent === 'function') onEvent(event);
    },
  });
  const committedToClient = typeof onCommit === 'function';
  if (committedToClient) {
    onCommit({ turns: res.turns || [], entries: turnsToEntries(res.turns || []), reply: res.reply || '' });
  }
  if (typeof onEvent === 'function') {
    // If a provider/runtime did not expose live events, preserve the old
    // post-run replay behavior as a fallback. Normal Claude/Codex v2 paths now
    // stream live and use turn_committed for the authoritative replacement.
    if (liveCount > 0 || committedToClient) {
      onEvent({ type: 'result', subtype: 'success', result: res.reply || '' });
      return res;
    }
    // Emit each canonical turn as Claude-shaped events so the live view shows
    // tool cards and thinking blocks, not just the final text. Assistant turns
    // become `assistant` events; tool-result user turns become `tool` events
    // that fill in the matching card's result pane.
    for (const turn of res.turns || []) {
      if (turn.role === 'assistant') {
        const content = [];
        for (const p of turn.parts || []) {
          if (p.type === 'text') content.push({ type: 'text', text: p.text });
          else if (p.type === 'thinking') content.push({ type: 'thinking', thinking: p.text });
          else if (p.type === 'tool_call') content.push({ type: 'tool_use', id: p.id, name: p.name || 'tool', input: p.input || {} });
        }
        if (content.length) onEvent({ type: 'assistant', message: { content } });
      } else if (turn.role === 'user') {
        for (const p of turn.parts || []) {
          if (p.type === 'tool_result') onEvent({ type: 'tool', tool_use_id: p.toolCallId, content: p.text || '' });
        }
      }
    }
    onEvent({ type: 'result', subtype: 'success', result: res.reply || '' });
  }
  return res;
}

module.exports = {
  PREFIX,
  isSyncId,
  newSyncId,
  turnsToEntries,
  loadHistoryEntries,
  directoryFor,
  runSyncTurn,
};
