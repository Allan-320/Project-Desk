@echo off
setlocal
cd /d "%~dp0"
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -STA -ExecutionPolicy Bypass -File "%~dp0start.ps1" -Empty %*
if errorlevel 1 (
 echo.
 echo Startup failed. See the message above.
 if not defined PROJECT_DESK_NO_PAUSE pause
 exit /b 1
)
exit /b 0
