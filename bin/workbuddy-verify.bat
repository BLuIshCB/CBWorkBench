@echo off
chcp 65001 >nul
node "%~dp0workbuddy.js" verify %*
exit /b %errorlevel%
