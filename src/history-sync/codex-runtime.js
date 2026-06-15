'use strict';

// Codex runtime for history-sync: materialize the canonical conversation into a
// disposable rollout, resume Codex on it, and ingest only the newly-appended
// turns back into canonical. Codex `exec resume` APPENDS to the same rollout
// file (verified on 0.139.0), so the delta is exactly the tail beyond the lines
// we wrote. See [[history-sync-keystone]].

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn, execFileSync } = require('child_process');
const compiler = require('../../codex-compiler');
const { codexPathFor } = require('../../codex-compiler/codex-adapter');
const { sandboxed } = require('../session-manager');
const procTracker = require('../proc-tracker');

function parseArguments(raw) {
  if (raw == null || raw === '') return {};
  if (typeof raw !== 'string') return raw;
  try { return JSON.parse(raw); } catch { return { raw }; }
}

function textFromContent(content) {
  if (!content) return '';
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => {
      if (!part) return '';
      if (part.type === 'output_text' || part.type === 'text' || part.type === 'input_text') return part.text || '';
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

function payloadText(payload) {
  if (!payload || typeof payload !== 'object') return '';
  if (typeof payload.message === 'string') return payload.message;
  if (typeof payload.content === 'string') return payload.content;
  if (Array.isArray(payload.content)) return textFromContent(payload.content);
  if (payload.summary) {
    if (typeof payload.summary === 'string') return payload.summary;
    if (Array.isArray(payload.summary)) return payload.summary.map((s) => s && (s.text || s.content || '')).filter(Boolean).join('\n');
  }
  return '';
}

// Codex `exec --json` emits runtime events, not persisted rollout entries.
// Convert only the displayable subset to the Claude-shaped stream events the UI
// already understands; persisted canonical ingest still comes from rollout tail.
function codexLiveEventToClaudeShape(event) {
  if (!event || typeof event !== 'object') return null;
  if (event.type === 'response_item') {
    const payload = event.payload || {};
    if (payload.type === 'message' && payload.role === 'assistant') {
      const text = textFromContent(payload.content);
      return text ? { type: 'assistant', message: { content: [{ type: 'text', text }] } } : null;
    }
    if (payload.type === 'reasoning') {
      const text = payloadText(payload);
      return text ? { type: 'assistant', message: { content: [{ type: 'thinking', thinking: text }] } } : null;
    }
    if (payload.type === 'function_call') {
      return {
        type: 'assistant',
        message: { content: [{ type: 'tool_use', id: payload.call_id, name: payload.name || 'tool', input: parseArguments(payload.arguments) }] },
      };
    }
    if (payload.type === 'function_call_output') {
      const output = payload.output == null
        ? ''
        : (typeof payload.output === 'string' ? payload.output : JSON.stringify(payload.output));
      return { type: 'tool', tool_use_id: payload.call_id, content: output };
    }
  }
  if (event.type === 'event_msg' && event.payload?.type === 'agent_message') {
    const text = event.payload.message || '';
    return text ? { type: 'assistant', message: { content: [{ type: 'text', text }] } } : null;
  }
  return null;
}

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

// Codex exec refuses to run outside a trusted git repo. Rather than passing
// --skip-git-repo-check (which leaves the dir un-versioned and the user's edits
// without a safety net), we make the project dir a real repo if it isn't one.
// Idempotent: `git init` on an existing repo is a no-op.
function ensureGitRepo(cwd) {
  try {
    execFileSync('git', ['rev-parse', '--is-inside-work-tree'], {
      cwd, stdio: 'ignore',
    });
    return; // already inside a work tree
  } catch { /* not a repo — init below */ }
  try {
    execFileSync('git', ['init'], { cwd, stdio: 'ignore' });
  } catch { /* best effort; codex will surface its own error if this failed */ }
}

// The app runs codex against a dedicated CODEX_HOME (data/codex-home) that is
// rebuilt/relocated independently of the user's personal ~/.codex. Codex reads
// its credentials from <CODEX_HOME>/auth.json, so without this the first turn
// after a codex-home rebuild dies with `401 Unauthorized: Missing bearer`. We
// symlink (not copy) the user's real ~/.codex/auth.json in, so token refreshes
// there are picked up automatically. Best-effort and idempotent: if auth.json
// already exists (or the source is missing) we leave it alone and let codex
// surface its own auth error.
function ensureCodexAuth(codexHome) {
  try {
    const dest = path.join(codexHome, 'auth.json');
    if (fs.existsSync(dest)) return; // already present (file or live symlink)
    const src = path.join(os.homedir(), '.codex', 'auth.json');
    if (!fs.existsSync(src)) return; // nothing to share
    fs.mkdirSync(codexHome, { recursive: true });
    fs.symlinkSync(src, dest);
  } catch { /* best effort; codex will surface its own auth error if this failed */ }
}

function run({ codexHome, cwd, sessionId, prompt, model, effort, processKey, sandbox = 'danger-full-access', onLiveEvent }) {
  ensureGitRepo(cwd);
  ensureCodexAuth(codexHome);
  return new Promise((resolve, reject) => {
    const args = ['exec', '--json', '-s', sandbox, '-C', cwd];
    if (model) args.push('-m', model);
    // Reasoning effort maps to codex's model_reasoning_effort config override
    // (minimal|low|medium|high|xhigh). Unset → codex's own default.
    if (effort) args.push('-c', `model_reasoning_effort="${effort}"`);
    args.push(
      '-c', `projects.${JSON.stringify(cwd)}.trust_level="trusted"`,
      'resume', sessionId, prompt,
    );
    // Codex's OWN sandbox is off (danger-full-access) so it doesn't nest a second
    // sandbox-exec; instead WE wrap it in the app Seatbelt — the single guard —
    // confining writes to the project dir. codexHome lives outside the workdir but
    // codex must append its rollout there, so it's added as an extra writable root.
    const codexBin = process.env.CODEX_PATH || 'codex';
    const [bin, spawnArgs] = sandboxed(codexBin, args, cwd, [codexHome]);
    const child = spawn(bin, spawnArgs, {
      cwd,
      env: { ...process.env, CODEX_HOME: codexHome, CODEX_SANDBOX_MODE: 'danger-full-access' },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });
    if (processKey) procTracker.register(processKey, child);
    let out = '';
    let err = '';
    let stdoutBuffer = '';
    child.stdout.on('data', (d) => {
      const chunk = d.toString();
      out += chunk;
      stdoutBuffer += chunk;
      const lines = stdoutBuffer.split('\n');
      stdoutBuffer = lines.pop();
      for (const line of lines) {
        const t = line.trim();
        if (!t) continue;
        try {
          const ev = JSON.parse(t);
          const live = codexLiveEventToClaudeShape(ev);
          if (live && typeof onLiveEvent === 'function') onLiveEvent(live);
        } catch { /* ignore non-json noise */ }
      }
    });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (stdoutBuffer.trim()) {
        try {
          const ev = JSON.parse(stdoutBuffer.trim());
          const live = codexLiveEventToClaudeShape(ev);
          if (live && typeof onLiveEvent === 'function') onLiveEvent(live);
        } catch { /* ignore */ }
      }
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
  let runError = null;
  try {
    await run({
      codexHome: mat.codexHome,
      cwd: mat.cwd,
      sessionId: mat.sessionId,
      prompt,
      model: opts.model,
      effort: opts.effort,
      processKey: opts.processKey,
      sandbox: opts.sandbox,
      onLiveEvent: opts.onLiveEvent,
    });
  } catch (err) {
    runError = err;
  }
  let added = [];
  if (fs.existsSync(mat.rolloutPath)) {
    try { added = ingestDelta(transcript, mat.rolloutPath, mat.origLineCount); }
    catch { /* prefer original run error if any */ }
  }
  if (runError && !added.length) throw runError;
  // Annotate the first new user turn with image basenames so history replay works.
  if (opts.imagePaths && opts.imagePaths.length) {
    const userTurn = added.find((t) =>
      t.role === 'user' && !(t.parts || []).every((p) => p.type === 'tool_result'));
    if (userTurn) {
      userTurn.parts.push(...opts.imagePaths.map((p) => ({ type: 'image', basename: path.basename(p) })));
    }
  }
  transcript.providerIds = { ...transcript.providerIds, codex: mat.sessionId };
  // Throwaway artifact: the rollout was just a materialization vehicle.
  if (opts.keepArtifacts !== true) {
    try { fs.unlinkSync(mat.rolloutPath); } catch { /* best effort */ }
  }
  return { added, sessionId: mat.sessionId };
}

module.exports = { materialize, run, ingestDelta, turn, defaultCodexHome, ensureGitRepo, ensureCodexAuth };
