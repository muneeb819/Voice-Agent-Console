@echo off
cd /d "%~dp0"
if not exist "node_modules" (
  echo Installing Node.js dependencies...
  call npm.cmd install
  if errorlevel 1 exit /b 1
)
echo Building TypeScript...
call npm.cmd run build
if errorlevel 1 exit /b 1
echo Starting Voice Agent Console + Public HTTPS Client Demo Tunnel...
call npm.cmd run demo
pause
