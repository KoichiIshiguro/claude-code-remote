'use strict';

// Guarded filesystem mutations for the file-manager UI.
//
// Access policy:
//   These are USER-driven operations through the front-end file manager, so they
//   run with the user's full access scope — anywhere under accessRoot (the whole
//   disk when accessRoot is null), plus any registered project. They are NOT
//   confined to the sandbox: confinement is the job of the per-session claude -p
//   seatbelt sandbox (session-manager.js), which limits what Claude can touch.
//   Restricting the user here too would block basic actions like creating a
//   folder for a brand-new project. The only hard guards kept below are narrow
//   safety rails (no deleting/renaming/moving a *registered project root*, which
//   would orphan its sidebar entry — remove it from the sidebar instead).

const fs = require('fs');
const path = require('path');
const projectsStore = require('./projects-store');

function err(message, code) {
  return Object.assign(new Error(message), { httpCode: code || 400 });
}

// A path is operable if it's browse-allowed (under accessRoot, or full disk when
// accessRoot is null) or inside a registered project.
const canWrite = (abs) => projectsStore.isAllowedPath(abs) || projectsStore.isBrowseAllowed(abs);
const canRead = canWrite;

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

// Create a new folder. Destination must be within the user's access scope.
function mkdir(parent, name) {
  const absParent = projectsStore.normalizePath(parent);
  if (!canWrite(absParent)) throw err('destination is outside the access scope', 403);
  requireDir(absParent, 'destination');
  const target = path.join(absParent, safeName(name));
  if (fs.existsSync(target)) throw err('a file or folder with that name already exists', 409);
  fs.mkdirSync(target);
  return target;
}

// Permanently delete files/folders in scope. Refuses to delete a project root.
function remove(paths) {
  if (!Array.isArray(paths) || !paths.length) throw err('paths is required');
  const abs = paths.map((p) => projectsStore.normalizePath(p));
  for (const a of abs) {
    if (!canWrite(a)) throw err(`outside the access scope: ${a}`, 403);
    if (isProjectRoot(a)) throw err('cannot delete a registered project root — remove it from the sidebar instead', 400);
  }
  const removed = [];
  for (const a of abs) {
    fs.rmSync(a, { recursive: true, force: true });
    removed.push(a);
  }
  return removed;
}

// Rename a file/folder in place.
function rename(target, newName) {
  const abs = projectsStore.normalizePath(target);
  if (!canWrite(abs)) throw err('outside the access scope', 403);
  if (isProjectRoot(abs)) throw err('cannot rename a registered project root', 400);
  const dest = path.join(path.dirname(abs), safeName(newName));
  if (fs.existsSync(dest)) throw err('a file or folder with that name already exists', 409);
  fs.renameSync(abs, dest);
  return dest;
}

// Shared transfer core for move/copy. dest + sources must be within the scope.
function transfer(sources, destDir, { deleteSource }) {
  if (!Array.isArray(sources) || !sources.length) throw err('sources is required');
  const absDest = projectsStore.normalizePath(destDir);
  if (!canWrite(absDest)) throw err('destination is outside the access scope', 403);
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
