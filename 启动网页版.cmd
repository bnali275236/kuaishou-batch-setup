@echo off
rem ===========================================================
rem  Kuaishou Ads Workbench - Web Mode launcher
rem  Double-click to start. Then open http://127.0.0.1:7801
rem
rem  This window = service + built-in watchdog.
rem  Keep it open (minimizing is fine). Close it to stop.
rem  If the service crashes, it restarts automatically.
rem  If another instance is already running, this window takes
rem  over and the old one yields, so double-click always works.
rem
rem  NOTE: keep this file pure ASCII + CRLF line endings.
rem        Chinese in .cmd breaks under GBK console.
rem ===========================================================
title Kuaishou Workbench - Web
setlocal
cd /d "%~dp0"

rem ---- locate node.exe: bundled copy first (stable version), then PATH / installs ----
set "NODE_EXE="
if exist "%~dp0tools\node\node.exe" set "NODE_EXE=%~dp0tools\node\node.exe"
if defined NODE_EXE goto run
for %%P in (node.exe) do if not "%%~$PATH:P"=="" set "NODE_EXE=%%~$PATH:P"
if defined NODE_EXE goto run
if exist "%ProgramFiles%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles%\nodejs\node.exe"
if defined NODE_EXE goto run
if exist "%ProgramW6432%\nodejs\node.exe" set "NODE_EXE=%ProgramW6432%\nodejs\node.exe"
if defined NODE_EXE goto run
if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set "NODE_EXE=%LOCALAPPDATA%\Programs\nodejs\node.exe"
if defined NODE_EXE goto run
for /d %%D in ("%USERPROFILE%\.workbuddy\binaries\node\versions\*") do if exist "%%~fD\node.exe" set "NODE_EXE=%%~fD\node.exe"
if defined NODE_EXE goto run
goto nonode

:run
echo [INFO] Node: %NODE_EXE%
"%NODE_EXE%" --version
echo.
"%NODE_EXE%" tools\web-launch.cjs

echo.
echo [INFO] Service stopped. You can close this window.
pause
exit /b 0

:nonode
echo [ERR] Node.js not found. Tried: PATH, tools\node, Program Files, LOCALAPPDATA, .workbuddy.
echo.
echo   Fix option 1 - drop a node.exe here:  %~dp0tools\node\node.exe
echo   Fix option 2 - install Node.js 18+ :  https://nodejs.org/
echo.
pause
exit /b 1
