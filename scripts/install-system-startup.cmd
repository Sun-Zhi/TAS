@echo off
setlocal
title TaskAssign System Startup Installer
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-system-startup.ps1"
if errorlevel 1 (
  echo.
  echo Installation failed. See C:\ProgramData\TaskAssign\system-startup-install.log
  pause
)
