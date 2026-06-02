@echo off
:: ============================================================================
::  Sutra — Ensure Running (idempotent)
::  Safe to run on wake-from-sleep, unlock, logon, or boot.
::  Starts the daemon (3001) and UI (3006) ONLY if they are not already
::  listening — repeated triggers never spawn duplicates or cause EADDRINUSE.
::
::  Uses pm2 to start/restart each process, exactly as you would manually.
::  If a stale process is holding port 3001 without serving (zombie), it is
::  killed first so pm2 can bind cleanly.
:: ============================================================================
title Sutra — Ensure Running
cd /d "%~dp0"

:: ── Daemon on 3001 ──────────────────────────────────────────────────────────
PowerShell -NoProfile -Command "if (Get-NetTCPConnection -LocalPort 3001 -State Listen -ErrorAction SilentlyContinue) { exit 0 } else { exit 1 }"
if errorlevel 1 (
  echo [ENSURE] Daemon not on 3001 — checking for stale port holder...
  PowerShell -NoProfile -Command ^
    "$p = (Get-NetTCPConnection -LocalPort 3001 -ErrorAction SilentlyContinue | Where-Object { $_.OwningProcess -gt 4 } | Select-Object -First 1).OwningProcess; if ($p) { Stop-Process -Id $p -Force; Start-Sleep -Seconds 1; Write-Host '[ENSURE] Killed stale PID' $p }"
  echo [ENSURE] Starting sutra-daemon via pm2...
  pm2 restart sutra-daemon --update-env
  if errorlevel 1 (
    echo [ENSURE] pm2 restart failed — trying pm2 start...
    pm2 start daemon/dist/index.js --name sutra-daemon --update-env
  )
) else (
  echo [ENSURE] Daemon already running on 3001 — leaving it alone.
)

:: ── UI on 3006 ──────────────────────────────────────────────────────────────
PowerShell -NoProfile -Command "if (Get-NetTCPConnection -LocalPort 3006 -State Listen -ErrorAction SilentlyContinue) { exit 0 } else { exit 1 }"
if errorlevel 1 (
  echo [ENSURE] UI not on 3006 — starting sutra-ui via pm2...
  pm2 restart sutra-ui
  if errorlevel 1 (
    echo [ENSURE] pm2 restart failed — trying pm2 start...
    pm2 start npm --name sutra-ui -- run dev
  )
) else (
  echo [ENSURE] UI already running on 3006 — leaving it alone.
)

echo [ENSURE] Done.
exit /b 0
