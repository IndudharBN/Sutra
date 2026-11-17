# Registers the wake-to-run end-of-day flatten task (current user, no admin needed). Re-runnable.
#   powershell -ExecutionPolicy Bypass -File REGISTER_EOD_FLATTEN.ps1
# Two weekday triggers anchored to US Eastern offsets (-05:00 EST and -04:00 EDT); each repeats every 2 min for
# 12 min starting 15:50 ET. The script itself gates on the real ET clock, so only the right regime acts.
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$name = 'Sutra-EOD-Flatten'

$action = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument ('//nologo "{0}\run_eod_flatten_hidden.vbs"' -f $root)
$triggers = foreach ($off in '-05:00', '-04:00') {
    $t = New-ScheduledTaskTrigger -Weekly -DaysOfWeek Monday, Tuesday, Wednesday, Thursday, Friday -At '15:50'
    $t.StartBoundary = ('{0}T15:50:00{1}' -f (Get-Date).ToString('yyyy-MM-dd'), $off)
    $t.Repetition = (New-ScheduledTaskTrigger -Once -At '15:50' -RepetitionInterval (New-TimeSpan -Minutes 2) -RepetitionDuration (New-TimeSpan -Minutes 12)).Repetition
    $t
}
$settings = New-ScheduledTaskSettingsSet -WakeToRun -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 5) -MultipleInstances IgnoreNew -Priority 4
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName $name -Action $action -Trigger $triggers -Settings $settings -Principal $principal -Force `
    -Description 'Wakes the PC and flattens all Alpaca paper positions at ~15:50 ET (independent of the daemon/watchdog).' | Out-Null
Get-ScheduledTask -TaskName $name | Get-ScheduledTaskInfo | Select-Object TaskName, NextRunTime | Format-List
