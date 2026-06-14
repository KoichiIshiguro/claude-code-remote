#!/usr/bin/env node
'use strict';

// Keystone de-risk driver (milestone 0 of history-sync).
//
// Builds a tiny provider-neutral canonical conversation, materializes it into a
// Codex CODEX_HOME as a resumable rollout, and prints the session id so a
// caller can run `codex exec resume <id> "..."` and confirm the converted
// Claude-origin context is actually visible to Codex.
//
// This is intentionally a throwaway harness around codex-compiler; the real
// materializer will live behind a narrow adapter once the round trip is proven.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const compiler = require('../codex-compiler');
const { codexPathFor, sessionIndexLine } = require('../codex-compiler/codex-adapter');
const {
  makeTranscript,
  makeTurn,
  textPart,
} = require('../codex-compiler/canonical');

const CODEX_HOME = process.env.CODEX_HOME
  || path.join(__dirname, '..', 'data', 'codex-home');
const cwd = process.argv[2] || process.cwd();
const secret = process.argv[3] || '7937';
const sessionId = crypto.randomUUID();

// A canonical conversation as if Claude Code produced it. The assistant turn
// commits the secret to "memory" so a later Codex resume can be probed for it.
const transcript = makeTranscript({
  id: sessionId,
  cwd,
  sourceProvider: 'claude',
  providerIds: { claude: sessionId },
  title: 'keystone resume test',
  turns: [
    makeTurn('user', [textPart(
      `私の好きな数字は ${secret} です。あとで聞くので覚えておいてください。`,
    )], { ts: '2026-06-14T04:00:00.000Z' }),
    makeTurn('assistant', [textPart(
      `承知しました。あなたの好きな数字は ${secret} ですね。覚えておきます。`,
    )], { ts: '2026-06-14T04:00:01.000Z' }),
  ],
});

const codexJsonl = compiler.canonicalToCodex(transcript, { sessionId, cwd });
const outPath = codexPathFor(CODEX_HOME, transcript, sessionId);
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, codexJsonl, 'utf8');
fs.appendFileSync(
  path.join(CODEX_HOME, 'session_index.jsonl'),
  sessionIndexLine(transcript, sessionId),
  'utf8',
);

console.log(JSON.stringify({
  sessionId,
  secret,
  cwd,
  codexHome: CODEX_HOME,
  rollout: outPath,
}, null, 2));
