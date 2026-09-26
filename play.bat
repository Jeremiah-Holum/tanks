@echo off
rem Steel Front: double-click to update, start the local server and open the game.
cd /d "%~dp0"
echo Updating...
git pull
if not exist node_modules (
  echo Installing dependencies...
  call npm install
)
echo Starting Steel Front at http://localhost:8477  (close this window to stop)
start "" "http://localhost:8477"
call npx http-server -p 8477 -c-1
