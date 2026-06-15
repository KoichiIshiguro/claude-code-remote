#!/usr/bin/env bash
set -euo pipefail

LABEL="com.saltybullet.claude-code-remote"
PORT="${PORT:-4040}"
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLIST_SRC="${REPO_DIR}/scripts/launchd/${LABEL}.plist"
PLIST_DST="${HOME}/Library/LaunchAgents/${LABEL}.plist"
DOMAIN="gui/$(id -u)"

log() { printf '\n==> %s\n' "$*"; }
warn() { printf '\nWARN: %s\n' "$*" >&2; }

cd "$REPO_DIR"

usage() {
  cat <<USAGE
Usage: ./update.sh [--help]

Updates and restarts claude-code-remote under launchd.

Environment options:
  NO_GIT_PULL=1    Skip git pull
  SKIP_INSTALL=1   Skip dependency install
  PORT=4040        Port to check after restart
USAGE
}

case "${1:-}" in
  -h|--help) usage; exit 0 ;;
  "") ;;
  *) echo "error: unknown argument: $1" >&2; usage >&2; exit 2 ;;
esac

log "repo: $REPO_DIR"

if [[ "${NO_GIT_PULL:-0}" != "1" ]]; then
  log "git pull --ff-only"
  git pull --ff-only
else
  warn "NO_GIT_PULL=1: skipping git pull"
fi

if [[ ! -f "$PLIST_SRC" ]]; then
  echo "error: launchd plist not found: $PLIST_SRC" >&2
  exit 1
fi

log "validate launchd plist"
plutil -lint "$PLIST_SRC"

if [[ "${SKIP_INSTALL:-0}" != "1" ]]; then
  log "install dependencies"
  if [[ -f pnpm-lock.yaml ]] && command -v pnpm >/dev/null 2>&1; then
    pnpm install --frozen-lockfile
  elif [[ -f pnpm-lock.yaml ]] && command -v corepack >/dev/null 2>&1; then
    corepack pnpm install --frozen-lockfile
  elif [[ -f package-lock.json ]]; then
    npm install
  else
    npm install
  fi
else
  warn "SKIP_INSTALL=1: skipping dependency install"
fi

if [[ ! -f .env ]] || ! grep -q '^CLAUDE_CODE_OAUTH_TOKEN=' .env; then
  warn ".env に CLAUDE_CODE_OAUTH_TOKEN が見つかりません。Claude 実行時に 401 になる可能性があります。"
fi

log "stop existing launchd job if loaded"
launchctl bootout "${DOMAIN}/${LABEL}" 2>/dev/null || true
launchctl unload "$PLIST_DST" 2>/dev/null || true

# If a manual node process is still holding the port, kill only this app's server.js.
if command -v lsof >/dev/null 2>&1; then
  PIDS="$(lsof -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null || true)"
  if [[ -n "$PIDS" ]]; then
    log "port $PORT is still in use; checking owner"
    for pid in $PIDS; do
      cmd="$(ps -p "$pid" -o command= 2>/dev/null || true)"
      if [[ "$cmd" == *"claude-code-remote/server.js"* || "$cmd" == *"/server.js"* ]]; then
        echo "killing old app process pid=$pid: $cmd"
        kill "$pid" 2>/dev/null || true
      else
        echo "error: port $PORT is used by a non-app process pid=$pid: $cmd" >&2
        exit 1
      fi
    done
    sleep 1
  fi
fi

log "install LaunchAgent plist"
mkdir -p "$(dirname "$PLIST_DST")"
cp "$PLIST_SRC" "$PLIST_DST"

log "start launchd job"
launchctl bootstrap "$DOMAIN" "$PLIST_DST" 2>/dev/null || launchctl load -w "$PLIST_DST"
launchctl enable "${DOMAIN}/${LABEL}" 2>/dev/null || true
launchctl kickstart -k "${DOMAIN}/${LABEL}" 2>/dev/null || true

log "wait for port $PORT"
for i in {1..20}; do
  if lsof -iTCP:"$PORT" -sTCP:LISTEN -n -P >/dev/null 2>&1; then
    break
  fi
  sleep 1
  if [[ "$i" == "20" ]]; then
    echo "error: service did not start listening on port $PORT" >&2
    echo "stderr log: ${REPO_DIR}/data/launchd-stderr.log" >&2
    tail -80 "${REPO_DIR}/data/launchd-stderr.log" 2>/dev/null || true
    exit 1
  fi
done

log "status"
launchctl list | grep "$LABEL" || true
lsof -iTCP:"$PORT" -sTCP:LISTEN -n -P || true

cat <<MSG

Done.
Logs:
  tail -f ${REPO_DIR}/data/launchd-stdout.log ${REPO_DIR}/data/launchd-stderr.log

Options:
  NO_GIT_PULL=1 ./update.sh    # git pull をスキップ
  SKIP_INSTALL=1 ./update.sh   # npm/pnpm install をスキップ
MSG
