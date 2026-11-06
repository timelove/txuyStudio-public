@echo off
chcp 65001 >nul
REM ============================================================
REM  txuyStudio relay server (local dev)
REM  Listens on :8787. Desktop app and web/phone clients
REM  connect OUTBOUND to it, so no firewall prompt.
REM
REM  NOTE: local programs are invoked with a dot-prefix (\relay.exe)
REM        because NoDefaultCurrentDirectoryInExePath=1 may be set in
REM        integrated terminals (VS Code / Claude Code).
REM  This file is ASCII-only on purpose: non-ASCII inside a .bat
REM  gets mis-parsed under the default console codepage.
REM ============================================================
setlocal
cd /d "%~dp0..\relay"

if not exist "relay.exe" (
  echo [build] relay.exe not found, building...
  go build -o relay.exe .
  if errorlevel 1 (
    echo [error] build failed - is Go installed?
    pause
    exit /b 1
  )
)

netstat -ano ^| findstr "LISTENING" ^| findstr ":8787" >nul 2>&1
if not errorlevel 1 (
  echo [warn] port 8787 already in use - another relay may be running.
  echo        Close it first, or this instance will fail to bind.
  echo.
)

echo.
echo === txuyStudio relay ===
echo   listen : http://127.0.0.1:8787   (health: /healthz)
echo   quit   : Ctrl+C
echo.

.\relay.exe -config relay-config.json

endlocal
pause
