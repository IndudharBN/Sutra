' Manual variant of run_ensure_hidden.vbs: -Force bypasses the 07:55-16:35 ET session gate.
Set oShell = CreateObject("WScript.Shell")
oShell.CurrentDirectory = "C:\Indu\RND\Sutra"
oShell.Run "powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File ""C:\Indu\RND\Sutra\scripts\ensure-running.ps1"" -Force", 0, True
