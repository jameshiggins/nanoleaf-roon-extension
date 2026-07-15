<#
.SYNOPSIS
  Liveness watchdog for the NanoleafRoon service.

.DESCRIPTION
  The extension (src/health.js) touches a heartbeat file every few seconds from a
  lifetime timer. If the Node event loop wedges — the observed failure where frames,
  Roon traffic, and logging all froze while the process stayed alive, so NSSM never
  saw an exit — the heartbeat stops advancing. This script polls the heartbeat and
  forces `Restart-Service NanoleafRoon` when it goes stale, so a freeze self-heals in
  ~20s instead of needing a manual restart. Runs as a persistent loop (installed as a
  SYSTEM scheduled task by install-watchdog.ps1) so it survives outside the wedged
  process. A missing heartbeat (service down) is treated as stale, so this also brings
  the service back up if it is stopped for any reason.
#>
param(
  [string]$Repo         = 'C:\Users\higgi\nanoleaf-roon-extension',
  [string]$Service      = 'NanoleafRoon',
  [int]   $StaleSeconds = 15,   # heartbeat older than this = wedged/down
  [int]   $CheckSeconds = 5,    # poll cadence
  [int]   $CooldownSeconds = 45 # after a restart, wait for the service to come back
)

$Heartbeat = Join-Path $Repo 'logs\heartbeat'
$LogFile   = Join-Path $Repo 'logs\watchdog.log'

function Write-Wd([string]$msg) {
  $line = "{0} {1}" -f ([DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ssZ')), $msg
  try { Add-Content -Path $LogFile -Value $line -Encoding utf8 } catch { }
}

Write-Wd "watchdog started (stale>${StaleSeconds}s, poll ${CheckSeconds}s, service=$Service)"

while ($true) {
  try {
    $stale = $true
    $ageStr = 'missing'
    if (Test-Path -LiteralPath $Heartbeat) {
      $age = ((Get-Date) - (Get-Item -LiteralPath $Heartbeat).LastWriteTime).TotalSeconds
      $ageStr = ('{0:N1}s' -f $age)
      $stale = $age -gt $StaleSeconds
    }

    if ($stale) {
      $svc = Get-Service -Name $Service -ErrorAction SilentlyContinue
      $status = if ($svc) { $svc.Status } else { 'not-installed' }
      Write-Wd "heartbeat $ageStr — restarting $Service (was $status)"
      try {
        Restart-Service -Name $Service -Force -ErrorAction Stop
        Write-Wd "restart issued; cooling down ${CooldownSeconds}s"
      } catch {
        Write-Wd "restart FAILED: $($_.Exception.Message)"
      }
      Start-Sleep -Seconds $CooldownSeconds
    }
  } catch {
    Write-Wd "loop error: $($_.Exception.Message)"
  }
  Start-Sleep -Seconds $CheckSeconds
}
