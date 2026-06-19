@echo off
:: ============================================================================
::  Sutra -- Ensure Running (idempotent)
::  Safe to run on wake-from-sleep, unlock, logon, or boot.
::  Starts the daemon (3001) and UI (3006) ONLY if they are not already
::  listening -- repeated triggers never spawn duplicates or cause EADDRINUSE.
::
::  Daemon: RUN_DAEMON.bat (self-restarting window, NO pm2).
::    - pm2's god daemon kept dying/orphaning the daemon -> "offline"; the leak
::      that justified pm2 is fixed in code, so a plain restart loop is simpler.
::    - crash output is visible in the "Sutra Daemon [3001]" window.
::  UI: pm2 (stable, never crashes, no reason to change)
:: ============================================================================
title Sutra -- Ensure Running
cd /d "%~dp0"

:: -- Daemon on 3001 -----------------------------------------------------------
:: NOTE: netstat probes instead of Get-NetTCPConnection -- the latter is CIM/WMI-
:: backed and can hang for minutes on Windows 11, which would freeze this watchdog.
PowerShell -NoProfile -Command "if (netstat -ano | Select-String ':3001\s' | Where-Object { $_ -match 'LISTENING' }) { exit 0 } else { exit 1 }"
if errorlevel 1 (
  echo [ENSURE] Daemon not on 3001 -- starting self-restarting wrapper window...
  start "Sutra Daemon [3001]" "%~dp0RUN_DAEMON.bat"
) else (
  echo [ENSURE] Daemon already running on 3001 -- leaving it alone.
)

:: -- UI on 3006 ---------------------------------------------------------------
PowerShell -NoProfile -Command "if (netstat -ano | Select-String ':3006\s' | Where-Object { $_ -match 'LISTENING' }) { exit 0 } else { exit 1 }"
if errorlevel 1 (
  echo [ENSURE] UI not on 3006 -- starting sutra-ui via pm2...
  pm2 restart sutra-ui
  if errorlevel 1 (
    pm2 start ecosystem.config.cjs --only sutra-ui
  )
) else (
  echo [ENSURE] UI already running on 3006 -- leaving it alone.
)

echo [ENSURE] Done.
exit /b 0
