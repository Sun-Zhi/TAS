@echo off
setlocal
set "HOST=0.0.0.0"
set "PORT=3000"
set "DATA_DIR=D:\TaskAssignData\data"
set "UPLOAD_DIR=D:\TaskAssignData\uploads"
set "LOG_DIR=D:\TaskAssignData\logs"
if not exist "%LOG_DIR%" mkdir "%LOG_DIR%"
cd /d "C:\Program Files\TaskAssign\app"
REM run-server.js supervises server.js and owns server.log: timestamps, child PID,
REM exit code and rotation. cmd.exe redirection can do none of those, and a process
REM cannot record its own exit code.
REM The redirection below is only a safety net for the supervisor failing to start;
REM in normal operation supervisor.log stays empty.
"C:\Program Files\nodejs\node.exe" "C:\Program Files\TaskAssign\app\scripts\run-server.js" >> "%LOG_DIR%\supervisor.log" 2>&1
