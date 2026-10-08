@echo off
cd /d "%~dp0"
node scripts\prepare-phone-test.mjs
if errorlevel 1 goto failed
node scripts\run-phones.mjs
if errorlevel 1 goto failed
exit /b 0
:failed
echo.
echo Phone test did not start. Read the message above.
pause
