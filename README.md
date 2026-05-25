<div align="center">

**English** | [日本語](README.ja.md)

# 🤖 Claude Code Remote

**A minimal, self-hosted web UI for [Claude Code](https://github.com/anthropics/claude-code) — drive Claude from any browser, any phone, anywhere.**

[![Node](https://img.shields.io/badge/node-%E2%89%A518-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![PWA](https://img.shields.io/badge/PWA-ready-5A0FC8?logo=pwa&logoColor=white)](#)
[![~2000 LOC](https://img.shields.io/badge/code-~2000_LOC-lightgrey)](#)

![Chat view](docs/screenshots/chat.png)

</div>

> **Why?** Other Claude Code web UIs are 30–50k LOC React/Tauri monsters. This one is **vanilla JS + Express in ~2,000 lines** — readable in an afternoon, hackable in a weekend, and battle-tested on real iOS Safari.

---

## ✨ Features

- 🔐 **GitHub OAuth** — single-user lockdown, no password to leak
- 💬 **Streaming chat UI** with tool-use cards, thinking blocks, and per-turn cost
- 📁 **Multi-project switcher** — open any subdirectory under `BASE_DIR`
- 🔄 **Resume any session** via Claude's native `--resume`
- 🛟 **Survive crashes** — in-flight responses are persisted to disk; reattach picks up where you left off
- 🖼️ **Drag / paste images** straight into chat (uses Claude's prompt-path syntax — no proprietary attachment API)
- 📱 **Installable PWA** with status-bar styling, splash screen, home-screen icon
- 🔌 **Auto-reconnect WebSocket** that survives mobile network switches and PM2 reloads
- 📄 **In-browser file viewer** with Markdown rendering and a refresh button
- ⚡ **Stateless prompt model** — spawns a fresh `claude` per turn, no zombies to babysit

## 📸 Screenshots

<table>
  <tr>
    <td align="center"><strong>Projects</strong><br><img src="docs/screenshots/projects.png" alt="Projects" width="100%"></td>
    <td align="center"><strong>Chat</strong><br><img src="docs/screenshots/chat.png" alt="Chat" width="100%"></td>
  </tr>
  <tr>
    <td align="center"><strong>Sign-in</strong><br><img src="docs/screenshots/login.png" alt="Sign in" width="100%"></td>
    <td align="center"><strong>Mobile (PWA)</strong><br><img src="docs/screenshots/mobile-chat.png" alt="Mobile chat" width="50%"></td>
  </tr>
</table>

---

## 🚀 Quick Start — let Claude set it up for you

You already have `claude` installed and logged in. Why type commands?

```bash
git clone https://github.com/KoichiIshiguro/claude-code-remote.git
cd claude-code-remote
claude "Read setup.md and set this up. Stop and ask whenever you need input."
```

That's the whole installer. Claude will:

1. Check Node / npm / `claude` are present
2. Run `npm install`
3. Walk you through creating the GitHub OAuth App on github.com
4. Generate a `SESSION_SECRET`
5. Write a reviewed `.env`
6. Smoke-test, then optionally wire up PM2 / systemd / Apache + Let's Encrypt

If it gets interrupted, re-run the same command — `setup.md` is **idempotent and resumable**.

> Yes, this README is for the tool you're setting up. We dogfood it daily.

<details>
<summary><strong>Prefer manual setup?</strong> (click to expand)</summary>

### 1. Clone & install

```bash
git clone https://github.com/KoichiIshiguro/claude-code-remote.git
cd claude-code-remote
npm install
```

### 2. Install the Claude CLI

This server **shells out** to the real `claude` binary — install and log in first:

```bash
# https://docs.claude.com/en/docs/claude-code/quickstart
claude --version
claude auth
```

### 3. Create a GitHub OAuth App

[github.com/settings/developers](https://github.com/settings/developers) → **New OAuth App**

- **Homepage URL**: `https://your-domain.example`
- **Authorization callback URL**: `https://your-domain.example/auth/github/callback`

### 4. Configure `.env`

```bash
cp .env.example .env
```

```env
GITHUB_CLIENT_ID=...
GITHUB_CLIENT_SECRET=...
GITHUB_CALLBACK_URL=https://your-domain.example/auth/github/callback
SESSION_SECRET=$(openssl rand -hex 32)
ALLOWED_GITHUB_USER=your-github-username
PORT=4000
BASE_DIR=/home/you/projects
CLAUDE_PATH=/home/you/.local/bin/claude
```

### 5. Run it

```bash
npm start
# or for production:
pm2 start server.js --name claude-code-remote && pm2 save
```

Visit `http://localhost:4000`.

### 6. (Recommended) HTTPS via Apache + Let's Encrypt

```apache
<VirtualHost *:443>
    ServerName claude.example.com
    ProxyPreserveHost On

    # WebSocket upgrade — must come before ProxyPass
    RewriteEngine On
    RewriteCond %{HTTP:Upgrade} websocket [NC]
    RewriteCond %{HTTP:Connection} upgrade [NC]
    RewriteRule /(.*) ws://127.0.0.1:4000/$1 [P,L]

    ProxyPass / http://127.0.0.1:4000/
    ProxyPassReverse / http://127.0.0.1:4000/
    LimitRequestBody 26214400    # 25 MB for image uploads

    SSLCertificateFile /etc/letsencrypt/live/claude.example.com/fullchain.pem
    SSLCertificateKeyFile /etc/letsencrypt/live/claude.example.com/privkey.pem
</VirtualHost>
```

Then `sudo certbot --apache -d claude.example.com`.

</details>

---

## 🆚 Comparison

| | **Claude Code Remote** | [siteboon/claudecodeui](https://github.com/siteboon/claudecodeui) | [d-kimuson/claude-code-viewer](https://github.com/d-kimuson/claude-code-viewer) |
|---|---|---|---|
| LOC | **~2,000** | 50k+ | 30k+ |
| Auth | **GitHub OAuth** | None / token | Single password |
| Frontend | Vanilla JS (no build step) | React + Vite | React + Vite |
| In-flight response persistence | **✅** | ❌ | ❌ |
| Image paste | ✅ | ❓ | ✅ |
| PWA | ✅ | ❓ | ✅ |
| WebSocket auto-reconnect | ✅ | ❓ | ❓ |
| Multi-project switcher | ✅ | ✅ | ✅ |
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
                               │ • passport       │
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

---

## 🔧 Configuration Reference

| Env var | Required | Description |
|---|---|---|
| `GITHUB_CLIENT_ID` | ✅ | From your GitHub OAuth App |
| `GITHUB_CLIENT_SECRET` | ✅ | From your GitHub OAuth App |
| `GITHUB_CALLBACK_URL` | ✅ | Must match the OAuth App exactly |
| `SESSION_SECRET` | ✅ | Long random string (`openssl rand -hex 32`) |
| `ALLOWED_GITHUB_USER` | | Only this GitHub username can sign in. If unset, any GitHub user can — **not recommended** |
| `PORT` | | Default `4000` |
| `BASE_DIR` | | Root for the project picker (e.g. `/home/you/projects`) |
| `CLAUDE_PATH` | | Absolute path to `claude` — set this under PM2 / systemd |
| `NODE_ENV` | | Set to `production` to enforce HTTPS-only cookies |

---

## 🛡️ Security Notes

- **Single-user by design.** `ALLOWED_GITHUB_USER` is checked on every login. There is no multi-user mode and no admin panel — that's the entire security model.
- **HTTPS is not optional in production.** OAuth tokens and session cookies fly in cleartext otherwise.
- **`--dangerously-skip-permissions` is on by default** because this UI is your personal remote. If you expose it, you're trusting Claude with your filesystem. Restrict `BASE_DIR` to a safe subtree.
- **Session store is in-memory** by default — PM2 reload logs you out. Swap to `connect-sqlite3` or `connect-redis` if that bothers you (one-line change in `src/auth.js`).

---

## 🗺️ Roadmap

- [ ] Persistent session store (SQLite) so PM2 reload doesn't sign you out
- [ ] Docker image
- [ ] CodeMirror live editing in the file viewer
- [ ] Push notifications when long prompts finish
- [ ] Multi-user via OAuth groups (probably never — that's not the design)

PRs welcome for everything above (and pushback welcome on the last one).

---

## 🤝 Contributing

This is a personal tool that grew into something shareable. PRs that **keep the LOC low and the dependency tree small** are very welcome. If you want to add a 5 MB chart library, please open an issue first.

```bash
git clone https://github.com/KoichiIshiguro/claude-code-remote.git
cd claude-code-remote
npm install
cp .env.example .env  # fill in your secrets
npm run dev           # auto-restart on file change
```

---

## 📜 License

MIT — see [LICENSE](LICENSE).

`claude` is Anthropic's commercial product and is not bundled with this repo. You need your own Claude account / API access.

---

<div align="center">

**Built because every remote-Claude UI on GitHub was either bloated, abandoned, or both.**

If this saved you a weekend, ⭐ star the repo — that's the only reward this project asks for.

</div>
