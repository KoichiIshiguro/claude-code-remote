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

test('Claude metadata and compact summaries survive canonical materialization', () => {
  const claudeWithMeta = [
    {
      parentUuid: null,
      type: 'user',
      isMeta: true,
      message: { role: 'user', content: '<local-command-caveat>do not answer</local-command-caveat>' },
      uuid: 'm1',
      timestamp: '2026-01-01T00:00:00.000Z',
      cwd: '/repo',
      sessionId: 'claude-session',
    },
    {
      parentUuid: 'm1',
      type: 'user',
      isCompactSummary: true,
      message: { role: 'user', content: 'Summary: previous implementation changed adapters.' },
      uuid: 'c1',
      timestamp: '2026-01-01T00:00:01.000Z',
      cwd: '/repo',
      sessionId: 'claude-session',
    },
    {
      parentUuid: 'c1',
      type: 'user',
      message: { role: 'user', content: 'Continue' },
      uuid: 'u1',
      timestamp: '2026-01-01T00:00:02.000Z',
      cwd: '/repo',
      sessionId: 'claude-session',
    },
  ].map(JSON.stringify).join('\n') + '\n';

  const canonical = compiler.claudeToCanonical(claudeWithMeta);
  assert.equal(canonical.turns.length, 1);
  assert.deepEqual(canonical.meta.contextItems.map((i) => i.kind), ['local_command', 'compact_summary']);

  const codexJsonl = compiler.canonicalToCodex(canonical, { sessionId: 'codex-mirror' });
  assert.match(codexJsonl, /<shared-agent-context>/);
  assert.match(codexJsonl, /Summary: previous implementation changed adapters/);
  assert.doesNotMatch(codexJsonl, /local-command-caveat/);

  const back = compiler.codexToCanonical(codexJsonl);
  assert.equal(back.turns.length, 1);
  assert.ok(back.meta.contextItems.some((i) => i.kind === 'bootstrap' && i.text.includes('compact_summary')));
});

test('Codex bootstrap, agent messages, and session meta survive canonical materialization', () => {
  const codexWithMeta = [
    {
      timestamp: '2026-01-01T00:00:00.000Z',
      type: 'session_meta',
      payload: {
        id: 'codex-session',
        timestamp: '2026-01-01T00:00:00.000Z',
        cwd: '/repo',
        cli_version: '0.test',
        base_instructions: { text: 'base instructions' },
      },
    },
    {
      timestamp: '2026-01-01T00:00:00.100Z',
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'developer',
        content: [{ type: 'input_text', text: 'developer-only resume context' }],
      },
    },
    {
      timestamp: '2026-01-01T00:00:00.200Z',
      type: 'event_msg',
      payload: { type: 'agent_message', message: 'progress: reading files' },
    },
    {
      timestamp: '2026-01-01T00:00:01.000Z',
      type: 'response_item',
      payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Continue' }] },
    },
  ].map(JSON.stringify).join('\n') + '\n';

  const canonical = compiler.codexToCanonical(codexWithMeta);
  assert.equal(canonical.turns.length, 1);
  assert.equal(canonical.meta.providerState.codex.sessionMeta.cli_version, '0.test');
  assert.ok(canonical.meta.contextItems.some((i) => i.kind === 'bootstrap' && i.text === 'developer-only resume context'));
  assert.ok(canonical.meta.contextItems.some((i) => i.kind === 'agent_message' && i.text === 'progress: reading files'));

  const claudeJsonl = compiler.canonicalToClaude(canonical, { sessionId: 'claude-mirror' });
  assert.match(claudeJsonl, /<shared-agent-context>/);
  assert.match(claudeJsonl, /developer-only resume context/);
  assert.match(claudeJsonl, /progress: reading files/);

  const back = compiler.claudeToCanonical(claudeJsonl);
  assert.equal(back.turns.length, 1);
  assert.ok(back.meta.contextItems.some((i) => i.kind === 'handoff'));
});
