'use strict';

// Spawning and tracking `claude -p` streams. History is no longer persisted
// here — it lives in Claude CLI's jsonl under ~/.claude/projects/, and is
// rebuilt on demand by jsonl-reader. This module is thin on purpose.

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const archiveStore = require('./archive-store');
const procTracker = require('./proc-tracker');
const { jsonlPathFor, readHistory, getLastTokens } = require('./jsonl-reader');

// ── Sandbox (macOS Seatbelt) ─────────────────────────────────────────────────
// The Node server itself runs with FULL filesystem access — it needs it for the
// project picker, git clone, and the file viewer. But every spawned `claude`
// child is a black box running an LLM, so we confine IT (and only it) at the
// KERNEL level by wrapping it in `sandbox-exec`. The confinement holds even
// though we pass --dangerously-skip-permissions, and even against `bash`/`cat`,
// because it's enforced on the syscall, not by claude's own permission logic.
//
// Strategy: we must START from `(allow default)`. A `(deny default)` profile
// blocks reads of the dyld shared cache and system dylibs, so NO binary can even
// exec inside the sandbox (it aborts with SIGABRT). From that permissive base we
// carve out the two things that matter for THIS tool's threat model — keeping a
// session's claude from touching anything but its own project folder:
//   1. file-write*  — denied everywhere, re-allowed only in workdir / ~/.claude /
//                     ~/.claude.json / temp. So claude can't modify any file
//                     outside its session, anywhere on disk.
//   2. file-read*   — denied across the project tree (the workdir's parent and
//                     BASE_DIR), re-allowed only for the workdir itself. So a
//                     session can't read sibling projects or climb to the parent.
// We deliberately do NOT deny all of $HOME: claude's own auth lives in the macOS
// Keychain (~/Library/Keychains) and its state in ~/.claude.json, so a blanket
// $HOME deny breaks claude itself. The goal here is project isolation, not $HOME
// lockdown. Rules are last-match-wins, so re-allows are placed AFTER the denies.
// macOS only; no-op elsewhere or when CLAUDE_SANDBOX=0.
// Debug denials with: log stream --style compact --predicate 'sender=="Sandbox"'
function buildSandboxProfile(workdir) {
  const home = os.homedir();
  const q = (p) => '"' + String(p).replace(/(["\\])/g, '\\$1') + '"';
  const sub = (...ps) => ps.map(q).map(s => `(subpath ${s})`).join(' ');
  const reEsc = (p) => String(p).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // claude keeps its main state in the top-level ~/.claude.json (+ .backup, and
  // a .tmp sibling it writes-then-renames). Match the whole family.
  const claudeJson = `(regex #"^${reEsc(path.join(home, '.claude.json'))}")`;

  // Where the child may WRITE (everywhere else is read-only).
  const writeOk = [
    workdir,
    path.join(home, '.claude'),       // transcripts (--resume), auth, todos, logs
    os.tmpdir(), '/private/var/folders', '/private/tmp', '/tmp',
  ];
  // Read-deny the project tree so a session can't see sibling projects or climb
  // out: the workdir's immediate parent, plus BASE_DIR (the whole picker root)
  // when set. The workdir re-allow below overrides these (last-match-wins).
  const denyRead = [...new Set([
    path.dirname(workdir),
    ...(process.env.BASE_DIR ? [path.resolve(process.env.BASE_DIR)] : []),
  ])];

  return [
    '(version 1)',
    '(allow default)',                          // permissive base so the runtime loads
    // — writes: nothing but the session folder, ~/.claude(.json), and temp —
    '(deny file-write*)',
    `(allow file-write* ${sub(...writeOk)})`,
    `(allow file-write* ${claudeJson})`,
    // — reads: block the project tree, then re-allow this session's folder —
    `(deny file-read* ${sub(...denyRead)})`,
    `(allow file-read* ${sub(workdir)})`,       // workdir last = wins
  ].join('\n');
}

// Returns [bin, args] for spawn() — wrapped in sandbox-exec on macOS so the
// child can only touch `workdir` (+ ~/.claude + temp + runtime). Untouched on
// non-macOS or when CLAUDE_SANDBOX=0.
function sandboxed(bin, args, workdir) {
  if (process.platform !== 'darwin' || process.env.CLAUDE_SANDBOX === '0') {
    return [bin, args];
  }
  return ['/usr/bin/sandbox-exec', ['-p', buildSandboxProfile(workdir), bin, ...args]];
}

// Auto-compact threshold (input tokens incl. cache). 167k matches the TUI's
// ~83.5% trigger on 200k-context models. Lookup order per call:
//   1. data/config.json autoCompactThreshold (settable from the UI)
//   2. CLAUDE_AUTO_COMPACT_THRESHOLD env var
//   3. 167_000
// A stored value of 0 (or any non-positive) disables auto-compact entirely.
const AUTO_COMPACT_DEFAULT = 167_000;
function getAutoCompactThreshold() {
  try {
    const cfg = require('./auth').loadConfig();
    if (typeof cfg.autoCompactThreshold === 'number') return cfg.autoCompactThreshold;
  } catch { /* config not readable yet */ }
  const env = parseInt(process.env.CLAUDE_AUTO_COMPACT_THRESHOLD);
  return Number.isFinite(env) && env > 0 ? env : AUTO_COMPACT_DEFAULT;
}

// Per-(sessionId) summary cache. Lost on restart — that's fine, regenerate.
const summaryCache = new Map();
const MAX_TRANSCRIPT_CHARS = 120_000;

function cancelRunning(key) { return procTracker.cancel(key); }
function isRunning(key) { return procTracker.isRunning(key); }

// Async generator. Yields stream-json events from `claude -p`. Caller is
// expected to inspect the `system/init` event to capture the assigned
// session_id for sessions that were created here (resumeSessionId=null).
// Allowed `--effort` values, mirroring `claude --help` (low, medium, high,
// xhigh, max). Anything else is ignored so we never pass a bad flag.
const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'];

async function* runPrompt({ directory, prompt, imagePaths = [], resumeSessionId = null, processKey, model = null, effort = null }) {
  if (!directory) throw new Error('directory required');
  if (!prompt) throw new Error('prompt required');
  if (!processKey) throw new Error('processKey required');

  const finalPrompt = imagePaths.length
    ? `${imagePaths.join('\n')}\n\n${prompt}`
    : prompt;

  const args = [
    '-p', finalPrompt,
    '--output-format', 'stream-json',
    '--verbose',
    '--dangerously-skip-permissions',
  ];

  // Model / effort come from app settings. When unset we pass nothing and let
  // the CLI use its own defaults (which is why unconfigured sessions can feel
  // faster — they may run at a lower default effort).
  if (model && typeof model === 'string') args.push('--model', model);
  if (effort && EFFORT_LEVELS.includes(effort)) args.push('--effort', effort);

  // -p (non-interactive) mode has no channel for tool-result return, so
  // AskUserQuestion silently hangs. Tell the model to ask in plain text.
  args.push('--append-system-prompt',
    'When you need to ask the user a question or offer choices, write the question as plain text in your reply and STOP your turn. List options as a numbered or bulleted list. Do NOT call the AskUserQuestion tool — this environment cannot return a tool result, so the question would silently fail.');

  if (resumeSessionId) args.push('--resume', resumeSessionId);

  const claudeBin = process.env.CLAUDE_PATH || 'claude';
  // Confine the child to `directory` (+ ~/.claude + temp). The server is
  // unaffected — only this spawned claude is sandboxed.
  const [bin, spawnArgs] = sandboxed(claudeBin, args, directory);
  const proc = spawn(bin, spawnArgs, { cwd: directory, env: { ...process.env } });
  procTracker.register(processKey, proc);

  let buffer = '';
  try {
    for await (const chunk of proc.stdout) {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) {
        const t = line.trim();
        if (!t) continue;
        try { yield JSON.parse(t); } catch { /* skip non-JSON */ }
      }
    }
  } catch { /* SIGTERM/cancel */ }

  if (buffer.trim()) {
    try { yield JSON.parse(buffer.trim()); } catch { /* ignore */ }
  }

  let stderr = '';
  for await (const chunk of proc.stderr) stderr += chunk.toString();
  await new Promise(r => proc.on('close', r));

  if (proc.signalCode === 'SIGTERM') {
    yield { type: 'cancelled' };
  } else if (proc.exitCode !== 0 && stderr) {
    yield { type: 'error', message: stderr.trim() };
  }
}

function shouldAutoCompact(sessionId, directory) {
  if (!sessionId || !directory) return false;
  const threshold = getAutoCompactThreshold();
  if (threshold <= 0) return false; // user disabled auto-compact
  const tokens = getLastTokens(sessionId, directory);
  return tokens != null && tokens > threshold;
}

function buildTranscript(history) {
  const parts = [];
  for (const e of history) {
    if (e.type === 'user') {
      parts.push(`ユーザー: ${e.text || ''}`);
    } else if (e.type === 'assistant') {
      const text = (e.blocks || []).map(b => {
        if (b.kind === 'text') return b.text;
        if (b.kind === 'tool') return `[ツール ${b.name}: ${b.title || ''}]`;
        return '';
      }).filter(Boolean).join('\n');
      if (text) parts.push(`アシスタント: ${text}`);
    }
  }
  let joined = parts.join('\n\n');
  if (joined.length > MAX_TRANSCRIPT_CHARS) {
    joined = '…(序盤省略)\n\n' + joined.slice(-MAX_TRANSCRIPT_CHARS);
  }
  return joined;
}

// One-shot summarization via a fresh `claude -p` aimed at /tmp so the
// orphan jsonl doesn't pollute any registered project.
function summarizeSession(sessionId, directory) {
  return new Promise((resolve, reject) => {
    const { history, exists } = readHistory(sessionId, directory);
    if (!exists || !history.length) {
      return reject(new Error('まだ要約する会話がありません'));
    }

    const cached = summaryCache.get(sessionId);
    if (cached && cached.atLength === history.length) return resolve(cached.text);

    const transcript = buildTranscript(history);
    const systemPrompt =
      'あなたは渡された会話履歴を読んで要約する専門アシスタントです。' +
      '履歴の中身に応答したり、続きを書いたり、質問に答えたり、ツールを呼び出したりしてはいけません。' +
      '出力は要約本文のみ。挨拶や前置きは一切書かないでください。';
    const userPrompt =
      '以下の "..." 内に会話履歴があります。これを日本語300字程度で要約してください。\n' +
      '「このスレッドがこれまで何をしてきたか」「今まさに何のフェーズにあるか」を含めること。\n\n' +
      '"' + transcript + '"\n\n' +
      '上記 "..." 内の履歴を300字程度で要約してください。本文のみ出力。';

    const claudeBin = process.env.CLAUDE_PATH || 'claude';
    // Summaries run aimed at /tmp; sandbox to tmp too so they touch no project.
    const [bin, spawnArgs] = sandboxed(claudeBin, [
      '-p',
      '--model', 'claude-haiku-4-5-20251001',
      '--append-system-prompt', systemPrompt,
      userPrompt,
    ], os.tmpdir());
    const proc = spawn(bin, spawnArgs, { cwd: os.tmpdir(), env: { ...process.env } });

    let stdout = '', stderr = '';
    proc.stdout.on('data', d => { stdout += d.toString(); });
    proc.stderr.on('data', d => { stderr += d.toString(); });

    const killTimer = setTimeout(() => { try { proc.kill('SIGTERM'); } catch {} }, 90_000);
    proc.on('close', code => {
      clearTimeout(killTimer);
      if (code === 0) {
        const text = stdout.trim();
        summaryCache.set(sessionId, { text, atLength: history.length });
        resolve(text);
      } else {
        reject(new Error(stderr.trim() || `claude exited with code ${code}`));
      }
    });
    proc.on('error', err => { clearTimeout(killTimer); reject(err); });
  });
}

// Physical delete: stop the running stream (if any), wait briefly, then
// unlink the jsonl. Also clears any archive flag.
function purgeSession(sessionId, directory) {
  cancelRunning(sessionId);
  try { fs.unlinkSync(jsonlPathFor(sessionId, directory)); } catch { /* may already be gone */ }
  archiveStore.restore(sessionId);
  summaryCache.delete(sessionId);
}

// No-op shim kept so existing shutdown handlers don't break; we no longer
// persist any in-flight state (jsonl is canonical and already on disk).
function flushPendingSave() { /* intentional no-op */ }

module.exports = {
  runPrompt, cancelRunning, isRunning,
  shouldAutoCompact, summarizeSession,
  purgeSession,
  flushPendingSave,
  getAutoCompactThreshold,
  AUTO_COMPACT_DEFAULT,
  EFFORT_LEVELS,
  buildSandboxProfile, sandboxed, // exported for tests
};
