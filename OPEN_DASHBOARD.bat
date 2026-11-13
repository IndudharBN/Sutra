@echo off
:: Sutra -- start everything (hidden) regardless of the session window, then open the dashboard.
cd /d "%~dp0"
wscript //nologo "%~dp0run_ensure_hidden_force.vbs"
timeout /t 4 /nobreak >nul
start "" "http://localhost:3006"
exit /b 0
