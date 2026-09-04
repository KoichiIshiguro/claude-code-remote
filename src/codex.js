'use strict';

// Codex engine adapter. Spawns `codex exec --json` (or `codex exec resume`)
// and translates its JSONL events into the claude stream-json shapes the rest
// of the app (ws-handler, liveTurn, the client) already understands:
//   thread.started                    → {type:'system', subtype:'init', session_id}
//   item.started  command_execution   → {type:'assistant', …tool_use(Bash)}
//   item.completed command_execution  → {type:'tool', tool_use_id, content}
//   item.completed agent_message      → {type:'assistant', …text}
//   turn.completed                    → {type:'result', subtype:'success', usage}
//   error                             → visible assistant text + {type:'error'}
// This keeps ws-handler's engine branching to "pick the adapter" and the
// client's stream renderer untouched.
//
// Sandbox: unlike claude (wrapped in sandbox-exec), codex ships its own
// seatbelt sandbox — and seatbelt does not nest, so we use codex's
// workspace-write mode and feed it the same extra writable roots the claude
// profile gets. All knobs go through `-c key=value` config overrides because
// those are accepted by both `exec` and `exec resume` (unlike -C / -s).

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const procTracker = require('./proc-tracker');

// Models usable on this machine's ChatGPT-authed codex (probed 2026-09: other
// published ids are rejected with invalid_request_error for this account type).
const CODEX_MODELS = ['gpt-5.6-sol', 'gpt-5.6-luna'];
// model_reasoning_effort values codex accepts.
const CODEX_EFFORT_LEVELS = ['minimal', 'low', 'medium', 'high'];

const CODEX_SESSIONS_DIR = path.join(os.homedir(), '.codex', 'sessions');

// TOML string literal for -c overrides.
function tomlStr(s) { return JSON.stringify(String(s)); }

// "/bin/zsh -lc 'echo hi'" → "echo hi" for tool-card titles; the raw wrapped
// form still shows in the result body when relevant.
function displayCommand(cmd) {
  if (Array.isArray(cmd)) cmd = cmd.join(' ');
  const m = /^\/\S+\s+-lc\s+'([\s\S]*)'$/.exec(cmd) || /^\/\S+\s+-lc\s+([\s\S]*)$/.exec(cmd);
  return (m ? m[1] : String(cmd || ''));
}

// One codex JSONL event → zero or more claude-shaped events.
function normalizeEvent(ev) {
  if (!ev || typeof ev !== 'object') return [];
  switch (ev.type) {
    case 'thread.started':
      return [{ type: 'system', subtype: 'init', session_id: ev.thread_id }];
    case 'item.started': {
      const it = ev.item || {};
      if (it.type === 'command_execution') {
        return [{
          type: 'assistant', uuid: `cdx-${it.id}-cmd`,
          message: { content: [{ type: 'tool_use', id: it.id, name: 'Bash', input: { command: displayCommand(it.command) } }] },
        }];
      }
      return [];
    }
    case 'item.completed': {
      const it = ev.item || {};
      if (it.type === 'agent_message') {
        return [{
          type: 'assistant', uuid: `cdx-${it.id}`,
          message: { content: [{ type: 'text', text: it.text || '' }] },
        }];
      }
      if (it.type === 'command_execution') {
        let out = it.aggregated_output || '';
        if (typeof it.exit_code === 'number' && it.exit_code !== 0) out += `\n(exit ${it.exit_code})`;
        return [{ type: 'tool', tool_use_id: it.id, content: out }];
      }
      if (it.type === 'reasoning' && it.text) {
        return [{
          type: 'assistant', uuid: `cdx-${it.id}`,
          message: { content: [{ type: 'thinking', thinking: it.text }] },
        }];
      }
      if (it.type === 'error') {
        return [{
          type: 'assistant', uuid: `cdx-${it.id}`,
          message: { content: [{ type: 'text', text: `⚠ ${it.message || 'codex error'}` }] },
        }];
      }
      // file_change / mcp_tool_call / web_search / … — generic tool card with
      // an immediate result so nothing is silently dropped.
      if (it.type && it.id) {
        return [
          {
            type: 'assistant', uuid: `cdx-${it.id}-gen`,
            message: { content: [{ type: 'tool_use', id: it.id, name: it.type, input: {} }] },
          },
          { type: 'tool', tool_use_id: it.id, content: JSON.stringify(it, null, 2).slice(0, 4000) },
        ];
      }
      return [];
    }
    case 'turn.completed': {
      const u = ev.usage || {};
      return [{
        type: 'result', subtype: 'success',
        usage: { input_tokens: u.input_tokens || 0, output_tokens: u.output_tokens || 0 },
      }];
    }
    case 'turn.failed':
    case 'error': {
      const msg = typeof ev.message === 'string' ? ev.message : JSON.stringify(ev.error || ev);
      return [{
        type: 'assistant', uuid: null,
        message: { content: [{ type: 'text', text: `⚠ Codex エラー: ${msg}` }] },
      }];
    }
    default:
      return [];
  }
}

// Async generator mirroring session-manager.runPrompt's contract: yields
// claude-shaped events, registers with procTracker under `processKey`, and
// yields {type:'cancelled'}/{type:'error'} when the run dies without a result.
async function* runPrompt({ directory, prompt, imagePaths = [], resumeSessionId = null, processKey, model = null, effort = null }) {
  if (!directory) throw new Error('directory required');
  if (!prompt && imagePaths.length === 0) throw new Error('prompt required');
  if (!processKey) throw new Error('processKey required');

  const finalPrompt = imagePaths.length
    ? (prompt ? `${imagePaths.join('\n')}\n\n${prompt}` : imagePaths.join('\n'))
    : prompt;

  // Extra writable roots = same list the claude sandbox profile gets, so a
  // project behaves identically under either engine.
  let extraWrite = [];
  try { extraWrite = require('./projects-store').resolvedWritablePaths(directory); }
  catch { /* config not ready */ }
  const writableRoots = [directory, ...extraWrite, os.tmpdir(), '/private/tmp', '/tmp'];

  const args = ['exec'];
  if (resumeSessionId) args.push('resume', resumeSessionId);
  args.push(
    finalPrompt,
    '--json',
    '--skip-git-repo-check',
    '-c', 'sandbox_mode="workspace-write"',
    '-c', `sandbox_workspace_write.writable_roots=[${writableRoots.map(tomlStr).join(',')}]`,
    '-c', 'sandbox_workspace_write.network_access=true',
    '-c', 'approval_policy="never"',
  );
  if (model && typeof model === 'string') args.push('-c', `model=${tomlStr(model)}`);
  if (effort && CODEX_EFFORT_LEVELS.includes(effort)) args.push('-c', `model_reasoning_effort=${tomlStr(effort)}`);

  const codexBin = process.env.CODEX_PATH || 'codex';
  // stdin MUST be closed: codex appends piped stdin to the prompt and waits
  // for EOF ("Reading additional input from stdin...") if it's a live pipe.
  const proc = spawn(codexBin, args, {
    cwd: directory, env: { ...process.env }, detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  procTracker.register(processKey, proc);

  let stderr = '';
  proc.stderr.on('data', d => { stderr += d.toString(); });
  proc.stderr.on('error', () => {});

  // Same post-result reap as the claude adapter: codex normally exits right
  // after turn.completed, but a leaked child inheriting stdout would hang the
  // close event forever, sticking the session on "Working".
  let sawResult = false, reapTimer = null;
  const scheduleReap = (ev) => {
    if (!ev || ev.type !== 'result' || sawResult) return;
    sawResult = true;
    reapTimer = setTimeout(() => {
      if (proc.exitCode !== null || proc.signalCode !== null) return;
      procTracker.killTree(proc, 'SIGTERM');
      const t = setTimeout(() => {
        if (proc.exitCode === null && proc.signalCode === null) procTracker.killTree(proc, 'SIGKILL');
      }, 3000);
      t.unref?.();
    }, 1500);
    reapTimer.unref?.();
  };

  let buffer = '';
  try {
    for await (const chunk of proc.stdout) {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) {
        const t = line.trim();
        if (!t) continue;
        let ev;
        try { ev = JSON.parse(t); } catch { continue; }
        for (const out of normalizeEvent(ev)) {
          yield out;
          scheduleReap(out);
        }
      }
    }
  } catch { /* SIGTERM/cancel */ }

  if (buffer.trim()) {
    try {
      const ev = JSON.parse(buffer.trim());
      for (const out of normalizeEvent(ev)) { yield out; scheduleReap(out); }
    } catch { /* ignore */ }
  }

  await new Promise(r => proc.on('close', r));
  if (reapTimer) clearTimeout(reapTimer);

  if (sawResult) {
    // normal completion
  } else if (proc.signalCode === 'SIGTERM' || proc.signalCode === 'SIGKILL') {
    yield { type: 'cancelled' };
  } else if (proc.exitCode !== 0 && stderr) {
    yield { type: 'error', message: stderr.trim() };
  }
}

// ── History from codex rollout files ─────────────────────────────────────────
// Rollouts live at ~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<sessionId>.jsonl.
// The `event_msg`/`item_completed` records carry exactly the conversation-level
// items (UserMessage / AgentMessage / CommandExecution) without the developer
// preamble noise, so history rebuilds from those alone.

const rolloutPathCache = new Map();

function findRolloutPath(sessionId) {
  const cached = rolloutPathCache.get(sessionId);
  if (cached && fs.existsSync(cached)) return cached;
  const suffix = `-${sessionId}.jsonl`;
  try {
    for (const y of fs.readdirSync(CODEX_SESSIONS_DIR).sort().reverse()) {
      const yDir = path.join(CODEX_SESSIONS_DIR, y);
      if (!fs.statSync(yDir).isDirectory()) continue;
      for (const m of fs.readdirSync(yDir).sort().reverse()) {
        const mDir = path.join(yDir, m);
        if (!fs.statSync(mDir).isDirectory()) continue;
        for (const d of fs.readdirSync(mDir).sort().reverse()) {
          const dDir = path.join(mDir, d);
          if (!fs.statSync(dDir).isDirectory()) continue;
          for (const f of fs.readdirSync(dDir)) {
            if (f.endsWith(suffix)) {
              const full = path.join(dDir, f);
              rolloutPathCache.set(sessionId, full);
              return full;
            }
          }
        }
      }
    }
  } catch { /* sessions dir missing */ }
  return null;
}

function itemText(content, key) {
  if (!Array.isArray(content)) return '';
  return content
    .filter(c => c && typeof c[key] === 'string' && (c.type === 'text' || c.type === 'Text'))
    .map(c => c[key]).join('\n');
}

// Same split the app applies to claude prompts: attachment paths are prepended
// to the prompt as bare lines; peel image paths back out for the client's
// inline previews.
function splitAttachmentLines(raw) {
  const lines = String(raw).split('\n');
  const images = [];
  let i = 0;
  while (i < lines.length && /^\/\S+\.(png|jpe?g|gif|webp|bmp|svg|avif|pdf|txt|md|csv|json|log|zip)$/i.test(lines[i].trim())) {
    images.push(path.basename(lines[i].trim())); i++;
  }
  while (i < lines.length && !lines[i].trim()) i++;
  return { text: lines.slice(i).join('\n'), images };
}

function readCodexHistory(sessionId) {
  const file = findRolloutPath(sessionId);
  if (!file) return { history: [], lastTokens: null, exists: false, truncated: false };
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); }
  catch { return { history: [], lastTokens: null, exists: false, truncated: false }; }

  const history = [];
  let lastTokens = null;
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    let e;
    try { e = JSON.parse(t); } catch { continue; }
    const ts = e.timestamp ? Date.parse(e.timestamp) : Date.now();
    if (e.type !== 'event_msg' || !e.payload) continue;
    const p = e.payload;
    if (p.type === 'token_count' && p.info?.total_token_usage) {
      const u = p.info.total_token_usage;
      lastTokens = (u.input_tokens || 0);
      continue;
    }
    if (p.type !== 'item_completed' || !p.item) continue;
    const it = p.item;
    if (it.type === 'UserMessage') {
      const rawText = itemText(it.content, 'text');
      if (!rawText || rawText.startsWith('<')) continue; // env/context injections
      const { text, images } = splitAttachmentLines(rawText);
      if (text || images.length) history.push({ type: 'user', text, images, ts });
    } else if (it.type === 'AgentMessage') {
      const text = itemText(it.content, 'text');
      if (text) history.push({ type: 'assistant', blocks: [{ kind: 'text', text }], ts });
    } else if (it.type === 'CommandExecution') {
      const cmd = displayCommand(it.command);
      let out = it.aggregated_output || '';
      if (typeof it.exit_code === 'number' && it.exit_code !== 0) out += `\n(exit ${it.exit_code})`;
      if (out.length > 4000) out = out.slice(0, 4000) + '\n…(truncated)';
      history.push({
        type: 'assistant',
        blocks: [{ kind: 'tool', name: 'Bash', title: cmd.split('\n')[0].slice(0, 80), toolId: it.id, result: out, artifacts: [] }],
        ts,
      });
    }
  }
  return { history, lastTokens, exists: true, truncated: false };
}

// First real user prompt, for the sidebar row (mirrors firstUserPreview).
function codexPreview(sessionId, maxLen = 120) {
  const { history } = readCodexHistory(sessionId);
  const u = history.find(h => h.type === 'user' && h.text);
  return u ? u.text.slice(0, maxLen) : '';
}

module.exports = { runPrompt, readCodexHistory, codexPreview, CODEX_MODELS, CODEX_EFFORT_LEVELS };
