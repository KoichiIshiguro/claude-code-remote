#!/usr/bin/env bash
set -euo pipefail
cd /Volumes/sal-dev/claude-code-remote
git pull
pnpm i
launchctl kill TERM "gui/$(id -u)/com.claude-code-remote"   # KeepAlive が自動で再起動
echo "✅ done (最大10秒で再起動)"
