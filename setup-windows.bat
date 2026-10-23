@echo off
rem Nus Local Edition: double-click to set up (or re-set up after a git pull).
rem   setup-windows.bat            asks: installer or run-from-folder
rem   setup-windows.bat installer  builds and runs dist\Nus-Setup.exe
rem   setup-windows.bat source     Desktop shortcut that runs this folder
chcp 65001 >nul
set MODE=%1
if "%MODE%"=="" set MODE=ask
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\windows\setup.ps1" -Mode %MODE%
echo.
pause
