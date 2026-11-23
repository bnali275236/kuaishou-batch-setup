@echo off
rem ===========================================================
rem  Kuaishou Ads Workbench - Backend Watchdog
rem  Probes http://127.0.0.1:7801 every 60s and restarts the
rem  backend automatically if it is down.
rem  Keep this window open (minimize it). Ctrl+C or close = stop.
rem  Start it on boot: put a shortcut of this file into
rem  shell:startup  (Win+R -> shell:startup)
rem  NOTE: keep this file pure ASCII + CRLF.
rem ===========================================================
title Kuaishou Backend Watchdog
cd /d "%~dp0"

node --version >nul 2>&1
if errorlevel 1 (
  echo [ERR] Node.js not found in PATH.
  pause
  exit /b 1
)

echo [INFO] Watchdog starting... log: .runtime\watchdog.log
node tools\watchdog.cjs
echo.
echo [INFO] Watchdog stopped.
pause
