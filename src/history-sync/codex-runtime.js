'use strict';

// Codex runtime for history-sync: materialize the canonical conversation into a
// disposable rollout, resume Codex on it, and ingest only the newly-appended
// turns back into canonical. Codex `exec resume` APPENDS to the same rollout
// file (verified on 0.139.0), so the delta is exactly the tail beyond the lines
// we wrote. See [[history-sync-keystone]].

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const compiler = require('../../codex-compiler');
const { codexPathFor } = require('../../codex-compiler/codex-adapter');

function defaultCodexHome() {
  return process.env.CODEX_HOME
    || path.join(__dirname, '..', '..', 'data', 'codex-home');
}

function materialize(transcript, opts = {}) {
  const codexHome = opts.codexHome || defaultCodexHome();
  const cwd = opts.cwd || transcript.cwd || process.cwd();
  const sessionId = crypto.randomUUID();
  const jsonl = compiler.canonicalToCodex(transcript, {
    sessionId,
    cwd,
    baseInstructions: opts.baseInstructions,
  });
  const rolloutPath = codexPathFor(codexHome, transcript, sessionId);
  fs.mkdirSync(path.dirname(rolloutPath), { recursive: true });
  fs.writeFileSync(rolloutPath, jsonl, 'utf8');
  const origLineCount = jsonl.trim().split('\n').length;
  return { sessionId, rolloutPath, origLineCount, codexHome, cwd };
}

function run({ codexHome, cwd, sessionId, prompt, sandbox = 'read-only' }) {
  return new Promise((resolve, reject) => {
    const args = [
      'exec',
      '-s', sandbox,
      '-C', cwd,
      '-c', `projects.${JSON.stringify(cwd)}.trust_level="trusted"`,
      'resume', sessionId, prompt,
    ];
    // Codex self-sandboxes; the host must NOT nest it under another sandbox.
    const child = spawn('codex', args, {
      cwd,
      env: { ...process.env, CODEX_HOME: codexHome, CODEX_SANDBOX_MODE: 'danger-full-access' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve({ stdout: out, stderr: err });
      else reject(new Error(`codex exec exited ${code}: ${err || out}`));
    });
  });
}

function ingestDelta(transcript, rolloutPath, origLineCount) {
  const lines = fs.readFileSync(rolloutPath, 'utf8').split('\n');
  const tail = lines.slice(origLineCount).filter((l) => l.trim());
  if (!tail.length) return [];
  const delta = compiler.codexToCanonical(tail.join('\n'));
  transcript.turns.push(...delta.turns);
  transcript.updatedAt = delta.updatedAt || transcript.updatedAt;
  return delta.turns;
}

// One full Codex turn against the shared canonical conversation.
async function turn(transcript, prompt, opts = {}) {
  const mat = materialize(transcript, opts);
  await run({
    codexHome: mat.codexHome,
    cwd: mat.cwd,
    sessionId: mat.sessionId,
    prompt,
    sandbox: opts.sandbox,
  });
  const added = ingestDelta(transcript, mat.rolloutPath, mat.origLineCount);
  transcript.providerIds = { ...transcript.providerIds, codex: mat.sessionId };
  // Throwaway artifact: the rollout was just a materialization vehicle.
  if (opts.keepArtifacts !== true) {
    try { fs.unlinkSync(mat.rolloutPath); } catch { /* best effort */ }
  }
  return { added, sessionId: mat.sessionId };
}

module.exports = { materialize, run, ingestDelta, turn, defaultCodexHome };
