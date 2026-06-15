#!/usr/bin/env bash
set -euo pipefail

LABEL="com.saltybullet.claude-code-remote"
DST_PLIST="${HOME}/Library/LaunchAgents/${LABEL}.plist"

if [[ -f "${DST_PLIST}" ]]; then
  launchctl unload "${DST_PLIST}" 2>/dev/null || true
  rm -f "${DST_PLIST}"
  echo "removed ${DST_PLIST}"
else
  echo "no plist at ${DST_PLIST} — nothing to remove"
fi
