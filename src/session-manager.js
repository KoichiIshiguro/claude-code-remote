'use strict';

// Spawning and tracking `claude -p` streams. History is no longer persisted
// here — it lives in Claude CLI's jsonl under ~/.claude/projects/, and is
// rebuilt on demand by jsonl-reader. This module is thin on purpose.

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const archiveStore = require('./archive-store');
const procTracker = require('./proc-tracker');
const { jsonlPathFor, readHistory, getLastTokens } = require('./jsonl-reader');

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
async function* runPrompt({ directory, prompt, imagePaths = [], resumeSessionId = null, processKey }) {
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

  // -p (non-interactive) mode has no channel for tool-result return, so
  // AskUserQuestion silently hangs. Tell the model to ask in plain text.
  args.push('--append-system-prompt',
    'When you need to ask the user a question or offer choices, write the question as plain text in your reply and STOP your turn. List options as a numbered or bulleted list. Do NOT call the AskUserQuestion tool — this environment cannot return a tool result, so the question would silently fail.');

  if (resumeSessionId) args.push('--resume', resumeSessionId);

  const claudeBin = process.env.CLAUDE_PATH || 'claude';
  const proc = spawn(claudeBin, args, { cwd: directory, env: { ...process.env } });
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
    const proc = spawn(claudeBin, [
      '-p',
      '--model', 'claude-haiku-4-5-20251001',
      '--append-system-prompt', systemPrompt,
      userPrompt,
    ], { cwd: os.tmpdir(), env: { ...process.env } });

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
};
