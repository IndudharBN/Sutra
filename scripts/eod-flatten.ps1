# ============================================================================
#  eod-flatten.ps1 - standalone end-of-day safety flatten.
#
#  Run by Windows Task Scheduler (task "Sutra-EOD-Flatten", WakeToRun) at ~15:50 ET on trading days.
#  Independent of the daemon AND the external watchdog: on 2026-11-16 the PC slept 20:31-21:11 UTC
#  and both of those (same machine, same sleep) missed the 15:50/15:52 flatten, so 13 positions
#  carried overnight with no stops. This task WAKES the PC for the flatten.
#
#  Gate: only acts Mon-Fri 15:50-15:59 ET (DST-safe via the Eastern time zone). The task is registered
#  with triggers for both UTC offsets; the wrong-regime trigger simply exits here. Idempotent: flat = no-op.
#  Usage:  powershell -File scripts\eod-flatten.ps1 [-Force] [-DryRun]   (-DryRun: read + log only, closes nothing)
# ============================================================================
param([switch]$Force, [switch]$DryRun)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$logDir = Join-Path $root 'logs'
New-Item -ItemType Directory -Force $logDir | Out-Null
$log = Join-Path $logDir 'eod-flatten.log'
function Log($m) { Add-Content -Path $log -Value ("{0} {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $m) }

$tz = [System.TimeZoneInfo]::FindSystemTimeZoneById('Eastern Standard Time')   # observes US daylight time
$et = [System.TimeZoneInfo]::ConvertTime([DateTime]::UtcNow, [System.TimeZoneInfo]::Utc, $tz)
$mins = $et.Hour * 60 + $et.Minute
$weekday = $et.DayOfWeek -ne 'Saturday' -and $et.DayOfWeek -ne 'Sunday'
if (-not $Force -and -not ($weekday -and $mins -ge (15 * 60 + 50) -and $mins -lt (16 * 60))) { exit 0 }

# Credentials from the gitignored daemon env file
$envFile = Join-Path $root 'daemon\.env.daemon'
$cfg = @{}
foreach ($l in Get-Content $envFile) { if ($l -match '^\s*(ALPACA_[A-Z_]+)\s*=\s*(.+?)\s*$') { $cfg[$Matches[1]] = $Matches[2] } }
if (-not $cfg['ALPACA_KEY']) { Log 'no Alpaca creds - abort'; exit 1 }
$base = if ($cfg['ALPACA_BASE_URL']) { $cfg['ALPACA_BASE_URL'].TrimEnd('/') } else { 'https://paper-api.alpaca.markets' }
$h = @{ 'APCA-API-KEY-ID' = $cfg['ALPACA_KEY']; 'APCA-API-SECRET-KEY' = $cfg['ALPACA_SECRET'] }

try { $raw = Invoke-RestMethod -Uri "$base/v2/positions" -Headers $h -TimeoutSec 15; $pos = @($raw | ForEach-Object { $_ }) }   # pipe to unroll: @(...) alone wraps a JSON array as ONE element
catch { Log "could not read positions: $($_.Exception.Message)"; exit 1 }
if ($pos.Count -eq 0) { Log "ET $($et.ToString('HH:mm')) flat - nothing to do"; exit 0 }

Log "ET $($et.ToString('HH:mm')) SAFETY FLATTEN: $($pos.Count) open: $(($pos | ForEach-Object { $_.symbol }) -join ',')"
if ($DryRun) { Log 'DRY RUN - would cancel all orders and close all positions; did nothing'; exit 0 }
try { Invoke-RestMethod -Uri "$base/v2/orders" -Method Delete -Headers $h -TimeoutSec 15 | Out-Null } catch { Log "cancel orders: $($_.Exception.Message)" }
Start-Sleep -Seconds 2
try { Invoke-RestMethod -Uri "$base/v2/positions" -Method Delete -Headers $h -TimeoutSec 20 | Out-Null; Log 'close-all submitted' }
catch { Log "close-all FAILED: $($_.Exception.Message)"; exit 1 }
Start-Sleep -Seconds 8
try { $raw2 = Invoke-RestMethod -Uri "$base/v2/positions" -Headers $h -TimeoutSec 15; $left = @($raw2 | ForEach-Object { $_ }); Log "after close: $($left.Count) position(s) still open" } catch { Log "verify failed: $($_.Exception.Message)" }
exit 0
