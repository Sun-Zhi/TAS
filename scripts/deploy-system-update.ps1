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

# Returns the process holding port 3000 when it is ours, $null when the port is free.
# Throws only when a genuinely foreign process owns the port.
function Get-TaskAssignListener {
  $listeners = Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue
  foreach ($listener in $listeners) {
    $process = Get-CimInstance Win32_Process -Filter "ProcessId=$($listener.OwningProcess)" -ErrorAction SilentlyContinue
    # The process can exit between the two queries. Treat a vanished PID as "port
    # released" rather than as a foreign owner; the previous version dereferenced a
    # null here and reported a misleading "non-TaskAssign process" error.
    if (-not $process) { continue }
    $commandLine = [string]$process.CommandLine
    if ($process.Name -eq 'node.exe' -and $commandLine -match '(?i)C:\\Program Files\\TaskAssign\\app\\server\.js|D:\\workspace\\taskassign\\server\.js') {
      return $process
    }
    throw "TCP 3000 is owned by a non-TaskAssign process, PID=$($listener.OwningProcess), Name=$($process.Name)"
  }
  return $null
}

# Stop the service and wait for port 3000 to actually be released.
#
# A truly graceful shutdown - one that runs the SIGTERM handler in server.js and lets
# db.close() checkpoint the database - is not reachable from here: the service runs as
# SYSTEM in session 0 behind a cmd.exe wrapper, so there is no console this script can
# attach to in order to deliver a CTRL_BREAK event. Reaching that would require a
# shutdown endpoint inside the application.
#
# What this does instead is strictly better than the previous "sleep 2 then kill -Force":
# ask Task Scheduler to end the task, give the process a real grace period to exit on
# its own, and force-kill only as a last resort. The grace period is deliberately
# longer than the 30s internal timeout in server.js so that its own shutdown path, if
# it ever does run, is allowed to finish.
function Stop-TaskAssignService {
  param([int]$GraceSeconds = 45)

  Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue

  $deadline = (Get-Date).AddSeconds($GraceSeconds)
  while ((Get-Date) -lt $deadline) {
    if (-not (Get-TaskAssignListener)) { return }
    Start-Sleep -Milliseconds 500
  }

  $stubborn = Get-TaskAssignListener
  if (-not $stubborn) { return }
  Write-Host "Port 3000 still held by PID $($stubborn.ProcessId) after ${GraceSeconds}s; forcing termination"
  # -ErrorAction SilentlyContinue: the process may exit on its own between the check
  # above and this call, and that race must not fail the deployment.
  Stop-Process -Id $stubborn.ProcessId -Force -ErrorAction SilentlyContinue

  Start-Sleep -Seconds 2
  if (Get-TaskAssignListener) {
    throw 'Port 3000 is still in use after forced termination'
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

$taskDisabled = $false
$exitCode = 0
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

  # Disable the task before stopping anything. The schedule includes a watchdog trigger
  # that re-runs the task every few minutes; if it fired while robocopy /MIR was halfway
  # through overwriting $appRoot, the service would come up on a half-copied directory,
  # and MultipleInstances=IgnoreNew would then silently discard the Start-ScheduledTask
  # below, leaving the health check to pass against the wrong code.
  Disable-ScheduledTask -TaskName $taskName | Out-Null
  $taskDisabled = $true

  try {
    # Stopping belongs inside this try. When it lived outside, any failure here jumped
    # straight to the outer catch, which logged and exited with the service already
    # stopped and nothing to bring it back.
    Stop-TaskAssignService

    Copy-Application $projectRoot $appRoot
    & icacls.exe (Split-Path -Parent $appRoot) /inheritance:r `
      /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' '*S-1-5-32-545:(OI)(CI)RX' | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Failed to secure the application directory' }

    Enable-ScheduledTask -TaskName $taskName | Out-Null
    $taskDisabled = $false
    Start-ScheduledTask -TaskName $taskName
    if (-not (Wait-ForHealth)) { throw 'Updated service failed its health check' }
  } catch {
    $failure = $_.Exception.Message
    # Re-disable before touching the application directory again. When the failure
    # happened after the Enable above - a failed Start or a failed health check - the
    # task is live, and its watchdog trigger can start the service on a half-restored
    # directory during the rollback copy below. That is the same race the forward path
    # guards against, and IgnoreNew would then discard the Start-ScheduledTask here,
    # letting the health check pass against a half-rolled-back tree.
    Disable-ScheduledTask -TaskName $taskName | Out-Null
    $taskDisabled = $true

    Stop-TaskAssignService
    Copy-Application $backupRoot $appRoot

    Enable-ScheduledTask -TaskName $taskName | Out-Null
    $taskDisabled = $false
    Start-ScheduledTask -TaskName $taskName
    if (-not (Wait-ForHealth)) {
      throw "Update failed, code was rolled back, but the restored service failed its health check: $failure"
    }
    throw "Update failed and code was rolled back: $failure"
  }

  $message = '{0} Update succeeded. backup={1}' -f (Get-Date -Format o), $backupRoot
  Set-Content -LiteralPath $deployLog -Value $message -Encoding UTF8
  Write-Host $message
} catch {
  $message = '{0} Update failed: {1}' -f (Get-Date -Format o), $_.Exception.Message
  Set-Content -LiteralPath $deployLog -Value $message -Encoding UTF8
  Write-Error $message
  $exitCode = 1
} finally {
  # Last-resort recovery: never leave the task disabled, whatever went wrong above. A
  # disabled task also disables the watchdog trigger, so the service would stay down
  # until a human noticed rather than being restarted within minutes.
  #
  # This must not fail quietly. Suppressing errors here would leave the task disabled
  # with nothing recorded anywhere, and by this point the console window is usually
  # gone, so the outcome has to reach $deployLog. Append rather than overwrite so the
  # original failure reason written by the catch above survives alongside it.
  if ($taskDisabled) {
    try {
      Enable-ScheduledTask -TaskName $taskName -ErrorAction Stop | Out-Null
      Start-ScheduledTask -TaskName $taskName -ErrorAction Stop
      $recovery = if (Wait-ForHealth) {
        'recovery=OK; task re-enabled and the service is healthy'
      } else {
        'recovery=DEGRADED; task re-enabled but the health check failed, the watchdog will retry within 5 minutes'
      }
    } catch {
      $recovery = 'recovery=FAILED ({0}); the task is STILL DISABLED and its watchdog is inactive, so the service will NOT come back on its own - re-enable it manually with Enable-ScheduledTask' -f $_.Exception.Message
    }
    $recoveryMessage = '{0} {1}' -f (Get-Date -Format o), $recovery
    try { Add-Content -LiteralPath $deployLog -Value $recoveryMessage -Encoding UTF8 } catch {}
    Write-Warning $recovery
  }
}
if ($exitCode) { exit $exitCode }
