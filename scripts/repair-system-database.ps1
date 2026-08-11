$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
$nodeExe = 'C:\Program Files\nodejs\node.exe'
$backupHelper = Join-Path $PSScriptRoot 'database-backup.js'
$sourceDb = Join-Path $projectRoot 'data\app.db'
$dataRoot = 'D:\TaskAssignData'
$deployedDb = Join-Path $dataRoot 'data\app.db'
$backupDir = Join-Path $dataRoot 'backups'
$snapshotDb = Join-Path $projectRoot 'data\repair-snapshot.db'
$taskName = 'TaskAssign LAN Server'
$repairLog = Join-Path $projectRoot 'system-database-repair.log'

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

function Invoke-DatabaseBackup([string]$Source, [string]$Destination) {
  if (Test-Path -LiteralPath $Destination) {
    Remove-Item -LiteralPath $Destination -Force
  }
  $output = & $nodeExe $backupHelper $Source $Destination
  if ($LASTEXITCODE -ne 0) { throw "Database backup failed: $Source" }
  return ($output | ConvertFrom-Json)
}

function Stop-TaskAssignProcesses {
  Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 2

  $listeners = Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue
  foreach ($listener in $listeners) {
    $process = Get-CimInstance Win32_Process -Filter "ProcessId=$($listener.OwningProcess)"
    $commandLine = [string]$process.CommandLine
    if ($process.Name -eq 'node.exe' -and $commandLine -match '(?i)TaskAssign.*server\.js|D:\\workspace\\taskassign\\server\.js') {
      Stop-Process -Id $listener.OwningProcess -Force
    } else {
      throw "TCP 3000 is owned by a non-TaskAssign process, PID=$($listener.OwningProcess)"
    }
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
  if (-not (Test-Path -LiteralPath $deployedDb)) {
    throw "Deployed database not found: $deployedDb"
  }
  if (-not (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue)) {
    throw "SYSTEM startup task not found: $taskName"
  }

  New-Item -ItemType Directory -Path $backupDir -Force | Out-Null
  $sourceInfo = Invoke-DatabaseBackup $sourceDb $snapshotDb
  $backupDb = Join-Path $backupDir ('app-before-repair-{0}.db' -f (Get-Date -Format 'yyyyMMdd-HHmmss'))
  $deployedInfo = Invoke-DatabaseBackup $deployedDb $backupDb

  Stop-TaskAssignProcesses
  Remove-Item -LiteralPath (Join-Path $dataRoot 'data\app.db-wal') -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath (Join-Path $dataRoot 'data\app.db-shm') -Force -ErrorAction SilentlyContinue
  Copy-Item -LiteralPath $snapshotDb -Destination $deployedDb -Force
  Copy-Item `
    -LiteralPath (Join-Path $projectRoot 'scripts\start-system-server.cmd') `
    -Destination (Join-Path $dataRoot 'start-system-server.cmd') `
    -Force

  Start-ScheduledTask -TaskName $taskName
  if (-not (Wait-ForHealth)) {
    Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    Copy-Item -LiteralPath $backupDb -Destination $deployedDb -Force
    Start-ScheduledTask -TaskName $taskName
    throw 'Health check failed; the pre-repair database was restored'
  }

  Remove-Item -LiteralPath $snapshotDb -Force -ErrorAction SilentlyContinue
  $message = '{0} Repair succeeded. sourceUsers={1}; sourceTasks={2}; oldUsers={3}; oldTasks={4}; backup={5}' -f `
    (Get-Date -Format o), $sourceInfo.users, $sourceInfo.tasks, $deployedInfo.users, $deployedInfo.tasks, $backupDb
  Set-Content -LiteralPath $repairLog -Value $message -Encoding UTF8
  Write-Host $message
} catch {
  Remove-Item -LiteralPath $snapshotDb -Force -ErrorAction SilentlyContinue
  $message = '{0} Repair failed: {1}' -f (Get-Date -Format o), $_.Exception.Message
  Set-Content -LiteralPath $repairLog -Value $message -Encoding UTF8
  Write-Error $message
  exit 1
}
