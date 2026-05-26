# Setup Instructions for Claude

> This file is meant to be read by Claude Code, not by humans.
> Humans: just run `claude "Read setup.md and set this up"` in the repo root.

You are setting up **claude-code-remote** for the human user. Work through the
checklist below **in order**. The setup is **idempotent and resumable** — at
every step, check the current state first and skip if already done. If you
are interrupted, the user can re-run you with the same prompt and you will
pick up from the first incomplete step.

**Important rules:**

- ✅ Before every action, **check the current state**. Do not blindly run
  commands. Skip steps that are already complete.
- 🛑 When you need information only the user can provide (OAuth credentials,
  domain name, etc.), **stop and ask**. Do not invent values.
- 🔒 Show the user the contents of `.env` before writing secrets, and ask
  for confirmation.
- 🚫 Do not run `sudo` unless the user explicitly authorizes it. PM2 / Apache
  setup that needs root is **optional** — offer it, don't assume it.
- 🪶 Keep terminal output short. Long stack traces should be summarized.

---

## Step 0 — Verify you are in the right directory

```bash
test -f package.json && grep -q '"name": "claude-code-remote"' package.json && echo OK
```

If this does not print `OK`, stop and tell the user to `cd` into the repo first.

---

## Step 1 — Verify prerequisites

Check each, and stop with a clear error if missing:

- `node --version` → must be ≥ 18
- At least one of `pnpm --version`, `npm --version`, or `yarn --version` → must exist
- `claude --version` → must exist (this is the Claude Code CLI itself)

If `claude` is missing, point the user at <https://docs.claude.com/en/docs/claude-code/quickstart>
and stop. We cannot proceed without it.

Also note the **absolute path** of `claude` (`which claude`) — you will need
it later for `CLAUDE_PATH` if the user picks PM2.

---

## Step 2 — Install dependencies

Detect the package manager the user has and use whatever they prefer.
The repo ships `pnpm-lock.yaml`, but npm and yarn also work.

```bash
test -d node_modules && echo "deps already installed" && exit 0
# pick whichever is available, preferring pnpm
if command -v pnpm >/dev/null; then pnpm install
elif command -v npm  >/dev/null; then npm install
elif command -v yarn >/dev/null; then yarn install
else echo "Need pnpm, npm, or yarn"; exit 1; fi
```

If install fails, show the user the last 20 lines of the error and stop.

---

## Step 3 — Prepare `.env`

**Check first:** if `.env` already exists, read it and report which required
fields are already filled. Skip steps for fields that are already set to
non-placeholder values.

Required fields:

| Field | How to get it |
|---|---|
| `GITHUB_CLIENT_ID` | From GitHub OAuth app (see Step 4) |
| `GITHUB_CLIENT_SECRET` | From GitHub OAuth app (see Step 4) |
| `GITHUB_CALLBACK_URL` | `{base_url}/auth/github/callback` |
| `SESSION_SECRET` | Generate with `openssl rand -hex 32` |
| `ALLOWED_GITHUB_USER` | Ask the user for their GitHub username |

Optional but recommended:

| Field | Default | When to set |
|---|---|---|
| `PORT` | `4000` | Change only if 4000 is taken |
| `BASE_DIR` | unset | Set to e.g. `/home/$USER/projects` to enable the project picker |
| `CLAUDE_PATH` | unset | **Set** if running under PM2 (use the absolute path from Step 1) |
| `NODE_ENV` | unset | Set to `production` only when behind HTTPS |

If `.env` does not exist yet, copy `.env.example` first:

```bash
cp .env.example .env
```

Then proceed to Step 4.

---

## Step 4 — Determine the base URL and create the GitHub OAuth app

**Ask the user:**

> Where will this run? Pick one:
>
> 1. **Localhost only** (testing) — base URL will be `http://localhost:4000`
> 2. **Behind a domain with HTTPS** (production) — give me the URL, e.g. `https://claude.example.com`

Use the answer to determine `base_url`. Then:

```text
GITHUB_CALLBACK_URL = {base_url}/auth/github/callback
```

**Now have the user create the OAuth app.** Print these instructions verbatim:

> 1. Open <https://github.com/settings/developers>
> 2. Click **"New OAuth App"**
> 3. Fill in:
>    - **Application name**: `Claude Code Remote` (or whatever you like)
>    - **Homepage URL**: `{base_url}`
>    - **Authorization callback URL**: `{base_url}/auth/github/callback`
> 4. Click **Register application**
> 5. Copy the **Client ID** and paste it here
> 6. Click **"Generate a new client secret"**, copy it, and paste it here

**Wait for the user** to paste both values. Do not proceed without them.

---

## Step 5 — Generate `SESSION_SECRET`

```bash
openssl rand -hex 32
```

Use the output as `SESSION_SECRET`.

---

## Step 6 — Ask about `BASE_DIR`

**Ask the user:**

> Do you want a "project picker" that lists subdirectories under a single
> parent folder? If yes, what's the absolute path? (e.g. `/home/$USER/projects`)
> Press enter to skip — you can always set this later.

If the user gives a path, verify it exists (`test -d $path`) and set `BASE_DIR`.
If they skip, leave it unset.

---

## Step 7 — Write `.env`

Build the final `.env` content. **Show it to the user** with secrets masked
(e.g. `GITHUB_CLIENT_SECRET=xxxx...xxxx` showing only first/last 4 chars) and
ask for confirmation. After confirmation, write the file.

Required content template:

```env
GITHUB_CLIENT_ID={client_id}
GITHUB_CLIENT_SECRET={client_secret}
GITHUB_CALLBACK_URL={callback_url}
SESSION_SECRET={session_secret}
ALLOWED_GITHUB_USER={github_username}
PORT={port}
# Optional fields below — only include if the user set them
BASE_DIR={base_dir}
CLAUDE_PATH={claude_path}
NODE_ENV=production
```

After writing, run:

```bash
chmod 600 .env
```

so secrets aren't world-readable.

---

## Step 8 — Smoke test

Start the server in the foreground:

```bash
npm start
```

Watch for: `Claude Code Remote running at http://localhost:{PORT}`.

If you see it within 5 seconds, kill it (Ctrl-C / SIGINT). The smoke test
passes.

If you see an error:

- **`SESSION_SECRET is required`** → Step 7 didn't write correctly. Re-check `.env`.
- **`EADDRINUSE`** → port is taken. Ask the user for a different port and update `.env`.
- Anything else → show the last 10 lines to the user.

---

## Step 9 — Ask about process supervisor

**Ask the user:**

> How do you want to run this long-term?
>
> 1. **PM2** (recommended for VPS) — auto-restart, log management
> 2. **systemd** — I'll generate a unit file but won't install it
> 3. **Just `npm start` in a tmux** — minimal, do nothing
> 4. **Skip** — you'll figure it out

For option **1 (PM2)**:

Check if PM2 is installed:

```bash
which pm2 || echo "pm2 not installed"
```

If not installed, ask: "Install PM2 globally? (`npm install -g pm2`)". Only
run with explicit yes.

Then:

```bash
pm2 start server.js --name claude-code-remote
pm2 save
```

Tell the user to run `pm2 startup` once manually if they want auto-start on
boot (it needs sudo, so we don't run it automatically).

For option **2 (systemd)**:

Generate `/tmp/claude-code-remote.service` and tell the user to install it
with `sudo cp` and `sudo systemctl enable --now claude-code-remote`. Don't
run sudo yourself.

```ini
[Unit]
Description=Claude Code Remote
After=network.target

[Service]
Type=simple
WorkingDirectory={absolute_repo_path}
ExecStart=/usr/bin/node server.js
Restart=on-failure
User={current_user}

[Install]
WantedBy=multi-user.target
```

For **3 / 4**: skip.

---

## Step 10 — Reverse proxy (optional)

**Only if** the user picked HTTPS in Step 4:

Ask: "Do you want me to generate an Apache or nginx vhost snippet?"

If Apache, print this with placeholders filled in:

```apache
<VirtualHost *:443>
    ServerName {hostname}
    ProxyPreserveHost On
    RewriteEngine On
    RewriteCond %{HTTP:Upgrade} websocket [NC]
    RewriteCond %{HTTP:Connection} upgrade [NC]
    RewriteRule /(.*) ws://127.0.0.1:{port}/$1 [P,L]
    ProxyPass / http://127.0.0.1:{port}/
    ProxyPassReverse / http://127.0.0.1:{port}/
    LimitRequestBody 26214400
    SSLCertificateFile /etc/letsencrypt/live/{hostname}/fullchain.pem
    SSLCertificateKeyFile /etc/letsencrypt/live/{hostname}/privkey.pem
</VirtualHost>
```

Tell the user how to enable it manually (`sudo a2ensite ... && sudo systemctl reload apache2`).
Don't run these yourself.

For Let's Encrypt: print the certbot command, don't run it:

```bash
sudo certbot --apache -d {hostname}
```

---

## Step 11 — Final summary

Print a tidy summary like:

```
✅ Setup complete

  URL:               {base_url}
  Allowed user:      {github_username}
  Process supervisor: {pm2|systemd|none}
  Reverse proxy:     {configured|skipped}

Next:
  1. Open {base_url} and sign in with GitHub
  2. (Optional) Add this site to your home screen for PWA mode
  3. Star the repo if you like it: https://github.com/<repo>

If anything broke, check:
  • pm2 logs claude-code-remote    (if you chose PM2)
  • ./node_modules/.bin/node server.js   (raw run, see stderr)
```

You're done. Don't add more output.

---

## Resume logic

If you are re-invoked, jump to the first step where the check fails:

- Step 1 fails → user needs to install something, stop and tell them
- Step 2 fails → `node_modules` missing → `npm install`
- Step 3-7 → if `.env` exists, read it, fill in only missing fields
- Step 8 → always re-run as a quick smoke test
- Step 9 → check `pm2 list | grep claude-code-remote` or `systemctl status`,
  skip if already running
- Step 10-11 → re-print summary if the user wants
