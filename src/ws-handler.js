'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const procTracker = require('./proc-tracker');
const projectsStore = require('./projects-store');
const archiveStore = require('./archive-store');
const nameStore = require('./name-store');
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

// sessionId → Set<ws>  (all clients watching that conversation)
const sessionClients = new Map();

// Shared (alpha) conversations only: the agent the client last selected for the
// session (claude|codex). Per-session and independent — switching here changes
// which peer runs the NEXT turn, while the canonical history stays shared.
const sessionAgent = new Map();

// Shared (alpha) conversations only: the model the client last selected for the
// session, sent per-turn alongside the agent. Empty/unset → let the agent CLI use
// its own default. Per-item model (Phase 2 queue) overrides this fallback.
const sessionModel = new Map();

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
// The set of slash commands (skills + built-ins) valid in the agent environment
// is environment-wide and effectively static, so we serve the persisted list to
// the prompt-box picker. The file is seeded out-of-band and survives restarts.
const SLASH_FILE = path.join(__dirname, '..', 'data', 'slash-commands.json');
let slashCommandsCache = (() => {
  try { const a = JSON.parse(fs.readFileSync(SLASH_FILE, 'utf8')); return Array.isArray(a) ? a.filter(c => typeof c === 'string') : []; }
  catch { return []; }
})();

function getSlashCommands() { return slashCommandsCache; }

function subscribe(key, ws) {
  if (!key) return;
  if (!sessionClients.has(key)) sessionClients.set(key, new Set());
  sessionClients.get(key).add(ws);
}

function unsubscribe(ws) {
  for (const [, clients] of sessionClients) clients.delete(ws);
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

// Look up a conversation's working directory from the canonical store.
function findDirectoryForSessionId(sessionId) {
  return syncBridge.directoryFor(sessionId) || null;
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

// v2 is canonical-first: the sidebar lists ONLY shared (canonical) sessions.
// Native agent session files are legacy artifacts — never the truth, and
// reachable solely through the per-project import modal (port_list_sources),
// not as peer entries here.
function listAllSessionsLegacy() {
  const archived = new Set(archiveStore.load());
  return sharedSessionsLegacy(null, archived, null);
}

// ─── Server-side prompt queue + runner ─────────────────────────────────────
//
// Prompts are queued per session and drained by a single browser-independent
// runner loop. While a turn is streaming, freshly sent prompts accumulate;
// when the turn ends the runner pulls ALL of them and submits them as one
// batched prompt (blank-line joined). The loop lives in the server process,
// so closing the browser doesn't stop it — the next batch still fires.

const runners = new Set(); // sessionIds with an active runner

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
// Every conversation is a canonical (xsync_) shared session, so the id is stable
// for the runner's whole life — no re-keying.
function kickRunner(key, directory) {
  if (runners.has(key)) return;
  runners.add(key);
  (async () => {
    try {
      while (true) {
        // Reservations first: pull this session's due ones and batch them ahead
        // of the live queue. Re-checked at the top of every turn, so a reserva-
        // tion whose time passed mid-turn fires the moment this turn finishes.
        const due = scheduledPrompts.takeDueFor(key, Date.now());
        if (due.length) broadcastScheduled(key);
        const items = [
          ...due.map(i => ({ id: i.id, text: i.text, imagePaths: i.imagePaths, agent: i.agent, model: i.model })),
          ...promptQueue.dequeueAll(key),
        ];
        if (!items.length) break;
        broadcastQueue(key); // queue just drained → empty
        // Split into contiguous same-agent runs so a Claude batch and a Codex
        // batch never merge into one turn — run them in order.
        for (const seg of segmentByAgent(items)) {
          const text = seg.items.map(i => i.text).join('\n\n');
          const images = seg.items.flatMap(i => i.imagePaths || []);
          // A batched segment runs under the model of its first item (all items
          // share an agent; model is usually constant within a run).
          const segModel = seg.items.find(i => i.model)?.model;
          await runSyncTurn(key, directory, text, images, seg.agent, segModel);
        }
      }
    } catch (e) {
      console.error('[prompt-queue runner]', e);
    } finally {
      runners.delete(key);
    }
  })();
}

// Runs a single SHARED turn for `key` — a canonical conversation whose id
// carries the `xsync_` prefix. The agent (claude|codex) is whatever the client
// last selected for this session; both peers append to the same canonical store.
// The reply is broadcast as Claude-shaped stream events so the existing renderer
// paints it. The id is a stable conversation id, so it never re-keys → returns key.
async function runSyncTurn(key, directory, prompt, imagePaths, agentArg, modelArg) {
  // Prefer the per-segment agent/model the runner passes (captured at enqueue
  // time); fall back to the session's last-selected values for ad-hoc callers.
  const agent = agentArg || sessionAgent.get(key) || 'claude';
  const model = modelArg !== undefined ? modelArg : (sessionModel.get(key) || undefined);
  liveTurn.begin(key, { prompt, images: imagePaths, compact: false });
  broadcast(key, {
    type: 'stream_start', sessionId: key, compact: false, prompt,
    images: imagePaths.map(p => path.basename(p)), agent,
  });
  try {
    await syncBridge.runSyncTurn({
      conversationId: key, agent, prompt, cwd: directory, model, imagePaths,
      onEvent: (event) => {
        liveTurn.record(key, event);
        broadcast(key, { type: 'stream_event', sessionId: key, event });
      },
    });
  } catch (err) {
    broadcast(key, { type: 'error', message: `[${agent}] ${err.message}`, sessionId: key });
  } finally {
    liveTurn.end(key);
    broadcast(key, { type: 'stream_end', sessionId: key });
  }
  return key;
}

// Every Claude session id currently reachable from the GUI (visible OR
// archived). Used by shell cleanup to decide which `ccr-*` tmux sessions are
// true orphans.
function knownSessionIds() {
  const ids = new Set();
  for (const t of historyStore.list()) {
    if (syncBridge.isSyncId(t.id)) ids.add(t.id);
  }
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
          send(ws, { type: 'project_added', project: entry });
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
        // Archived CANONICAL conversations for this project — the only kind v2
        // has. Restoring one un-hides it back into the sidebar.
        const projectPath = msg.projectPath;
        if (!projectPath) { send(ws, { type: 'error', message: 'projectPath required' }); return; }
        const archived = new Set(archiveStore.load());
        const sessions = historyStore.list()
          .filter(t => syncBridge.isSyncId(t.id) && archived.has(t.id) && (t.cwd || '') === projectPath)
          .map(t => {
            const firstUser = (t.turns || []).find(x => x.role === 'user');
            const preview = firstUser
              ? (firstUser.parts || []).filter(p => p.type === 'text').map(p => p.text).join(' ').trim().slice(0, 120)
              : '';
            return { sessionId: t.id, mtime: t._mtime || 0, archived: true, aiTitle: t.title || '', preview };
          })
          .sort((a, b) => b.mtime - a.mtime);
        send(ws, { type: 'archived_list', projectPath, sessions });
        break;
      }

      // ─── Session create / delete / archive / restore / purge ───────────────

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
        historyStore.save(transcript);
        subscribe(id, ws);
        watchDir(directory, ws);
        send(ws, { type: 'shared_session_created', sessionId: id, directory });
        send(ws, { type: 'sessions_list', sessions: listAllSessionsLegacy() });
        break;
      }

      case 'delete_session': {
        const sid = msg.sessionId;
        if (!sid) { send(ws, { type: 'error', message: 'sessionId required' }); return; }
        procTracker.cancel(sid);
        archiveStore.archive(sid);
        send(ws, { type: 'session_deleted', sessionId: sid });
        send(ws, { type: 'sessions_list', sessions: listAllSessionsLegacy() });
        break;
      }

      case 'archive_session': {
        const sid = msg.sessionId;
        if (!sid) { send(ws, { type: 'error', message: 'sessionId required' }); return; }
        procTracker.cancel(sid);
        archiveStore.archive(sid);
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
        // Physical delete of a canonical conversation: stop any running turn,
        // remove the transcript file, and clear its custom name / archive flag.
        const sid = msg.sessionId;
        if (!sid) { send(ws, { type: 'error', message: 'sessionId required' }); return; }
        procTracker.cancel(sid);
        historyStore.remove(sid);
        nameStore.remove(sid);
        archiveStore.restore(sid);
        send(ws, { type: 'purge_ok', sessionId: sid });
        send(ws, { type: 'sessions_list', sessions: listAllSessionsLegacy() });
        break;
      }

      // ─── Attach / cancel / summary / permissions ──────────────────────────

      case 'attach': {
        const sid = msg.sessionId;
        if (!sid) { send(ws, { type: 'error', message: 'sessionId required' }); return; }

        // Every conversation is a canonical (xsync_) shared session: history comes
        // from the canonical store, pre-normalized into the renderer's shape. An
        // unknown/non-canonical id resolves to an empty transcript.
        subscribe(sid, ws);
        const { entries, directory } = syncBridge.loadHistoryEntries(sid, msg.directory);
        if (directory) watchDir(directory, ws);
        send(ws, {
          type: 'history',
          sessionId: sid,
          directory: directory || '',
          branch: directory ? gitInfo.currentBranch(directory) : '',
          history: entries,
          streaming: runners.has(sid),
          liveTurn: liveTurnPayload(sid),
          currentEntry: null,
          allowedTools: null,
          lastTokens: null,
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
        procTracker.cancel(msg.sessionId);
        if (msg.sessionId) {
          promptQueue.clear(msg.sessionId);
          liveTurn.end(msg.sessionId);
          broadcastQueue(msg.sessionId);
          // Always flip every live client off "Working", even if the process
          // had already finished (so cancel() was a no-op and no stream_end
          // would otherwise fire). Idempotent on the client.
          broadcast(msg.sessionId, { type: 'stream_end', sessionId: msg.sessionId });
        }
        break;

      case 'update_permissions':
        // Permissions are no longer per-session — claude always runs with
        // --dangerously-skip-permissions. Echo back for compat with old UI.
        send(ws, { type: 'permissions_updated', sessionId: msg.sessionId, allowedTools: msg.allowedTools || null });
        break;

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
        // Refuse while any agent turn is streaming in this directory — a
        // checkout would swap files out from under the running process.
        const busy = procTracker.runningKeys().some(k => {
          const d = findDirectoryForSessionId(k);
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

        if (!prompt && imagePaths.length === 0) { send(ws, { type: 'error', message: 'prompt required' }); return; }
        if (!sessionId) { send(ws, { type: 'error', message: 'sessionId required' }); return; }

        // Canonical session: cwd comes from the shared store. Record the per-turn
        // agent/model choice (claude|codex; model empty → CLI default).
        const directory = msg.directory || syncBridge.directoryFor(sessionId);
        const agent = msg.agent === 'codex' ? 'codex' : 'claude';
        const model = (typeof msg.model === 'string' && msg.model) ? msg.model : undefined;
        sessionAgent.set(sessionId, agent);
        if (model) sessionModel.set(sessionId, model);
        else sessionModel.delete(sessionId);

        if (!directory) {
          send(ws, { type: 'error', message: 'directory could not be determined', sessionId });
          return;
        }

        // Drop a duplicate /compact already waiting in the queue: a double-tapped
        // compact button (the second tap slips through before the server's
        // stream_start flips the client's isStreaming) would otherwise queue two.
        if (typeof prompt === 'string' && prompt.trim() === '/compact') {
          const pending = promptQueue.list(sessionId) || [];
          if (pending.some(i => (i.text || '').trim() === '/compact')) {
            broadcastQueue(sessionId);
            break;
          }
        }

        // Enqueue and (re)start the runner. If a turn is already streaming this
        // prompt accumulates and is batched into the next turn; otherwise the
        // runner picks it up immediately. The runner is browser-independent —
        // it keeps draining even if this socket closes.
        subscribe(sessionId, ws);
        promptQueue.enqueue(sessionId, { text: prompt, imagePaths, agent, model });
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

        if (!prompt && imagePaths.length === 0) { send(ws, { type: 'error', message: 'prompt required' }); return; }
        if (!sessionId) { send(ws, { type: 'error', message: 'sessionId required' }); return; }
        if (typeof fireAt !== 'number' || !isFinite(fireAt)) { send(ws, { type: 'error', message: 'fireAt (epoch ms) required' }); return; }

        const directory = msg.directory || syncBridge.directoryFor(sessionId);
        if (!directory) {
          send(ws, { type: 'error', message: 'directory could not be determined', sessionId });
          return;
        }

        subscribe(sessionId, ws);
        // Capture the agent/model at reserve time so the reservation fires under
        // what was chosen now, not what's selected later.
        const schedAgent = msg.agent === 'codex' ? 'codex' : 'claude';
        const schedModel = (typeof msg.model === 'string' && msg.model) ? msg.model : undefined;
        // Already due (clock skew / picked a past time): run it now via the
        // normal queue instead of waiting for the next timer tick.
        if (fireAt <= Date.now()) {
          promptQueue.enqueue(sessionId, { text: prompt, imagePaths, agent: schedAgent, model: schedModel });
          broadcastQueue(sessionId);
          kickRunner(sessionId, directory);
          break;
        }
        scheduledPrompts.add({ sessionId, directory, text: prompt, imagePaths, agent: schedAgent, model: schedModel, fireAt });
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
        let directory = msg.directory || findDirectoryForSessionId(sid);
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
