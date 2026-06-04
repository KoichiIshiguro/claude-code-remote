'use strict';

const { execFileSync } = require('child_process');

// Return the current git branch name for `dir`, or null when `dir` isn't a
// git work tree (or git is unavailable). Detached HEAD reports as null too —
// `--abbrev-ref` yields "HEAD" in that case, which isn't a useful label.
function currentBranch(dir) {
  if (!dir) return null;
  try {
    const out = execFileSync('git', ['-C', dir, 'rev-parse', '--abbrev-ref', 'HEAD'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 2000,
    }).trim();
    if (!out || out === 'HEAD') return null;
    return out;
  } catch {
    return null;
  }
}

// List local branch names for `dir`, most-recently-committed first. Returns []
// when `dir` isn't a git work tree or git is unavailable.
function listBranches(dir) {
  if (!dir) return [];
  try {
    const out = execFileSync('git', [
      '-C', dir, 'for-each-ref',
      '--sort=-committerdate',
      '--format=%(refname:short)',
      'refs/heads/',
    ], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 3000,
    });
    return out.split('\n').map(s => s.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

// Check out `branch` in `dir`. Returns { ok: true, branch } on success, or
// { ok: false, error } carrying git's stderr (e.g. "Your local changes would be
// overwritten…") on failure.
function checkoutBranch(dir, branch) {
  if (!dir || !branch) return { ok: false, error: 'directory and branch required' };
  try {
    execFileSync('git', ['-C', dir, 'checkout', branch], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 8000,
    });
    return { ok: true, branch };
  } catch (err) {
    const stderr = (err.stderr || '').toString().trim();
    return { ok: false, error: stderr || err.message || 'checkout failed' };
  }
}

module.exports = { currentBranch, listBranches, checkoutBranch };
