<#
.SYNOPSIS
  Register (and start) the NanoleafRoon liveness watchdog as a SYSTEM scheduled task.

.DESCRIPTION
  Creates a scheduled task "NanoleafWatchdog" that runs scripts/watchdog.ps1 at system
  startup as SYSTEM (so it can Restart-Service without a UAC prompt) and is auto-restarted
  by Task Scheduler if it ever exits. Then starts it immediately. Re-running this is safe —
  the task is replaced (-Force).

  Run from an ELEVATED PowerShell:
      pwsh -File scripts\install-watchdog.ps1

  Uninstall:  Unregister-ScheduledTask -TaskName NanoleafWatchdog -Confirm:$false
#>
param(
  [string]$TaskName = 'NanoleafWatchdog'
)
$ErrorActionPreference = 'Stop'

$repo   = Split-Path -Parent $PSScriptRoot           # ...\nanoleaf-roon-extension
$script = Join-Path $PSScriptRoot 'watchdog.ps1'
if (-not (Test-Path -LiteralPath $script)) { throw "watchdog.ps1 not found at $script" }

# Prefer PowerShell 7 (pwsh) if present, else Windows PowerShell.
$pwsh = (Get-Command pwsh -ErrorAction SilentlyContinue).Source
if (-not $pwsh) { $pwsh = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" }

$arg = "-NoProfile -NonInteractive -WindowStyle Hidden -File `"$script`" -Repo `"$repo`""

$action    = New-ScheduledTaskAction -Execute $pwsh -Argument $arg
$trigger   = New-ScheduledTaskTrigger -AtStartup
$principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
$settings  = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) `
  -ExecutionTimeLimit ([TimeSpan]::Zero) `
  -MultipleInstances IgnoreNew

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
  -Principal $principal -Settings $settings -Force | Out-Null
Write-Output "Registered scheduled task '$TaskName' -> $pwsh $arg"

Start-ScheduledTask -TaskName $TaskName
Start-Sleep -Seconds 2
$state = (Get-ScheduledTask -TaskName $TaskName).State
Write-Output "Task state: $state"
Write-Output "Watchdog log: $(Join-Path $repo 'logs\watchdog.log')"
