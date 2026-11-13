' Launches scripts\ensure-running.ps1 completely hidden (no console flash).
' Used by the Sutra-EnsureRunning scheduled task. The script itself self-gates to
' Mon-Fri 07:55-16:35 ET, so off-hours ticks are instant no-ops.
' 0 = hidden window; True = wait for completion.
Set oShell = CreateObject("WScript.Shell")
oShell.CurrentDirectory = "C:\Indu\RND\Sutra"
oShell.Run "powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File ""C:\Indu\RND\Sutra\scripts\ensure-running.ps1""", 0, True
