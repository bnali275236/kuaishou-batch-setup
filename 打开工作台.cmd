@echo off
rem ===========================================================
rem  Kuaishou Ads Workbench - quick open (web mode)
rem  Double-click: opens the workbench page in your browser.
rem  If the service is not running yet, it starts it first,
rem  then opens the page automatically.
rem
rem  NOTE: keep this file pure ASCII + CRLF line endings.
rem ===========================================================
setlocal
cd /d "%~dp0"

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
goto nonode

:run
"%NODE_EXE%" tools\web-launch.cjs --open
exit /b %ERRORLEVEL%

:nonode
echo [ERR] Node.js not found. Tried: PATH, tools\node, Program Files, LOCALAPPDATA, .workbuddy.
pause
exit /b 1
