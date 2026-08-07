@echo off
rem Supervisor for the cloudflared tunnel (code.cnly.au -> 127.0.0.1:4620).
rem Mirrors harness-run.cmd: restart on exit, log output, no admin required.
rem Started at login by CloudflaredTunnel.vbs in the user's Startup folder.

set "CF_LOG=C:\AI\voice harness\cloudflared.out.log"

tasklist /FI "IMAGENAME eq cloudflared.exe" 2>nul | find /I "cloudflared.exe" >nul 2>&1
if "%errorlevel%"=="0" (
  echo [%date% %time%] skipped: cloudflared already running >> "%CF_LOG%"
  exit /b 0
)

:loop
echo [%date% %time%] starting cloudflared >> "%CF_LOG%"
"C:\Users\karan\.local\bin\cloudflared.exe" tunnel run cvh-harness >> "%CF_LOG%" 2>&1
echo [%date% %time%] cloudflared exited with code %errorlevel% >> "%CF_LOG%"
timeout /t 3 /nobreak >nul
goto loop
