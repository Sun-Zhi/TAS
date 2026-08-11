@echo off
setlocal
title TaskAssign Data Migration
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0migrate-system-data-to-d.ps1"
if errorlevel 1 (
  echo.
  echo Migration failed. See D:\workspace\taskassign\system-data-migration.log
  pause
)
