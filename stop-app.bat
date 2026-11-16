@echo off
REM ============================================================
REM  YT Transcript Video - stop only the processes this project
REM  started (backend + frontend). Unrelated processes are safe.
REM ============================================================
title YT Transcript Video
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\stop-app.ps1"
pause
