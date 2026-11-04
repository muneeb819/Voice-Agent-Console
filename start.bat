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
echo Starting Voice Agent Console (default http://127.0.0.1:533; see server output for actual listener)...
call npm.cmd start
pause
