# NOTE: keep this file pure ASCII. Windows PowerShell 5.1 reads .ps1 using the system
# ANSI code page, so non-ASCII text without a UTF-8 BOM breaks the parser.

$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
$installRoot = Join-Path $env:ProgramFiles 'TaskAssign'
$appRoot = Join-Path $installRoot 'app'
$dataRoot = 'D:\TaskAssignData'
$taskName = 'TaskAssign LAN Server'
$installLog = Join-Path $dataRoot 'logs\system-startup-install.log'
$workspaceLog = Join-Path $projectRoot 'system-startup-install.log'

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

. (Join-Path $PSScriptRoot 'taskassign-task-config.ps1')

try {
  New-Item -ItemType Directory -Path $appRoot -Force | Out-Null
  New-Item -ItemType Directory -Path (Join-Path $dataRoot 'data') -Force | Out-Null
  New-Item -ItemType Directory -Path (Join-Path $dataRoot 'uploads') -Force | Out-Null
  New-Item -ItemType Directory -Path (Join-Path $dataRoot 'logs') -Force | Out-Null
  New-Item -ItemType Directory -Path (Join-Path $dataRoot 'backups') -Force | Out-Null

  & robocopy.exe $projectRoot $appRoot /MIR /R:2 /W:1 `
    /XD '.git' 'data' 'uploads' `
    /XF '*.log' '*.tmp' '*.temp' | Out-Null
  if ($LASTEXITCODE -ge 8) {
    throw "Application copy failed; Robocopy exit code: $LASTEXITCODE"
  }

  $sourceDb = Join-Path $projectRoot 'data\app.db'
  $targetDb = Join-Path $dataRoot 'data\app.db'
  if ((Test-Path -LiteralPath $sourceDb) -and -not (Test-Path -LiteralPath $targetDb)) {
    Copy-Item -LiteralPath $sourceDb -Destination $targetDb
  }

  $sourceUploads = Join-Path $projectRoot 'uploads'
  $targetUploads = Join-Path $dataRoot 'uploads'
  if ((Test-Path -LiteralPath $sourceUploads) -and -not (Get-ChildItem $targetUploads -Force | Select-Object -First 1)) {
    Copy-Item -Path (Join-Path $sourceUploads '*') -Destination $targetUploads -Recurse -Force
  }

  # Use a protected path without spaces because schtasks parses /TR quoting inconsistently.
  $taskLauncher = Join-Path $dataRoot 'start-system-server.cmd'
  Copy-Item `
    -LiteralPath (Join-Path $appRoot 'scripts\start-system-server.cmd') `
    -Destination $taskLauncher `
    -Force

  & icacls.exe $installRoot /inheritance:r `
    /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' '*S-1-5-32-545:(OI)(CI)RX' | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Failed to secure the application directory' }

  & icacls.exe $dataRoot /inheritance:r `
    /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Failed to secure the data directory' }

  $taskCommand = 'C:\Windows\System32\cmd.exe /d /c D:\TaskAssignData\start-system-server.cmd'
  & schtasks.exe /Create `
    /TN $taskName `
    /SC ONSTART `
    /RU SYSTEM `
    /RL HIGHEST `
    /TR $taskCommand `
    /F | Out-Null
  if ($LASTEXITCODE -ne 0) {
    throw "Startup task registration failed; schtasks exit code: $LASTEXITCODE"
  }

  # schtasks.exe cannot express the settings this service needs, and its defaults are
  # actively harmful here: it applies ExecutionTimeLimit=3 days, which terminated the
  # service after 72 hours on 2026-08-31, and it leaves ONSTART as the only trigger so
  # nothing restarted it. Apply the shared schedule immediately after creation so a
  # re-install can never reintroduce that.
  $task = Set-TaskAssignSchedule -TaskName $taskName

  Remove-ItemProperty `
    -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' `
    -Name 'TaskAssign LAN Server' `
    -ErrorAction SilentlyContinue

  $message = '{0} Installed protected task "{1}"; {2}' -f `
    (Get-Date -Format o), $taskName, (Format-TaskAssignSchedule $task)
  Set-Content -LiteralPath $installLog -Value $message -Encoding UTF8
  Set-Content -LiteralPath $workspaceLog -Value $message -Encoding UTF8
  Write-Host $message
} catch {
  New-Item -ItemType Directory -Path (Join-Path $dataRoot 'logs') -Force | Out-Null
  $message = '{0} Install failed: {1}' -f (Get-Date -Format o), $_.Exception.Message
  Set-Content -LiteralPath $workspaceLog -Value $message -Encoding UTF8
  try { Set-Content -LiteralPath $installLog -Value $message -Encoding UTF8 } catch {}
  Write-Error $message
  exit 1
}
