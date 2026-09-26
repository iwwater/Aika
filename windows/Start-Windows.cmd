@echo off
setlocal
cd /d "%~dp0code\desktop-pet"
where node.exe >nul 2>nul
if errorlevel 1 if exist "%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe" set "PATH=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin;%PATH%"
where npm.cmd >nul 2>nul
if errorlevel 1 if exist "%~dp0..\.tooling\bin\npm.cmd" set "PATH=%~dp0..\.tooling\bin;%PATH%"
where npm.cmd >nul 2>nul
if errorlevel 1 (
  echo Install Node.js LTS with npm, then open this shortcut again.
  pause
  exit /b 1
)
if not exist node_modules (
  call npm.cmd ci
  if errorlevel 1 goto failed
)
call npm.cmd run dev
if errorlevel 1 goto failed
exit /b 0
:failed
echo.
echo The development preview could not start. See README-WINDOWS.md.
pause
exit /b 1
