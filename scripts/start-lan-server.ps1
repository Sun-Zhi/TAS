$ErrorActionPreference = 'Stop'
$env:HOST = '0.0.0.0'
$env:PORT = '3000'

Start-Process `
  -FilePath 'C:\Program Files\nodejs\node.exe' `
  -ArgumentList 'D:\workspace\taskassign\server.js' `
  -WorkingDirectory 'D:\workspace\taskassign' `
  -WindowStyle Hidden
