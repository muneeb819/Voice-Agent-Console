@echo off
title Voice Agent Console - Install Support Components
cd /d "%~dp0"

echo ============================================================
echo   Voice Agent Console - Windows Support Components Installer
echo ============================================================
echo.

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-windows-prereqs.ps1"
set EXIT_CODE=%ERRORLEVEL%

echo.
if %EXIT_CODE% NEQ 0 (
  echo [!] Setup finished with exit code %EXIT_CODE%. Review messages above.
) else (
  echo [OK] Setup completed! You can now run start.bat or open this folder in Visual Studio / VS Code.
)
pause
exit /b %EXIT_CODE%
