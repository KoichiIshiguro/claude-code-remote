#!/usr/bin/env bash
# Install claude-code-remote as a per-user macOS LaunchAgent.
#
# Why LaunchAgent (not LaunchDaemon):
#   `claude` reads OAuth credentials from the user's login keychain. A system
#   LaunchDaemon runs without that keychain and falls back to a stale token,
#   so every API call returns 401. A LaunchAgent runs in the user's session
#   and inherits the right environment.
#
# Prerequisite:
#   Set CLAUDE_CODE_OAUTH_TOKEN in <repo>/.env before loading the agent.
#   Generate one on a machine with a real terminal via: `claude setup-token`
#   (it opens a browser; needs a TTY, so do this once outside launchd).
#   Without this token the server starts, but every `claude -p` spawn 401s.

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
LABEL="com.saltybullet.claude-code-remote"
SRC_PLIST="${REPO_DIR}/scripts/launchd/${LABEL}.plist"
DST_PLIST="${HOME}/Library/LaunchAgents/${LABEL}.plist"

if [[ ! -f "${SRC_PLIST}" ]]; then
  echo "error: source plist missing at ${SRC_PLIST}" >&2
  exit 1
fi

mkdir -p "${HOME}/Library/LaunchAgents"

# Unload any previous instance so we can overwrite cleanly.
if launchctl list | grep -q "${LABEL}"; then
  echo "unloading existing ${LABEL}..."
  launchctl unload "${DST_PLIST}" 2>/dev/null || true
fi

cp "${SRC_PLIST}" "${DST_PLIST}"
echo "installed plist -> ${DST_PLIST}"

launchctl load -w "${DST_PLIST}"
echo "loaded ${LABEL}"

sleep 1
launchctl list | grep "${LABEL}" || {
  echo "warn: agent not visible in launchctl list" >&2
  exit 1
}

echo
echo "done. tail logs with:"
echo "  tail -f ${REPO_DIR}/data/launchd-stdout.log ${REPO_DIR}/data/launchd-stderr.log"
