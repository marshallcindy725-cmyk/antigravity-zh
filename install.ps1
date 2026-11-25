# antigravity-zh 安装脚本（Windows PowerShell）
# 用法：在与本脚本同目录下执行  .\install.ps1
#       若系统提示禁止运行脚本，可执行：powershell -ExecutionPolicy Bypass -File .\install.ps1
# 作用：把插件包安装到 ~/.gemini/config/plugins/antigravity-zh 并注册启用状态，
#       完全等价于用户在 Antigravity 界面中启用插件。

$ErrorActionPreference = 'Stop'
$utf8NoBom = [System.Text.UTF8Encoding]::new($false)

$srcRoot = $PSScriptRoot
$pluginName = 'antigravity-zh'

# 1. 定位 .gemini（支持 junction/重定向/自定义 HOME）
$geminiCandidates = @()
if ($env:USERPROFILE) { $geminiCandidates += (Join-Path $env:USERPROFILE '.gemini') }
if ($env:HOME) { $geminiCandidates += (Join-Path $env:HOME '.gemini') }
$gemini = $null
foreach ($c in $geminiCandidates) {
  if (Test-Path (Join-Path $c 'config\plugins')) { $gemini = $c; break }
}
if (-not $gemini) {
  $gemini = (Join-Path $env:USERPROFILE '.gemini')
  New-Item -ItemType Directory -Path (Join-Path $gemini 'config\plugins') -Force | Out-Null
}

$pluginsDir = Join-Path $gemini 'config\plugins'
$dest = Join-Path $pluginsDir $pluginName
Write-Host "[1/4] 插件目录: $pluginsDir"

# 2. 复制插件（原位覆盖，兼容 sidecar 进程正在运行的场景；保留已有 config.json）
if (-not (Test-Path $dest)) {
  New-Item -ItemType Directory -Path $dest -Force | Out-Null
} else {
  Write-Host "  发现已安装版本，正在更新..."
}

$keep = @('plugin.json', 'sidecars', 'dictionaries', 'README.md', 'README.en.md', 'LICENSE', 'CHANGELOG.md')
foreach ($item in $keep) {
  $from = Join-Path $srcRoot $item
  if (-not (Test-Path $from)) { continue }
  $to = Join-Path $dest $item
  if (Test-Path $from -PathType Container) {
    if (-not (Test-Path $to)) { New-Item -ItemType Directory -Path $to -Force | Out-Null }
    Copy-Item "$from\*" $to -Recurse -Force
  } else {
    Copy-Item $from $to -Force
  }
}

# config.json：仅在目标不存在时写入默认模板（无 BOM UTF-8）
$destConfig = Join-Path $dest 'config.json'
if (-not (Test-Path $destConfig)) {
  $srcConfig = Join-Path $srcRoot 'config.json'
  if (Test-Path $srcConfig) {
    Copy-Item $srcConfig $destConfig -Force
  } else {
    $defaultCfg = "{`n  `"userDataDirs`": [],`n  `"portFiles`": [],`n  `"logLevel`": `"info`"`n}`n"
    [System.IO.File]::WriteAllText($destConfig, $defaultCfg, $utf8NoBom)
  }
}

Write-Host "[2/4] 复制完成：$(($keep | Where-Object { Test-Path (Join-Path $srcRoot $_) }) -join ', ')"

# 3. 注册启用状态（等价于在 UI 中启用）
$configDir = Join-Path $gemini 'config'
if (-not (Test-Path $configDir)) {
  New-Item -ItemType Directory -Path $configDir -Force | Out-Null
}
$configPath = Join-Path $configDir 'config.json'

if (Test-Path $configPath) {
  $rawConfig = [System.IO.File]::ReadAllText($configPath, $utf8NoBom)
} else {
  $rawConfig = ''
}

if ($rawConfig.Trim()) {
  $nodeScript = @'
const fs = require('fs');
const p = process.argv[2];
let c = {};
try { c = JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '')); } catch (e) { c = {}; }
c.plugins = c.plugins || {};
c.plugins['antigravity-zh'] = { enabled: true };
c.sidecars = c.sidecars || {};
fs.writeFileSync(p, JSON.stringify(c, null, 2) + '\n', 'utf8');
'@
  $tmpScript = Join-Path $env:TEMP ("agy-zh-cfg-" + [Guid]::NewGuid().ToString('N').Substring(0,8) + ".js")
  [System.IO.File]::WriteAllText($tmpScript, $nodeScript, $utf8NoBom)

  $node = Get-Command node -ErrorAction SilentlyContinue
  $done = $false
  if ($node) {
    & $node.Source $tmpScript $configPath | Out-Null
    $done = ($LASTEXITCODE -eq 0)
  }
  if (-not $done) {
    Add-Type -AssemblyName System.Web.Extensions
    $ser = New-Object System.Web.Script.Serialization.JavaScriptSerializer
    $ser.MaxJsonLength = [int]::MaxValue
    $obj = $ser.DeserializeObject($rawConfig.TrimStart([char]0xFEFF))
    if (-not $obj) { $obj = @{} }
    if (-not $obj['plugins']) { $obj['plugins'] = @{} }
    $obj['plugins'][$pluginName] = @{ enabled = $true }
    [System.IO.File]::WriteAllText($configPath, $ser.Serialize($obj), $utf8NoBom)
    $done = $true
  }
  Remove-Item $tmpScript -Force -ErrorAction SilentlyContinue
  if ($done) { Write-Host "[3/4] 已在插件配置中启用（config.json: plugins[$pluginName].enabled = true）" }
} else {
  $initJson = "{`n  `"plugins`": {`n    `"$pluginName`": { `"enabled`": true }`n  }`n}`n"
  [System.IO.File]::WriteAllText($configPath, $initJson, $utf8NoBom)
  Write-Host "[3/4] 已创建插件配置并启用"
}

Write-Host "[4/4] 安装完成！"
Write-Host ""
Write-Host "  请重启 Antigravity（或退出后重新打开）以加载汉化。"
Write-Host "  首次启动由语言服务器自动拉起汉化守护进程（sidecar）。"
Write-Host "  卸载：运行 uninstall.ps1"
