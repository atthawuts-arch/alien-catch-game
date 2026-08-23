@echo off
rem ============================================================
rem  Save the Alien - offline launcher
rem  Double-click this file to play. Keep this window open
rem  while playing; close it to stop the game server.
rem ============================================================
cd /d "%~dp0"
echo.
echo   Starting "Save the Alien" ...
echo   Your browser will open at http://localhost:5500
echo   (Keep this window open. Close it to stop.)
echo.

rem Open the browser after a short delay so the server is ready
start "" cmd /c "timeout /t 2 >nul & start "" http://localhost:5500/"

rem Try Python launchers in order, then fall back to a message
where py >nul 2>nul && (py -m http.server 5500 & goto :eof)
where python >nul 2>nul && (python -m http.server 5500 & goto :eof)
where python3 >nul 2>nul && (python3 -m http.server 5500 & goto :eof)

echo Python was not found. Please install Python from https://python.org
pause
