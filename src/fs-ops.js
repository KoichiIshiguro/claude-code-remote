'use strict';

// Guarded filesystem mutations for the file-manager UI.
//
// Encapsulation policy (see design discussion):
//   - WRITE/DELETE targets must live inside a registered project (the sandbox).
//   - READ sources may live anywhere browse-allowed (accessRoot), so files can
//     be pulled INTO the sandbox, but nothing outside it can be clobbered.
//   - Symlink escapes are defused by realpath-ing the *parent* dir and joining a
//     sanitized basename, never trusting a caller-supplied full path for a target.

const fs = require('fs');
const path = require('path');
const projectsStore = require('./projects-store');

function err(message, code) {
  return Object.assign(new Error(message), { httpCode: code || 400 });
}

// A path is a valid mutation target if it sits inside a registered project.
const inSandbox = (abs) => projectsStore.isAllowedPath(abs);
// A path is a valid read source if it's browse-allowed (accessRoot) or sandbox.
const canRead = (abs) => projectsStore.isAllowedPath(abs) || projectsStore.isBrowseAllowed(abs);

function safeName(name) {
  if (typeof name !== 'string' || !name.trim()) throw err('name is required');
  const n = name.trim();
  if (n === '.' || n === '..' || n.includes('/') || n.includes('\\') || n.includes('\0')) {
    throw err('invalid name');
  }
  return n;
}

function requireDir(abs, label) {
  let st;
  try { st = fs.statSync(abs); } catch { throw err(`${label} does not exist`, 404); }
  if (!st.isDirectory()) throw err(`${label} is not a directory`);
}

function isProjectRoot(abs) {
  return projectsStore.loadProjects().some((p) => p.path === abs);
}

// Create a new folder inside a sandbox directory.
function mkdir(parent, name) {
  const absParent = projectsStore.normalizePath(parent);
  if (!inSandbox(absParent)) throw err('destination is outside the sandbox', 403);
  requireDir(absParent, 'destination');
  const target = path.join(absParent, safeName(name));
  if (fs.existsSync(target)) throw err('a file or folder with that name already exists', 409);
  fs.mkdirSync(target);
  return target;
}

// Permanently delete sandbox files/folders. Refuses to delete a project root.
function remove(paths) {
  if (!Array.isArray(paths) || !paths.length) throw err('paths is required');
  const abs = paths.map((p) => projectsStore.normalizePath(p));
  for (const a of abs) {
    if (!inSandbox(a)) throw err(`outside the sandbox: ${a}`, 403);
    if (isProjectRoot(a)) throw err('cannot delete a registered project root — remove it from the sidebar instead', 400);
  }
  const removed = [];
  for (const a of abs) {
    fs.rmSync(a, { recursive: true, force: true });
    removed.push(a);
  }
  return removed;
}

// Rename a sandbox file/folder in place.
function rename(target, newName) {
  const abs = projectsStore.normalizePath(target);
  if (!inSandbox(abs)) throw err('outside the sandbox', 403);
  if (isProjectRoot(abs)) throw err('cannot rename a registered project root', 400);
  const dest = path.join(path.dirname(abs), safeName(newName));
  if (fs.existsSync(dest)) throw err('a file or folder with that name already exists', 409);
  fs.renameSync(abs, dest);
  return dest;
}

// Shared transfer core for move/copy. dest dir must be sandbox; sources readable.
function transfer(sources, destDir, { deleteSource }) {
  if (!Array.isArray(sources) || !sources.length) throw err('sources is required');
  const absDest = projectsStore.normalizePath(destDir);
  if (!inSandbox(absDest)) throw err('destination is outside the sandbox', 403);
  requireDir(absDest, 'destination');

  const planned = [];
  for (const s of sources) {
    const absSrc = projectsStore.normalizePath(s);
    if (!canRead(absSrc)) throw err(`source not accessible: ${absSrc}`, 403);
    if (absDest === absSrc || absDest.startsWith(absSrc + path.sep)) {
      throw err('cannot move/copy a folder into itself', 400);
    }
    if (isProjectRoot(absSrc) && deleteSource) {
      throw err('cannot move a registered project root', 400);
    }
    const targetPath = path.join(absDest, path.basename(absSrc));
    if (fs.existsSync(targetPath)) throw err(`already exists at destination: ${path.basename(absSrc)}`, 409);
    planned.push({ absSrc, targetPath });
  }

  const done = [];
  for (const { absSrc, targetPath } of planned) {
    if (deleteSource) {
      try {
        fs.renameSync(absSrc, targetPath);
      } catch (e) {
        if (e.code === 'EXDEV') {
          // Cross-device move: copy then delete the original.
          fs.cpSync(absSrc, targetPath, { recursive: true });
          fs.rmSync(absSrc, { recursive: true, force: true });
        } else {
          throw e;
        }
      }
    } else {
      fs.cpSync(absSrc, targetPath, { recursive: true });
    }
    done.push(targetPath);
  }
  return done;
}

function move(sources, destDir) { return transfer(sources, destDir, { deleteSource: true }); }
function copy(sources, destDir) { return transfer(sources, destDir, { deleteSource: false }); }

module.exports = { mkdir, remove, rename, move, copy };
