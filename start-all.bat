@echo off
chcp 65001 >nul
cd /d "%~dp0"
title QQ Bridge - start all
echo ==========================================
echo   QQ Bridge one-click start
echo ==========================================
echo.
echo Requirement: DeepSeek Harness desktop app must be running.
echo.
echo [1/2] preflight: sync DSH port, make sure SnowLuma is up
node scripts\preflight.mjs
echo.
echo [2/2] starting bridge - keep this window open
echo.
call start.bat
