'use strict';

const path = require('path');
const {
  iso,
  newId,
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
  textFromContent,
} = require('./canonical');
const { readJsonl, stringifyJsonl } = require('./claude-adapter');

function parseArguments(raw) {
  if (raw == null || raw === '') return {};
  if (typeof raw !== 'string') return raw;
  try { return JSON.parse(raw); }
  catch { return { raw }; }
}

function outputText(output) {
  if (output == null) return '';
  if (typeof output === 'string') return output;
  return JSON.stringify(output);
}

function payloadText(payload) {
  if (!payload || typeof payload !== 'object') return '';
  if (typeof payload.message === 'string') return payload.message;
  if (typeof payload.content === 'string') return payload.content;
  if (Array.isArray(payload.content)) return textFromContent(payload.content);
  if (payload.summary) {
    if (typeof payload.summary === 'string') return payload.summary;
    if (Array.isArray(payload.summary)) {
      return payload.summary.map((s) => s && (s.text || s.content || '')).filter(Boolean).join('\n');
    }
  }
  return '';
}

function isBootstrapMessage(payload) {
  if (!payload || payload.type !== 'message') return false;
  if (payload.role === 'developer' || payload.role === 'system') return true;
  if (payload.role !== 'user') return false;
  const text = textFromContent(payload.content).trim();
  return text.startsWith('<environment_context>')
    || text.startsWith('<permissions instructions>')
    || text.startsWith('<app-context>')
    || text.startsWith('# AGENTS.md instructions');
}

function codexToCanonical(input, opts = {}) {
  const events = Array.isArray(input) ? input : readJsonl(input);
  let id = opts.id || '';
  let cwd = opts.cwd || '';
  let createdAt = '';
  let updatedAt = '';
  const turns = [];
  const seenUserMessages = new Set();
  let meta = {};

  for (const event of events) {
    if (!event || typeof event !== 'object') continue;
    if (event.timestamp && !createdAt) createdAt = event.timestamp;
    if (event.timestamp) updatedAt = event.timestamp;

    if (event.type === 'session_meta') {
      const payload = event.payload || {};
      id = id || payload.id || '';
      cwd = cwd || payload.cwd || '';
      createdAt = createdAt || payload.timestamp || event.timestamp;
      meta = setProviderState(meta, 'codex', {
        sessionMeta: payload,
        baseInstructions: payload.base_instructions,
        modelProvider: payload.model_provider,
        cliVersion: payload.cli_version,
        threadSource: payload.thread_source,
      });
      continue;
    }

    if (event.type === 'response_item') {
      const payload = event.payload || {};
      if (isBootstrapMessage(payload)) {
        meta = appendContextItem(meta, contextItem('codex', 'bootstrap', payloadText(payload), {
          ts: event.timestamp,
          role: payload.role || '',
          raw: event,
        }));
        continue;
      }

      if (payload.type === 'message') {
        const text = textFromContent(payload.content);
        if (!text) continue;
        if (payload.role === 'user') {
          seenUserMessages.add(text);
          turns.push(makeTurn('user', [textPart(text)], {
            ts: event.timestamp,
            providerMeta: { codex: event },
          }));
        } else if (payload.role === 'assistant') {
          const parts = [];
          for (const part of payload.content || []) {
            if (!part) continue;
            if (part.type === 'output_text' || part.type === 'text') parts.push(textPart(part.text));
          }
          if (parts.length) {
            turns.push(makeTurn('assistant', parts, {
              ts: event.timestamp,
              providerMeta: { codex: event },
            }));
          }
        }
        continue;
      }

      if (payload.type === 'reasoning') {
        const text = payloadText(payload);
        if (text) {
          turns.push(makeTurn('assistant', [thinkingPart(text)], {
            ts: event.timestamp,
            providerMeta: { codex: event },
          }));
        } else {
          meta = appendContextItem(meta, contextItem('codex', 'reasoning', '', {
            ts: event.timestamp,
            role: 'assistant',
            raw: event,
          }));
        }
        continue;
      }

      if (payload.type === 'function_call') {
        turns.push(makeTurn('assistant', [
          toolCallPart(payload.call_id, payload.name, parseArguments(payload.arguments), payload.name),
        ], {
          ts: event.timestamp,
          providerMeta: { codex: event },
        }));
        continue;
      }

      if (payload.type === 'function_call_output') {
        turns.push(makeTurn('user', [
          toolResultPart(payload.call_id, outputText(payload.output), false),
        ], {
          ts: event.timestamp,
          providerMeta: { codex: event },
        }));
      }
      continue;
    }

    if (event.type === 'event_msg') {
      if (event.payload?.type === 'user_message') {
        const text = event.payload.message || '';
        if (text && !seenUserMessages.has(text)) {
          seenUserMessages.add(text);
          turns.push(makeTurn('user', [textPart(text)], {
            ts: event.timestamp,
            providerMeta: { codex: event },
          }));
        }
        continue;
      }
      if (event.payload?.type === 'agent_message') {
        meta = appendContextItem(meta, contextItem('codex', 'agent_message', event.payload.message || '', {
          ts: event.timestamp,
          role: 'assistant',
          raw: event,
        }));
        continue;
      }
    }

    meta = appendContextItem(meta, contextItem('codex', event.type || 'unknown_event', payloadText(event.payload), {
      ts: event.timestamp,
      raw: event,
    }));
  }

  return makeTranscript({
    id: id || opts.fallbackId || newId(),
    cwd,
    createdAt,
    updatedAt: updatedAt || createdAt,
    title: opts.title || '',
    sourceProvider: 'codex',
    providerIds: { codex: id || '' },
    turns,
    meta,
  });
}

function contentForText(role, text) {
  return [{ type: role === 'assistant' ? 'output_text' : 'input_text', text }];
}

function canonicalToCodex(transcript, opts = {}) {
  const id = opts.sessionId || transcript.providerIds?.codex || transcript.id || newId();
  const cwd = opts.cwd || transcript.cwd || process.cwd();
  const createdAt = iso(transcript.createdAt);
  // Codex 0.139.0 strictly deserializes the first line as SessionMeta and
  // rejects the whole rollout ("does not start with session metadata") if it
  // fails. Two non-obvious requirements, reverse-engineered against a real
  // codex-tui session: `thread_source` must be a known enum value (`"user"` —
  // NOT a custom marker like `"converted"`), and `base_instructions.text` must
  // be present and non-empty. `git` is optional. See history-sync keystone test.
  const entries = [{
    timestamp: createdAt,
    type: 'session_meta',
    payload: {
      id,
      timestamp: createdAt,
      cwd,
      originator: opts.originator || 'claude-code-remote',
      cli_version: opts.cliVersion || 'codex-compiler-prototype',
      source: 'cli',
      thread_source: 'user',
      model_provider: 'openai',
      base_instructions: {
        text: opts.baseInstructions
          || 'You are Codex. Continue this shared conversation, which was '
            + 'imported from another coding agent. Earlier turns may reference '
            + 'tools or context produced outside this session.',
      },
    },
  }];

  const preservedContext = contextText(transcript);
  if (preservedContext) {
    entries.push({
      timestamp: createdAt,
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'developer',
        content: [{
          type: 'input_text',
          text: `<shared-agent-context>\n${preservedContext}\n</shared-agent-context>`,
        }],
      },
    });
  }

  for (const turn of transcript.turns || []) {
    const ts = iso(turn.ts);
    if (turn.role === 'user') {
      const toolResults = (turn.parts || []).filter((part) => part.type === 'tool_result');
      const texts = (turn.parts || []).filter((part) => part.type === 'text').map((part) => part.text).filter(Boolean);
      for (const text of texts) {
        entries.push({
          timestamp: ts,
          type: 'response_item',
          payload: { type: 'message', role: 'user', content: contentForText('user', text) },
        });
        entries.push({
          timestamp: ts,
          type: 'event_msg',
          payload: { type: 'user_message', message: text, images: [], local_images: [], text_elements: [] },
        });
      }
      for (const part of toolResults) {
        entries.push({
          timestamp: ts,
          type: 'response_item',
          payload: { type: 'function_call_output', call_id: part.toolCallId, output: part.text },
        });
      }
      continue;
    }

    if (turn.role !== 'assistant') continue;
    const text = (turn.parts || []).filter((part) => part.type === 'text').map((part) => part.text).filter(Boolean).join('\n');
    if (text) {
      entries.push({
        timestamp: ts,
        type: 'response_item',
        payload: { type: 'message', role: 'assistant', content: contentForText('assistant', text) },
      });
    }
    for (const part of turn.parts || []) {
      if (part.type !== 'tool_call') continue;
      entries.push({
        timestamp: ts,
        type: 'response_item',
        payload: {
          type: 'function_call',
          name: part.name,
          arguments: JSON.stringify(part.input == null ? {} : part.input),
          call_id: part.id,
        },
      });
    }
  }

  return stringifyJsonl(entries);
}

function codexPathFor(codexHome, transcript, sessionId) {
  const id = sessionId || transcript.providerIds?.codex || transcript.id;
  const d = new Date(transcript.createdAt || Date.now());
  const yyyy = String(d.getFullYear());
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const stamp = d.toISOString().replace(/\.\d{3}Z$/, '').replace(/:/g, '-');
  return path.join(codexHome, 'sessions', yyyy, mm, dd, `rollout-${stamp}-${id}.jsonl`);
}

function sessionIndexLine(transcript, sessionId) {
  return JSON.stringify({
    id: sessionId || transcript.providerIds?.codex || transcript.id,
    thread_name: transcript.title || '',
    updated_at: iso(transcript.updatedAt),
  }) + '\n';
}

module.exports = {
  codexToCanonical,
  canonicalToCodex,
  codexPathFor,
  sessionIndexLine,
};
