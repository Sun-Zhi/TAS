@echo off
setlocal
title TaskAssign Startup Task Fix
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0fix-startup-task.ps1"
if errorlevel 1 (
  echo.
  echo Fix failed. See D:\TaskAssignData\logs\startup-task-fix.log
  pause
)
