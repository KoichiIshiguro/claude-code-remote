'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { v4: uuidv4 } = require('uuid');
const { readJson, writeJsonAtomic } = require('./atomic-json');
const { DATA_DIR, loadConfig, saveConfig } = require('./auth');

const PROJECTS_FILE = path.join(DATA_DIR, 'projects.json');

function resolveTilde(p) {
  if (typeof p !== 'string') return p;
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

function normalizePath(p) {
  let resolved = path.resolve(resolveTilde(p));
  try { resolved = fs.realpathSync(resolved); } catch { /* path may not exist yet */ }
  return resolved;
}

function loadProjects() {
  return readJson(PROJECTS_FILE, []);
}

function saveProjects(projects) {
  writeJsonAtomic(PROJECTS_FILE, projects);
}

function addProject({ path: rawPath, name } = {}) {
  if (!rawPath) throw new Error('path is required');
  const absPath = normalizePath(rawPath);
  if (!fs.existsSync(absPath)) {
    throw new Error(`Directory does not exist: ${absPath}`);
  }
  const projects = loadProjects();
  if (projects.some(p => p.path === absPath)) {
    throw new Error(`Project already registered: ${absPath}`);
  }
  const entry = {
    id: uuidv4(),
    path: absPath,
    name: (name && String(name).trim()) || path.basename(absPath) || absPath,
    addedAt: new Date().toISOString(),
    writablePaths: [],   // extra dirs the sandboxed claude may write to (besides workdir)
  };
  projects.push(entry);
  saveProjects(projects);
  return entry;
}

function removeProject(idOrPath) {
  const projects = loadProjects();
  const filtered = projects.filter(p => p.id !== idOrPath && p.path !== idOrPath);
  if (filtered.length === projects.length) return false;
  saveProjects(filtered);
  return true;
}

function findProjectByPath(absPath) {
  const target = normalizePath(absPath);
  return loadProjects().find(p => p.path === target) || null;
}

// Is absPath inside any registered project? Uses trailing-sep prefix check so
// "/tmp/foo" does not falsely match "/tmp/foobar".
function isAllowedPath(absPath) {
  const target = normalizePath(absPath);
  for (const p of loadProjects()) {
    if (target === p.path) return true;
    if (target.startsWith(p.path + path.sep)) return true;
  }
  return false;
}

function getAccessRoot() {
  const cfg = loadConfig();
  return cfg.accessRoot ?? null;
}

function setAccessRoot(p) {
  const value = (p === null || p === undefined) ? null : normalizePath(p);
  saveConfig({ accessRoot: value });
}

// ── Write allow-lists (sandbox) ──────────────────────────────────────────────
// The sandboxed claude can write to its workdir + caches by default; these lists
// grant additional writable dirs (e.g. a pnpm store outside the workdir).
// Resolve ~ and realpath, drop blanks/dupes.
function sanitizePaths(paths) {
  if (!Array.isArray(paths)) return [];
  const out = [];
  for (const p of paths) {
    if (typeof p !== 'string' || !p.trim()) continue;
    const abs = normalizePath(p);
    if (!out.includes(abs)) out.push(abs);
  }
  return out;
}

function getProject(id) {
  return loadProjects().find(p => p.id === id) || null;
}

// System-wide writable dirs (config.json) — apply to EVERY sandboxed session.
function getSystemWritablePaths() {
  const cfg = loadConfig();
  return Array.isArray(cfg.writablePaths) ? cfg.writablePaths : [];
}

function setSystemWritablePaths(paths) {
  const clean = sanitizePaths(paths);
  saveConfig({ writablePaths: clean });
  return clean;
}

function setProjectWritablePaths(id, paths) {
  const projects = loadProjects();
  const proj = projects.find(p => p.id === id);
  if (!proj) throw new Error(`project not found: ${id}`);
  proj.writablePaths = sanitizePaths(paths);
  saveProjects(projects);
  return proj;
}

// What the sandbox should grant for a given workdir: the system list PLUS the
// writable list of whichever registered project owns that workdir.
function resolvedWritablePaths(workdir) {
  const out = [...getSystemWritablePaths()];
  try {
    const target = normalizePath(workdir);
    for (const p of loadProjects()) {
      if (target === p.path || target.startsWith(p.path + path.sep)) {
        if (Array.isArray(p.writablePaths)) out.push(...p.writablePaths);
      }
    }
  } catch { /* workdir unresolvable — system list only */ }
  return [...new Set(out)];
}

// For the file-manager folder picker: a path is browse-allowed if accessRoot
// is null (full access) OR the target sits under accessRoot.
function isBrowseAllowed(absPath) {
  const target = normalizePath(absPath);
  const root = getAccessRoot();
  if (!root) return true;
  if (target === root) return true;
  return target.startsWith(root + path.sep);
}

module.exports = {
  loadProjects, saveProjects,
  addProject, removeProject, findProjectByPath, getProject,
  isAllowedPath, isBrowseAllowed,
  getAccessRoot, setAccessRoot,
  getSystemWritablePaths, setSystemWritablePaths,
  setProjectWritablePaths, resolvedWritablePaths,
  normalizePath, resolveTilde,
};
