@echo off
setlocal
set "HOST=0.0.0.0"
set "PORT=3000"
set "DATA_DIR=D:\TaskAssignData\data"
set "UPLOAD_DIR=D:\TaskAssignData\uploads"
if not exist "D:\TaskAssignData\logs" mkdir "D:\TaskAssignData\logs"
cd /d "C:\Program Files\TaskAssign\app"
"C:\Program Files\nodejs\node.exe" "C:\Program Files\TaskAssign\app\server.js" >> "D:\TaskAssignData\logs\server.log" 2>&1
