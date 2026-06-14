#!/usr/bin/env node
'use strict';

// Symmetric keystone driver: build a tiny canonical conversation as if Codex
// produced it, materialize it into a Claude Code projects dir as a resumable
// jsonl, and print the session id so a caller can run
// `claude --resume <id> -p "..."` (from <cwd>) and confirm the converted
// Codex-origin context is visible to Claude.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const compiler = require('../codex-compiler');
const { claudePathFor } = require('../codex-compiler/claude-adapter');
const { makeTranscript, makeTurn, textPart } = require('../codex-compiler/canonical');

const home = process.env.CLAUDE_HOME_DIR || require('os').homedir();
const cwd = process.argv[2] || process.cwd();
const secret = process.argv[3] || 'DELTA-77';
const sessionId = crypto.randomUUID();

const transcript = makeTranscript({
  id: sessionId,
  cwd,
  sourceProvider: 'codex',
  providerIds: { codex: sessionId },
  title: 'keystone resume test (codex->claude)',
  turns: [
    makeTurn('user', [textPart(
      `私の合言葉は ${secret} です。あとで聞くので覚えておいてください。`,
    )], { ts: '2026-06-14T04:00:00.000Z' }),
    makeTurn('assistant', [textPart(
      `承知しました。あなたの合言葉は ${secret} ですね。覚えておきます。`,
    )], { ts: '2026-06-14T04:00:01.000Z' }),
  ],
});

const jsonl = compiler.canonicalToClaude(transcript, { sessionId, cwd });
const outPath = claudePathFor(home, cwd, sessionId);
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, jsonl, 'utf8');

console.log(JSON.stringify({ sessionId, secret, cwd, jsonl: outPath }, null, 2));
