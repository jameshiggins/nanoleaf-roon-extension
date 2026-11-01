# Auto-heal for the Nanoleaf wall's audio feed.
#
# RDP'ing into this box detaches the user session from the physical console and
# Windows strips every local audio endpoint (VB-Cable included) — the extension
# then captures pure silence and the wall goes static. Run by the scheduled task
# "NanoleafConsoleAutoHeal" (as SYSTEM, on TerminalServices event 24 = session
# disconnected): reattach the disconnected session to the console so the audio
# devices return, then restart the extension so capture recovers immediately.
#
# Safe to fire spuriously: if no disconnected session exists (user is active,
# or already on the console) it exits without touching anything.

$log = 'C:\Users\higgi\nanoleaf-roon-service\autoheal.log'
function Log($m) { Add-Content -Path $log -Value ("{0} {1}" -f (Get-Date -Format 's'), $m) }

$sessions = query session 2>&1 | Out-String
# Already on the console? Nothing to do.
if ($sessions -match '(?m)^\s*>?console\s+higgi\s') { exit 0 }

# A disconnected user session prints with an empty SESSIONNAME column:
#   "  higgi                    1  Disc"
if ($sessions -notmatch '(?m)^\s+higgi\s+(\d+)\s+Disc') {
  exit 0  # no disconnected session (user still actively RDP'd in, or logged out)
}
$id = $Matches[1]

Log "RDP disconnect: reattaching session $id to console"
tscon $id /dest:console
if ($LASTEXITCODE -ne 0) { Log "tscon failed (exit $LASTEXITCODE)"; exit 1 }

# Give Windows a moment to re-enumerate audio endpoints, then bounce the
# extension so ffmpeg reopens VB-Cable now instead of on its retry backoff.
Start-Sleep -Seconds 8
schtasks /End /TN "Nanoleaf Roon Extension" 2>&1 | Out-Null
Start-Sleep -Seconds 3
schtasks /Run /TN "Nanoleaf Roon Extension" 2>&1 | Out-Null
Log "healed: session $id on console, extension restarted"
