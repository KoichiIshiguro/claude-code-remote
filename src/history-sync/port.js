'use strict';

// Forward-compat bridge between NATIVE agent session files and the canonical
// shared store. Two directions, both project-scoped (one cwd):
//
//   import — read an existing native Claude jsonl / Codex rollout (READ-ONLY),
//            convert to canonical, and seed a BRAND-NEW shared conversation.
//            The new id gets the `xsync_` prefix and providerIds is emptied, so
//            the imported history is agent-neutral and born "shared" (exactly
//            like a fresh shared session, but pre-populated). This is how a user
//            who already has Claude/Codex history carries it into the alpha.
//
//   export — materialize a shared conversation back OUT to a native file at the
//            real CLI location, so the stock `claude --resume` / `codex resume`
//            pickers can open it. Best-effort: a synthesized jsonl/rollout may or
//            may not satisfy every CLI version — the caller surfaces the written
//            path so it can be verified empirically. Canonical is never mutated.
//
// See [[history-sync-keystone]].

const fs = require('fs');
const os = require('os');
const path = require('path');
const compiler = require('../../codex-compiler');
const store = require('./store');
const jsonlReader = require('../jsonl-reader');
const syncBridge = require('./ws-bridge');
const claudeRuntime = require('./claude-runtime');
const codexRuntime = require('./codex-runtime');

// Codex rollouts may live in several homes: the app's dedicated CODEX_HOME and
// the user's personal ~/.codex (their pre-alpha history). Scan all, dedup.
function codexHomes() {
  const homes = new Set();
  homes.add(codexRuntime.defaultCodexHome());
  homes.add(path.join(os.homedir(), '.codex'));
  if (process.env.CODEX_HOME) homes.add(process.env.CODEX_HOME);
  return [...homes];
}

// sessions/YYYY/MM/DD/rollout-*.jsonl — walk the date-bucketed tree.
function walkRollouts(home) {
  const out = [];
  const base = path.join(home, 'sessions');
  let years;
  try { years = fs.readdirSync(base); } catch { return out; }
  for (const y of years) {
    const yp = path.join(base, y);
    let months; try { months = fs.readdirSync(yp); } catch { continue; }
    for (const m of months) {
      const mp = path.join(yp, m);
      let days; try { days = fs.readdirSync(mp); } catch { continue; }
      for (const d of days) {
        const dp = path.join(mp, d);
        let files; try { files = fs.readdirSync(dp); } catch { continue; }
        for (const f of files) {
          if (f.startsWith('rollout-') && f.endsWith('.jsonl')) out.push(path.join(dp, f));
        }
      }
    }
  }
  return out;
}

function previewOf(transcript) {
  const u = (transcript.turns || []).find(
    (t) => t.role === 'user' && (t.parts || []).some((p) => p.type === 'text'),
  );
  const txt = u ? (u.parts.find((p) => p.type === 'text')?.text || '') : '';
  return txt.replace(/\s+/g, ' ').trim().slice(0, 100);
}

function samePath(a, b) {
  if (!a || !b) return false;
  try { return path.resolve(a) === path.resolve(b); } catch { return a === b; }
}

// Enumerate native sessions importable into the shared store for one project dir.
// Claude sources come from the projects jsonl dir; Codex sources are rollouts
// whose session_meta cwd matches this folder. Returns { claude:[], codex:[] }.
function listImportSources(cwd) {
  const claude = jsonlReader.listJsonlsForProject(cwd).map((s) => ({
    agent: 'claude',
    sessionId: s.sessionId,
    mtime: s.mtime,
    title: jsonlReader.getLatestAiTitle(s.sessionId, cwd) || '',
    preview: jsonlReader.firstUserPreview(s.sessionId, cwd) || '',
  }));

  const codex = [];
  const seen = new Set();
  for (const home of codexHomes()) {
    for (const file of walkRollouts(home)) {
      if (seen.has(file)) continue;
      seen.add(file);
      try {
        const text = fs.readFileSync(file, 'utf8');
        const nl = text.indexOf('\n');
        const firstLine = nl === -1 ? text : text.slice(0, nl);
        let meta; try { meta = JSON.parse(firstLine); } catch { continue; }
        if (!meta || meta.type !== 'session_meta') continue;
        if (!samePath(meta.payload && meta.payload.cwd, cwd)) continue;
        const transcript = compiler.codexToCanonical(text, { cwd });
        codex.push({
          agent: 'codex',
          sessionId: (meta.payload && meta.payload.id) || path.basename(file, '.jsonl'),
          file,
          mtime: fs.statSync(file).mtimeMs,
          title: transcript.title || '',
          preview: previewOf(transcript),
        });
      } catch { /* skip unreadable rollout */ }
    }
  }
  codex.sort((a, b) => b.mtime - a.mtime);
  return { claude, codex };
}

// Shared (canonical) conversations rooted at this project dir — the export side
// of the modal lists these so the user can write any of them back to a native CLI.
function listSharedFor(cwd) {
  return store.list()
    .filter((t) => samePath(t.cwd, cwd))
    .map((t) => ({
      conversationId: t.id,
      title: t.title || '',
      turns: (t.turns || []).length,
      mtime: t._mtime || 0,
    }))
    .sort((a, b) => b.mtime - a.mtime);
}

// Read a native session (read-only) → seed a NEW shared conversation. The new id
// is `xsync_`-prefixed and providerIds is EMPTIED so it's agent-neutral, shows in
// the shared sidebar, and births clean (per-turn sync re-assigns native ids).
function importSession({ agent, sessionId, file, cwd }) {
  let transcript;
  if (agent === 'codex') {
    if (!file) throw new Error('codex import requires file path');
    transcript = compiler.codexToCanonical(fs.readFileSync(file, 'utf8'), { cwd });
  } else {
    const p = file || jsonlReader.jsonlPathFor(sessionId, cwd);
    transcript = compiler.claudeToCanonical(fs.readFileSync(p, 'utf8'), { cwd });
  }
  if (!(transcript.turns || []).length) throw new Error('nothing to import (empty session)');

  transcript.id = syncBridge.newSyncId();
  transcript.providerIds = {};          // agent-neutral: born shared
  transcript.cwd = transcript.cwd || cwd || '';
  store.save(transcript);
  return {
    conversationId: transcript.id,
    title: transcript.title || '',
    turns: transcript.turns.length,
    cwd: transcript.cwd,
    sourceAgent: agent,
  };
}

// Materialize a shared conversation OUT to a native file the stock CLI can open.
// Reuses each runtime's materialize() (which writes but does NOT delete — the
// per-turn delete lives only in turn()). Canonical is read-only here.
function exportSession({ conversationId, agent, cwd }) {
  const transcript = store.load(conversationId, { cwd });
  if (!(transcript.turns || []).length) throw new Error('nothing to export (empty conversation)');
  const realCwd = cwd || transcript.cwd || process.cwd();

  if (agent === 'codex') {
    const mat = codexRuntime.materialize(transcript, { cwd: realCwd });
    return { agent: 'codex', path: mat.rolloutPath, sessionId: mat.sessionId };
  }
  const mat = claudeRuntime.materialize(transcript, { cwd: realCwd });
  // materialize skips the write only when there's no history — guarded above.
  try { jsonlReader.ensurePickerVisible(mat.jsonlPath); } catch { /* best effort */ }
  return { agent: 'claude', path: mat.jsonlPath, sessionId: mat.sessionId };
}

module.exports = { listImportSources, listSharedFor, importSession, exportSession };
