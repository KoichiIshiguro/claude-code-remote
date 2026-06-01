<div align="center">

**English** | [日本語](README.ja.md)

# 🤖 Claude Code Remote

**A minimal, self-hosted web UI for [Claude Code](https://github.com/anthropics/claude-code) — drive Claude from any browser, any phone, anywhere.**

[![CI](https://github.com/KoichiIshiguro/claude-code-remote/actions/workflows/ci.yml/badge.svg)](https://github.com/KoichiIshiguro/claude-code-remote/actions/workflows/ci.yml)
[![Node](https://img.shields.io/badge/node-%E2%89%A518-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![License: PolyForm Internal Use](https://img.shields.io/badge/license-PolyForm_Internal_Use-blue.svg)](LICENSE)
[![PWA](https://img.shields.io/badge/PWA-ready-5A0FC8?logo=pwa&logoColor=white)](#)
[![~3k LOC](https://img.shields.io/badge/code-~3k_LOC-lightgrey)](#)

![Chat view](docs/screenshots/chat.png)

</div>

> **Why?** Other Claude Code web UIs are 30–50k LOC React/Tauri monsters. This one is **vanilla JS + Express in ~3,000 lines of backend** — readable in an afternoon, hackable in a weekend, and battle-tested on real iOS Safari.

---

## ✨ Features

- 🔐 **Tailscale-first auth** — local ID/PW set up via browser on first run; designed to sit behind your private Tailscale network, not on the open web
- 💬 **Streaming chat UI** with tool-use cards, thinking blocks, and per-turn cost
- 📁 **Explicit multi-project switcher** — register any folder through a built-in file-browser picker (or zip import); each project is sandboxed to its own path, and adding one never auto-spawns a session
- 🧵 **Multiple sessions per project** — keep parallel conversations in the same repo and switch between them from the sidebar
- 🗄️ **Archive / restore / purge sessions** — hide finished threads, bring them back, or permanently delete the underlying jsonl
- ↔️ **TUI-compatible** — Claude's own `~/.claude/projects/*.jsonl` is the single source of truth, so sessions you start in the `claude` CLI show up here (and vice-versa)
- 🔄 **Resume any session** via Claude's native `--resume`
- 🖥️ **Built-in terminal** — a persistent tmux-backed shell per session that survives server restarts (where tmux is available); plain-shell fallback on Windows / no-tmux hosts
- 🛟 **Survive crashes** — in-flight responses are persisted to disk; reattach picks up where you left off
- 🖼️ **Drag / paste images** straight into chat (uses Claude's prompt-path syntax — no proprietary attachment API)
- 📱 **Installable PWA** with status-bar styling, splash screen, home-screen icon
- 🔌 **Auto-reconnect WebSocket** that survives mobile network switches and PM2 reloads
- 📄 **In-browser file viewer** with Markdown rendering and a refresh button
- ⚡ **Stateless prompt model** — spawns a fresh `claude` per turn, no zombies to babysit
- 📊 **Context size indicator** — a status-bar meter shows the real input-token count from the last API call (matches what the TUI shows)
- 🗜️ **Auto-compact at TUI threshold** — when context hits 167k (Claude Code TUI's ~83.5% trigger on 200k models), `/compact` runs automatically before the next prompt

## 📸 Screenshots

<table>
  <tr>
    <td align="center" width="50%"><strong>Chat</strong><br><img src="docs/screenshots/chat.png" alt="Chat" width="100%"></td>
    <td align="center" width="50%"><strong>Sign-in</strong><br><img src="docs/screenshots/login.png" alt="Sign in" width="100%"></td>
  </tr>
  <tr>
    <td align="center"><strong>Mobile chat</strong><br><img src="docs/screenshots/mobile-chat.png" alt="Mobile chat" width="260"></td>
    <td align="center"><strong>Mobile projects</strong><br><img src="docs/screenshots/mobile-projects.png" alt="Mobile projects" width="260"></td>
  </tr>
</table>

---

## 🚀 Quick Start

### 1. Install prerequisites

- **Node.js ≥ 18**, **git**, **[Claude CLI](https://docs.claude.com/en/docs/claude-code/quickstart)** signed in with your Pro/Max account
- (Optional but recommended) **[Tailscale](https://tailscale.com/download)** so you can reach the server from your phone

### 2. Clone & install

```bash
git clone https://github.com/KoichiIshiguro/claude-code-remote.git
cd claude-code-remote
npm install
```

### 3. Run it

```bash
npm start
```

Open `http://localhost:4000` — you'll be redirected to `/setup`, the first-run wizard. Pick a username, password, and an access scope (a single folder to sandbox to, or full disk access on a trusted tailnet). Done.

After setup, sign in from your phone at `http://<tailscale-ip>:4000` (the wizard shows you the URL + a QR code).

### Forgot your username or password?

There is no recovery email and no "forgot password" link by design (single-user, personal-use). To reset:

```bash
node server.js --reset-auth
```

This deletes `data/admin.json` and exits. The next `npm start` will redirect to `/setup` so you can pick a fresh username + password. Your `config.json`, project list, and conversation history (jsonl) are untouched.

### (Optional) Run on boot

If you want the server to come up automatically when the machine restarts, wire it up with launchd (macOS), systemd (Linux), or the Windows Task Scheduler — pointing at `node server.js` in this directory.

> **⚠️ Background services need a long-lived auth token.** When `claude` runs
> interactively it reads its OAuth credentials from your login Keychain. A
> launchd/systemd background agent runs *outside* your GUI login session and
> **cannot read that Keychain**, so it falls back to a stale token and every
> prompt fails with `401 Invalid authentication credentials`. Fix it once:
> on your everyday GUI machine, open a real terminal and run
> ```bash
> claude setup-token        # opens a browser to authorize — needs a TTY
> ```
> then put the printed token in this directory's `.env` and restart the service:
> ```bash
> echo 'CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-...' >> .env
> ```
> The server passes it straight to each spawned `claude`, so auth no longer
> depends on the Keychain. (Running `node server.js` by hand in your own shell
> doesn't need this — that shell already has Keychain access.)

### (Optional) Public HTTPS

If you want to expose this on the open internet instead of Tailscale, **don't** — but if you must, terminate TLS in front (Apache / Caddy / nginx), add HTTP basic-auth at the proxy on top of the built-in ID/PW, and seriously consider narrowing the access scope to a sandboxed subtree.

---

## 🆚 Comparison

| | **Claude Code Remote** | [siteboon/claudecodeui](https://github.com/siteboon/claudecodeui) | [d-kimuson/claude-code-viewer](https://github.com/d-kimuson/claude-code-viewer) |
|---|---|---|---|
| LOC | **~3,000** | 50k+ | 30k+ |
| Auth | **Local ID/PW + Tailscale** | None / token | Single password |
| Frontend | Vanilla JS (no build step) | React + Vite | React + Vite |
| In-flight response persistence | **✅** | ❌ | ❌ |
| Image paste | ✅ | ❓ | ✅ |
| PWA | ✅ | ❓ | ✅ |
| WebSocket auto-reconnect | ✅ | ❓ | ❓ |
| Multi-project switcher | ✅ | ✅ | ✅ |
| Multiple sessions per project | ✅ | ❓ | ✅ |
| Bring-your-own auth | Drop-in via reverse proxy | Same | Same |
| Read the whole source | **~1 hour** | A week | Several days |

**Bottom line:** if you want a CodeMirror-based editor and a built-in Git GUI, use CloudCLI. If you want a chat window that just works and that you can fork in a weekend, use this.

---

## 🏗️ How it Works

```
┌─────────────────┐   HTTPS    ┌──────────────────┐
│ Browser / PWA   │ ◄────────► │ Reverse Proxy    │
│ (iOS / Desktop) │            │ (Apache / Caddy) │
└─────────────────┘            └────────┬─────────┘
                                        │ HTTP + WS
                                        ▼
                               ┌──────────────────┐
                               │ Node.js server   │
                               │ (this repo)      │
                               │ • Express        │
                               │ • ws             │
                               │ • bcrypt session │
                               └────────┬─────────┘
                                        │ spawn() per prompt
                                        ▼
                               ┌──────────────────┐
                               │ claude CLI       │
                               │ -p --resume <id> │
                               │ --output-format  │
                               │   stream-json    │
                               └──────────────────┘
```

**Key design choices**

- **One `claude` process per prompt.** No long-lived background agents. Conversation state lives in Claude's own `~/.claude/projects/*.jsonl` and is restored via `--resume`.
- **In-flight responses are streamed to disk** every 500 ms (debounced). If the server is killed mid-response, reattach renders the partial output and lets you say "continue" — Claude resumes via `--resume`.
- **Images are passed as file paths** (`/abs/path/to/image.png`) embedded in the prompt — the same way Claude Code's TUI handles drag-and-drop.
- **No build step.** The frontend is `<script>` + Vanilla JS + a single `marked` import. You can `npm install` over a flaky mobile tether and still ship.
- **Context tracked from per-call `usage`.** Each `assistant` stream event carries the actual input-token count of that API call (not a turn-aggregate); the meter and the auto-compact decision both read from it, so behavior matches Claude Code TUI's own `/compact` threshold.

---

## 🔧 Configuration Reference

All configuration is **optional** — the first-run wizard at `/setup` writes admin credentials and the access scope to `data/admin.json` and `data/config.json`, the registered projects live in `data/projects.json`, and the session secret is auto-generated. Use env vars only to override these defaults.

| Env var | Description |
|---|---|
| `PORT` | HTTP port. Default `4000` |
| `CLAUDE_PATH` | Absolute path to `claude` — set when PATH isn't inherited (PM2 / systemd / launchd) |
| `CLAUDE_CODE_OAUTH_TOKEN` | Long-lived auth token from `claude setup-token`. **Required when running under launchd/systemd**, which can't read the login Keychain — without it every prompt 401s. See *Run on boot* above |
| `SESSION_SECRET` | Override the auto-generated one (useful for shared cookie domains across deployments) |
| `CLAUDE_AUTO_COMPACT_THRESHOLD` | Input-token count that triggers an auto-`/compact` before the next prompt. Default `167000` (TUI's ~83.5% trigger on 200k-context models). Set to e.g. `835000` for 1M tiers |
| `TMUX_PATH` | Absolute path to `tmux` for the built-in terminal — set when it isn't on PATH. Auto-detected via `which tmux` otherwise; falls back to a plain shell if tmux is absent |
| `CCR_SHELL` | Override the shell the terminal launches (default: `$SHELL -l`, or `powershell.exe` on Windows) |
| `NODE_ENV=production` | Enforce HTTPS-only session cookies. Only set when terminating TLS in front |
| `CLAUDE_SANDBOX` | **macOS only.** `0` disables the per-session OS sandbox. On by default — see Security Notes |

---

## 🛡️ Security Notes

- **Designed to live on Tailscale, not on the public internet.** A single bcrypt-hashed password (set at `/setup`, stored in `data/admin.json`) is not enough to survive sustained brute-force from the open web. Keep this on your private tailnet, or put HTTP basic-auth in front of it at the reverse proxy if you must expose it.
- **HTTPS is still required for any non-Tailscale exposure.** Session cookies in cleartext are immediately game-over.
- **`--dangerously-skip-permissions` is on by default** because this UI is your personal remote. If you expose it, you're trusting Claude with your filesystem — narrow the access scope to a safe subtree.
- **Per-session OS sandbox (macOS).** Even with `--dangerously-skip-permissions`, each spawned `claude` is wrapped in `sandbox-exec` (kernel-level Seatbelt) so it **cannot write anywhere outside its own session folder** (plus `~/.claude` and temp) and **cannot read sibling projects or climb above the session folder** — enforced on the syscall, so it holds against `bash`/`cat` too. The Node server itself is *not* sandboxed (it needs full access for the picker, git clone, and the file viewer); only the LLM child is. Auth (`~/.claude.json` + Keychain) stays reachable so Claude still works. macOS-only; set `CLAUDE_SANDBOX=0` to disable. No effect on Linux/Windows yet.
- **Single-user by design.** There is no multi-user mode and no admin panel. That is the entire security model.
- **Session store is file-backed** (`data/auth-sessions.json`, atomic writes via `src/session-store.js`), so a server restart or PM2 reload no longer signs you out. Swap to `connect-sqlite3` / `connect-redis` if you outgrow a single JSON file.

---

## 🗺️ Roadmap

- [x] Persistent session store so a restart / PM2 reload doesn't sign you out
- [ ] Docker image
- [ ] CodeMirror live editing in the file viewer
- [ ] Push notifications when long prompts finish
- [ ] Multi-user via OAuth groups (probably never — that's not the design)

Roadmap items are tracked in [issues](https://github.com/KoichiIshiguro/claude-code-remote/issues). Feature requests and bug reports are welcome there.

---

## 🤝 Contributing

**Pull requests are not accepted.** This project is maintained as a single-author codebase. Please file issues for bugs and feature requests — they're read and triaged, just not merged from outside the repo.

If you want a local development setup for your own use:

```bash
git clone https://github.com/KoichiIshiguro/claude-code-remote.git
cd claude-code-remote
pnpm install          # or: npm install
cp .env.example .env  # fill in your secrets
pnpm dev              # auto-restart on file change
```

---

## 📜 License

**[PolyForm Internal Use 1.0.0](LICENSE)** — source-available for internal use only.

You may:
- Clone, build, run, and modify the software for your own internal business use (personal or company-internal)
- Self-host it on any infrastructure you control

You may not:
- Distribute the software or any derivative work to third parties (modified or unmodified, free or paid)
- Provide it as a hosted/managed service to third parties
- Re-publish forks of this repository

> **Versions v0.6.0 and earlier remain available under the MIT License.** The license change applies from the first commit following the v0.6.0 release.

`claude` is Anthropic's commercial product and is not bundled with this repo. You need your own Claude account / API access.

---

<div align="center">

**Built because every remote-Claude UI on GitHub was either bloated, abandoned, or both.**

If this saved you a weekend, ⭐ star the repo — that's the only reward this project asks for.

</div>
