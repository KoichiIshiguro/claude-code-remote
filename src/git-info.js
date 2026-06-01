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

module.exports = { currentBranch };
