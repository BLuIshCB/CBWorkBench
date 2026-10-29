@echo off
chcp 65001 >nul
node "%~dp0workbuddy.js" login %*
exit /b %errorlevel%
