'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { v4: uuidv4 } = require('uuid');
const sm = require('./session-manager');
const procTracker = require('./proc-tracker');
const projectsStore = require('./projects-store');
const archiveStore = require('./archive-store');
const jsonlReader = require('./jsonl-reader');
const cloneJobs = require('./clone-jobs');

// sessionId or placeholderId → Set<ws>  (all clients watching that key)
const sessionClients = new Map();

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

function sessionToLegacyShape(s, projectPath) {
  return {
    id: s.sessionId,
    sessionId: s.sessionId,
    directory: projectPath,
    lastActivity: new Date(s.mtime).toISOString(),
    streaming: procTracker.isRunning(s.sessionId),
    allowedTools: null,
    lastTokens: null,
    preview: jsonlReader.firstUserPreview(s.sessionId, projectPath),
  };
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

function listAllSessionsLegacy() {
  const archived = new Set(archiveStore.load());
  const out = [];
  for (const p of projectsStore.loadProjects()) {
    const ls = jsonlReader.listJsonlsForProject(p.path);
    for (const s of ls) {
      if (archived.has(s.sessionId)) continue;
      out.push(sessionToLegacyShape(s, p.path));
    }
  }
  for (const [pid, entry] of pendingSessions) {
    if (archived.has(pid)) continue;
    out.push(pendingToLegacyShape(pid, entry));
  }
  return out;
}

function handleConnection(ws /*, req */) {
  ws.on('close', () => unsubscribe(ws));

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

      // ─── Session listing ───────────────────────────────────────────────────

      case 'list_sessions': {
        if (msg.projectPath) {
          const archived = new Set(archiveStore.load());
          const list = jsonlReader.listJsonlsForProject(msg.projectPath)
            .filter(s => !archived.has(s.sessionId))
            .map(s => sessionToLegacyShape(s, msg.projectPath));
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
        send(ws, { type: 'purge_ok', sessionId: sid });
        send(ws, { type: 'sessions_list', sessions: listAllSessionsLegacy() });
        break;
      }

      // ─── Attach / cancel / summary / permissions ──────────────────────────

      case 'attach': {
        const sid = msg.sessionId;
        if (!sid) { send(ws, { type: 'error', message: 'sessionId required' }); return; }

        if (pendingSessions.has(sid)) {
          subscribe(sid, ws);
          const entry = pendingSessions.get(sid);
          send(ws, {
            type: 'history',
            sessionId: sid,
            directory: entry.directory,
            history: [],
            streaming: procTracker.isRunning(sid),
            currentEntry: null,
            allowedTools: null,
            lastTokens: null,
          });
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
        const { history, lastTokens } = jsonlReader.readHistory(sid, directory);
        send(ws, {
          type: 'history',
          sessionId: sid,
          directory,
          history,
          streaming: procTracker.isRunning(sid),
          currentEntry: null,
          allowedTools: null,
          lastTokens,
        });
        break;
      }

      case 'cancel':
        procTracker.cancel(msg.sessionId);
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

      // ─── Git clone background jobs ─────────────────────────────────────────

      case 'clone_start': {
        try {
          const jobId = cloneJobs.startClone({ url: msg.url, name: msg.name });
          // Auto-subscribe the requester so their UI sees streaming output.
          const state = cloneJobs.attach(jobId, ws);
          send(ws, { type: 'clone_started', jobId, state });
        } catch (err) {
          send(ws, { type: 'clone_failed', error: err.message });
        }
        break;
      }

      case 'clone_attach': {
        const state = cloneJobs.attach(msg.jobId, ws);
        if (!state) { send(ws, { type: 'error', message: 'Clone job not found' }); return; }
        send(ws, { type: 'clone_state', state });
        break;
      }

      case 'list_clone_jobs': {
        send(ws, { type: 'clone_jobs_list', jobs: cloneJobs.listJobs() });
        break;
      }

      // ─── Prompt streaming ──────────────────────────────────────────────────

      case 'send_prompt': {
        const { prompt, imagePaths = [] } = msg;
        let { sessionId } = msg;
        let directory = msg.directory;

        if (!prompt) { send(ws, { type: 'error', message: 'prompt required' }); return; }
        if (!sessionId) { send(ws, { type: 'error', message: 'sessionId required' }); return; }

        const placeholder = pendingSessions.get(sessionId);
        const isNewSession = !!placeholder;

        if (placeholder) directory = directory || placeholder.directory;
        else if (!directory) directory = findDirectoryForSessionId(sessionId);

        if (!directory) {
          send(ws, { type: 'error', message: 'directory could not be determined', sessionId });
          return;
        }

        subscribe(sessionId, ws);
        let resolvedSessionId = isNewSession ? null : sessionId;
        const resumeSessionId = isNewSession ? null : sessionId;
        const processKey = sessionId;

        if (!isNewSession && sm.shouldAutoCompact(sessionId, directory)) {
          broadcast(sessionId, { type: 'stream_start', sessionId, autoCompact: true });
          try {
            for await (const event of sm.runPrompt({
              directory, prompt: '/compact',
              resumeSessionId: sessionId, processKey: sessionId,
            })) {
              broadcast(sessionId, { type: 'stream_event', sessionId, event });
            }
          } catch (err) {
            broadcast(sessionId, { type: 'error', message: `auto-compact failed: ${err.message}`, sessionId });
          } finally {
            broadcast(sessionId, { type: 'stream_end', sessionId });
          }
        }

        broadcast(sessionId, { type: 'stream_start', sessionId });

        // AskUserQuestion intercept state. The tool can't actually be answered
        // in `-p` mode (no stdin channel for tool_result), so we surface the
        // question to the user, cancel the stream, and write a synthetic
        // tool_result into the jsonl so the next /resume isn't dangling.
        let interceptedAUQ = null;

        try {
          for await (const event of sm.runPrompt({
            directory, prompt, imagePaths,
            resumeSessionId, processKey,
          })) {
            if (isNewSession && !resolvedSessionId
                && event.type === 'system' && event.subtype === 'init' && event.session_id) {
              resolvedSessionId = event.session_id;
              procTracker.rekey(sessionId, resolvedSessionId);
              rekeySubscribers(sessionId, resolvedSessionId);
              pendingSessions.delete(sessionId);
              send(ws, { type: 'session_assigned', placeholderId: sessionId, sessionId: resolvedSessionId });
              // Refresh the sidebar so the placeholder row is replaced by the
              // real session row — otherwise the user's first ⋯ menu would
              // target the now-defunct placeholder id.
              send(ws, { type: 'sessions_list', sessions: listAllSessionsLegacy() });
            }

            // Scan assistant events for AskUserQuestion. We let the event
            // through to the client so the model's preceding text still
            // renders, then schedule a cancel after a brief delay to give
            // claude time to flush this assistant turn to its jsonl.
            if (!interceptedAUQ && event.type === 'assistant') {
              const content = event.message && event.message.content;
              if (Array.isArray(content)) {
                const auq = content.find(b => b && b.type === 'tool_use' && b.name === 'AskUserQuestion');
                if (auq) {
                  interceptedAUQ = {
                    toolUseId: auq.id,
                    questions: (auq.input && auq.input.questions) || [],
                  };
                  setTimeout(() => { try { procTracker.cancel(processKey); } catch {} }, 200);
                }
              }
            }

            const bk = resolvedSessionId || sessionId;
            broadcast(bk, { type: 'stream_event', sessionId: resolvedSessionId || sessionId, event });
          }
        } catch (err) {
          const bk = resolvedSessionId || sessionId;
          broadcast(bk, { type: 'error', message: err.message, sessionId: resolvedSessionId || sessionId });
        } finally {
          for (const p of imagePaths) { try { fs.unlinkSync(p); } catch {} }
          const bk = resolvedSessionId || sessionId;

          // AskUserQuestion follow-up: append a synthetic tool_result and tell
          // the UI to render an explanatory banner. Best-effort — failures
          // here don't poison the regular finalize path.
          if (interceptedAUQ && (resolvedSessionId || sessionId)) {
            const realSid = resolvedSessionId || sessionId;
            try {
              const tail = jsonlReader.readTailEntry(realSid, directory);
              const parentUuid = tail && typeof tail.uuid === 'string' ? tail.uuid : null;
              const { v4: uuidv4 } = require('uuid');
              const entry = {
                parentUuid,
                sessionId: realSid,
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
              jsonlReader.appendJsonlLine(realSid, directory, entry);
            } catch (e) {
              // Non-fatal — the resume will surface the dangling tool_use and
              // claude will likely re-ask or error, which is informative enough.
            }
            broadcast(bk, {
              type: 'ask_user_question_intercepted',
              sessionId: realSid,
              toolUseId: interceptedAUQ.toolUseId,
              questions: interceptedAUQ.questions,
            });
          }

          broadcast(bk, { type: 'stream_end', sessionId: resolvedSessionId || sessionId });
          if (placeholder && pendingSessions.has(sessionId)) {
            placeholder.lastActivity = Date.now();
          }
        }
        break;
      }

      default:
        send(ws, { type: 'error', message: `Unknown message type: ${msg.type}` });
    }
  });
}

module.exports = { handleConnection };
