@echo off
rem ============================================================
rem  Save the Alien - Together Edition (2 Players VS)
rem  Double-click to play offline. Keep this window open;
rem  close it to stop the game server.
rem ============================================================
cd /d "%~dp0"
echo.
echo   Starting "Save the Alien - Together Edition (2P VS)" ...
echo   Your browser will open at http://localhost:5500/versus.html
echo   (Keep this window open. Close it to stop.)
echo.

start "" cmd /c "timeout /t 2 >nul & start "" http://localhost:5500/versus.html"

where py >nul 2>nul && (py -m http.server 5500 & goto :eof)
where python >nul 2>nul && (python -m http.server 5500 & goto :eof)
where python3 >nul 2>nul && (python3 -m http.server 5500 & goto :eof)

echo Python was not found. Please install Python from https://python.org
pause
