'use strict';

const crypto = require('crypto');

function newId() {
  return crypto.randomUUID();
}

function iso(value) {
  if (!value) return new Date().toISOString();
  const d = value instanceof Date ? value : new Date(value);
  return Number.isFinite(d.getTime()) ? d.toISOString() : new Date().toISOString();
}

function textFromContent(content) {
  if (!content) return '';
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => {
      if (!part) return '';
      if (part.type === 'text' || part.type === 'input_text' || part.type === 'output_text') {
        return part.text || '';
      }
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

function stableHash(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function makeTranscript(attrs = {}) {
  const createdAt = iso(attrs.createdAt || attrs.timestamp);
  return {
    version: attrs.version || 2,
    id: attrs.id || newId(),
    cwd: attrs.cwd || '',
    createdAt,
    updatedAt: iso(attrs.updatedAt || createdAt),
    title: attrs.title || '',
    sourceProvider: attrs.sourceProvider || '',
    providerIds: attrs.providerIds || {},
    turns: Array.isArray(attrs.turns) ? attrs.turns : [],
    // Provider-neutral metadata that is not a normal visible chat turn but may
    // matter when materializing a synthetic native session for another agent.
    //
    // Shape:
    //   {
    //     contextItems: [
    //       { id, provider, kind, role, ts, text, private, raw }
    //     ],
    //     providerState: { claude: {...}, codex: {...} },
    //     selection: {...} // used by the main app
    //   }
    meta: attrs.meta && typeof attrs.meta === 'object' ? attrs.meta : {},
  };
}

function makeTurn(role, parts, attrs = {}) {
  return {
    id: attrs.id || newId(),
    role,
    ts: iso(attrs.ts || attrs.timestamp),
    parts: Array.isArray(parts) ? parts.filter(Boolean) : [],
    providerMeta: attrs.providerMeta || {},
  };
}

function textPart(text) {
  return text ? { type: 'text', text: String(text) } : null;
}

function thinkingPart(text, isPrivate = true) {
  return text ? { type: 'thinking', text: String(text), private: !!isPrivate } : null;
}

function toolCallPart(id, name, input, display) {
  return {
    type: 'tool_call',
    id: id || newId(),
    name: name || 'tool',
    input: input == null ? {} : input,
    display: display || name || 'tool',
  };
}

function toolResultPart(toolCallId, text, isError = false) {
  return {
    type: 'tool_result',
    toolCallId: toolCallId || '',
    text: text == null ? '' : String(text),
    isError: !!isError,
  };
}

function contextItem(provider, kind, text, attrs = {}) {
  return {
    id: attrs.id || newId(),
    provider: provider || attrs.provider || '',
    kind: kind || attrs.kind || 'metadata',
    role: attrs.role || '',
    ts: iso(attrs.ts || attrs.timestamp),
    text: text == null ? '' : String(text),
    private: attrs.private !== undefined ? !!attrs.private : true,
    raw: attrs.raw,
  };
}

function appendContextItem(meta, item) {
  if (!item) return meta && typeof meta === 'object' ? meta : {};
  const out = meta && typeof meta === 'object' ? { ...meta } : {};
  const list = Array.isArray(out.contextItems) ? out.contextItems.slice() : [];
  list.push(item);
  out.contextItems = list;
  return out;
}

function setProviderState(meta, provider, state) {
  const out = meta && typeof meta === 'object' ? { ...meta } : {};
  const providerState = out.providerState && typeof out.providerState === 'object'
    ? { ...out.providerState }
    : {};
  providerState[provider] = {
    ...(providerState[provider] && typeof providerState[provider] === 'object' ? providerState[provider] : {}),
    ...(state && typeof state === 'object' ? state : {}),
  };
  out.providerState = providerState;
  return out;
}

function contextText(transcript, opts = {}) {
  const items = transcript && transcript.meta && Array.isArray(transcript.meta.contextItems)
    ? transcript.meta.contextItems
    : [];
  const allowedKinds = new Set(opts.kinds || [
    'system',
    'bootstrap',
    'compact_summary',
    'summary',
    'agent_message',
    'handoff',
    'task_state',
  ]);
  const chunks = [];
  for (const item of items) {
    if (!item || !allowedKinds.has(item.kind)) continue;
    const text = String(item.text || '').trim();
    if (!text) continue;
    const label = [item.provider, item.kind].filter(Boolean).join(':');
    chunks.push(label ? `### ${label}\n${text}` : text);
  }
  if (!chunks.length) return '';
  return [
    'The following provider-neutral context was preserved from non-visible or provider-specific session metadata.',
    'Use it only as background for continuing this shared conversation.',
    '',
    chunks.join('\n\n'),
  ].join('\n');
}

function visibleText(turn) {
  return (turn.parts || [])
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('\n');
}

function transcriptSummary(transcript) {
  const turns = transcript.turns || [];
  const firstUser = turns.find((turn) => turn.role === 'user' && visibleText(turn));
  const last = turns[turns.length - 1];
  return {
    id: transcript.id,
    cwd: transcript.cwd,
    title: transcript.title || (firstUser ? visibleText(firstUser).slice(0, 80) : ''),
    turns: turns.length,
    updatedAt: last ? last.ts : transcript.updatedAt,
    hash: stableHash(transcript),
  };
}

module.exports = {
  iso,
  newId,
  stableHash,
  textFromContent,
  makeTranscript,
  makeTurn,
  textPart,
  thinkingPart,
  toolCallPart,
  toolResultPart,
  contextItem,
  appendContextItem,
  setProviderState,
  contextText,
  visibleText,
  transcriptSummary,
};
