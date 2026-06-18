@echo off
:: ============================================================================
::  Sutra -- Full Restart (Daemon + Dashboard)
::  Rebuilds and restarts the daemon (3001) in a visible window, restarts the
::  pm2 UI (3006), and opens the dashboard in the browser. Use this for a clean
::  slate; use RESTART_DAEMON.bat when the UI is fine and only the engine needs
::  a restart.
:: ============================================================================
title Sutra -- Full Restart
cls
echo.
echo  =====================================================
echo    Sutra  ^|  Full Restart (Daemon + Dashboard)
echo  =====================================================
echo.
cd /d "%~dp0"

:: -- Build first; if it fails, leave everything as-is ---------------------
echo  [1/4] Building daemon (tsc)...
call npm run build:daemon
if errorlevel 1 (
  echo.
  echo  [BUILD FAILED] -- daemon and UI left as-is. Fix and retry.
  echo.
  pause
  exit /b 1
)

:: -- Restart the daemon via pm2 (memory-recycled + autorestart) -----------
:: pm2 delete fully stops the managed process and releases port 3001; the
:: netstat sweep then clears any stale NON-pm2 holder so the fresh start can't
:: hit EADDRINUSE. NOTE: netstat instead of Get-NetTCPConnection -- the latter
:: is CIM/WMI-backed and can hang for minutes on Windows 11.
echo  [2/4] Restarting daemon (pm2) on port 3001...
call pm2 delete sutra-daemon >nul 2>&1
PowerShell -NoProfile -Command "$ls = netstat -ano | Select-String ':3001\s' | Where-Object { $_ -match 'LISTENING' }; $procIds = $ls | ForEach-Object { ($_.ToString().Trim() -split '\s+')[-1] } | Where-Object { [int]$_ -gt 4 } | Sort-Object -Unique; if ($procIds) { foreach ($p in $procIds) { Stop-Process -Id $p -Force -ErrorAction SilentlyContinue; Write-Host ('  Cleared stale port holder PID ' + $p + '.') } }"
timeout /t 2 /nobreak >nul
call pm2 start ecosystem.config.cjs --only sutra-daemon
timeout /t 3 /nobreak >nul

:: -- Restart the UI via pm2 (start it if pm2 has no entry yet) -------------
echo  [3/4] Restarting UI (pm2) on port 3006...
call pm2 restart sutra-ui
if errorlevel 1 (
  call pm2 start ecosystem.config.cjs --only sutra-ui
)

:: -- Persist the pm2 process list so both survive a reboot ----------------
echo  [4/4] Saving pm2 process list...
call pm2 save

timeout /t 3 /nobreak >nul
start "" "http://localhost:3006"
echo.
echo  =====================================================
echo    Daemon : http://localhost:3001/api/state
echo    UI     : http://localhost:3006
echo  =====================================================
echo.
echo  Both are running. You can close this window.
echo.
pause
exit /b 0
