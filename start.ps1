# CBWorkBench 一键启动脚本 (PowerShell)
$OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

Set-Location -Path $PSScriptRoot

Write-Host "=======================================================" -ForegroundColor Cyan
Write-Host "               CBWorkBench 一键启动器                   " -ForegroundColor Cyan
Write-Host "=======================================================" -ForegroundColor Cyan
Write-Host ""

try {
    $nodeVer = node -v
    Write-Host "[状态] 检测到 Node.js: $nodeVer" -ForegroundColor Green
} catch {
    Write-Host "[错误] 未检测到 Node.js，请先安装 Node.js (推荐 Node 22+ 或 Node 24+)。" -ForegroundColor Red
    Read-Host "按回车键退出..."
    exit 1
}

Write-Host ""
Write-Host "=======================================================" -ForegroundColor Yellow
Write-Host "  服务访问地址: http://127.0.0.1:3721/                 " -ForegroundColor Yellow
Write-Host "  如需停止服务: 请按 Ctrl + C 或关闭当前窗口             " -ForegroundColor DarkGray
Write-Host "=======================================================" -ForegroundColor Yellow
Write-Host ""

node bin/cb-workbench.js
