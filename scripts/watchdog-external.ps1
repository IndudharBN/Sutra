# ============================================================================
#  Sutra EXTERNAL watchdog - catches WEDGES the in-process watchdog cannot.
#
#  The in-process watchdog (daemon/src/watchdog.ts) runs ON the daemon's own
#  event loop, so when the loop is starved (e.g. a co-located CPU-heavy process
#  like a Kubera backtest hogging the machine) the watchdog's own timer can't
#  fire - the daemon sits alive-but-wedged, holding port 3001 but not answering.
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
$FailsToKill   = 3       # consecutive failures before killing (~90s of wedge)
$GraceSec      = 45      # after a kill, wait for the .bat loop to respawn before polling again

function Get-DaemonPid {
    $line = netstat -ano | Select-String ":$Port\s" | Where-Object { $_ -match 'LISTENING' } | Select-Object -First 1
    if ($line) { return ($line.ToString().Trim() -split '\s+')[-1] }
    return $null
}

#  Alpaca creds (read from daemon/.env.daemon so we can flatten independently) 
$envFile = Join-Path $PSScriptRoot "..\daemon\.env.daemon"
$Alpaca = @{}
if (Test-Path $envFile) {
    foreach ($l in Get-Content $envFile) {
        if ($l -match '^\s*(ALPACA_[A-Z_]+)\s*=\s*(.+?)\s*$') { $Alpaca[$Matches[1]] = $Matches[2] }
    }
}
$AlpacaHeaders = @{
    'APCA-API-KEY-ID'     = $Alpaca['ALPACA_KEY']
    'APCA-API-SECRET-KEY' = $Alpaca['ALPACA_SECRET']
}
$AlpacaBase = $Alpaca['ALPACA_BASE_URL']

function Get-ETMinutes {
    # ET wall-clock minutes-since-midnight, DST-aware via the Windows tz database.
    $et = [System.TimeZoneInfo]::FindSystemTimeZoneById('Eastern Standard Time')
    $now = [System.TimeZoneInfo]::ConvertTime([DateTime]::UtcNow, [System.TimeZoneInfo]::Utc, $et)
    return ($now.Hour * 60 + $now.Minute)
}

# EXTERNAL EOD FLATTEN - the safety net. The daemon's own EOD close runs at 15:50 ET
# on a setInterval; if the daemon is WEDGED at the close its timer never fires and
# positions carry overnight (this is what drained the account Jul 21-24). This runs
# in a separate process, so at 15:52 ET it independently flattens any position still
# open - cancel resting orders first (free the shares), then market-close everything.
# Idempotent: if the daemon already flattened, there is nothing to close.
$EOD_FLATTEN_MIN = 15 * 60 + 52   # 15:52 ET - 2 min after the daemon's 15:50, so the
                                  # daemon gets first crack and we only backstop.
$EOD_CUTOFF_MIN  = 16 * 60 + 30   # stop attempting after 16:30 ET (retries every poll until flat)

# POST-EOD RECONCILE - after the close settles, converge the ledger's P&L onto
# Alpaca's real matched fills (fixes partial-exit whole-share drift). Runs once
# per ET day at 16:05 ET, well after all EOD fills have settled at the broker.
$RECONCILE_MIN   = 16 * 60 + 5    # 16:05 ET
$reconciledDate  = ''

function Invoke-Reconcile {
    $script = Join-Path $PSScriptRoot 'reconcile-daily.mjs'
    if (-not (Test-Path $script)) { Write-Host "[watchdog] reconcile skipped - $script not found"; return }
    Write-Host "[watchdog] $(Get-Date -Format HH:mm:ss) running daily Alpaca reconcile --apply"
    try {
        $out = & node $script '--apply' 2>&1 | Out-String
        Write-Host $out.Trim()
    } catch { Write-Host "[watchdog] reconcile FAILED: $($_.Exception.Message)" }
}

function Invoke-EodFlatten {
    if (-not $AlpacaBase) { Write-Host "[watchdog] EOD flatten skipped - no Alpaca creds loaded"; return }
    try {
        $pos = Invoke-RestMethod -Uri "$AlpacaBase/v2/positions" -Headers $AlpacaHeaders -TimeoutSec 10 -ErrorAction Stop
    } catch { Write-Host "[watchdog] $(Get-Date -Format HH:mm:ss) EOD: could not read positions ($($_.Exception.Message))"; return }
    $pos = @($pos); if ($pos.Count -eq 0) { Write-Host "[watchdog] $(Get-Date -Format HH:mm:ss) EOD: no open positions - daemon already flat OK"; return }

    Write-Host "[watchdog] $(Get-Date -Format HH:mm:ss) EOD SAFETY FLATTEN - $($pos.Count) position(s) still open, closing at market:"
    foreach ($p in $pos) { Write-Host "    $($p.symbol) $($p.side) $($p.qty) (unrealized $($p.unrealized_pl))" }
    # 1. cancel resting bracket/OCO orders so shares are free to liquidate
    try { Invoke-RestMethod -Uri "$AlpacaBase/v2/orders" -Method Delete -Headers $AlpacaHeaders -TimeoutSec 10 -ErrorAction Stop | Out-Null } catch {}
    Start-Sleep -Seconds 1
    # 2. liquidate all positions at market (DELETE = close, Alpaca's REST convention)
    try {
        Invoke-RestMethod -Uri "$AlpacaBase/v2/positions" -Method Delete -Headers $AlpacaHeaders -TimeoutSec 15 -ErrorAction Stop | Out-Null
        Write-Host "[watchdog] $(Get-Date -Format HH:mm:ss) EOD flatten submitted - positions closing at market"
    } catch { Write-Host "[watchdog] $(Get-Date -Format HH:mm:ss) EOD flatten FAILED: $($_.Exception.Message)" }
}

Write-Host "[watchdog] external health-check armed - poll $HealthUrl every ${IntervalSec}s, kill after $FailsToKill consecutive failures (~$($FailsToKill*$IntervalSec)s wedge). EOD safety-flatten at 15:52 ET."

$fails = 0
while ($true) {
    Start-Sleep -Seconds $IntervalSec

    # EOD safety-flatten (independent of daemon health). RETRIES on EVERY poll in
    # the 15:52-16:30 ET window while ANY position is still open - not once/day.
    # On 2026-07-28 the daemon was DEAD at 15:50 and only respawned at 16:10, so a
    # single 15:52 shot could miss entirely and 13 positions carried overnight.
    # Invoke-EodFlatten is a no-op when Alpaca is already flat, so repeated calls
    # are safe and cheap; it self-stops once the account has zero open positions.
    $etMin = Get-ETMinutes
    $etDay = ([System.TimeZoneInfo]::ConvertTime([DateTime]::UtcNow, [System.TimeZoneInfo]::Utc, [System.TimeZoneInfo]::FindSystemTimeZoneById('Eastern Standard Time'))).ToString('yyyy-MM-dd')
    if ($etMin -ge $EOD_FLATTEN_MIN -and $etMin -lt $EOD_CUTOFF_MIN) {
        Invoke-EodFlatten
    }

    # Post-EOD reconcile (once per ET day, after the flatten settles).
    if ($etMin -ge $RECONCILE_MIN -and $etMin -lt $EOD_CUTOFF_MIN -and $reconciledDate -ne $etDay) {
        Invoke-Reconcile
        $reconciledDate = $etDay
    }

    $ok = $false
    try {
        $resp = Invoke-RestMethod -Uri $HealthUrl -TimeoutSec $TimeoutSec -ErrorAction Stop
        if ($resp.ok -eq $true) { $ok = $true }
    } catch { $ok = $false }

    if ($ok) {
        if ($fails -gt 0) { Write-Host "[watchdog] $(Get-Date -Format HH:mm:ss) recovered - health OK (uptime $([math]::Round($resp.uptime))s)" }
        $fails = 0
        continue
    }

    $fails++
    $daemonPid = Get-DaemonPid
    Write-Host "[watchdog] $(Get-Date -Format HH:mm:ss) health FAILED ($fails/$FailsToKill) - port held by PID $daemonPid"

    if ($fails -ge $FailsToKill) {
        if ($daemonPid) {
            Write-Host "[watchdog] $(Get-Date -Format HH:mm:ss) WEDGE CONFIRMED - killing PID $daemonPid so the launcher respawns it"
            Stop-Process -Id $daemonPid -Force -ErrorAction SilentlyContinue
        } else {
            Write-Host "[watchdog] $(Get-Date -Format HH:mm:ss) no listener on $Port - daemon already down, launcher should be respawning"
        }
        $fails = 0
        Write-Host "[watchdog] waiting ${GraceSec}s for respawn before resuming polls-"
        Start-Sleep -Seconds $GraceSec
    }
}
