#!/bin/bash
#
# Claude Code Remote — one-shot installer for macOS / Linux.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/KoichiIshiguro/claude-code-remote/main/install.sh | bash
#   — or download and double-click —
#
# Installs (in this order, only if missing):
#   Homebrew (macOS) → Node.js → git → Claude CLI → Tailscale
# Then clones this repo, installs npm deps, starts the server in the
# background, and opens http://localhost:4000/setup in your browser.

set -e

B=$(printf '\033[1m'); D=$(printf '\033[2m'); R=$(printf '\033[0m')
OK="✅"; ARROW="→"; WARN="⚠️ "; CROSS="❌"

step()  { echo ""; echo "${B}${ARROW} $1${R}"; }
ok()    { echo "  ${OK} $1"; }
warn()  { echo "  ${WARN}$1"; }
err()   { echo ""; echo "${CROSS} $1" >&2; exit 1; }

INSTALL_DIR="${CLAUDE_CODE_REMOTE_DIR:-$HOME/claude-code-remote}"
REPO_URL="${CLAUDE_CODE_REMOTE_REPO:-https://github.com/KoichiIshiguro/claude-code-remote.git}"
PORT="${PORT:-4000}"

echo "${B}╔════════════════════════════════════════╗${R}"
echo "${B}║  Claude Code Remote — installer        ║${R}"
echo "${B}╚════════════════════════════════════════╝${R}"
echo "${D}Installs Node.js, Claude CLI, Tailscale; then starts the server.${R}"
echo ""

case "$(uname -s)" in
  Darwin*) OS=macos ;;
  Linux*)  OS=linux ;;
  *)       err "Unsupported OS. Need macOS or Linux. For Windows, use install.ps1." ;;
esac
ok "$OS detected"

# ── 1. Homebrew (macOS only) ──────────────────────────────────────────────────
if [ "$OS" = "macos" ]; then
  step "Homebrew"
  if command -v brew >/dev/null 2>&1; then
    ok "already installed"
  else
    echo "  Installing Homebrew — your Mac password will be required."
    /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
    if   [ -x /opt/homebrew/bin/brew ]; then eval "$(/opt/homebrew/bin/brew shellenv)"
    elif [ -x /usr/local/bin/brew     ]; then eval "$(/usr/local/bin/brew shellenv)"
    fi
    command -v brew >/dev/null 2>&1 || err "Homebrew install failed."
    ok "installed"
  fi
fi

# ── 2. Node.js (>= 18) ────────────────────────────────────────────────────────
step "Node.js"
node_ok=0
if command -v node >/dev/null 2>&1; then
  major=$(node -e 'process.stdout.write(String(process.versions.node.split(".")[0]))')
  if [ "$major" -ge 18 ] 2>/dev/null; then node_ok=1; fi
fi
if [ "$node_ok" = "1" ]; then
  ok "Node $(node -v) already installed"
else
  if [ "$OS" = "macos" ]; then
    brew install node
  else
    curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
    sudo apt-get install -y nodejs
  fi
  ok "installed"
fi

# ── 3. git ────────────────────────────────────────────────────────────────────
step "git"
if command -v git >/dev/null 2>&1; then
  ok "$(git --version | awk '{print $1, $3}') already installed"
else
  if [ "$OS" = "macos" ]; then
    echo "  Triggering Xcode Command Line Tools install (a GUI dialog will appear)..."
    xcode-select --install 2>/dev/null || true
    err "Click 'Install' in the dialog, wait for it to finish, then re-run this script."
  else
    sudo apt-get install -y git
    ok "installed"
  fi
fi

# ── 4. Claude CLI ─────────────────────────────────────────────────────────────
step "Claude CLI"
if command -v claude >/dev/null 2>&1; then
  ok "already installed"
else
  echo "  Installing Claude CLI..."
  curl -fsSL claude.ai/install.sh | bash
  export PATH="$HOME/.local/bin:$PATH"
  if ! command -v claude >/dev/null 2>&1; then
    err "Claude CLI installed but not on PATH. Open a new terminal and re-run this script."
  fi
  ok "installed"
fi

echo ""
echo "  ${D}Next, you'll need to sign in to Claude with your Pro/Max account.${R}"
echo "  ${D}If you haven't signed in before, run this once after the script finishes:${R}"
echo "      ${B}claude${R}    ${D}(then type /login inside the TUI)${R}"

# ── 5. Tailscale ──────────────────────────────────────────────────────────────
step "Tailscale"
if command -v tailscale >/dev/null 2>&1; then
  ok "already installed"
else
  if [ "$OS" = "macos" ]; then
    brew install --cask tailscale
    ok "Tailscale.app installed — open it from Applications and sign in"
  else
    curl -fsSL https://tailscale.com/install.sh | sh
    ok "installed — run 'sudo tailscale up' to sign in"
  fi
fi

# ── 6. Clone & install ────────────────────────────────────────────────────────
step "Claude Code Remote"
if [ -d "$INSTALL_DIR/.git" ]; then
  echo "  Existing checkout found at $INSTALL_DIR — updating"
  (cd "$INSTALL_DIR" && git pull --quiet --ff-only) || warn "git pull failed; continuing with existing version"
else
  git clone --quiet "$REPO_URL" "$INSTALL_DIR"
  ok "cloned to $INSTALL_DIR"
fi

cd "$INSTALL_DIR"
echo "  Installing dependencies (1-2 min)..."
npm install --silent --no-audit --no-fund
ok "dependencies installed"

# ── 7. Start server in the background ─────────────────────────────────────────
step "Starting server on port $PORT"
PIDFILE="$INSTALL_DIR/.server.pid"
if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
  ok "already running (PID $(cat "$PIDFILE"))"
else
  PORT="$PORT" nohup node server.js > server.log 2>&1 &
  echo $! > "$PIDFILE"
  sleep 2
  if kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
    ok "started (PID $(cat "$PIDFILE"))"
  else
    err "Server failed to start. Check $INSTALL_DIR/server.log"
  fi
fi

# ── 8. Open browser ───────────────────────────────────────────────────────────
URL="http://localhost:$PORT/setup"
echo ""
echo "${B}🎉 All set.${R}  Opening $URL ..."
( open "$URL" 2>/dev/null || xdg-open "$URL" 2>/dev/null ) &

echo ""
echo "${D}Useful commands:${R}"
echo "  Log:     ${B}tail -f $INSTALL_DIR/server.log${R}"
echo "  Stop:    ${B}kill \$(cat $INSTALL_DIR/.server.pid)${R}"
echo "  Restart: ${B}cd $INSTALL_DIR && kill \$(cat .server.pid) 2>/dev/null; nohup node server.js > server.log 2>&1 & echo \$! > .server.pid${R}"
echo ""
