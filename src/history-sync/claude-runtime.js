'use strict';

// Claude runtime for history-sync — symmetric to codex-runtime. Materializes
// the shared canonical conversation into a disposable Claude jsonl under the
// projects dir, resumes Claude on it non-interactively, and ingests the newly
// appended turns back into canonical. Claude `--resume <id>` (without
// --fork-session) continues the same session id and appends to the same jsonl,
// so the delta is the tail beyond the lines we wrote. See [[history-sync-keystone]].

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const compiler = require('../../codex-compiler');
const { claudePathFor } = require('../../codex-compiler/claude-adapter');
const { sandboxed } = require('../sandbox');

function defaultClaudeHome() {
  // Claude auth is bound to the real ~/.claude (keychain + credentials), so we
  // materialize there rather than into a relocated dir. CLAUDE_CONFIG_DIR would
  // relocate storage but breaks auth.
  return process.env.CLAUDE_HOME_DIR || os.homedir();
}

function materialize(transcript, opts = {}) {
  const home = opts.home || defaultClaudeHome();
  // Claude derives its projects-dir name from the *real* (symlink-resolved) cwd,
  // so canonicalize here. Otherwise a symlinked workdir (e.g. /tmp → /private/tmp)
  // makes us read the jsonl at the un-resolved path while claude wrote it under
  // the resolved one → ENOENT on ingest.
  let cwd = opts.cwd || transcript.cwd || process.cwd();
  try { cwd = fs.realpathSync(cwd); } catch { /* keep as-is if it can't be resolved */ }
  const sessionId = crypto.randomUUID();
  const hasHistory = (transcript.turns || []).length > 0;
  const jsonlPath = claudePathFor(home, cwd, sessionId);
  // First turn: nothing to resume, so DON'T pre-write an (empty) jsonl — claude
  // `--resume` on an empty file fails with "No conversation found". Instead we run
  // fresh with `--session-id` (see run/turn) and let claude create the jsonl.
  let origLineCount = 0;
  if (hasHistory) {
    const jsonl = compiler.canonicalToClaude(transcript, { sessionId, cwd });
    fs.mkdirSync(path.dirname(jsonlPath), { recursive: true });
    fs.writeFileSync(jsonlPath, jsonl, 'utf8');
    origLineCount = jsonl.trim() ? jsonl.trim().split('\n').length : 0;
  }
  return { sessionId, jsonlPath, origLineCount, home, cwd, hasHistory };
}

function run({ cwd, sessionId, prompt, model, resume = true }) {
  return new Promise((resolve, reject) => {
    // First turn of a shared conversation has nothing to resume — create the
    // session fresh under our chosen id (so its jsonl lands at the known path we
    // ingest). Later turns resume the materialized jsonl.
    const args = resume
      ? ['--resume', sessionId, '-p', prompt]
      : ['--session-id', sessionId, '-p', prompt];
    args.push('--dangerously-skip-permissions');
    if (model) args.push('--model', model);
    // Confine writes to the project dir (+ ~/.claude, caches, temp) with the same
    // Seatbelt the native path uses. claude materializes/appends its jsonl under
    // ~/.claude, already covered by the profile.
    const claudeBin = process.env.CLAUDE_PATH || 'claude';
    const [bin, spawnArgs] = sandboxed(claudeBin, args, cwd);
    const child = spawn(bin, spawnArgs, {
      cwd,
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve({ stdout: out, stderr: err });
      else reject(new Error(`claude exited ${code}: ${err || out}`));
    });
  });
}

function ingestDelta(transcript, jsonlPath, origLineCount) {
  const lines = fs.readFileSync(jsonlPath, 'utf8').split('\n');
  const tail = lines.slice(origLineCount).filter((l) => l.trim());
  if (!tail.length) return [];
  const delta = compiler.claudeToCanonical(tail.join('\n'));
  transcript.turns.push(...delta.turns);
  transcript.updatedAt = delta.updatedAt || transcript.updatedAt;
  return delta.turns;
}

async function turn(transcript, prompt, opts = {}) {
  const mat = materialize(transcript, opts);
  let runError = null;
  try {
    await run({ cwd: mat.cwd, sessionId: mat.sessionId, prompt, model: opts.model, resume: mat.hasHistory });
  } catch (err) {
    runError = err;
  }
  // Always attempt to ingest whatever Claude wrote, even on non-zero exit — Claude
  // writes turns (tool calls, assistant response) before failing, and discarding
  // them silently on any non-zero exit loses history entirely (session looks empty
  // after reload even though the work was done).
  let added = [];
  if (fs.existsSync(mat.jsonlPath)) {
    try {
      added = ingestDelta(transcript, mat.jsonlPath, mat.origLineCount);
    } catch { /* malformed jsonl: prefer original run error if any */ }
  }
  // Re-throw only if we got nothing useful — a true startup/auth failure with no
  // jsonl written is still a hard error that should surface to the caller.
  if (runError && !added.length) throw runError;
  transcript.providerIds = { ...transcript.providerIds, claude: mat.sessionId };
  if (opts.keepArtifacts !== true) {
    try { fs.unlinkSync(mat.jsonlPath); } catch { /* best effort */ }
  }
  return { added, sessionId: mat.sessionId };
}

module.exports = { materialize, run, ingestDelta, turn, defaultClaudeHome };
