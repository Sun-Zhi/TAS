@echo off
setlocal
cd /d "D:\workspace\taskassign"
set "HOST=0.0.0.0"
set "PORT=3000"
"C:\Program Files\nodejs\node.exe" server.js >> "D:\workspace\taskassign\server.log" 2>&1
