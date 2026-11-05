param(
    [string]$WorkBuddyProductPath = 'D:\CODE\TOOL\WorkBuddy\resources\app.asar.unpacked\cli\product.json'
)
$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$runtimeRoot = Join-Path $projectRoot 'data/runtimes'
$configPath = Join-Path $projectRoot 'data/agent-cli.json'

# 使用官方发行包，所有二进制与配置都放在当前项目，不修改全局 PATH。
New-Item -ItemType Directory -Force $runtimeRoot | Out-Null
& npm install --prefix (Join-Path $runtimeRoot 'native') --no-audit --no-fund --ignore-scripts '@openai/codex@0.166.0' '@tencent-ai/codebuddy-code@2.179.0'
if ($LASTEXITCODE -ne 0) { throw '官方 npm CLI 安装失败。' }

$agyDir = Join-Path $runtimeRoot 'antigravity'
$agyPath = Join-Path $agyDir 'agy.exe'
if (!(Test-Path -LiteralPath $agyPath)) {
    $manifest = Invoke-RestMethod 'https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests/windows_amd64.json'
    New-Item -ItemType Directory -Force $agyDir | Out-Null
    $downloadPath = Join-Path $agyDir 'agy.download'
    Invoke-WebRequest $manifest.url -OutFile $downloadPath
    if ((Get-FileHash $downloadPath -Algorithm SHA512).Hash.ToLower() -ne $manifest.sha512.ToLower()) {
        throw 'Antigravity CLI SHA512 校验失败，未安装。'
    }
    Move-Item -LiteralPath $downloadPath -Destination $agyPath
}

if (Test-Path -LiteralPath $configPath) {
    Write-Host "已保留现有配置：$configPath"
    exit 0
}
if (!(Test-Path -LiteralPath $WorkBuddyProductPath)) {
    throw '请通过 -WorkBuddyProductPath 指定 WorkBuddy 官方 product.json；未生成虚构的产品配置。'
}
$nodeResolver = Join-Path $projectRoot 'src/utils/nodeResolver.js'
$nodeUrl = ([Uri]$nodeResolver).AbsoluteUri
$nodePath = & node --input-type=module -e "import { resolveSupportedNode } from '$nodeUrl'; console.log(resolveSupportedNode());"
if ($LASTEXITCODE -ne 0) { throw '请安装 Node 24 或设置 CB_NODE_PATH。' }
$nodePath = $nodePath.Trim()

$product = Get-Content -LiteralPath $WorkBuddyProductPath -Raw | ConvertFrom-Json
if (!$product.authentication -or !$product.endpoint) { throw 'WorkBuddy 产品配置缺少 authentication 或 endpoint。' }
# 独立认证标识只改变 CLI 凭据文件名，避免重登录覆盖桌面版加密凭据。
$product.authentication.id = 'cbworkbench-workbuddy-cli'
$productPath = Join-Path $runtimeRoot 'workbuddy-product.json'
[IO.File]::WriteAllText($productPath, ($product | ConvertTo-Json -Depth 80))
$config = @{
    workbuddy = @{
        executable = $nodePath
        script = Join-Path $runtimeRoot 'native/node_modules/@tencent-ai/codebuddy-code/bin/codebuddy'
        env = @{
            ACC_PRODUCT_CONFIG_PATH = $productPath
            CODEBUDDY_CONFIG_DIR = Join-Path $projectRoot 'data/workbuddy-cli'
        }
    }
    codex = @{
        executable = $nodePath
        script = Join-Path $runtimeRoot 'native/node_modules/@openai/codex/bin/codex.js'
    }
    antigravity = @{ executable = $agyPath }
}
[IO.File]::WriteAllText($configPath, ($config | ConvertTo-Json -Depth 5))
Write-Host "CLI 已安装，配置：$configPath"
Write-Host '首次使用运行 node bin/agent.js login workbuddy；随后分别 verify 三个 CLI。'
