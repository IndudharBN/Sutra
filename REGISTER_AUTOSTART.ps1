# ============================================================================
#  Sutra — Register auto-start with Windows Task Scheduler
#  Run ONCE (no admin needed).
#      Right-click > Run with PowerShell   — or:
#      powershell -ExecutionPolicy Bypass -File .\REGISTER_AUTOSTART.ps1
#
#  Creates task "Sutra-EnsureRunning" that runs ENSURE_RUNNING.bat on:
#    - workstation UNLOCK  (returning after sleep/lock — the key trigger)
#    - LOGON               (covers reboots / Windows Update restarts)
#
#  ENSURE_RUNNING.bat is idempotent — fires on every unlock harmlessly.
#  If both processes are already running it exits in under a second.
# ============================================================================

$ErrorActionPreference = 'Stop'
$root     = Split-Path -Parent $MyInvocation.MyCommand.Path
$script   = Join-Path $root 'run_ensure_hidden.vbs'
$taskName = 'Sutra-EnsureRunning'

if (-not (Test-Path $script)) { throw "run_ensure_hidden.vbs not found at $script" }

$svc = New-Object -ComObject Schedule.Service
$svc.Connect()
$rootFolder = $svc.GetFolder('\')

$def = $svc.NewTask(0)
$def.RegistrationInfo.Description = 'Ensure Sutra daemon (3001) and UI (3006) are running. Idempotent — safe to fire on every unlock.'
$def.Settings.Enabled                    = $true
$def.Settings.StartWhenAvailable         = $true   # catch up if trigger was missed
$def.Settings.DisallowStartIfOnBatteries = $false
$def.Settings.StopIfGoingOnBatteries     = $false
$def.Settings.ExecutionTimeLimit         = 'PT0S'  # no time limit
$def.Settings.MultipleInstances          = 2       # ignore new instance if already running
$def.Settings.Priority                    = 4       # NORMAL. Task Scheduler's default (7) is BELOW_NORMAL and children inherit it

# Trigger 1: workstation UNLOCK (TASK_TRIGGER_SESSION_STATE_CHANGE = 11)
$tUnlock             = $def.Triggers.Create(11)
$tUnlock.StateChange = 8   # TASK_SESSION_UNLOCK
$tUnlock.UserId      = "$env:USERDOMAIN\$env:USERNAME"
$tUnlock.Enabled     = $true

# Trigger 2: LOGON (TASK_TRIGGER_LOGON = 9)
$tLogon         = $def.Triggers.Create(9)
$tLogon.UserId  = "$env:USERDOMAIN\$env:USERNAME"
$tLogon.Enabled = $true

# Trigger 3: Mon-Fri session poll (TASK_TRIGGER_WEEKLY = 3). NOT 24/7: starts 11:50 local
# and repeats every 15 min for 10h. The machine is on GMT while the US session moves with
# US DST (07:55 ET = 11:55 BST / 12:55 GMT), so 11:50 local covers both; the exact
# 07:55-16:35 ET gate lives in scripts\ensure-running.ps1 (off-window ticks are instant no-ops).
$tDaily = $def.Triggers.Create(3)
$tDaily.DaysOfWeek   = 62          # Mon(2)+Tue(4)+Wed(8)+Thu(16)+Fri(32)
$tDaily.WeeksInterval = 1
$tDaily.StartBoundary = (Get-Date '11:50').ToString('yyyy-MM-ddTHH:mm:ss')
$tDaily.Repetition.Interval = 'PT15M'
$tDaily.Repetition.Duration = 'PT10H'
$tDaily.Enabled = $true

# Action: hidden launcher (wscript -> powershell -WindowStyle Hidden): no console flash
$action                  = $def.Actions.Create(0)  # TASK_ACTION_EXEC
$action.Path             = "$env:SystemRoot\System32\wscript.exe"
$action.Arguments        = "//nologo `"$root\run_ensure_hidden.vbs`""
$action.WorkingDirectory = $root

# Register (create or replace if exists)
# 6 = TASK_CREATE_OR_UPDATE, 3 = run only when user is logged on
$rootFolder.RegisterTaskDefinition($taskName, $def, 6, $null, $null, 3) | Out-Null

Write-Host ""
Write-Host "  Registered scheduled task '$taskName'." -ForegroundColor Green
Write-Host "  Triggers: workstation unlock + logon  ->  $script"
Write-Host ""
Write-Host "  Test it now:   Start-ScheduledTask -TaskName '$taskName'"
Write-Host "  Inspect:       taskschd.msc"
Write-Host "  Remove later:  Unregister-ScheduledTask -TaskName '$taskName' -Confirm:`$false"
Write-Host ""
