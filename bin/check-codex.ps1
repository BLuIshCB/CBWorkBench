param([switch]$InstallMissing)
$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
if (!(Get-Command node -ErrorAction SilentlyContinue)) { throw '源码版需要 Node 24+，请先安装 Node。' }
if (!(Test-Path -LiteralPath (Join-Path $projectRoot 'node_modules/zod/package.json'))) {
    throw "工作台依赖未安装，请在 $projectRoot 运行 npm install。"
}
$codex = Get-Command codex -ErrorAction SilentlyContinue
if (!$codex -and $InstallMissing) {
    & npm install --global '@openai/codex'
    if ($LASTEXITCODE -ne 0) { throw 'Codex 安装失败，请检查 npm 输出。' }
    $codex = Get-Command codex -ErrorAction SilentlyContinue
}
if (!$codex) { throw '未发现 Codex。可配置实际入口，或显式使用 -InstallMissing 安装。' }
Write-Host "已发现 Codex：$($codex.Source)。沿用已有安装和登录态。"
Push-Location $projectRoot
try {
    & node bin/agent.js list
    if ($LASTEXITCODE -ne 0) { throw '运行时或 CLI 检查失败，请按输出修复。' }
} finally { Pop-Location }
Write-Host '运行 npm start，在运行时页面点击 Codex 的“验证真实对话”。未登录时在原生终端运行 codex login。'
Write-Host '工作台仍需 Node 24+ 与 npm 依赖；WorkBuddy/Antigravity 缺失不阻断 Codex。'
