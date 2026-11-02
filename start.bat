@echo off
cd /d "%~dp0"
if not exist "node_modules" (
  echo Installing Node.js dependencies...
  call npm.cmd ci
  if errorlevel 1 exit /b 1
)
echo Building TypeScript...
call npm.cmd run build
if errorlevel 1 exit /b 1
echo Starting Voice Agent Console + Live Simulator + VICIdial Bridge on http://115.186.137.240:533 ...
call npm.cmd start
pause
