@echo off
:: Thin shim -- the real logic is scripts\ensure-running.ps1 (hidden, session-gated
:: to Mon-Fri 07:55-16:35 ET). Pass -Force to bypass the gate:  ENSURE_RUNNING.bat -Force
cd /d "%~dp0"
PowerShell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\ensure-running.ps1" %*
exit /b 0
