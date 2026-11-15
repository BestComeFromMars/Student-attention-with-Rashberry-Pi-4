@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Please install Node.js 22.19 or newer from https://nodejs.org/en/download
  exit /b 1
)
node scripts\requirement.mjs %*
exit /b %errorlevel%
