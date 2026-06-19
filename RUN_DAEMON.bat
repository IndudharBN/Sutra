@echo off
:: ============================================================================
::  Sutra Daemon -- self-restarting wrapper (NO pm2).
::
::  Why no pm2: pm2's god daemon proved unstable on this machine -- it kept
::  dying and orphaning the daemon, leaving a server-less zombie / split-brain
::  that the dashboard reported as "Daemon offline" even though a node process
::  was alive. The memory leak that originally justified pm2's auto-recycle is
::  now fixed in code (alpacaClient cache eviction), so a plain restart loop is
::  simpler and far more reliable for a single always-on process.
::
::  This window relaunches the daemon on ANY exit (crash, OOM, EADDRINUSE-exit)
::  after a short backoff. Crash output stays visible here. Close the window or
::  press Ctrl+C to stop it for good.
:: ============================================================================
title Sutra Daemon [3001]
cd /d "%~dp0"

:: Clear any stale holder of 3001 before the first start so we never tight-loop
:: on EADDRINUSE against a leftover process.
PowerShell -NoProfile -Command "$p = netstat -ano | Select-String ':3001\s' | Where-Object { $_ -match 'LISTENING' } | ForEach-Object { ($_.ToString().Trim() -split '\s+')[-1] } | Where-Object { [int]$_ -gt 4 } | Sort-Object -Unique; if ($p) { $p | ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue }; Start-Sleep -Seconds 1 }"

:loop
echo.
echo [%date% %time%] starting Sutra daemon on port 3001...
node --max-old-space-size=1024 daemon\dist\index.js
echo.
echo [%date% %time%] daemon exited (code %errorlevel%) -- restarting in 3s.  (close window or Ctrl+C to stop)
timeout /t 3 /nobreak >nul
goto loop
