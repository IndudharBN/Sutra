' Launches ENSURE_RUNNING.bat completely hidden (no console flash).
' Used by the Sutra-EnsureRunning scheduled task so the periodic health
' check never pops a window. 0 = hidden window; True = wait for completion.
Set oShell = CreateObject("WScript.Shell")
oShell.CurrentDirectory = "C:\Indu\RND\Sutra"
oShell.Run "cmd /c ""C:\Indu\RND\Sutra\ENSURE_RUNNING.bat""", 0, True
