@echo off
REM ============================================================
REM  YT Transcript Video - start backend (:8000) + frontend (:3000)
REM  then open Google Chrome at http://localhost:3000
REM  (Chrome opens only AFTER the frontend is ready)
REM ============================================================
title YT Transcript Video
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start-app.ps1"
pause
