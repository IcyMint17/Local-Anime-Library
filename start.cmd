@echo off
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 goto NO_NODE

node -e "const v=process.versions.node.split('.').map(Number); process.exit(v[0]>22||(v[0]===22&&v[1]>=5)?0:1)"
if errorlevel 1 goto OLD_NODE

node src/main.js %*
if errorlevel 1 pause
exit /b 0

:NO_NODE
echo.
echo   Node.js was not found.
echo   Install Node.js 22.5 or newer from https://nodejs.org/ and run this again.
echo.
pause
exit /b 1

:OLD_NODE
echo.
echo   Node.js is too old. Version 22.5 or newer is required.
echo   Current version:
node --version
echo.
pause
exit /b 1
