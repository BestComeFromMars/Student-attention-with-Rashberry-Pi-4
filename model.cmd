@echo off
setlocal
node "%~dp0scripts\model-run.mjs" %*
exit /b %ERRORLEVEL%
