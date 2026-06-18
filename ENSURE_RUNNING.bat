@echo off
:: ============================================================================
::  Sutra -- Ensure Running (idempotent)
::  Safe to run on wake-from-sleep, unlock, logon, or boot.
::  Starts the daemon (3001) and UI (3006) ONLY if they are not already
::  listening -- repeated triggers never spawn duplicates or cause EADDRINUSE.
::
::  Daemon: pm2-managed (sutra-daemon).
::    - pm2 backstop-recycles at 1.2 GB RSS (the cache leak is fixed in code;
::      this only catches a genuine runaway) and autorestarts on crash
::    - logs: `pm2 logs sutra-daemon`   status: `pm2 status`
::  UI: pm2 (stable, never crashes, no reason to change)
:: ============================================================================
title Sutra -- Ensure Running
cd /d "%~dp0"

:: -- Daemon on 3001 -----------------------------------------------------------
:: NOTE: netstat probes instead of Get-NetTCPConnection -- the latter is CIM/WMI-
:: backed and can hang for minutes on Windows 11, which would freeze this watchdog.
PowerShell -NoProfile -Command "if (netstat -ano | Select-String ':3001\s' | Where-Object { $_ -match 'LISTENING' }) { exit 0 } else { exit 1 }"
if errorlevel 1 (
  echo [ENSURE] Daemon not on 3001 -- checking for stale (non-pm2) port holder...
  PowerShell -NoProfile -Command "$p = netstat -ano | Select-String ':3001\s' | Where-Object { $_ -match 'LISTENING' } | ForEach-Object { ($_.ToString().Trim() -split '\s+')[-1] } | Where-Object { [int]$_ -gt 4 } | Sort-Object -Unique | Select-Object -First 1; if ($p) { Stop-Process -Id $p -Force -ErrorAction SilentlyContinue; Start-Sleep -Seconds 2; Write-Host '[ENSURE] Killed stale PID' $p }"
  echo [ENSURE] Starting Sutra daemon via pm2...
  pm2 restart sutra-daemon
  if errorlevel 1 (
    pm2 start ecosystem.config.cjs --only sutra-daemon
  )
  pm2 save
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
