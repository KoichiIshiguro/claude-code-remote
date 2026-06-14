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
  textFromContent,
} = require('./canonical');

function readJsonl(text) {
  return String(text || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function stringifyJsonl(entries) {
  return entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n';
}

function displayForTool(name, input) {
  if (!input || typeof input !== 'object') return name || 'tool';
  if (name === 'Bash') return input.command || name;
  if (input.file_path) return input.file_path;
  if (input.path) return input.path;
  return name || 'tool';
}

function claudeToCanonical(input, opts = {}) {
  const events = Array.isArray(input) ? input : readJsonl(input);
  let id = opts.id || '';
  let cwd = opts.cwd || '';
  let createdAt = '';
  let updatedAt = '';
  let title = '';
  const turns = [];

  for (const event of events) {
    if (!event || typeof event !== 'object') continue;
    if (event.sessionId && !id) id = event.sessionId;
    if (event.cwd && !cwd) cwd = event.cwd;
    if (event.timestamp && !createdAt) createdAt = event.timestamp;
    if (event.timestamp) updatedAt = event.timestamp;

    if (event.type === 'ai-title' && event.aiTitle) {
      title = String(event.aiTitle);
      continue;
    }

    if (event.type === 'user') {
      if (event.isMeta || event.isCompactSummary) continue;
      const content = event.message && event.message.content;
      if (Array.isArray(content) && content.some((part) => part && part.type === 'tool_result')) {
        for (const part of content) {
          if (!part || part.type !== 'tool_result') continue;
          let text = '';
          if (typeof part.content === 'string') text = part.content;
          else if (Array.isArray(part.content)) text = textFromContent(part.content) || JSON.stringify(part.content);
          else if (part.content != null) text = JSON.stringify(part.content);
          turns.push(makeTurn('user', [
            toolResultPart(part.tool_use_id, text, part.is_error),
          ], {
            id: event.uuid,
            ts: event.timestamp,
            providerMeta: { claude: event },
          }));
        }
        continue;
      }
      const text = textFromContent(content || event.message);
      if (!text) continue;
      turns.push(makeTurn('user', [textPart(text)], {
        id: event.uuid,
        ts: event.timestamp,
        providerMeta: { claude: event },
      }));
      continue;
    }

    if (event.type === 'assistant') {
      const parts = [];
      for (const part of event.message?.content || []) {
        if (!part) continue;
        if (part.type === 'text') parts.push(textPart(part.text));
        else if (part.type === 'thinking') parts.push(thinkingPart(part.thinking || part.text));
        else if (part.type === 'tool_use') {
          parts.push(toolCallPart(part.id, part.name, part.input, displayForTool(part.name, part.input)));
        }
      }
      if (!parts.length) continue;
      turns.push(makeTurn('assistant', parts, {
        id: event.uuid,
        ts: event.timestamp,
        providerMeta: { claude: event },
      }));
    }
  }

  return makeTranscript({
    id: id || opts.fallbackId || newId(),
    cwd,
    createdAt,
    updatedAt: updatedAt || createdAt,
    title,
    sourceProvider: 'claude',
    providerIds: { claude: id || '' },
    turns,
  });
}

function canonicalToClaude(transcript, opts = {}) {
  const sessionId = opts.sessionId || transcript.providerIds?.claude || transcript.id || newId();
  const cwd = opts.cwd || transcript.cwd || process.cwd();
  const version = opts.version || 'codex-compiler-prototype';
  const entries = [];
  let parentUuid = null;

  for (const turn of transcript.turns || []) {
    const uuid = turn.id || newId();
    const base = {
      parentUuid,
      isSidechain: false,
      uuid,
      timestamp: iso(turn.ts),
      userType: 'external',
      entrypoint: 'cli',
      cwd,
      sessionId,
      version,
    };

    if (turn.role === 'user') {
      const toolResults = (turn.parts || []).filter((part) => part.type === 'tool_result');
      const texts = (turn.parts || []).filter((part) => part.type === 'text').map((part) => part.text).filter(Boolean);
      if (toolResults.length) {
        entries.push({
          ...base,
          type: 'user',
          message: {
            role: 'user',
            content: toolResults.map((part) => ({
              type: 'tool_result',
              tool_use_id: part.toolCallId,
              content: part.text,
              is_error: !!part.isError,
            })),
          },
        });
      } else if (texts.length) {
        entries.push({
          ...base,
          type: 'user',
          message: { role: 'user', content: texts.join('\n') },
        });
      } else {
        continue;
      }
    } else if (turn.role === 'assistant') {
      const content = [];
      for (const part of turn.parts || []) {
        if (part.type === 'text') content.push({ type: 'text', text: part.text });
        else if (part.type === 'thinking') content.push({ type: 'thinking', thinking: part.text || '' });
        else if (part.type === 'tool_call') {
          content.push({
            type: 'tool_use',
            id: part.id || newId(),
            name: part.name || 'tool',
            input: part.input == null ? {} : part.input,
          });
        }
      }
      if (!content.length) continue;
      entries.push({
        ...base,
        type: 'assistant',
        requestId: `codex-compiler-${uuid}`,
        message: {
          id: `msg_${uuid.replace(/-/g, '').slice(0, 24)}`,
          type: 'message',
          role: 'assistant',
          model: opts.model || 'converted',
          content,
          stop_reason: null,
          stop_sequence: null,
          usage: {},
        },
      });
    } else {
      continue;
    }
    parentUuid = uuid;
  }

  if (transcript.title) {
    entries.push({ type: 'ai-title', aiTitle: transcript.title, sessionId });
  }
  return stringifyJsonl(entries);
}

function encodedClaudeCwd(absPath) {
  return String(absPath || '').replace(/[^a-zA-Z0-9]/g, '-');
}

function claudePathFor(homeDir, cwd, sessionId) {
  return path.join(homeDir, '.claude', 'projects', encodedClaudeCwd(cwd), `${sessionId}.jsonl`);
}

module.exports = {
  readJsonl,
  stringifyJsonl,
  claudeToCanonical,
  canonicalToClaude,
  encodedClaudeCwd,
  claudePathFor,
};
