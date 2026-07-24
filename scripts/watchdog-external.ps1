# ============================================================================
#  Sutra EXTERNAL watchdog — catches WEDGES the in-process watchdog cannot.
#
#  The in-process watchdog (daemon/src/watchdog.ts) runs ON the daemon's own
#  event loop, so when the loop is starved (e.g. a co-located CPU-heavy process
#  like a Kubera backtest hogging the machine) the watchdog's own timer can't
#  fire — the daemon sits alive-but-wedged, holding port 3001 but not answering.
#  That exact failure scrambled order/ledger sync and produced 322 phantom
#  trades (see memory: ledger-truth).
#
#  This runs in a SEPARATE process. It polls /api/health; if the daemon fails
#  to answer within the timeout for N consecutive checks, it force-kills the
#  wedged process. The RUN_DAEMON.bat restart loop then respawns it cleanly.
#
#  Usage:  powershell -NoProfile -File scripts\watchdog-external.ps1
#  Runs until you close the window / Ctrl+C.
# ============================================================================

$Port          = 3001
$HealthUrl     = "http://localhost:$Port/api/health"
$IntervalSec   = 30      # how often to poll
$TimeoutSec    = 8       # per-request timeout
$FailsToKill   = 3       # consecutive failures before killing (≈90s of wedge)
$GraceSec      = 45      # after a kill, wait for the .bat loop to respawn before polling again

function Get-DaemonPid {
    $line = netstat -ano | Select-String ":$Port\s" | Where-Object { $_ -match 'LISTENING' } | Select-Object -First 1
    if ($line) { return ($line.ToString().Trim() -split '\s+')[-1] }
    return $null
}

Write-Host "[watchdog] external health-check armed — poll $HealthUrl every ${IntervalSec}s, kill after $FailsToKill consecutive failures (~$($FailsToKill*$IntervalSec)s wedge)"

$fails = 0
while ($true) {
    Start-Sleep -Seconds $IntervalSec
    $ok = $false
    try {
        $resp = Invoke-RestMethod -Uri $HealthUrl -TimeoutSec $TimeoutSec -ErrorAction Stop
        if ($resp.ok -eq $true) { $ok = $true }
    } catch { $ok = $false }

    if ($ok) {
        if ($fails -gt 0) { Write-Host "[watchdog] $(Get-Date -Format HH:mm:ss) recovered — health OK (uptime $([math]::Round($resp.uptime))s)" }
        $fails = 0
        continue
    }

    $fails++
    $daemonPid = Get-DaemonPid
    Write-Host "[watchdog] $(Get-Date -Format HH:mm:ss) health FAILED ($fails/$FailsToKill) — port held by PID $daemonPid"

    if ($fails -ge $FailsToKill) {
        if ($daemonPid) {
            Write-Host "[watchdog] $(Get-Date -Format HH:mm:ss) WEDGE CONFIRMED — killing PID $daemonPid so the launcher respawns it"
            Stop-Process -Id $daemonPid -Force -ErrorAction SilentlyContinue
        } else {
            Write-Host "[watchdog] $(Get-Date -Format HH:mm:ss) no listener on $Port — daemon already down, launcher should be respawning"
        }
        $fails = 0
        Write-Host "[watchdog] waiting ${GraceSec}s for respawn before resuming polls…"
        Start-Sleep -Seconds $GraceSec
    }
}
