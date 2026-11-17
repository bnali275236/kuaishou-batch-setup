@echo off
rem ===========================================================
rem  Toggle the logon autostart for the web-mode service.
rem  Task name: KuaishouWebWorkbench (runs tools\web-launch.cjs)
rem  NOTE: keep this file pure ASCII + CRLF.
rem ===========================================================
setlocal enabledelayedexpansion
set "TASK=KuaishouWebWorkbench"

schtasks /Query /TN "%TASK%" >nul 2>&1
if errorlevel 1 (
  echo [ERR] Task "%TASK%" is not registered on this machine.
  echo       Start the service once with the normal launcher first.
  pause
  exit /b 1
)

echo   1 = Disable autostart  ^(service will NOT start at logon^)
echo   2 = Enable autostart   ^(service starts at logon, no window^)
echo   3 = Show current status
echo.
choice /c 123 /n /m "Select 1/2/3: "
if errorlevel 3 goto status
if errorlevel 2 goto enable
goto disable

:disable
schtasks /End /TN "%TASK%" >nul 2>&1
schtasks /Change /TN "%TASK%" /DISABLE >nul 2>&1
if errorlevel 1 (
  echo [ERR] Disable failed. Try: right-click this file - Run as administrator.
) else (
  echo [OK] Autostart DISABLED. The service will not start at next logon.
  echo      Current running instance was stopped as well.
  for /f "tokens=5" %%P in ('netstat -ano ^| findstr /C:":7801 " ^| findstr "LISTENING"') do taskkill /PID %%P /F >nul 2>&1
)
goto end

:enable
schtasks /Change /TN "%TASK%" /ENABLE >nul 2>&1
if errorlevel 1 (
  echo [ERR] Enable failed. Try: right-click this file - Run as administrator.
) else (
  echo [OK] Autostart ENABLED.
  choice /n /m "Start it right now? (Y/N): "
  if not errorlevel 2 schtasks /Run /TN "%TASK%" >nul 2>&1
)
goto end

:status
schtasks /Query /TN "%TASK%"
goto end

:end
echo.
pause
