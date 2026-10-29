@echo off
title CBWorkBench

cd /d "%~dp0"

where node >nul 2>nul
if %ERRORLEVEL% neq 0 (
    echo [ERROR] Node.js not found in PATH. Please install Node.js ^(Node 22+ or 24+ recommended^).
    pause
    exit /b 1
)

echo ============================================================
echo   CBWorkBench Launcher
echo   Web UI: http://127.0.0.1:3721/
echo   Press Ctrl+C to stop the server
echo ============================================================
echo.

node bin/cb-workbench.js

if %ERRORLEVEL% neq 0 (
    echo.
    echo [ERROR] Server exited with code %ERRORLEVEL%.
    pause
)
