# Claude Code Remote — one-shot installer for Windows 10/11.
#
# Usage:
#   Right-click install.bat → Run as administrator   (recommended)
#   — or —
#   powershell -ExecutionPolicy Bypass -File install.ps1
#
# Installs (in this order, only if missing): Node.js, git, Claude CLI, Tailscale.
# Then clones the repo, installs npm deps, starts the server in the background,
# and opens http://localhost:4000/setup.

$ErrorActionPreference = 'Stop'

$InstallDir = if ($env:CLAUDE_CODE_REMOTE_DIR) { $env:CLAUDE_CODE_REMOTE_DIR } else { "$HOME\claude-code-remote" }
$RepoUrl    = if ($env:CLAUDE_CODE_REMOTE_REPO) { $env:CLAUDE_CODE_REMOTE_REPO } else { "https://github.com/KoichiIshiguro/claude-code-remote.git" }
$Port       = if ($env:PORT) { $env:PORT } else { "4000" }

function Step($msg) { Write-Host ""; Write-Host "→ $msg" -ForegroundColor Cyan }
function OK($msg)   { Write-Host "  ✅ $msg" -ForegroundColor Green }
function Warn($msg) { Write-Host "  ⚠️  $msg" -ForegroundColor Yellow }
function Die($msg)  { Write-Host ""; Write-Host "❌ $msg" -ForegroundColor Red; exit 1 }
function Has($cmd)  { return [bool](Get-Command $cmd -ErrorAction SilentlyContinue) }

Write-Host "╔════════════════════════════════════════╗" -ForegroundColor Cyan
Write-Host "║  Claude Code Remote — installer        ║" -ForegroundColor Cyan
Write-Host "╚════════════════════════════════════════╝" -ForegroundColor Cyan
Write-Host "Installs Node.js, Claude CLI, Tailscale; then starts the server." -ForegroundColor DarkGray

# ── 0. winget ─────────────────────────────────────────────────────────────────
Step "winget"
if (-not (Has 'winget')) {
  Write-Host "  winget not found. Install 'App Installer' from the Microsoft Store first." -ForegroundColor Yellow
  Start-Process "ms-windows-store://pdp/?productid=9NBLGGH4NNS1"
  Die "After installing App Installer, re-run this script."
}
OK "winget available"

# ── 1. Node.js (>= 18) ────────────────────────────────────────────────────────
Step "Node.js"
$nodeOk = $false
if (Has 'node') {
  $major = [int](& node -e 'process.stdout.write(String(process.versions.node.split(".")[0]))')
  if ($major -ge 18) { $nodeOk = $true; OK "Node v$($major) already installed" }
}
if (-not $nodeOk) {
  winget install --id OpenJS.NodeJS.LTS -e --accept-package-agreements --accept-source-agreements --silent
  $env:Path = [Environment]::GetEnvironmentVariable("Path","Machine") + ";" +
              [Environment]::GetEnvironmentVariable("Path","User")
  if (-not (Has 'node')) { Die "Node.js installed but not on PATH. Open a new PowerShell window and re-run." }
  OK "installed"
}

# ── 2. git ────────────────────────────────────────────────────────────────────
Step "git"
if (Has 'git') {
  OK "already installed"
} else {
  winget install --id Git.Git -e --accept-package-agreements --accept-source-agreements --silent
  $env:Path = [Environment]::GetEnvironmentVariable("Path","Machine") + ";" +
              [Environment]::GetEnvironmentVariable("Path","User")
  if (-not (Has 'git')) { Die "git installed but not on PATH. Open a new PowerShell window and re-run." }
  OK "installed"
}

# ── 3. Claude CLI ─────────────────────────────────────────────────────────────
Step "Claude CLI"
if (Has 'claude') {
  OK "already installed"
} else {
  Write-Host "  Installing Claude CLI..."
  Invoke-Expression (Invoke-RestMethod -Uri "https://claude.ai/install.ps1")
  $env:Path = [Environment]::GetEnvironmentVariable("Path","Machine") + ";" +
              [Environment]::GetEnvironmentVariable("Path","User")
  if (-not (Has 'claude')) { Die "Claude CLI installed but not on PATH. Open a new PowerShell window and re-run." }
  OK "installed"
}

Write-Host ""
Write-Host "  Next, sign in to Claude with your Pro/Max account." -ForegroundColor DarkGray
Write-Host "  If you haven't signed in yet, after this script finishes run:" -ForegroundColor DarkGray
Write-Host "      claude    (then type /login inside the TUI)" -ForegroundColor White

# ── 4. Tailscale ──────────────────────────────────────────────────────────────
Step "Tailscale"
if (Has 'tailscale') {
  OK "already installed"
} else {
  winget install --id tailscale.tailscale -e --accept-package-agreements --accept-source-agreements --silent
  OK "installed — open the Tailscale app from the Start menu and sign in"
}

# ── 5. Clone & npm install ────────────────────────────────────────────────────
Step "Claude Code Remote"
if (Test-Path "$InstallDir\.git") {
  Write-Host "  Existing checkout found at $InstallDir — updating"
  Push-Location $InstallDir
  try { git pull --quiet --ff-only } catch { Warn "git pull failed; continuing" }
  Pop-Location
} else {
  git clone --quiet $RepoUrl $InstallDir
  OK "cloned to $InstallDir"
}

Push-Location $InstallDir
Write-Host "  Installing dependencies (1-2 min)..."
npm install --silent --no-audit --no-fund | Out-Null
OK "dependencies installed"

# ── 6. Start server in background ─────────────────────────────────────────────
Step "Starting server on port $Port"
$pidFile = "$InstallDir\.server.pid"
$alreadyRunning = $false
if (Test-Path $pidFile) {
  $existingPid = Get-Content $pidFile -ErrorAction SilentlyContinue
  if ($existingPid -and (Get-Process -Id $existingPid -ErrorAction SilentlyContinue)) {
    OK "already running (PID $existingPid)"
    $alreadyRunning = $true
  }
}
if (-not $alreadyRunning) {
  $env:PORT = $Port
  $proc = Start-Process -FilePath "node" -ArgumentList "server.js" `
                        -WorkingDirectory $InstallDir `
                        -RedirectStandardOutput "$InstallDir\server.log" `
                        -RedirectStandardError "$InstallDir\server.err.log" `
                        -WindowStyle Hidden -PassThru
  $proc.Id | Out-File -Encoding ascii $pidFile
  Start-Sleep -Seconds 2
  if (Get-Process -Id $proc.Id -ErrorAction SilentlyContinue) {
    OK "started (PID $($proc.Id))"
  } else {
    Die "Server failed to start. Check $InstallDir\server.err.log"
  }
}
Pop-Location

# ── 7. Open browser ───────────────────────────────────────────────────────────
$url = "http://localhost:$Port/setup"
Write-Host ""
Write-Host "🎉 All set." -ForegroundColor Green
Write-Host "Opening $url ..."
Start-Process $url

Write-Host ""
Write-Host "Useful commands:" -ForegroundColor DarkGray
Write-Host "  Log:     Get-Content $InstallDir\server.log -Wait"
Write-Host "  Stop:    Stop-Process -Id (Get-Content $InstallDir\.server.pid)"
Write-Host "  Restart: cd $InstallDir; Stop-Process -Id (Get-Content .server.pid) -ErrorAction SilentlyContinue; Start-Process node server.js -WindowStyle Hidden -PassThru | %% { `$_.Id | Out-File .server.pid }"
Write-Host ""
