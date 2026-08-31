# Shared scheduled-task configuration for "TaskAssign LAN Server".
#
# Dot-source this from install-system-startup.ps1 and fix-startup-task.ps1 so the
# schedule lives in exactly one place. The 2026-08-31 outage happened because
# schtasks.exe /Create silently applies a default ExecutionTimeLimit of 3 days and the
# only trigger was ONSTART: the service was killed after 72 hours and nothing restarted
# it. Defining the schedule here means a future re-install cannot reintroduce that.
#
# NOTE: keep this file pure ASCII. Windows PowerShell 5.1 reads .ps1 using the system
# ANSI code page, so non-ASCII text without a UTF-8 BOM breaks the parser.

function Set-TaskAssignSchedule {
  param(
    [Parameter(Mandatory = $true)][string]$TaskName,
    [int]$WatchdogMinutes = 5
  )

  $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction Stop

  # PT0S removes the execution time limit. Without it Task Scheduler terminates the
  # long-running server process after its default of 3 days.
  $task.Settings.ExecutionTimeLimit = 'PT0S'
  # Retry when Task Scheduler classifies the run as failed.
  $task.Settings.RestartCount = 3
  $task.Settings.RestartInterval = 'PT1M'
  # The watchdog trigger below re-runs the task on an interval. IgnoreNew turns that
  # into a no-op while the service is healthy, so it never starts a second instance
  # that would fight over port 3000.
  $task.Settings.MultipleInstances = 'IgnoreNew'
  # Allow a late start when a trigger was missed, e.g. D: not ready at boot.
  $task.Settings.StartWhenAvailable = $true
  $task.Settings.DisallowStartIfOnBatteries = $false
  $task.Settings.StopIfGoingOnBatteries = $false

  # Two triggers on purpose. RestartCount only fires when the task is classified as
  # failed, and it gives up once the retries are exhausted; with an ONSTART-only
  # trigger the service would then stay down until the next reboot. The watchdog
  # covers the case where the process is simply gone but the task was not deemed a
  # failure. Worst-case downtime becomes $WatchdogMinutes.
  $startupTrigger = New-ScheduledTaskTrigger -AtStartup
  $watchdogTrigger = New-ScheduledTaskTrigger `
    -Once -At (Get-Date).AddMinutes(1) `
    -RepetitionInterval (New-TimeSpan -Minutes $WatchdogMinutes)
  $task.Triggers = @($startupTrigger, $watchdogTrigger)

  $task | Set-ScheduledTask | Out-Null

  # Read back and verify instead of trusting the write.
  $after = Get-ScheduledTask -TaskName $TaskName -ErrorAction Stop
  if ($after.Settings.ExecutionTimeLimit -ne 'PT0S') {
    throw "ExecutionTimeLimit was not applied; it is still $($after.Settings.ExecutionTimeLimit)"
  }
  if ($after.Triggers.Count -ne 2) {
    throw "Expected 2 triggers, found $($after.Triggers.Count)"
  }
  # SYSTEM reads back as either 'SYSTEM' or the well-known SID S-1-5-18.
  $runAs = [string]$after.Principal.UserId
  if ($runAs -notmatch 'SYSTEM' -and $runAs -ne 'S-1-5-18') {
    throw "Run-as account is '$runAs'; expected SYSTEM"
  }

  return $after
}

function Format-TaskAssignSchedule {
  param([Parameter(Mandatory = $true)]$Task)
  return 'ExecutionTimeLimit={0}; RestartCount={1}; RestartInterval={2}; MultipleInstances={3}; triggers={4}; runAs={5}; state={6}' -f `
    $Task.Settings.ExecutionTimeLimit, $Task.Settings.RestartCount, $Task.Settings.RestartInterval,
    $Task.Settings.MultipleInstances, $Task.Triggers.Count, $Task.Principal.UserId, $Task.State
}
