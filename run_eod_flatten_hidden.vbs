' Hidden launcher for scripts\eod-flatten.ps1 (no console window). Used by the Sutra-EOD-Flatten scheduled task.
Dim sh, here
Set sh = CreateObject("WScript.Shell")
here = CreateObject("Scripting.FileSystemObject").GetParentFolderName(WScript.ScriptFullName)
sh.Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & here & "\scripts\eod-flatten.ps1""", 0, False
