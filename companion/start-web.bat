@echo off
chcp 65001 >nul
REM ============================================================
REM  txuyStudio companion - web client (dev mode, hot reload)
REM  App source: .\app  (Flutter)
REM  Serves on :8899
REM
REM  Prereq: relay running (start-relay.bat) + desktop app online.
REM  This file is ASCII-only on purpose: non-ASCII inside a .bat
REM  gets mis-parsed under the default console codepage.
REM ============================================================
setlocal

set "PORT=8899"
set "APP_DIR=%~dp0app"
set "FLUTTER_BIN=D:\work\Android\flutterVersion\flutter3.47.7\bin"

REM ------------------------------------------------------------
REM  Port guard: a stale "flutter run" (or anything else) holding
REM  :8899 would make this run fail or serve an old bundle. Stop
REM  here and print the exact command to free the port.
REM ------------------------------------------------------------
set "HOLDER="
for /f "tokens=5" %%p in ('netstat -ano ^| findstr /i "LISTENING" ^| findstr /c:":%PORT% "') do if not defined HOLDER set "HOLDER=%%p"

if defined HOLDER (
  echo.
  echo [error] port %PORT% is already in use  ^(PID %HOLDER%^)
  echo.
  echo   inspect : tasklist /FI "PID eq %HOLDER%"
  echo   kill    : taskkill /PID %HOLDER% /F
  echo.
  echo A stale "flutter run" is the usual holder. Free the port, then re-run this script.
  echo.
  pause
  exit /b 1
)

set "PATH=%FLUTTER_BIN%;%PATH%"
REM China mirrors - direct pub.dev often times out
set "PUB_HOSTED_URL=https://pub.flutter-io.cn"
set "FLUTTER_STORAGE_BASE_URL=https://storage.flutter-io.cn"

if not exist "%APP_DIR%\pubspec.yaml" (
  echo [error] Flutter project not found: %APP_DIR%
  pause
  exit /b 1
)

cd /d "%APP_DIR%"

echo.
echo === txuyStudio companion (web) ===
echo   url  : http://localhost:%PORT%   ^(open it in your browser manually^)
echo   relay: ws://127.0.0.1:8787/ws   (run start-relay.bat first)
echo   keys : r = hot reload, R = hot restart, q = quit
echo.

call flutter pub get
call flutter run -d web-server --web-port %PORT%

endlocal
pause
