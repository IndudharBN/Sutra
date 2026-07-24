@echo off
:: ============================================================================
::  Sutra EXTERNAL watchdog launcher.
::
::  Run this in ADDITION to RUN_DAEMON.bat. It polls the daemon's /api/health
::  from a separate process and force-kills the daemon if it wedges (alive but
::  not answering) — the failure the in-process watchdog and the .bat restart
::  loop both structurally cannot catch. RUN_DAEMON.bat then respawns it.
::
::  Self-relaunches if the watchdog script itself ever exits.
:: ============================================================================
title Sutra Watchdog [3001]
cd /d "%~dp0"

:loop
echo.
echo [%date% %time%] starting external watchdog...
PowerShell -NoProfile -ExecutionPolicy Bypass -File "scripts\watchdog-external.ps1"
echo.
echo [%date% %time%] watchdog exited (code %errorlevel%) -- restarting in 5s.  (close window or Ctrl+C to stop)
timeout /t 5 /nobreak >nul
goto loop
