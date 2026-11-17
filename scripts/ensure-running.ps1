# ============================================================================
#  Sutra -- Ensure Running (idempotent, HIDDEN, session-gated)
#
#  Replaces ENSURE_RUNNING.bat's 24/7 polling. Called by the Sutra-EnsureRunning
#  scheduled task (via run_ensure_hidden.vbs, so no console ever flashes).
#
#  Gate: only acts Mon-Fri, 07:55-16:35 ET (5 min before the 08:00 ET first
#  scan, through the 16:05 reconcile). Outside that window it exits in
#  milliseconds and touches nothing -- no netstat, no CIM, no process spawns.
#  Weekend/holiday ticks are no-ops. Pass -Force to bypass the gate (manual use).
#
#  Everything it launches is HIDDEN and logs to .\logs\*.log -- no windows.
#  The UI no longer goes through pm2: pm2 restart-looped sutra-ui and leaked
#  84 orphan vite processes (168 restarts). Plain hidden node + --strictPort.
# ============================================================================
param([switch]$Force)

$ErrorActionPreference = 'SilentlyContinue'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

# -- Session gate (ET, DST-aware via the Windows tz database) -----------------
$et   = [System.TimeZoneInfo]::ConvertTime([DateTime]::UtcNow, [System.TimeZoneInfo]::FindSystemTimeZoneById('Eastern Standard Time'))
$mins = $et.Hour * 60 + $et.Minute
$weekday = $et.DayOfWeek -ne 'Saturday' -and $et.DayOfWeek -ne 'Sunday'
$START_MIN = 7 * 60 + 55    # 07:55 ET -- 5 min before first scan (08:00)
$END_MIN   = 16 * 60 + 35   # 16:35 ET -- after EOD flatten (15:52) + reconcile (16:05)
if (-not $Force -and -not ($weekday -and $mins -ge $START_MIN -and $mins -lt $END_MIN)) { exit 0 }

function Test-Listening([int]$port) {
    # Real TCP connect (v4 then v6): netstat parsing proved unreliable, and
    # Get-NetTCPConnection is CIM-backed and can hang for minutes on Win11.
    foreach ($addr in '127.0.0.1', '::1') {
        $c = New-Object System.Net.Sockets.TcpClient
        try {
            if ($c.ConnectAsync($addr, $port).Wait(1000) -and $c.Connected) { return $true }
        } catch {} finally { $c.Close() }
    }
    return $false
}
function Test-CmdLine([string]$name, [string]$pattern) {
    return [bool](Get-CimInstance Win32_Process -Filter "Name='$name'" | Where-Object { $_.CommandLine -match $pattern })
}
function Start-Hidden([string]$exe, [string]$arguments) {
    Start-Process -FilePath $exe -ArgumentList $arguments -WorkingDirectory $root -WindowStyle Hidden | Out-Null
}

# -- Daemon (3001): self-restarting wrapper, hidden, output -> logs\daemon-out.log
if (-not (Test-Listening 3001) -and -not (Test-CmdLine 'cmd.exe' 'RUN_DAEMON')) {
    Start-Hidden 'cmd.exe' "/c `"`"$root\RUN_DAEMON.bat`" >> `"$root\logs\daemon-out.log`" 2>&1`""
}

# -- External watchdog (health poll + 15:52 EOD flatten + 16:05 reconcile) -----
if (-not (Test-CmdLine 'powershell.exe' 'watchdog-external') -and -not (Test-CmdLine 'cmd.exe' 'RUN_WATCHDOG')) {
    Start-Hidden 'cmd.exe' "/c `"`"$root\RUN_WATCHDOG.bat`" >> `"$root\logs\watchdog.log`" 2>&1`""
}

# -- UI (3006): plain hidden vite. --strictPort => never silently hops to 3007.
if (-not (Test-Listening 3006)) {
    # Direct node + -Redirect* (a cmd /c "..>>log" wrapper died silently here). Logs overwrite per start.
    Start-Process -FilePath 'node' -ArgumentList 'node_modules\vite\bin\vite.js', '--port=3006', '--host=127.0.0.1', '--strictPort' `
        -WorkingDirectory $root -WindowStyle Hidden `
        -RedirectStandardOutput "$root\logs\ui-out.log" -RedirectStandardError "$root\logs\ui-error.log" | Out-Null
}
exit 0
