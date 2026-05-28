@echo off
REM Claude Code Remote — Windows installer entry point.
REM Bypasses execution policy for one run and calls install.ps1 next to this file.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1"
echo.
echo Press any key to close...
pause >nul
