@echo off
rem Stop the web-mode service (kills whoever listens on port 7801)
setlocal enabledelayedexpansion
set FOUND=0
for /f "tokens=5" %%P in ('netstat -ano ^| findstr /C:":7801 " ^| findstr "LISTENING"') do (
  echo Stopping PID %%P ...
  taskkill /PID %%P /F >nul 2>&1
  set FOUND=1
)
if "!FOUND!"=="0" echo [INFO] Nothing is listening on 7801.
pause
