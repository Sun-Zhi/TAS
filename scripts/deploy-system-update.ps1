$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
$appRoot = 'C:\Program Files\TaskAssign\app'
$dataRoot = 'D:\TaskAssignData'
$taskName = 'TaskAssign LAN Server'
$deployLog = Join-Path $projectRoot 'system-update.log'

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = [Security.Principal.WindowsPrincipal]::new($identity)
$isAdmin = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

if (-not $isAdmin) {
  Start-Process `
    -FilePath 'powershell.exe' `
    -Verb RunAs `
    -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ('"{0}"' -f $PSCommandPath))
  exit 0
}

function Stop-TaskAssignProcesses {
  Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 2
  $listeners = Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue
  foreach ($listener in $listeners) {
    $process = Get-CimInstance Win32_Process -Filter "ProcessId=$($listener.OwningProcess)"
    $commandLine = [string]$process.CommandLine
    if ($process.Name -eq 'node.exe' -and $commandLine -match '(?i)C:\\Program Files\\TaskAssign\\app\\server\.js|D:\\workspace\\taskassign\\server\.js') {
      Stop-Process -Id $listener.OwningProcess -Force
    } else {
      throw "TCP 3000 is owned by a non-TaskAssign process, PID=$($listener.OwningProcess)"
    }
  }
}

function Copy-Application([string]$Source, [string]$Destination) {
  & robocopy.exe $Source $Destination /MIR /R:2 /W:1 `
    /XD '.git' 'data' 'uploads' `
    /XF '*.log' '*.tmp' '*.temp' | Out-Null
  if ($LASTEXITCODE -ge 8) {
    throw "Application copy failed; Robocopy exit code: $LASTEXITCODE"
  }
}

function Wait-ForHealth {
  for ($attempt = 0; $attempt -lt 40; $attempt++) {
    try {
      $response = Invoke-WebRequest -UseBasicParsing 'http://127.0.0.1:3000/index.html' -TimeoutSec 2
      if ($response.StatusCode -eq 200) { return $true }
    } catch {}
    Start-Sleep -Milliseconds 250
  }
  return $false
}

try {
  if (-not (Test-Path -LiteralPath (Join-Path $appRoot 'server.js'))) {
    throw "Protected application not found: $appRoot"
  }
  if (-not (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue)) {
    throw "SYSTEM startup task not found: $taskName"
  }

  $backupRoot = Join-Path $dataRoot ('backups\app-code-before-update-{0}' -f (Get-Date -Format 'yyyyMMdd-HHmmss'))
  New-Item -ItemType Directory -Path $backupRoot -Force | Out-Null
  Copy-Application $appRoot $backupRoot

  Stop-TaskAssignProcesses
  try {
    Copy-Application $projectRoot $appRoot
    & icacls.exe (Split-Path -Parent $appRoot) /inheritance:r `
      /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' '*S-1-5-32-545:(OI)(CI)RX' | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Failed to secure the application directory' }

    Start-ScheduledTask -TaskName $taskName
    if (-not (Wait-ForHealth)) { throw 'Updated service failed its health check' }
  } catch {
    Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    Copy-Application $backupRoot $appRoot
    Start-ScheduledTask -TaskName $taskName
    throw "Update failed and code was rolled back: $($_.Exception.Message)"
  }

  $message = '{0} Update succeeded. backup={1}' -f (Get-Date -Format o), $backupRoot
  Set-Content -LiteralPath $deployLog -Value $message -Encoding UTF8
  Write-Host $message
} catch {
  $message = '{0} Update failed: {1}' -f (Get-Date -Format o), $_.Exception.Message
  Set-Content -LiteralPath $deployLog -Value $message -Encoding UTF8
  Write-Error $message
  exit 1
}
