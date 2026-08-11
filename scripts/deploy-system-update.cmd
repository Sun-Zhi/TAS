@echo off
setlocal
title TaskAssign System Update
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0deploy-system-update.ps1"
if errorlevel 1 (
  echo.
  echo Update failed. See D:\workspace\taskassign\system-update.log
  pause
)
