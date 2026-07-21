@echo off
rem Autostart entrypoint for Windows Startup.
rem If the harness is already healthy, exit so manual runs/logon races do not create
rem a second supervisor loop hammering port 4620.

set "HARNESS_URL=http://127.0.0.1:4620/api/health"
set "AUTOSTART_LOG=C:\AI\voice harness\harness-autostart.log"

curl.exe -fsS --max-time 2 "%HARNESS_URL%" >nul 2>&1
if "%errorlevel%"=="0" (
  echo [%date% %time%] skipped: harness already healthy >> "%AUTOSTART_LOG%"
  exit /b 0
)

echo [%date% %time%] launching supervisor >> "%AUTOSTART_LOG%"
call "C:\AI\voice harness\harness-run.cmd"
