@echo off
chcp 65001 >nul
cd /d "%~dp0"
rem Harden state/ ACLs (Windows needs WRITE_DAC; the directory owner normally has it,
rem so no UAC prompt in the usual case). This NEVER blocks startup: if it cannot get
rem permission it prints a copy-pasteable command and exits 0.
rem See docs/guides/SECURITY_BASELINE.md ("secrets at rest").
node scripts\harden-state-acl.mjs --quiet
rem DSH 桌面版每次启动都会换端口，桥接却用固定 baseUrl。先把地址同步成
rem 当前真正在跑的那个（读 ~/.dsh/logs 里的 "dsh web: http://127.0.0.1:PORT"）。
node scripts\sync-dsh-url.mjs
:loop
node src/bridge.js
set code=%errorlevel%
if "%code%"=="2" (
    echo [%date% %time%] bridge already running in another window. Exiting.
    pause
    exit /b 2
)
echo [%date% %time%] bridge exited (code %code%), restarting in 5 seconds...
timeout /t 5 /nobreak >nul
goto loop
