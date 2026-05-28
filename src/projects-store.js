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
  addProject, removeProject, findProjectByPath,
  isAllowedPath, isBrowseAllowed,
  getAccessRoot, setAccessRoot,
  normalizePath, resolveTilde,
};
