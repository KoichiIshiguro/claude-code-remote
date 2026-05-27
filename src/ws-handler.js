'use strict';

const {
  createSession, getSession, listSessions, deleteSession,
  cancelRunning, runPrompt, updatePermissions,
  pushUserMessage, startAssistantEntry, feedEvent, finalizeEntry, getHistory,
  shouldAutoCompact,
} = require('./session-manager');
const fs = require('fs');

// sessionId → Set<ws>  (all clients watching that session)
const sessionClients = new Map();

function send(ws, obj) {
  if (ws.readyState === 1 /* OPEN */) ws.send(JSON.stringify(obj));
}

function broadcast(sessionId, obj) {
  const clients = sessionClients.get(sessionId);
  if (!clients) return;
  const data = JSON.stringify(obj);
  for (const c of clients) {
    if (c.readyState === 1) c.send(data);
  }
}

function subscribe(sessionId, ws) {
  if (!sessionClients.has(sessionId)) sessionClients.set(sessionId, new Set());
  sessionClients.get(sessionId).add(ws);
}

function unsubscribe(ws) {
  for (const [, clients] of sessionClients) clients.delete(ws);
}

function handleConnection(ws, req) {
  ws.on('close', () => unsubscribe(ws));

  ws.on('message', async (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); }
    catch { send(ws, { type: 'error', message: 'Invalid JSON' }); return; }

    switch (msg.type) {

      case 'list_sessions':
        send(ws, { type: 'sessions_list', sessions: listSessions() });
        break;

      case 'create_session': {
        const { directory } = msg;
        if (!directory) { send(ws, { type: 'error', message: 'directory is required' }); return; }
        try {
          const session = createSession(directory);
          send(ws, { type: 'session_created', session });
        } catch (err) { send(ws, { type: 'error', message: err.message }); }
        break;
      }

      case 'delete_session':
        deleteSession(msg.sessionId);
        send(ws, { type: 'session_deleted', sessionId: msg.sessionId });
        break;

      case 'attach': {
        const { sessionId } = msg;
        const session = getSession(sessionId);
        if (!session) { send(ws, { type: 'error', message: 'Session not found' }); return; }

        subscribe(sessionId, ws);
        const hist = getHistory(sessionId);
        send(ws, {
          type: 'history',
          sessionId,
          directory: session.directory,
          history: hist.history,
          streaming: hist.streaming,
          currentEntry: hist.currentEntry,
          allowedTools: hist.allowedTools,
          lastTokens: hist.lastTokens,
        });
        break;
      }

      case 'update_permissions': {
        const { sessionId, allowedTools } = msg;
        const session = getSession(sessionId);
        if (!session) { send(ws, { type: 'error', message: 'Session not found' }); return; }
        updatePermissions(sessionId, allowedTools);
        broadcast(sessionId, { type: 'permissions_updated', sessionId, allowedTools });
        break;
      }

      case 'cancel': {
        const { sessionId } = msg;
        cancelRunning(sessionId);
        break;
      }

      case 'send_prompt': {
        const { sessionId, prompt, imagePaths = [] } = msg;
        if (!sessionId || !prompt) {
          send(ws, { type: 'error', message: 'sessionId and prompt are required' }); return;
        }
        const session = getSession(sessionId);
        if (!session) {
          send(ws, { type: 'error', message: 'Session not found', sessionId }); return;
        }
        subscribe(sessionId, ws);

        // Auto-compact when context is heavy. Runs /compact as a standalone
        // turn so it shows in history; the user's prompt follows on a fresh
        // (compacted) context.
        if (shouldAutoCompact(sessionId)) {
          pushUserMessage(sessionId, '/compact', 0);
          broadcast(sessionId, { type: 'stream_start', sessionId, autoCompact: true });
          startAssistantEntry(sessionId);
          try {
            for await (const event of runPrompt(sessionId, '/compact', [])) {
              feedEvent(sessionId, event);
              broadcast(sessionId, { type: 'stream_event', sessionId, event });
            }
          } catch (err) {
            broadcast(sessionId, { type: 'error', message: `auto-compact failed: ${err.message}`, sessionId });
          } finally {
            finalizeEntry(sessionId);
            broadcast(sessionId, { type: 'stream_end', sessionId });
          }
        }

        pushUserMessage(sessionId, prompt, imagePaths.length);
        broadcast(sessionId, { type: 'stream_start', sessionId });
        startAssistantEntry(sessionId);

        try {
          for await (const event of runPrompt(sessionId, prompt, imagePaths)) {
            feedEvent(sessionId, event);
            broadcast(sessionId, { type: 'stream_event', sessionId, event });
          }
        } catch (err) {
          broadcast(sessionId, { type: 'error', message: err.message, sessionId });
        } finally {
          for (const p of imagePaths) { try { fs.unlinkSync(p); } catch { /* ignore */ } }
          finalizeEntry(sessionId);
          broadcast(sessionId, { type: 'stream_end', sessionId });
        }
        break;
      }

      default:
        send(ws, { type: 'error', message: `Unknown message type: ${msg.type}` });
    }
  });
}

module.exports = { handleConnection };
