# antigravity-zh 卸载脚本（Windows PowerShell）
# 用法：.\uninstall.ps1
#       若系统提示禁止运行脚本，可执行：powershell -ExecutionPolicy Bypass -File .\uninstall.ps1

$ErrorActionPreference = 'Stop'
$utf8NoBom = [System.Text.UTF8Encoding]::new($false)

$pluginName = 'antigravity-zh'

# 1. 定位 .gemini
$geminiCandidates = @()
if ($env:USERPROFILE) { $geminiCandidates += (Join-Path $env:USERPROFILE '.gemini') }
if ($env:HOME) { $geminiCandidates += (Join-Path $env:HOME '.gemini') }
$gemini = $null
foreach ($c in $geminiCandidates) {
  if (Test-Path (Join-Path $c "config\plugins\$pluginName")) { $gemini = $c; break }
}
if (-not $gemini) { Write-Host "未找到已安装的 antigravity-zh，无需卸载。"; exit 0 }

$dest = Join-Path $gemini "config\plugins\$pluginName"

# 2. 先从 config.json 移除启用项与 sidecar 记录（触发语言服务器释放守护进程）
$configPath = Join-Path $gemini 'config\config.json'
if (Test-Path $configPath) {
  $nodeScript = @'
const fs = require('fs');
const p = process.argv[2];
let c = {};
try { c = JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '')); } catch (e) { process.exit(0); }
if (c.plugins) { delete c.plugins['antigravity-zh']; }
if (c.sidecars) { Object.keys(c.sidecars).filter(k => k.startsWith('antigravity-zh/')).forEach(k => delete c.sidecars[k]); }
fs.writeFileSync(p, JSON.stringify(c, null, 2) + '\n', 'utf8');
'@
  $tmpScript = Join-Path $env:TEMP ("agy-zh-un-" + [Guid]::NewGuid().ToString('N').Substring(0,8) + ".js")
  [System.IO.File]::WriteAllText($tmpScript, $nodeScript, $utf8NoBom)

  $node = Get-Command node -ErrorAction SilentlyContinue
  $done = $false
  if ($node) {
    & $node.Source $tmpScript $configPath | Out-Null
    $done = ($LASTEXITCODE -eq 0)
  }
  if (-not $done) {
    $raw = [System.IO.File]::ReadAllText($configPath, $utf8NoBom).TrimStart([char]0xFEFF)
    if ($raw.Trim()) {
      Add-Type -AssemblyName System.Web.Extensions
      $ser = New-Object System.Web.Script.Serialization.JavaScriptSerializer
      $ser.MaxJsonLength = [int]::MaxValue
      $obj = $ser.DeserializeObject($raw)
      if ($obj -and $obj['plugins']) { $null = $obj['plugins'].Remove($pluginName) }
      if ($obj -and $obj['sidecars']) {
        $keys = @($obj['sidecars'].Keys | Where-Object { $_ -like "$pluginName/*" })
        foreach ($k in $keys) { $null = $obj['sidecars'].Remove($k) }
      }
      [System.IO.File]::WriteAllText($configPath, $ser.Serialize($obj), $utf8NoBom)
    }
  }
  Remove-Item $tmpScript -Force -ErrorAction SilentlyContinue
  Write-Host "已从 config.json 移除启用项与 sidecar 记录。"
  Start-Sleep -Seconds 1
}

# 3. 删除插件目录（若被运行中的 Antigravity 占用则给出友好提示）
try {
  Remove-Item $dest -Recurse -Force -ErrorAction Stop
  Write-Host "已删除: $dest"
} catch {
  Write-Warning "部分文件正被运行中的 Antigravity 占用未能立即删除：$dest"
  Write-Host "请先完全退出 Antigravity 后再运行一次 .\uninstall.ps1，或手动删除上述目录。"
  exit 1
}

Write-Host ""
Write-Host "卸载完成。重启 Antigravity 即恢复英文原版（本插件从未修改过应用文件）。"
