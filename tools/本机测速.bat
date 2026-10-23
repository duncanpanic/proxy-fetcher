@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0.."
echo ================================================
echo  proxy-fetcher  local probe (Windows)
echo ================================================
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0local-probe.ps1" %*
set RC=%ERRORLEVEL%
echo.
if not "%RC%"=="0" echo [failed] exit code %RC%
echo Config: %CD%\local\nodes.yaml
echo Report: %CD%\local\report.txt
echo.
pause
exit /b %RC%
