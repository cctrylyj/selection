@echo off
REM Double-click to start the sourcing system (API + web) and open it in Chrome.
REM Content is intentionally ASCII-only to avoid Windows code page garbling.

cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js not found. Please install Node 22+ first.
  pause
  exit /b 1
)

echo [1/3] Starting API server on 127.0.0.1:8787 ...
start "sourcing-api" /min node server\index.js

echo [2/3] Starting web dev server on 127.0.0.1:5173 ...
start "sourcing-web" /min npx vite --host 127.0.0.1

echo [3/3] Waiting for the server, then opening Chrome ...
timeout /t 5 /nobreak >nul

set "CHROME="
if exist "C:\Program Files\Google\Chrome\Application\chrome.exe" set "CHROME=C:\Program Files\Google\Chrome\Application\chrome.exe"
if exist "C:\Program Files (x86)\Google\Chrome\Application\chrome.exe" set "CHROME=C:\Program Files (x86)\Google\Chrome\Application\chrome.exe"

if defined CHROME (
  start "" "%CHROME%" "http://127.0.0.1:5173/"
) else (
  echo [WARN] Chrome not found, falling back to the default browser.
  start "" "http://127.0.0.1:5173/"
)

echo Done. Two minimized windows are running; close them to stop the system.
exit /b 0
