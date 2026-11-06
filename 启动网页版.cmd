@echo off
rem ===========================================================
rem  Kuaishou Ads Workbench - Web Mode launcher
rem  Double-click to start. Then open http://127.0.0.1:7801
rem  Data dir = %APPDATA%\KuaishouWorkbench (resolved in Node)
rem  Close this window to stop the service.
rem  NOTE: keep this file pure ASCII. Chinese in .cmd breaks
rem        under GBK console and silently drops env vars.
rem ===========================================================
title Kuaishou Workbench - Web
cd /d "%~dp0"

netstat -ano | findstr /C:":7801 " | findstr "LISTENING" >nul
if %errorlevel%==0 (
  echo [STOP] Port 7801 is already in use.
  echo        Quit the desktop app first, or run the stop script.
  echo        Desktop app and web mode must NOT run together.
  pause
  exit /b 1
)

node tools\web-launch.cjs
pause
