# Repair the "TaskAssign LAN Server" scheduled task and bring the service back up.
#
# Root cause: install-system-startup.ps1 used to create the task with schtasks.exe
# /Create and never passed /ET, so Task Scheduler applied its default
# ExecutionTimeLimit of 3 days. The only trigger was ONSTART, so once the 72-hour limit
# terminated the service nothing restarted it until the next reboot.
# Measured: started 2026-08-28 10:01:10, killed 2026-08-31 10:01:11 -> 72:00:01.
#
# install-system-startup.ps1 now applies the same schedule at install time, so this
# script is only needed to repair a task that predates that fix, or to re-apply the
# schedule after someone changed it by hand.
#
# This script only edits the task settings and triggers. It does not re-register the
# task, touch application code, or touch the database.
#
# NOTE: keep this file pure ASCII. Windows PowerShell 5.1 reads .ps1 using the system
# ANSI code page, so non-ASCII text without a UTF-8 BOM breaks the parser.

# Set when this instance was spawned by the self-elevation below. That instance owns a
# throwaway console window, so it must pause before exiting or the operator never sees
# the output. A run that was already elevated must not pause, so it stays scriptable.
param([switch]$Elevated)

$ErrorActionPreference = 'Stop'

$taskName = 'TaskAssign LAN Server'
$dataRoot = 'D:\TaskAssignData'
$fixLog = Join-Path $dataRoot 'logs\startup-task-fix.log'

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = [Security.Principal.WindowsPrincipal]::new($identity)
$isAdmin = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

if (-not $isAdmin) {
  Start-Process `
    -FilePath 'powershell.exe' `
    -Verb RunAs `
    -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ('"{0}"' -f $PSCommandPath), '-Elevated')
  exit 0
}

. (Join-Path $PSScriptRoot 'taskassign-task-config.ps1')

function Write-FixLog([string]$Message) {
  New-Item -ItemType Directory -Path (Split-Path -Parent $fixLog) -Force | Out-Null
  Add-Content -LiteralPath $fixLog -Value $Message -Encoding UTF8
  Write-Host $Message
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

$exitCode = 0
try {
  # Log the pre-change state, not just print it. On a self-elevated run the console
  # window disappears, and the original ExecutionTimeLimit is the evidence that matters
  # most when diagnosing a recurrence.
  $before = Get-ScheduledTask -TaskName $taskName -ErrorAction Stop
  Write-FixLog ('{0} Before: {1}' -f (Get-Date -Format o), (Format-TaskAssignSchedule $before))

  $after = Set-TaskAssignSchedule -TaskName $taskName

  if ($after.State -ne 'Running') {
    Start-ScheduledTask -TaskName $taskName
  }
  if (-not (Wait-ForHealth)) {
    throw 'Task started but the health check on http://127.0.0.1:3000/index.html failed; see D:\TaskAssignData\logs\server.log'
  }

  $final = Get-ScheduledTask -TaskName $taskName
  Write-FixLog ('{0} Fix succeeded: {1}; health=OK' -f (Get-Date -Format o), (Format-TaskAssignSchedule $final))
} catch {
  $message = '{0} Fix failed: {1}' -f (Get-Date -Format o), $_.Exception.Message
  try { Write-FixLog $message } catch { Write-Host $message }
  Write-Error $message
  $exitCode = 1
} finally {
  # The self-elevated instance owns its own console window, which Windows closes the
  # moment the script ends. Without this the operator sees nothing on success.
  if ($Elevated) {
    Write-Host ''
    Read-Host 'Press Enter to close'
  }
}
if ($exitCode) { exit $exitCode }
