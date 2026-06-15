'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { v4: uuidv4 } = require('uuid');
const sm = require('./session-manager');
const procTracker = require('./proc-tracker');
const projectsStore = require('./projects-store');
const archiveStore = require('./archive-store');
const nameStore = require('./name-store');
const jsonlReader = require('./jsonl-reader');
const promptQueue = require('./prompt-queue');
const scheduledPrompts = require('./scheduled-prompts');
const liveTurn = require('./live-turn');
const { sessionDir } = require('./attachments');
const shell = require('./shell-manager');
const gitInfo = require('./git-info');
const syncBridge = require('./history-sync/ws-bridge');
const historyStore = require('./history-sync/store');
const historyPort = require('./history-sync/port');
const { segmentByAgent } = require('./history-sync/segment-by-agent');
const { selectionForTranscript, setTranscriptSelection } = require('./history-sync/selection');

// sessionId or placeholderId → Set<ws>  (all clients watching that key)
const sessionClients = new Map();

// Shared (alpha) conversations only: the agent the client last selected for the
// session (claude|codex). Per-session and independent — switching here changes
// which peer runs the NEXT turn, while the canonical history stays shared.
const sessionAgent = new Map();

// Shared (alpha) conversations only: the model the client last selected for the
// session, sent per-turn alongside the agent. Empty/unset → let the agent CLI use
// its own default. Per-item model (Phase 2 queue) overrides this fallback.
const sessionModel = new Map();

// Shared (alpha) conversations only: the reasoning effort the client last
// selected for the session, sent per-turn alongside the model. Empty/unset →
// let the agent CLI use its own default. Per-item effort overrides this fallback.
const sessionEffort = new Map();

// Placeholder sessions that haven't yet been written to a jsonl. Lost on
// server restart — intentional. UI generates an id, server tracks the
// directory; once the first prompt's stream-json init reveals the real
// Claude session id, we rekey and drop the placeholder.
const pendingSessions = new Map(); // placeholderId → { directory, createdAt, lastActivity }

function send(ws, obj) {
  if (ws.readyState === 1) ws.send(JSON.stringify(obj));
}

function broadcast(key, obj) {
  const clients = sessionClients.get(key);
  if (!clients) return;
  const data = JSON.stringify(obj);
  for (const c of clients) if (c.readyState === 1) c.send(data);
}

// ── Available slash commands ────────────────────────────────────────────────
// The stream-json `init` event reports the slash commands valid in this `-p`
// environment (skills + built-ins like /compact). They're environment-wide and
// effectively static, so we cache the latest list, persist it (survives restart
// → available on the very next page load), and push it to whoever's viewing the
// session so the prompt-box picker populates without a reload.
const SLASH_FILE = path.join(__dirname, '..', 'data', 'slash-commands.json');
let slashCommandsCache = (() => {
  try { const a = JSON.parse(fs.readFileSync(SLASH_FILE, 'utf8')); return Array.isArray(a) ? a.filter(c => typeof c === 'string') : []; }
  catch { return []; }
})();

function getSlashCommands() { return slashCommandsCache; }

function recordSlashCommands(key, list) {
  if (!Array.isArray(list)) return;
  const next = list.filter(c => typeof c === 'string');
  if (!next.length) return;
  const changed = next.length !== slashCommandsCache.length || next.some((c, i) => c !== slashCommandsCache[i]);
  if (changed) {
    slashCommandsCache = next;
    try { fs.writeFileSync(SLASH_FILE, JSON.stringify(next)); } catch {}
  }
  broadcast(key, { type: 'slash_commands', commands: next });
}

function subscribe(key, ws) {
  if (!key) return;
  if (!sessionClients.has(key)) sessionClients.set(key, new Set());
  sessionClients.get(key).add(ws);
}

function unsubscribe(ws) {
  for (const [, clients] of sessionClients) clients.delete(ws);
}

function rekeySubscribers(oldKey, newKey) {
  if (!oldKey || !newKey || oldKey === newKey) return;
  const set = sessionClients.get(oldKey);
  if (!set) return;
  sessionClients.delete(oldKey);
  const existing = sessionClients.get(newKey);
  if (existing) for (const c of set) existing.add(c);
  else sessionClients.set(newKey, set);
}

// ── Branch tracking ─────────────────────────────────────────────────────────
// Clients viewing a directory get pushed a `branch_changed` only when the branch
// is switched explicitly from within the app (switch_branch handler). The old
// 2.5s background poll that also caught HEAD moves from outside the app (e.g.
// Claude running `git checkout` mid-turn) was removed — it wasn't worth the
// constant `git` spawns. The branch pill still shows the value loaded with the
// session; it just won't auto-refresh on out-of-band HEAD changes until reload.
const dirClients = new Map(); // absDir → Set<ws> currently viewing it
const dirBranch = new Map();  // absDir → last branch we broadcast (string|null)

function broadcastBranch(absDir, branch) {
  const set = dirClients.get(absDir);
  if (!set) return;
  const data = JSON.stringify({ type: 'branch_changed', directory: absDir, branch });
  for (const c of set) if (c.readyState === 1) c.send(data);
}

// Point `ws` at `dir` so an in-app branch switch can be broadcast to it, dropping
// whatever it watched before (a client only ever views one session/dir at a time).
function watchDir(dir, ws) {
  unwatchWs(ws);
  if (!dir) return;
  const absDir = path.resolve(dir);
  if (!dirClients.has(absDir)) dirClients.set(absDir, new Set());
  dirClients.get(absDir).add(ws);
  if (!dirBranch.has(absDir)) dirBranch.set(absDir, gitInfo.currentBranch(absDir));
}

function unwatchWs(ws) {
  for (const [dir, set] of dirClients) {
    set.delete(ws);
    if (set.size === 0) { dirClients.delete(dir); dirBranch.delete(dir); }
  }
}

// Look up directory by sessionId. Pending placeholders take precedence; then
// scan registered projects for a matching jsonl filename.
function findDirectoryForSessionId(sessionId) {
  if (pendingSessions.has(sessionId)) return pendingSessions.get(sessionId).directory;
  for (const p of projectsStore.loadProjects()) {
    const ls = jsonlReader.listJsonlsForProject(p.path);
    if (ls.some(s => s.sessionId === sessionId)) return p.path;
  }
  return null;
}

// A shared (alpha) canonical conversation → the sidebar's legacy session shape.
// These live in the history-sync store, not a native jsonl, so list_sessions /
// listAllSessionsLegacy must fold them in explicitly or they're invisible.
function sharedToLegacyShape(t) {
  const turns = t.turns || [];
  const firstUser = turns.find((x) => x.role === 'user');
  const preview = firstUser
    ? (firstUser.parts || []).filter((p) => p.type === 'text').map((p) => p.text).join(' ').trim().slice(0, 80)
    : '';
  return {
    id: t.id,
    sessionId: t.id,
    directory: t.cwd || '',
    lastActivity: new Date(t._mtime || Date.now()).toISOString(),
    streaming: procTracker.isRunning(t.id),
    allowedTools: null,
    lastTokens: null,
    aiTitle: t.title || '',
    preview,
    customName: nameStore.get(t.id),
    shared: true,
    agents: Object.keys(t.providerIds || {}),
  };
}

// Shared conversations rooted at `projectPath` (or all, when omitted), already
// filtered to real sync ids and not archived. `seen` lets callers dedupe.
function sharedSessionsLegacy(projectPath, archived, seen) {
  const out = [];
  for (const t of historyStore.list()) {
    if (!syncBridge.isSyncId(t.id)) continue;        // skip non-routable demo/scratch files
    if (archived && archived.has(t.id)) continue;
    if (seen && seen.has(t.id)) continue;
    if (projectPath != null && (t.cwd || '') !== projectPath) continue;
    if (seen) seen.add(t.id);
    out.push(sharedToLegacyShape(t));
  }
  return out;
}

function pendingToLegacyShape(placeholderId, entry) {
  return {
    id: placeholderId,
    sessionId: null,
    directory: entry.directory,
    lastActivity: new Date(entry.lastActivity).toISOString(),
    streaming: procTracker.isRunning(placeholderId),
    allowedTools: null,
    lastTokens: null,
    preview: '',
  };
}

// v2 is canonical-first: the sidebar lists ONLY shared (canonical) sessions.
// Pre-v2 native jsonl sessions are legacy artifacts — never the truth, and
// reachable solely through the per-project import modal (port_list_sources),
// not as peer entries here. Pending placeholders are folded in only while a
// turn is materializing them; they fall away once the canonical row exists.
function listAllSessionsLegacy() {
  const archived = new Set(archiveStore.load());
  const out = [];
  const seen = new Set();
  for (const [pid, entry] of pendingSessions) {
    if (archived.has(pid)) continue;
    seen.add(pid);
    out.push(pendingToLegacyShape(pid, entry));
  }
  out.push(...sharedSessionsLegacy(null, archived, seen));
  return out;
}

// ─── Server-side prompt queue + runner ─────────────────────────────────────
//
// Prompts are queued per session and drained by a single browser-independent
// runner loop. While a turn is streaming, freshly sent prompts accumulate;
// when the turn ends the runner pulls ALL of them and submits them as one
// batched prompt (blank-line joined). The loop lives in the server process,
// so closing the browser doesn't stop it — the next batch still fires.

// keys (sessionId | placeholderId) with an active runner. Values carry a unique
// token so cancel/rekey/finally cannot accidentally clear a newer runner.
const runners = new Map();
// Keys whose CURRENT in-flight turn is a (auto-)compact. Server-authoritative so
// a fresh page load / project switch can re-show the "compacting…" note from the
// history payload instead of relying on client-side in-memory state (which a full
// navigation wipes). Maps key → { auto: bool }.
const compactingKeys = new Map();

function runnerState(key) {
  return runners.get(key) || null;
}

function markRunnerCancelling(key) {
  const r = runners.get(key);
  if (r) r.cancelling = true;
}

function rekeyRunner(oldKey, newKey) {
  if (!oldKey || !newKey || oldKey === newKey) return;
  const r = runners.get(oldKey);
  if (!r) return;
  runners.delete(oldKey);
  r.activeKey = newKey;
  if (!runners.has(newKey)) runners.set(newKey, r);
}

function hasPendingWork(key) {
  const queued = (promptQueue.list(key) || []).length > 0;
  const due = scheduledPrompts.listFor(key).some(i => i.fireAt <= Date.now());
  return queued || due;
}

function loadSelectionForSession(sessionId, directory) {
  try {
    const t = historyStore.load(sessionId, { cwd: directory });
    return selectionForTranscript(t);
  } catch {
    return selectionForTranscript(null);
  }
}

function queueStateMsg(key) {
  return {
    type: 'queue_state',
    sessionId: key,
    queue: promptQueue.list(key).map(i => ({ id: i.id, text: i.text, agent: i.agent })),
  };
}

function broadcastQueue(key) {
  broadcast(key, queueStateMsg(key));
}

function scheduledStateMsg(key) {
  return {
    type: 'scheduled_state',
    sessionId: key,
    scheduled: scheduledPrompts.listFor(key).map(i => ({ id: i.id, text: i.text, fireAt: i.fireAt, agent: i.agent })),
  };
}

function broadcastScheduled(key) {
  broadcast(key, scheduledStateMsg(key));
}

// Wake any session that has a reservation due. We deliberately do NOT consume
// the reservations here — the runner pulls its own due items (with priority over
// the live queue) at the top of each turn. That single rule covers both cases:
// an idle session gets a fresh runner that drains them immediately, and a busy
// session's existing runner drains them the instant its current turn finishes.
// Pulling in the runner (not here) also closes the race where a reservation
// enqueued just as the runner is exiting would be orphaned with no one to drain
// it. 30s granularity is plenty for minute-level scheduling.
function checkScheduledPrompts() {
  const woken = new Set();
  for (const item of scheduledPrompts.listDue(Date.now())) {
    if (woken.has(item.sessionId)) continue;
    woken.add(item.sessionId);
    kickRunner(item.sessionId, item.directory);
  }
}
const schedTimer = setInterval(checkScheduledPrompts, 30000);
schedTimer.unref?.();

// Snapshot of the in-flight turn for a reconnecting/switching client to replay,
// so the just-sent prompt and the assistant output so far survive a reload
// before this turn's jsonl is written. null when no turn is streaming.
function liveTurnPayload(key) {
  const t = liveTurn.get(key);
  if (!t) return null;
  // Basenames only; the client builds /attachment URLs from session + dir.
  const images = (t.images || []).map(p => path.basename(p));
  return { prompt: t.prompt, images, compact: t.compact, events: t.events };
}

// Idempotent: starts a runner for `key` if one isn't already draining it.
function kickRunner(key, directory) {
  if (runners.has(key)) return;
  const runner = { id: uuidv4(), activeKey: key, directory, cancelling: false };
  runners.set(key, runner);
  let activeKey = key;
  (async () => {
    try {
      while (true) {
        // Reservations first: pull this session's due ones and batch them ahead
        // of the live queue. Re-checked at the top of every turn, so a reserva-
        // tion whose time passed mid-turn fires the moment this turn finishes.
        const due = scheduledPrompts.takeDueFor(activeKey, Date.now());
        if (due.length) broadcastScheduled(activeKey);
        const items = [
          ...due.map(i => ({ id: i.id, text: i.text, imagePaths: i.imagePaths, agent: i.agent, model: i.model, effort: i.effort })),
          ...promptQueue.dequeueAll(activeKey),
        ];
        if (!items.length) break;
        runner.cancelling = false;
        broadcastQueue(activeKey); // queue just drained → empty
        const sync = syncBridge.isSyncId(activeKey);
        // Shared sessions: split into contiguous same-agent runs so a Claude batch
        // and a Codex batch never merge into one turn — run them in order. Native
        // sessions are always Claude → exactly one segment (old behaviour intact).
        const segments = sync
          ? segmentByAgent(items)
          : [{ agent: 'claude', items }];
        for (const seg of segments) {
          const text = seg.items.map(i => i.text).join('\n\n');
          const images = seg.items.flatMap(i => i.imagePaths || []);
          // A batched segment runs under the model/effort of its first item (all
          // items share an agent; model/effort are usually constant within a run).
          const segModel = seg.items.find(i => i.model)?.model;
          const segEffort = seg.items.find(i => i.effort)?.effort;
          const resolved = sync
            ? await runSyncTurn(activeKey, directory, text, images, seg.agent, segModel, segEffort)
            : await runOneTurn(activeKey, directory, text, images);
          // A placeholder resolved to a real session id mid-run: the queue and
          // runner membership were already migrated inside runOneTurn at init.
          if (resolved && resolved !== activeKey) {
            rekeyRunner(activeKey, resolved);
            activeKey = resolved;
            runner.activeKey = resolved;
          }
        }
      }
    } catch (e) {
      console.error('[prompt-queue runner]', e);
    } finally {
      const current = runners.get(activeKey);
      if (current && current.id === runner.id) runners.delete(activeKey);
      // Close the race where cancel/finally or a reservation due at loop exit
      // leaves work queued with no owner. Do not resurrect a user-cancelled
      // runner unless new work arrived after cancel.
      if (hasPendingWork(activeKey)) kickRunner(activeKey, directory);
    }
  })();
}

// Runs a single `claude -p` turn for `key`. Returns the resolved session id
// (the real id once a new session's init event arrives, otherwise `key`).
async function runOneTurn(key, directory, prompt, imagePaths) {
  const cfg = require('./auth').loadConfig();
  const model = typeof cfg.model === 'string' ? cfg.model : null;
  const effort = typeof cfg.effort === 'string' ? cfg.effort : null;

  const isNewSession = pendingSessions.has(key);
  let resolvedSessionId = isNewSession ? null : key;
  const resumeSessionId = isNewSession ? null : key;
  const processKey = key;

  // A manual /compact must NOT be preceded by an auto-compact: that would
  // compact twice (the auto-compact pre-phase, then the manual /compact
  // itself). Detect it up front so the auto-compact pre-check can skip it.
  const isCompactCmd = typeof prompt === 'string' && prompt.trim() === '/compact';

  if (!isNewSession && !isCompactCmd && sm.shouldAutoCompact(key, directory)) {
    compactingKeys.set(key, { auto: true });
    // Buffer the REAL user prompt (not '/compact') with compact:true, so a reload
    // during the auto-compact phase still shows the user's pending prompt bubble
    // alongside the "compacting…" note (the compact output itself is suppressed).
    liveTurn.begin(key, { prompt, images: imagePaths, compact: true });
    broadcast(key, { type: 'stream_start', sessionId: key, autoCompact: true });
    try {
      for await (const event of sm.runPrompt({
        directory, prompt: '/compact',
        resumeSessionId: key, processKey: key, model, effort,
      })) {
        liveTurn.record(key, event);
        broadcast(key, { type: 'stream_event', sessionId: key, event });
      }
    } catch (err) {
      if (!runnerState(key)?.cancelling) {
        broadcast(key, { type: 'error', message: `auto-compact failed: ${err.message}`, sessionId: key });
      }
    } finally {
      compactingKeys.delete(key);
      liveTurn.end(key);
      broadcast(key, { type: 'stream_end', sessionId: key });
    }
  }

  // Tag the stream when the prompt itself is a manual /compact so the UI can
  // show a "compacting…" indicator (auto-compact above sets its own flag).
  if (isCompactCmd) compactingKeys.set(key, { auto: false });
  liveTurn.begin(key, { prompt, images: imagePaths, compact: isCompactCmd });
  // Carry the prompt text being processed so the client can draw its user bubble
  // now. Queued prompts aren't shown as bubbles while waiting (only in the queue
  // area), so this is the moment they become a real message. Suppressed for a
  // /compact (it's a maintenance action, not a message).
  broadcast(key, {
    type: 'stream_start', sessionId: key, compact: isCompactCmd,
    prompt: isCompactCmd ? null : prompt,
    // Basenames only; the client builds /attachment URLs from session + dir.
    images: isCompactCmd ? [] : imagePaths.map(p => path.basename(p)),
  });

  // AskUserQuestion intercept — the tool can't be answered in `-p` mode, so we
  // surface the question, cancel the stream, and write a synthetic tool_result
  // so the next /resume isn't left dangling.
  let interceptedAUQ = null;

  try {
    for await (const event of sm.runPrompt({
      directory, prompt, imagePaths, resumeSessionId, processKey, model, effort,
    })) {
      // Every init (new or resumed) carries the env's slash command list.
      if (event.type === 'system' && event.subtype === 'init' && Array.isArray(event.slash_commands)) {
        recordSlashCommands(key, event.slash_commands);
      }
      if (isNewSession && !resolvedSessionId
          && event.type === 'system' && event.subtype === 'init' && event.session_id) {
        resolvedSessionId = event.session_id;
        // Claim the real id immediately so a concurrent kick(realId) (from a
        // prompt sent after the client learns the new id) is a no-op rather
        // than spawning a second runner.
        rekeyRunner(key, resolvedSessionId);
        procTracker.rekey(key, resolvedSessionId);
        rekeySubscribers(key, resolvedSessionId);
        promptQueue.rekey(key, resolvedSessionId);
        scheduledPrompts.rekey(key, resolvedSessionId);
        liveTurn.rekey(key, resolvedSessionId);
        // Re-key the pending record to the REAL id instead of deleting it. Claude
        // emits `init` before it has necessarily flushed the session jsonl to
        // disk, so deleting here left a window where the sidebar had neither the
        // placeholder row nor a jsonl-derived row → the session vanished until a
        // reload. Keeping a pending row under the real id bridges that gap;
        // listAllSessionsLegacy de-dups it once the jsonl appears, and the turn's
        // stream_end cleans it up.
        const pendingEntry = pendingSessions.get(key);
        pendingSessions.delete(key);
        if (pendingEntry) pendingSessions.set(resolvedSessionId, pendingEntry);
        broadcast(resolvedSessionId, { type: 'session_assigned', placeholderId: key, sessionId: resolvedSessionId });
        broadcast(resolvedSessionId, { type: 'sessions_list', sessions: listAllSessionsLegacy() });
      }

      if (!interceptedAUQ && event.type === 'assistant') {
        const content = event.message && event.message.content;
        if (Array.isArray(content)) {
          const auq = content.find(b => b && b.type === 'tool_use' && b.name === 'AskUserQuestion');
          if (auq) {
            interceptedAUQ = {
              toolUseId: auq.id,
              questions: (auq.input && auq.input.questions) || [],
            };
            setTimeout(() => { try { procTracker.cancel(resolvedSessionId || key); } catch {} }, 200);
          }
        }
      }

      const bk = resolvedSessionId || key;
      liveTurn.record(bk, event);
      broadcast(bk, { type: 'stream_event', sessionId: bk, event });
    }
  } catch (err) {
    const bk = resolvedSessionId || key;
    if (!runnerState(bk)?.cancelling && !runnerState(key)?.cancelling) {
      broadcast(bk, { type: 'error', message: err.message, sessionId: bk });
    }
  } finally {
    const bk = resolvedSessionId || key;
    // Persist attachments instead of deleting them: move each out of the
    // project's .upload-files (keeping the working dir clean) into the
    // server-managed attachments/<session>/ store, so they stay viewable later
    // via GET /attachment. Best-effort — a failure just leaves the file in place.
    for (const p of imagePaths) {
      try {
        const destDir = sessionDir(bk);
        fs.mkdirSync(destDir, { recursive: true });
        const dest = path.join(destDir, path.basename(p));
        try { fs.renameSync(p, dest); }
        catch { fs.copyFileSync(p, dest); fs.unlinkSync(p); } // cross-device
      } catch {}
    }

    if (interceptedAUQ && bk) {
      try {
        const tail = jsonlReader.readTailEntry(bk, directory);
        const parentUuid = tail && typeof tail.uuid === 'string' ? tail.uuid : null;
        const entry = {
          parentUuid,
          sessionId: bk,
          type: 'user',
          isMeta: false,
          uuid: uuidv4(),
          timestamp: new Date().toISOString(),
          cwd: directory,
          message: {
            role: 'user',
            content: [{
              type: 'tool_result',
              tool_use_id: interceptedAUQ.toolUseId,
              content: 'AskUserQuestion is unsupported in -p mode. The user will respond in plain text in the next prompt.',
              is_error: true,
            }],
          },
        };
        jsonlReader.appendJsonlLine(bk, directory, entry);
      } catch (e) {
        // Non-fatal — resume will surface the dangling tool_use.
      }
      broadcast(bk, {
        type: 'ask_user_question_intercepted',
        sessionId: bk,
        toolUseId: interceptedAUQ.toolUseId,
        questions: interceptedAUQ.questions,
      });
    }

    compactingKeys.delete(key);
    compactingKeys.delete(bk);
    liveTurn.end(key);
    liveTurn.end(bk);
    broadcast(bk, { type: 'stream_end', sessionId: bk });
    if (isNewSession) {
      if (resolvedSessionId) {
        // init arrived → the session jsonl is now on disk, so the jsonl-derived
        // row replaces the transitional pending one. Drop both keys.
        pendingSessions.delete(resolvedSessionId);
        pendingSessions.delete(key);
      } else if (pendingSessions.has(key)) {
        // init never came (turn errored before it) → keep the placeholder so the
        // user can retry; just freshen its activity time.
        pendingSessions.get(key).lastActivity = Date.now();
      }
      // Push a refreshed list so the sidebar row updates to its real title/preview.
      broadcast(bk, { type: 'sessions_list', sessions: listAllSessionsLegacy() });
    }
  }

  return resolvedSessionId || key;
}

// Runs a single SHARED (alpha) turn for `key` — a canonical conversation whose id
// carries the `xsync_` prefix. The agent (claude|codex) is whatever the client
// last selected for this session; both peers append to the same canonical store.
// The reply is broadcast as Claude-shaped stream events so the existing renderer
// paints it. The id is a stable conversation id, so it never re-keys → returns key.
async function runSyncTurn(key, directory, prompt, imagePaths, agentArg, modelArg, effortArg) {
  // Prefer the per-segment agent/model/effort the runner passes (captured at
  // enqueue time); fall back to the session's last-selected values for ad-hoc
  // callers.
  const agent = agentArg || sessionAgent.get(key) || 'claude';
  const model = modelArg !== undefined ? modelArg : (sessionModel.get(key) || undefined);
  const effort = effortArg !== undefined ? effortArg : (sessionEffort.get(key) || undefined);
  liveTurn.begin(key, { prompt, images: imagePaths, compact: false });
  broadcast(key, {
    type: 'stream_start', sessionId: key, compact: false, prompt,
    images: imagePaths.map(p => path.basename(p)), agent,
  });
  try {
    await syncBridge.runSyncTurn({
      conversationId: key, agent, prompt, cwd: directory, model, effort, imagePaths,
      processKey: key,
      onEvent: (event) => {
        liveTurn.record(key, event);
        broadcast(key, { type: 'stream_event', sessionId: key, event });
      },
    });
  } catch (err) {
    if (!runnerState(key)?.cancelling) {
      broadcast(key, { type: 'error', message: `[${agent}] ${err.message}`, sessionId: key });
    }
  } finally {
    // Persist uploaded images to the per-session attachment store so they remain
    // viewable via /attachment after the turn (same as runOneTurn does).
    for (const p of imagePaths) {
      try {
        const destDir = sessionDir(key);
        fs.mkdirSync(destDir, { recursive: true });
        const dest = path.join(destDir, path.basename(p));
        try { fs.renameSync(p, dest); }
        catch { fs.copyFileSync(p, dest); fs.unlinkSync(p); }
      } catch {}
    }
    liveTurn.end(key);
    broadcast(key, { type: 'stream_end', sessionId: key });
  }
  return key;
}

// Every Claude session id currently reachable from the GUI (visible OR
// archived) plus any in-flight placeholders. Used by shell cleanup to decide
// which `ccr-*` tmux sessions are true orphans.
function knownSessionIds() {
  const ids = new Set();
  for (const p of projectsStore.loadProjects()) {
    for (const s of jsonlReader.listJsonlsForProject(p.path)) ids.add(s.sessionId);
  }
  for (const pid of pendingSessions.keys()) ids.add(pid);
  return [...ids];
}

function handleConnection(ws /*, req */) {
  ws.on('close', () => {
    unsubscribe(ws);
    unwatchWs(ws);
    // Detach this client's shell (tmux session lives on for re-attach).
    if (ws._shell) { try { ws._shell.kill(); } catch {} ws._shell = null; }
  });

  ws.on('message', async (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); }
    catch { send(ws, { type: 'error', message: 'Invalid JSON' }); return; }

    switch (msg.type) {

      // ─── Project management ────────────────────────────────────────────────

      case 'list_projects':
        send(ws, { type: 'projects_list', projects: projectsStore.loadProjects() });
        break;

      case 'add_project': {
        try {
          const entry = projectsStore.addProject({ path: msg.path, name: msg.name });
          // Auto-archive existing jsonls under this folder so they don't
          // suddenly clutter the sidebar; user can restore via ↻ modal.
          const existing = jsonlReader.listJsonlsForProject(entry.path);
          if (existing.length) archiveStore.archiveMany(existing.map(e => e.sessionId));
          send(ws, { type: 'project_added', project: entry, autoArchived: existing.length });
          send(ws, { type: 'projects_list', projects: projectsStore.loadProjects() });
        } catch (err) {
          send(ws, { type: 'error', message: err.message });
        }
        break;
      }

      case 'remove_project': {
        const ok = projectsStore.removeProject(msg.id || msg.path);
        send(ws, { type: 'project_removed', ok });
        send(ws, { type: 'projects_list', projects: projectsStore.loadProjects() });
        break;
      }

      // ─── Settings: sandbox write allow-lists ───────────────────────────────

      case 'system_settings_get':
        send(ws, { type: 'system_settings', writablePaths: projectsStore.getSystemWritablePaths() });
        break;

      case 'system_settings_set': {
        try {
          const paths = projectsStore.setSystemWritablePaths(msg.paths || []);
          send(ws, { type: 'system_settings', writablePaths: paths, saved: true });
        } catch (err) {
          send(ws, { type: 'error', message: err.message });
        }
        break;
      }

      case 'project_settings_get': {
        const proj = projectsStore.getProject(msg.projectId);
        if (!proj) { send(ws, { type: 'error', message: 'project not found' }); break; }
        send(ws, { type: 'project_settings', project: proj, writablePaths: proj.writablePaths || [] });
        break;
      }

      case 'project_settings_set': {
        try {
          const proj = projectsStore.setProjectWritablePaths(msg.projectId, msg.paths || []);
          send(ws, { type: 'project_settings', project: proj, writablePaths: proj.writablePaths || [], saved: true });
          send(ws, { type: 'projects_list', projects: projectsStore.loadProjects() });
        } catch (err) {
          send(ws, { type: 'error', message: err.message });
        }
        break;
      }

      // ─── Shared-history import / export (forward-compat) ───────────────────

      case 'port_list_sources': {
        const proj = projectsStore.getProject(msg.projectId);
        const cwd = (proj && proj.path) || msg.cwd;
        if (!cwd) { send(ws, { type: 'error', message: 'project not found' }); break; }
        try {
          const sources = historyPort.listImportSources(cwd);
          const shared = historyPort.listSharedFor(cwd);
          send(ws, { type: 'port_sources', projectId: msg.projectId, cwd, ...sources, shared });
        } catch (err) {
          send(ws, { type: 'error', message: err.message });
        }
        break;
      }

      case 'port_import': {
        const proj = projectsStore.getProject(msg.projectId);
        const cwd = (proj && proj.path) || msg.cwd;
        try {
          const res = historyPort.importSession({
            agent: msg.agent, sessionId: msg.sessionId, file: msg.file, cwd,
          });
          send(ws, { type: 'port_imported', ...res });
          // Surface the new shared session in the sidebar immediately. Canonical
          // sessions only — the just-imported native source stays in the import
          // modal, it is not promoted to a peer sidebar entry.
          if (cwd) {
            const archived = new Set(archiveStore.load());
            const list = sharedSessionsLegacy(cwd, archived, null);
            send(ws, { type: 'sessions_list', projectPath: cwd, sessions: list });
          }
        } catch (err) {
          send(ws, { type: 'error', message: err.message });
        }
        break;
      }

      case 'port_export': {
        const cwd = msg.cwd || syncBridge.directoryFor(msg.conversationId);
        try {
          const res = historyPort.exportSession({
            conversationId: msg.conversationId, agent: msg.agent, cwd,
          });
          send(ws, { type: 'port_exported', conversationId: msg.conversationId, ...res });
        } catch (err) {
          send(ws, { type: 'error', message: err.message });
        }
        break;
      }

      // ─── Session listing ───────────────────────────────────────────────────

      case 'list_sessions': {
        if (msg.projectPath) {
          const archived = new Set(archiveStore.load());
          // Canonical-only: native jsonl sessions live in the import modal, not
          // the sidebar (see listAllSessionsLegacy).
          const list = sharedSessionsLegacy(msg.projectPath, archived, null);
          send(ws, { type: 'sessions_list', projectPath: msg.projectPath, sessions: list });
        } else {
          send(ws, { type: 'sessions_list', sessions: listAllSessionsLegacy() });
        }
        break;
      }

      case 'list_archived': {
        const projectPath = msg.projectPath;
        if (!projectPath) { send(ws, { type: 'error', message: 'projectPath required' }); return; }
        const archived = new Set(archiveStore.load());
        const sessions = jsonlReader.listJsonlsForProject(projectPath).map(s => ({
          sessionId: s.sessionId,
          mtime: s.mtime,
          archived: archived.has(s.sessionId),
          aiTitle: jsonlReader.getLatestAiTitle(s.sessionId, projectPath),
          preview: jsonlReader.firstUserPreview(s.sessionId, projectPath),
        }));
        send(ws, { type: 'archived_list', projectPath, sessions });
        break;
      }

      // ─── Session create / delete / archive / restore / purge ───────────────

      case 'create_session': {
        // Compat path: generate a placeholder id and remember its directory.
        // The first send_prompt with this id spawns claude without --resume
        // and captures the real session_id from the init event.
        const directory = msg.directory;
        if (!directory) { send(ws, { type: 'error', message: 'directory required' }); return; }
        const placeholderId = uuidv4();
        const now = Date.now();
        pendingSessions.set(placeholderId, { directory, createdAt: now, lastActivity: now });
        const session = {
          id: placeholderId,
          sessionId: null,
          directory,
          createdAt: new Date(now).toISOString(),
          lastActivity: new Date(now).toISOString(),
          streaming: false,
          allowedTools: null,
          lastTokens: null,
        };
        send(ws, { type: 'session_created', session });
        send(ws, { type: 'sessions_list', sessions: listAllSessionsLegacy() });
        break;
      }

      case 'create_shared_session': {
        // Canonical-first new session. The SERVER mints the id and persists an
        // empty transcript immediately (cwd-bound, provider-neutral) so the
        // session is durable from the instant of creation — reload-safe, visible
        // in the sidebar, and seen by other devices — instead of living only in
        // one browser's memory until the first turn writes it.
        const directory = msg.directory;
        if (!directory) { send(ws, { type: 'error', message: 'directory required' }); return; }
        const id = syncBridge.newSyncId();
        const transcript = historyStore.load(id, { cwd: directory });
        transcript.cwd = directory;
        transcript.providerIds = {};
        const selection = setTranscriptSelection(transcript, {});
        historyStore.save(transcript);
        subscribe(id, ws);
        watchDir(directory, ws);
        send(ws, { type: 'shared_session_created', sessionId: id, directory, selection });
        send(ws, { type: 'sessions_list', sessions: listAllSessionsLegacy() });
        break;
      }

      case 'set_session_selection': {
        const sid = msg.sessionId;
        if (!sid || !syncBridge.isSyncId(sid)) {
          send(ws, { type: 'error', message: 'shared sessionId required' });
          break;
        }
        try {
          const transcript = historyStore.load(sid, {});
          const selection = setTranscriptSelection(transcript, msg.patch || {});
          historyStore.save(transcript);
          sessionAgent.set(sid, selection.selectedAgent);
          sessionModel.set(sid, selection.models[selection.selectedAgent]);
          const effort = selection.efforts[selection.selectedAgent];
          if (effort) sessionEffort.set(sid, effort);
          else sessionEffort.delete(sid);
          broadcast(sid, { type: 'selection_updated', sessionId: sid, selection });
        } catch (err) {
          send(ws, { type: 'error', message: err.message, sessionId: sid });
        }
        break;
      }

      case 'delete_session': {
        const sid = msg.sessionId;
        if (!sid) { send(ws, { type: 'error', message: 'sessionId required' }); return; }
        if (pendingSessions.has(sid)) {
          procTracker.cancel(sid);
          pendingSessions.delete(sid);
        } else {
          procTracker.cancel(sid);
          archiveStore.archive(sid);
        }
        send(ws, { type: 'session_deleted', sessionId: sid });
        send(ws, { type: 'sessions_list', sessions: listAllSessionsLegacy() });
        break;
      }

      case 'archive_session': {
        const sid = msg.sessionId;
        if (!sid) { send(ws, { type: 'error', message: 'sessionId required' }); return; }
        procTracker.cancel(sid);
        // Pending placeholders are in-memory only — drop them outright
        // instead of just archiving the placeholder string.
        if (pendingSessions.has(sid)) pendingSessions.delete(sid);
        else archiveStore.archive(sid);
        send(ws, { type: 'archive_ok', sessionId: sid });
        send(ws, { type: 'sessions_list', sessions: listAllSessionsLegacy() });
        break;
      }

      case 'rename_session': {
        const sid = msg.sessionId;
        if (!sid) { send(ws, { type: 'error', message: 'sessionId required' }); return; }
        nameStore.set(sid, msg.name);
        send(ws, { type: 'rename_ok', sessionId: sid, name: nameStore.get(sid) });
        send(ws, { type: 'sessions_list', sessions: listAllSessionsLegacy() });
        break;
      }

      case 'restore_session': {
        const sid = msg.sessionId;
        if (!sid) { send(ws, { type: 'error', message: 'sessionId required' }); return; }
        archiveStore.restore(sid);
        send(ws, { type: 'restore_ok', sessionId: sid });
        send(ws, { type: 'sessions_list', sessions: listAllSessionsLegacy() });
        break;
      }

      case 'purge_session': {
        const sid = msg.sessionId;
        // Pending placeholder: no jsonl exists yet, just drop the in-memory entry.
        if (sid && pendingSessions.has(sid)) {
          procTracker.cancel(sid);
          pendingSessions.delete(sid);
          send(ws, { type: 'purge_ok', sessionId: sid });
          send(ws, { type: 'sessions_list', sessions: listAllSessionsLegacy() });
          break;
        }
        const dir = msg.directory || findDirectoryForSessionId(sid);
        if (!sid || !dir) { send(ws, { type: 'error', message: 'sessionId and directory required' }); return; }
        sm.purgeSession(sid, dir);
        nameStore.remove(sid);
        send(ws, { type: 'purge_ok', sessionId: sid });
        send(ws, { type: 'sessions_list', sessions: listAllSessionsLegacy() });
        break;
      }

      // ─── Attach / cancel / summary / permissions ──────────────────────────

      case 'attach': {
        const sid = msg.sessionId;
        if (!sid) { send(ws, { type: 'error', message: 'sessionId required' }); return; }

        // Shared (alpha) conversation: history comes from the canonical store, not
        // a native jsonl. Entries are pre-normalized into the renderer's shape.
        if (syncBridge.isSyncId(sid)) {
          subscribe(sid, ws);
          const { entries, directory, selection } = syncBridge.loadHistoryEntries(sid, msg.directory);
          if (directory) watchDir(directory, ws);
          send(ws, {
            type: 'history',
            sessionId: sid,
            directory: directory || '',
            branch: directory ? gitInfo.currentBranch(directory) : '',
            history: entries,
            streaming: runners.has(sid),
            selection,
            liveTurn: liveTurnPayload(sid),
            currentEntry: null,
            allowedTools: null,
            lastTokens: null,
          });
          send(ws, queueStateMsg(sid));
          send(ws, scheduledStateMsg(sid));
          return;
        }

        if (pendingSessions.has(sid)) {
          subscribe(sid, ws);
          const entry = pendingSessions.get(sid);
          watchDir(entry.directory, ws);
          send(ws, {
            type: 'history',
            sessionId: sid,
            directory: entry.directory,
            history: [],
            streaming: procTracker.isRunning(sid),
            liveTurn: liveTurnPayload(sid),
            currentEntry: null,
            allowedTools: null,
            lastTokens: null,
          });
          send(ws, queueStateMsg(sid));
        send(ws, scheduledStateMsg(sid));
          return;
        }

        const directory = msg.directory || findDirectoryForSessionId(sid);
        if (!directory) {
          send(ws, {
            type: 'history',
            sessionId: sid,
            directory: '',
            history: [],
            streaming: false,
            currentEntry: null,
            allowedTools: null,
            lastTokens: null,
          });
          return;
        }

        subscribe(sid, ws);
        watchDir(directory, ws);
        const { history, lastTokens, truncated } = jsonlReader.readHistory(sid, directory);
        send(ws, {
          type: 'history',
          sessionId: sid,
          directory,
          branch: gitInfo.currentBranch(directory),
          history,
          truncated,
          streaming: procTracker.isRunning(sid),
          compacting: compactingKeys.has(sid) ? compactingKeys.get(sid) : null,
          liveTurn: liveTurnPayload(sid),
          currentEntry: null,
          allowedTools: null,
          lastTokens,
        });
        send(ws, queueStateMsg(sid));
        send(ws, scheduledStateMsg(sid));
        break;
      }

      case 'ping':
        // Client heartbeat. Reply so the client can detect a half-open socket
        // (common on mobile when backgrounded / on a network handoff) and force
        // a reconnect instead of getting stuck on a stale "Working" state.
        send(ws, { type: 'pong' });
        break;

      case 'cancel':
        // Stop the current turn AND drop everything queued behind it.
        markRunnerCancelling(msg.sessionId);
        procTracker.cancel(msg.sessionId);
        if (msg.sessionId) {
          promptQueue.clear(msg.sessionId);
          liveTurn.end(msg.sessionId);
          broadcastQueue(msg.sessionId);
          // Always flip every live client off "Working", even if the process
          // had already finished (so cancel() was a no-op and no stream_end
          // would otherwise fire). Idempotent on the client.
          broadcast(msg.sessionId, { type: 'stream_end', sessionId: msg.sessionId, cancelled: true });
        }
        break;

      case 'update_permissions':
        // Permissions are no longer per-session — claude always runs with
        // --dangerously-skip-permissions. Echo back for compat with old UI.
        send(ws, { type: 'permissions_updated', sessionId: msg.sessionId, allowedTools: msg.allowedTools || null });
        break;

      case 'request_summary': {
        const sid = msg.sessionId;
        const dir = msg.directory || findDirectoryForSessionId(sid);
        if (!sid || !dir) { send(ws, { type: 'summary_error', sessionId: sid, message: 'session not found' }); return; }
        try {
          const text = await sm.summarizeSession(sid, dir);
          send(ws, { type: 'summary', sessionId: sid, text });
        } catch (err) {
          send(ws, { type: 'summary_error', sessionId: sid, message: err.message });
        }
        break;
      }

      // ─── File browser (for the folder picker) ─────────────────────────────

      case 'browse_dir': {
        let dir = msg.path;
        if (!dir) dir = projectsStore.getAccessRoot() || os.homedir();
        const absDir = path.resolve(dir);
        if (!projectsStore.isBrowseAllowed(absDir)) {
          send(ws, { type: 'dir_listing', path: absDir, error: 'Access denied' });
          return;
        }
        try {
          const entries = fs.readdirSync(absDir, { withFileTypes: true });
          const items = entries
            .map(e => ({
              name: e.name,
              isDir: e.isDirectory(),
              hidden: e.name.startsWith('.'),
            }))
            .sort((a, b) => {
              if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
              return a.name.localeCompare(b.name);
            });
          send(ws, {
            type: 'dir_listing',
            path: absDir,
            parent: path.dirname(absDir),
            items,
            canAddHere: !projectsStore.findProjectByPath(absDir) && fs.existsSync(absDir),
          });
        } catch (err) {
          send(ws, { type: 'dir_listing', path: absDir, error: err.message });
        }
        break;
      }

      case 'create_folder': {
        const parent = msg.parent;
        const name = msg.name;
        if (!parent || !name) { send(ws, { type: 'error', message: 'parent and name required' }); return; }
        if (!/^[a-zA-Z0-9_.\- ]+$/.test(name)) { send(ws, { type: 'error', message: 'Invalid folder name (letters, digits, _.- and spaces only)' }); return; }
        const target = path.join(path.resolve(parent), name);
        if (!projectsStore.isBrowseAllowed(target)) { send(ws, { type: 'error', message: 'Access denied' }); return; }
        try {
          fs.mkdirSync(target, { recursive: false });
          send(ws, { type: 'folder_created', path: target });
        } catch (err) {
          send(ws, { type: 'error', message: err.message });
        }
        break;
      }

      // ─── Git branch ────────────────────────────────────────────────────────

      case 'list_branches': {
        const dir = msg.directory || findDirectoryForSessionId(msg.sessionId);
        if (!dir) { send(ws, { type: 'branch_list', directory: '', branches: [], current: null, error: 'directory unknown' }); return; }
        const absDir = path.resolve(dir);
        if (!projectsStore.isBrowseAllowed(absDir)) { send(ws, { type: 'branch_list', directory: absDir, branches: [], current: null, error: 'Access denied' }); return; }
        send(ws, {
          type: 'branch_list',
          directory: absDir,
          branches: gitInfo.listBranches(absDir),
          current: gitInfo.currentBranch(absDir),
        });
        break;
      }

      case 'switch_branch': {
        const dir = msg.directory || findDirectoryForSessionId(msg.sessionId);
        const branch = msg.branch;
        if (!dir || !branch) { send(ws, { type: 'branch_switched', ok: false, error: 'directory and branch required' }); return; }
        const absDir = path.resolve(dir);
        if (!projectsStore.isBrowseAllowed(absDir)) { send(ws, { type: 'branch_switched', directory: absDir, ok: false, error: 'Access denied' }); return; }
        // Refuse while any Claude turn is streaming in this directory — a
        // checkout would swap files out from under the running process.
        const busy = procTracker.runningKeys().some(k => {
          const d = pendingSessions.has(k) ? pendingSessions.get(k).directory : findDirectoryForSessionId(k);
          return d && path.resolve(d) === absDir;
        });
        if (busy) { send(ws, { type: 'branch_switched', directory: absDir, ok: false, busy: true, error: 'このフォルダでセッションが実行中です。完了してから切り替えてください。' }); return; }
        // Only switch to a known local branch (also blocks checking out an
        // arbitrary ref / path supplied by a rogue client).
        if (!gitInfo.listBranches(absDir).includes(branch)) { send(ws, { type: 'branch_switched', directory: absDir, ok: false, error: 'unknown branch: ' + branch }); return; }
        const res = gitInfo.checkoutBranch(absDir, branch);
        if (res.ok) {
          const cur = gitInfo.currentBranch(absDir);
          // Keep the poll cache in step and push the new branch to every client
          // viewing this directory (reactive pill update for the initiator too).
          dirBranch.set(absDir, cur);
          broadcastBranch(absDir, cur);
          send(ws, { type: 'branch_switched', directory: absDir, ok: true, branch: cur });
        } else {
          send(ws, { type: 'branch_switched', directory: absDir, ok: false, error: res.error });
        }
        break;
      }

      // ─── Prompt streaming ──────────────────────────────────────────────────

      case 'send_prompt': {
        const { prompt, imagePaths = [] } = msg;
        const { sessionId } = msg;
        let directory = msg.directory;

        if (!prompt && imagePaths.length === 0) { send(ws, { type: 'error', message: 'prompt required' }); return; }
        if (!sessionId) { send(ws, { type: 'error', message: 'sessionId required' }); return; }

        const placeholder = pendingSessions.get(sessionId);
        if (placeholder) directory = directory || placeholder.directory;
        else if (!directory) directory = findDirectoryForSessionId(sessionId);

        let enqAgent;
        let enqModel;
        let enqEffort;
        // Shared (alpha) sessions carry no native jsonl, so fall back to the cwd
        // remembered in the canonical store, and record the per-turn agent choice.
        if (syncBridge.isSyncId(sessionId)) {
          if (!directory) directory = syncBridge.directoryFor(sessionId);
          const selection = loadSelectionForSession(sessionId, directory);
          enqAgent = msg.agent === 'codex' || msg.agent === 'claude'
            ? msg.agent
            : selection.selectedAgent;
          enqModel = typeof msg.model === 'string' && msg.model
            ? msg.model
            : selection.models[enqAgent];
          enqEffort = typeof msg.effort === 'string'
            ? msg.effort
            : selection.efforts[enqAgent];
          sessionAgent.set(sessionId, enqAgent);
          if (enqModel) sessionModel.set(sessionId, enqModel);
          else sessionModel.delete(sessionId);
          if (enqEffort) sessionEffort.set(sessionId, enqEffort);
          else sessionEffort.delete(sessionId);
        }

        if (!directory) {
          send(ws, { type: 'error', message: 'directory could not be determined', sessionId });
          return;
        }

        // Drop a duplicate /compact: a double-tapped compact button (the second
        // tap slips through before the server's stream_start flips the client's
        // isStreaming) would otherwise queue two /compact and run two compact
        // turns. Also avoids dequeueAll joining them into "/compact\n\n/compact",
        // which isCompactCmd wouldn't recognise as a compact at all.
        if (typeof prompt === 'string' && prompt.trim() === '/compact') {
          const pending = promptQueue.list(sessionId) || [];
          if (compactingKeys.has(sessionId)
              || pending.some(i => (i.text || '').trim() === '/compact')) {
            broadcastQueue(sessionId);
            break;
          }
        }

        // Enqueue and (re)start the runner. If a turn is already streaming this
        // prompt accumulates and is batched into the next turn; otherwise the
        // runner picks it up immediately. The runner is browser-independent —
        // it keeps draining even if this socket closes.
        subscribe(sessionId, ws);
        promptQueue.enqueue(sessionId, { text: prompt, imagePaths, agent: enqAgent, model: enqModel, effort: enqEffort });
        broadcastQueue(sessionId);
        kickRunner(sessionId, directory);
        break;
      }

      case 'dequeue_item': {
        if (msg.sessionId && msg.id) {
          promptQueue.remove(msg.sessionId, msg.id);
          broadcastQueue(msg.sessionId);
        }
        break;
      }

      case 'clear_queue': {
        if (msg.sessionId) {
          promptQueue.clear(msg.sessionId);
          broadcastQueue(msg.sessionId);
        }
        break;
      }

      // ─── Scheduled (reserved) prompts ─────────────────────────────────────

      case 'schedule_prompt': {
        const { prompt, imagePaths = [], fireAt } = msg;
        const { sessionId } = msg;
        let directory = msg.directory;

        if (!prompt && imagePaths.length === 0) { send(ws, { type: 'error', message: 'prompt required' }); return; }
        if (!sessionId) { send(ws, { type: 'error', message: 'sessionId required' }); return; }
        if (typeof fireAt !== 'number' || !isFinite(fireAt)) { send(ws, { type: 'error', message: 'fireAt (epoch ms) required' }); return; }

        const placeholder = pendingSessions.get(sessionId);
        if (placeholder) directory = directory || placeholder.directory;
        else if (!directory) directory = findDirectoryForSessionId(sessionId);
        let schedAgent;
        let schedModel;
        let schedEffort;
        if (syncBridge.isSyncId(sessionId)) {
          if (!directory) directory = syncBridge.directoryFor(sessionId);
          const selection = loadSelectionForSession(sessionId, directory);
          schedAgent = msg.agent === 'codex' || msg.agent === 'claude'
            ? msg.agent
            : selection.selectedAgent;
          schedModel = typeof msg.model === 'string' && msg.model
            ? msg.model
            : selection.models[schedAgent];
          schedEffort = typeof msg.effort === 'string'
            ? msg.effort
            : selection.efforts[schedAgent];
        }
        if (!directory) {
          send(ws, { type: 'error', message: 'directory could not be determined', sessionId });
          return;
        }

        subscribe(sessionId, ws);
        // Capture the agent/model at reserve time (shared sessions only) so the
        // reservation fires under what was chosen now, not what's selected later.
        // Already due (clock skew / picked a past time): run it now via the
        // normal queue instead of waiting for the next timer tick.
        if (fireAt <= Date.now()) {
          promptQueue.enqueue(sessionId, { text: prompt, imagePaths, agent: schedAgent, model: schedModel, effort: schedEffort });
          broadcastQueue(sessionId);
          kickRunner(sessionId, directory);
          break;
        }
        scheduledPrompts.add({ sessionId, directory, text: prompt, imagePaths, agent: schedAgent, model: schedModel, effort: schedEffort, fireAt });
        broadcastScheduled(sessionId);
        break;
      }

      case 'cancel_scheduled': {
        if (msg.sessionId && msg.id) {
          scheduledPrompts.remove(msg.sessionId, msg.id);
          broadcastScheduled(msg.sessionId);
        }
        break;
      }

      // ─── Persistent shell (tmux-backed PTY) ───────────────────────────────

      case 'shell_attach': {
        const sid = msg.sessionId;
        if (!sid) { send(ws, { type: 'shell_error', message: 'sessionId required' }); break; }
        let directory = msg.directory
          || (pendingSessions.get(sid) || {}).directory
          || findDirectoryForSessionId(sid);
        // One shell pty per socket — drop any prior one (detaches its tmux).
        if (ws._shell) { try { ws._shell.kill(); } catch {} ws._shell = null; }
        let term;
        try { term = shell.open(sid, directory, msg.cols, msg.rows); }
        catch (e) { send(ws, { type: 'shell_error', message: e.message }); break; }
        ws._shell = term;
        term.onData(d => send(ws, { type: 'shell_output', data: d }));
        term.onExit(() => {
          if (ws._shell === term) ws._shell = null;
          send(ws, { type: 'shell_exit' });
        });
        send(ws, { type: 'shell_attached', sessionId: sid, directory: directory || '' });
        break;
      }

      case 'shell_input':
        if (ws._shell && typeof msg.data === 'string') { try { ws._shell.write(msg.data); } catch {} }
        break;

      case 'shell_resize':
        if (ws._shell && msg.cols && msg.rows) { try { ws._shell.resize(msg.cols, msg.rows); } catch {} }
        break;

      case 'shell_detach':
        // Close the modal: detach the pty, leave tmux running for re-attach.
        if (ws._shell) { try { ws._shell.kill(); } catch {} ws._shell = null; }
        break;

      case 'shell_cleanup': {
        // Kill every ccr-* tmux session not reachable from the GUI.
        const killed = shell.cleanupOrphans(knownSessionIds());
        send(ws, { type: 'shell_cleanup_done', killed });
        break;
      }

      default:
        send(ws, { type: 'error', message: `Unknown message type: ${msg.type}` });
    }
  });
}

module.exports = { handleConnection, getSlashCommands };
