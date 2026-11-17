@echo off
rem ===========================================================
rem  Stop the web-mode service.
rem  1) end the scheduled task first - otherwise its watchdog
rem     restarts whatever we just killed
rem  2) kill the launcher (watchdog parent) recorded in
rem     .runtime\launcher-7801.pid, together with its children
rem  3) kill the port listener, retry a few times
rem  4) verify the port is really free
rem  Needed because the console window hides itself after
rem  startup - there is no window left to close by hand.
rem  NOTE: keep this file pure ASCII + CRLF.
rem ===========================================================
setlocal enabledelayedexpansion
set "TASK=KuaishouWebWorkbench"
set "LOCKFILE=%~dp0.runtime\launcher-7801.pid"

echo [1/4] Ending scheduled task %TASK% ...
schtasks /Query /TN "%TASK%" >nul 2>&1
if errorlevel 1 (
  echo   Task not registered, skip.
) else (
  schtasks /End /TN "%TASK%" >nul 2>&1
  timeout /t 3 /nobreak >nul
)

echo [2/4] Stopping launcher (watchdog parent) ...
set "LPID="
if exist "%LOCKFILE%" (
  for /f "usebackq delims=" %%L in ("%LOCKFILE%") do set "LPID=%%L"
)
if defined LPID (
  echo   Killing launcher PID !LPID! and its children ...
  taskkill /PID !LPID! /F /T >nul 2>&1
) else (
  echo   No launcher pid file, skip.
)
timeout /t 2 /nobreak >nul

echo [3/4] Killing listener on port 7801 ...
set ATTEMPT=0
:killloop
set "FOUND=0"
for /f "tokens=5" %%P in ('netstat -ano ^| findstr /C:":7801 " ^| findstr "LISTENING"') do (
  echo   Stopping PID %%P ...
  taskkill /PID %%P /F >nul 2>&1
  set "FOUND=1"
)
if "!FOUND!"=="0" goto killed
set /a ATTEMPT+=1
if !ATTEMPT! lss 3 (
  echo   Still listening, retry !ATTEMPT!/3 ...
  timeout /t 2 /nobreak >nul
  goto killloop
)

:killed
echo [4/4] Verifying ...
netstat -ano | findstr /C:":7801 " | findstr "LISTENING" >nul
if errorlevel 1 (
  echo [OK] Service stopped, port 7801 is free.
) else (
  echo [WARN] Port 7801 is still occupied - something keeps restarting it.
  echo        Run autostart-toggle.cmd and choose option 1.
)

echo.
echo Autostart stays ENABLED: service starts again at next logon.
echo To disable it permanently, run autostart-toggle.cmd
pause
