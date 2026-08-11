@echo off
setlocal
title TaskAssign Database Repair
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0repair-system-database.ps1"
if errorlevel 1 (
  echo.
  echo Repair failed. See D:\workspace\taskassign\system-database-repair.log
  pause
)
