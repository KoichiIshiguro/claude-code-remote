#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const compiler = require('./index');

function usage(exitCode = 1) {
  const out = exitCode ? console.error : console.log;
  out(`Usage:
  node codex-compiler/cli.js inspect --provider claude|codex --input in.jsonl
  node codex-compiler/cli.js claude-to-codex --input claude.jsonl --output codex.jsonl [--cwd path] [--session-id id]
  node codex-compiler/cli.js codex-to-claude --input codex.jsonl --output claude.jsonl [--cwd path] [--session-id id]
  node codex-compiler/cli.js to-canonical --provider claude|codex --input in.jsonl --output out.json`);
  process.exit(exitCode);
}

function args(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) out._.push(a);
    else out[a.slice(2)] = argv[++i];
  }
  return out;
}

function read(file) {
  if (!file) usage();
  return fs.readFileSync(file, 'utf8');
}

function write(file, text) {
  if (!file) usage();
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  fs.writeFileSync(file, text, 'utf8');
}

function toCanonical(provider, text, opts) {
  if (provider === 'claude') return compiler.claudeToCanonical(text, opts);
  if (provider === 'codex') return compiler.codexToCanonical(text, opts);
  throw new Error(`Unknown provider: ${provider}`);
}

function main() {
  const parsed = args(process.argv.slice(2));
  const cmd = parsed._[0];
  if (!cmd || parsed.help) usage(0);

  if (cmd === 'inspect') {
    const transcript = toCanonical(parsed.provider, read(parsed.input), parsed);
    console.log(JSON.stringify(compiler.transcriptSummary(transcript), null, 2));
    return;
  }

  if (cmd === 'to-canonical') {
    const transcript = toCanonical(parsed.provider, read(parsed.input), parsed);
    write(parsed.output, JSON.stringify(transcript, null, 2) + '\n');
    return;
  }

  if (cmd === 'claude-to-codex') {
    const transcript = compiler.claudeToCanonical(read(parsed.input), parsed);
    write(parsed.output, compiler.canonicalToCodex(transcript, {
      sessionId: parsed['session-id'],
      cwd: parsed.cwd,
    }));
    return;
  }

  if (cmd === 'codex-to-claude') {
    const transcript = compiler.codexToCanonical(read(parsed.input), parsed);
    write(parsed.output, compiler.canonicalToClaude(transcript, {
      sessionId: parsed['session-id'],
      cwd: parsed.cwd,
    }));
    return;
  }

  usage();
}

try {
  main();
} catch (err) {
  console.error(err.stack || err.message);
  process.exit(1);
}
