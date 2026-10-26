@echo off
cd /d "%~dp0"
if not exist "node_modules" (
  echo Installing Node.js dependencies...
  call npm install
)
if not exist "dist" (
  echo Building TypeScript...
  call npm run build
)
echo Starting Voice Agent Console + Live Simulator + VICIdial Bridge on http://localhost:3000 ...
call npm start
pause
