'use strict';

// macOS Seatbelt confinement for spawned agent CLIs (claude / codex).
//
// The Node server itself runs with FULL filesystem access — it needs it for the
// project picker, git clone, and the file viewer. But every spawned agent child
// is a black box running an LLM, so we confine IT (and only it) at the KERNEL
// level by wrapping it in `sandbox-exec`. The confinement holds even though we
// pass --dangerously-skip-permissions, and even against `bash`/`cat`, because
// it's enforced on the syscall, not by the agent's own permission logic.
//
// Strategy: we must START from `(allow default)`. A `(deny default)` profile
// blocks reads of the dyld shared cache and system dylibs, so NO binary can even
// exec inside the sandbox (it aborts with SIGABRT). From that permissive base we
// carve out the ONE thing that matters for THIS tool's threat model — keeping a
// session's agent from MODIFYING anything but its own project folder:
//   file-write*  — denied everywhere, re-allowed only in workdir / ~/.claude /
//                  ~/.claude.json / regenerable caches / temp. So the agent can't
//                  modify, create, or delete any file outside its session.
// READS are intentionally left open (`allow default`): this is a single-user dev
// box on a private network, so isolating the user's own projects from each other
// on read has little value, and read-denies on the project tree forced fragile
// realpath/metadata workarounds that broke `node -c`, Python imports, and build
// tools. Write isolation is the real protection and it stays strict.
// We also do NOT deny $HOME: claude's auth lives in the macOS Keychain
// (~/Library/Keychains) and its state in ~/.claude.json, so a blanket $HOME deny
// would break claude itself. Rules are last-match-wins; re-allows follow denies.
// macOS only; no-op elsewhere or when CLAUDE_SANDBOX=0.
// Debug denials with: log stream --style compact --predicate 'sender=="Sandbox"'

const os = require('os');
const path = require('path');

function buildSandboxProfile(workdir, extraWritable = []) {
  const home = os.homedir();
  const q = (p) => '"' + String(p).replace(/(["\\])/g, '\\$1') + '"';
  const sub = (...ps) => ps.map(q).map(s => `(subpath ${s})`).join(' ');
  const reEsc = (p) => String(p).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // claude keeps its main state in the top-level ~/.claude.json (+ .backup, and
  // a .tmp sibling it writes-then-renames). Match the whole family.
  const claudeJson = `(regex #"^${reEsc(path.join(home, '.claude.json'))}")`;

  // Package-manager / tool CACHES & global stores. These live outside the
  // workdir but holding them read-only breaks `npm/pnpm/pip install`, build
  // tools, and language toolchains, which write to a shared per-user cache.
  // They're regenerable caches and global stores — NOT other projects' source
  // — so allowing writes here keeps project-to-project isolation intact while
  // letting installs work. (~/.ssh and friends stay untouched: not listed.)
  const cacheDirs = [
    path.join(home, '.cache'),             // XDG cache: pip, yarn berry, go, many tools
    path.join(home, 'Library', 'Caches'),  // macOS per-user caches
    path.join(home, '.npm'),               // npm cache
    path.join(home, '.pnpm-store'),        // pnpm content-addressable store (legacy loc)
    path.join(home, '.local', 'share', 'pnpm'),  // pnpm home / global bin (XDG)
    path.join(home, 'Library', 'pnpm'),    // pnpm home on macOS (default PNPM_HOME)
    path.join(home, '.yarn'),              // yarn global / classic cache
    path.join(home, '.bun'),               // bun install cache & global bin
    path.join(home, '.deno'),              // deno module cache
    path.join(home, '.cargo'),             // rust registry cache + installed bins
    path.join(home, '.rustup'),            // rust toolchains
    path.join(home, 'go', 'pkg', 'mod'),   // go module cache
  ];

  // User-granted extra writable dirs: a system-wide list (config.json) plus the
  // owning project's own list. This is the escape hatch for stores/caches that
  // live outside the workdir and the hardcoded cacheDirs above (e.g. a pnpm
  // store on another volume). Lazy require to avoid load-order coupling.
  let extraWrite = [];
  try { extraWrite = require('./projects-store').resolvedWritablePaths(workdir); }
  catch { /* projects-store/config not ready — fall back to defaults */ }

  // Where the child may WRITE (everywhere else is read-only).
  const writeOk = [
    workdir,
    path.join(home, '.claude'),       // transcripts (--resume), auth, todos, logs
    ...cacheDirs,
    ...extraWrite,
    ...extraWritable,                 // caller-supplied (e.g. the sync codex-home,
                                      // which lives outside the workdir but must
                                      // stay writable so codex can append its rollout)
    os.tmpdir(), '/private/var/folders', '/private/tmp', '/tmp',
    '/dev',                           // /dev/null, /dev/tty, /dev/stdout… — git and
                                      // most CLIs abort without writable /dev devices
  ];
  // READS are left fully open (the permissive base handles them). This box is a
  // single-user dev machine reached over a private network; the thing that
  // matters is that a session can't MODIFY anything outside its own project, so
  // a runaway/injected agent can't damage sibling projects or system files.
  return [
    '(version 1)',
    '(allow default)',                          // permissive base: reads + exec + net
    // — writes: nothing but the session folder, ~/.claude(.json), caches, temp —
    '(deny file-write*)',
    `(allow file-write* ${sub(...writeOk)})`,
    `(allow file-write* ${claudeJson})`,
  ].join('\n');
}

// Returns [bin, args] for spawn() — wrapped in sandbox-exec on macOS so the
// child can only touch `workdir` (+ ~/.claude + temp + runtime). Untouched on
// non-macOS or when CLAUDE_SANDBOX=0.
function sandboxed(bin, args, workdir, extraWritable = []) {
  if (process.platform !== 'darwin' || process.env.CLAUDE_SANDBOX === '0') {
    return [bin, args];
  }
  return ['/usr/bin/sandbox-exec', ['-p', buildSandboxProfile(workdir, extraWritable), bin, ...args]];
}

module.exports = { buildSandboxProfile, sandboxed };
