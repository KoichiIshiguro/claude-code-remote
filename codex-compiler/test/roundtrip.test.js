'use strict';

const assert = require('assert');
const test = require('node:test');
const compiler = require('../index');

const claudeFixture = [
  {
    parentUuid: null,
    type: 'user',
    message: { role: 'user', content: 'Build a small app' },
    uuid: 'u1',
    timestamp: '2026-01-01T00:00:00.000Z',
    cwd: '/repo',
    sessionId: 'claude-session',
  },
  {
    parentUuid: 'u1',
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [
        { type: 'text', text: 'I will inspect the repo.' },
        { type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'ls' } },
      ],
    },
    uuid: 'a1',
    timestamp: '2026-01-01T00:00:01.000Z',
    cwd: '/repo',
    sessionId: 'claude-session',
  },
  {
    parentUuid: 'a1',
    type: 'user',
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'package.json' }],
    },
    uuid: 'tr1',
    timestamp: '2026-01-01T00:00:02.000Z',
    cwd: '/repo',
    sessionId: 'claude-session',
  },
  { type: 'ai-title', aiTitle: 'Build app', sessionId: 'claude-session' },
].map(JSON.stringify).join('\n') + '\n';

const codexFixture = [
  {
    timestamp: '2026-01-01T00:00:00.000Z',
    type: 'session_meta',
    payload: { id: 'codex-session', timestamp: '2026-01-01T00:00:00.000Z', cwd: '/repo' },
  },
  {
    timestamp: '2026-01-01T00:00:00.100Z',
    type: 'response_item',
    payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Build a small app' }] },
  },
  {
    timestamp: '2026-01-01T00:00:01.000Z',
    type: 'response_item',
    payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'I will inspect the repo.' }] },
  },
  {
    timestamp: '2026-01-01T00:00:01.100Z',
    type: 'response_item',
    payload: { type: 'function_call', name: 'exec_command', arguments: '{"cmd":"ls"}', call_id: 'call-1' },
  },
  {
    timestamp: '2026-01-01T00:00:02.000Z',
    type: 'response_item',
    payload: { type: 'function_call_output', call_id: 'call-1', output: 'package.json' },
  },
].map(JSON.stringify).join('\n') + '\n';

test('Claude JSONL converts to canonical turns', () => {
  const transcript = compiler.claudeToCanonical(claudeFixture);
  assert.equal(transcript.id, 'claude-session');
  assert.equal(transcript.cwd, '/repo');
  assert.equal(transcript.title, 'Build app');
  assert.equal(transcript.turns.length, 3);
  assert.equal(transcript.turns[1].parts[1].type, 'tool_call');
  assert.equal(transcript.turns[2].parts[0].type, 'tool_result');
});

test('Codex JSONL converts to canonical turns', () => {
  const transcript = compiler.codexToCanonical(codexFixture);
  assert.equal(transcript.id, 'codex-session');
  assert.equal(transcript.cwd, '/repo');
  assert.equal(transcript.turns.length, 4);
  assert.equal(transcript.turns[2].parts[0].type, 'tool_call');
  assert.equal(transcript.turns[3].parts[0].type, 'tool_result');
});

test('Claude -> Codex -> canonical preserves visible conversation', () => {
  const fromClaude = compiler.claudeToCanonical(claudeFixture);
  const codexJsonl = compiler.canonicalToCodex(fromClaude, { sessionId: 'codex-mirror' });
  const fromCodex = compiler.codexToCanonical(codexJsonl);
  assert.equal(fromCodex.turns[0].parts[0].text, 'Build a small app');
  assert.equal(fromCodex.turns[1].parts[0].text, 'I will inspect the repo.');
  assert.equal(fromCodex.turns[2].parts[0].type, 'tool_call');
  assert.equal(fromCodex.turns[3].parts[0].text, 'package.json');
});

test('Codex -> Claude -> canonical preserves visible conversation', () => {
  const fromCodex = compiler.codexToCanonical(codexFixture);
  const claudeJsonl = compiler.canonicalToClaude(fromCodex, { sessionId: 'claude-mirror' });
  const fromClaude = compiler.claudeToCanonical(claudeJsonl);
  assert.equal(fromClaude.turns[0].parts[0].text, 'Build a small app');
  assert.equal(fromClaude.turns[1].parts[0].text, 'I will inspect the repo.');
  assert.equal(fromClaude.turns[2].parts[0].type, 'tool_call');
  assert.equal(fromClaude.turns[3].parts[0].text, 'package.json');
});
