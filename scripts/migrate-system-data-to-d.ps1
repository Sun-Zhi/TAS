$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
$nodeExe = 'C:\Program Files\nodejs\node.exe'
$backupHelper = Join-Path $PSScriptRoot 'database-backup.js'
$oldRoot = Join-Path $env:ProgramData 'TaskAssign'
$newRoot = 'D:\TaskAssignData'
$taskName = 'TaskAssign LAN Server'
$oldLauncher = 'C:\ProgramData\TaskAssign\start-system-server.cmd'
$newLauncher = 'D:\TaskAssignData\start-system-server.cmd'
$migrationLog = Join-Path $projectRoot 'system-data-migration.log'

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

function Set-TaskLauncher([string]$Launcher) {
  $taskCommand = "C:\Windows\System32\cmd.exe /d /c $Launcher"
  & schtasks.exe /Change /TN $taskName /TR $taskCommand | Out-Null
  if ($LASTEXITCODE -ne 0) {
    throw "Failed to update startup task; schtasks exit code: $LASTEXITCODE"
  }
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
  $expectedOldRoot = 'C:\ProgramData\TaskAssign'
  if ([IO.Path]::GetFullPath($oldRoot).TrimEnd('\') -ne $expectedOldRoot) {
    throw "Unexpected source directory: $oldRoot"
  }
  if (-not (Test-Path -LiteralPath (Join-Path $oldRoot 'data\app.db'))) {
    throw "Source database not found under $oldRoot"
  }
  if (-not (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue)) {
    throw "SYSTEM startup task not found: $taskName"
  }

  foreach ($directory in @('data', 'uploads', 'logs', 'backups')) {
    New-Item -ItemType Directory -Path (Join-Path $newRoot $directory) -Force | Out-Null
  }

  Stop-TaskAssignProcesses

  $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
  $sourceDb = Join-Path $oldRoot 'data\app.db'
  $targetDb = Join-Path $newRoot 'data\app.db'
  $migratingDb = Join-Path $newRoot 'data\app.db.migrating'
  if (Test-Path -LiteralPath $targetDb) {
    $existingBackup = Join-Path $newRoot "backups\app-existing-before-migration-$stamp.db"
    Invoke-DatabaseBackup $targetDb $existingBackup | Out-Null
  }
  $dbInfo = Invoke-DatabaseBackup $sourceDb $migratingDb

  $oldUploads = Join-Path $oldRoot 'uploads'
  if (Test-Path -LiteralPath $oldUploads) {
    & robocopy.exe $oldUploads (Join-Path $newRoot 'uploads') /E /R:2 /W:1 /COPY:DAT | Out-Null
    if ($LASTEXITCODE -ge 8) { throw "Attachment copy failed; Robocopy exit code: $LASTEXITCODE" }
  }

  $oldBackups = Join-Path $oldRoot 'backups'
  if (Test-Path -LiteralPath $oldBackups) {
    & robocopy.exe $oldBackups (Join-Path $newRoot 'backups') /E /R:2 /W:1 /COPY:DAT | Out-Null
    if ($LASTEXITCODE -ge 8) { throw "Backup copy failed; Robocopy exit code: $LASTEXITCODE" }
  }

  Get-ChildItem -LiteralPath $oldRoot -Filter '*.log' -File -ErrorAction SilentlyContinue | ForEach-Object {
    Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $newRoot 'logs') -Force
  }

  Remove-Item -LiteralPath $targetDb -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath (Join-Path $newRoot 'data\app.db-wal') -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath (Join-Path $newRoot 'data\app.db-shm') -Force -ErrorAction SilentlyContinue
  Copy-Item -LiteralPath $migratingDb -Destination (Join-Path $newRoot "backups\app-before-d-migration-$stamp.db") -Force
  Move-Item -LiteralPath $migratingDb -Destination $targetDb
  Copy-Item -LiteralPath (Join-Path $projectRoot 'scripts\start-system-server.cmd') -Destination $newLauncher -Force

  & icacls.exe $newRoot /inheritance:r `
    /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Failed to secure the D drive data directory' }

  Set-TaskLauncher $newLauncher
  Start-ScheduledTask -TaskName $taskName
  if (-not (Wait-ForHealth)) {
    Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    Set-TaskLauncher $oldLauncher
    Start-ScheduledTask -TaskName $taskName
    throw 'D drive deployment health check failed; the task was restored to the C drive launcher'
  }

  Remove-Item -LiteralPath $oldRoot -Recurse -Force
  $message = '{0} Migration succeeded. target={1}; users={2}; tasks={3}; oldRootRemoved=true' -f `
    (Get-Date -Format o), $newRoot, $dbInfo.users, $dbInfo.tasks
  Set-Content -LiteralPath (Join-Path $newRoot 'logs\system-data-migration.log') -Value $message -Encoding UTF8
  Set-Content -LiteralPath $migrationLog -Value $message -Encoding UTF8
  Write-Host $message
} catch {
  $message = '{0} Migration failed: {1}' -f (Get-Date -Format o), $_.Exception.Message
  Set-Content -LiteralPath $migrationLog -Value $message -Encoding UTF8
  Write-Error $message
  exit 1
}
