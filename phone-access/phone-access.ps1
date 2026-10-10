# 手机访问 DSH：按需启动中继与隧道，然后打开一张"访问页面"（二维码内嵌，可复制链接/口令）。
#   -SkipBootstrap : 只生成并打开页面，不动中继/隧道
#   -Diagnose      : 只打印诊断信息
#   -NoOpen        : 只生成页面不打开浏览器（调试用）
# 中文只出现在字符串里；脚本必须带 UTF-8 BOM（PS 5.1 无 BOM 会按 ANSI 解析并吃掉大括号）。

param(
  [switch]$SkipBootstrap,
  [switch]$Diagnose,
  [switch]$NoOpen
)

$ErrorActionPreference = 'Continue'
$OutputEncoding = [System.Text.UTF8Encoding]::new($false)

# 工作区根目录：从本脚本位置推导（本脚本在 <root>\phone-access\ 下），换机器/换目录都不用改代码。
# 也允许用环境变量 DSH_WORKSPACE 覆盖（把整套工具放在工作区之外时用）。
if ($env:DSH_WORKSPACE) {
  $Workspace = $env:DSH_WORKSPACE
} else {
  $Workspace = Split-Path -Parent (Split-Path -Parent $PSCommandPath)
}
$Creds = Join-Path $env:USERPROFILE '.dsh\.credentials.yaml'
$AccessPage = Join-Path $Workspace 'phone-access\access.html'

# 日志目录：优先环境变量，逐级回退（Join-Path 遇到空串会抛终止错误，必须自己判断）
$logsCandidates = @()
if ($env:DSH_HOME) { $logsCandidates += "$env:DSH_HOME\logs" }
if ($env:USERPROFILE) { $logsCandidates += "$env:USERPROFILE\.dsh\logs" }
$LogsDir = $null
foreach ($candidate in $logsCandidates) { if (Test-Path $candidate) { $LogsDir = $candidate; break } }
if (-not $LogsDir) { $LogsDir = "$env:USERPROFILE\.dsh\logs" }
$UrlStateFile = Join-Path $LogsDir 'webhook-tunnel-url.txt'

function Get-PublicUrl {
  if (Test-Path $UrlStateFile) {
    $fromState = (Get-Content $UrlStateFile -Raw -ErrorAction SilentlyContinue)
    if ($fromState) {
      $fromState = $fromState.Trim()
      if ($fromState -match '^https://[a-z0-9-]+\.trycloudflare\.com$') { return $fromState }
    }
  }
  return $null
}

function Get-LanUrl {
  try {
    $addrs = [System.Net.Dns]::GetHostAddresses([System.Net.Dns]::GetHostName()) |
      Where-Object { $_.AddressFamily -eq 'InterNetwork' -and $_.IPAddressToString -notlike '127.*' }
    if ($addrs) { return "http://$($addrs[0].IPAddressToString):19388" }
  } catch { }
  return $null
}

function Get-Password {
  if (-not (Test-Path $Creds)) { return $null }
  $line = Select-String -Path $Creds -Pattern '^\s+PHONE_ACCESS_PASSWORD:\s*(\S+)\s*$' -ErrorAction SilentlyContinue |
    Select-Object -First 1
  if ($line) { return $line.Matches[0].Groups[1].Value }
  return $null
}

function Test-Port([int]$port) {
  $client = New-Object System.Net.Sockets.TcpClient
  try {
    $client.Connect('127.0.0.1', $port)
    $client.Close()
    return $true
  } catch {
    return $false
  }
}

# ---- 诊断模式 ----
if ($Diagnose) {
  Write-Host '--- 诊断 ---'
  Write-Host ("USERPROFILE   : {0}" -f $env:USERPROFILE)
  Write-Host ("DSH_HOME      : [{0}]" -f $env:DSH_HOME)
  Write-Host ("LogsDir       : {0}" -f $LogsDir)
  Write-Host ("url-state     : {0}  存在={1}" -f $UrlStateFile, (Test-Path $UrlStateFile))
  Write-Host ("public        : [{0}]" -f (Get-PublicUrl))
  Write-Host ("lan           : [{0}]" -f (Get-LanUrl))
  Write-Host ("password      : {0}" -f $(if (Get-Password) { 'ok' } else { 'FAILED' }))
  Write-Host ("relay 19388   : {0}" -f (Test-Port 19388))
  Write-Host ("webhook 3081  : {0}" -f (Test-Port 3081))
  Write-Host ("access page   : {0}" -f $AccessPage)
  return
}

# ---- 1) 按需启动 ----
$bootstrapError = $null
if (-not $SkipBootstrap) {
  Write-Host '正在准备手机访问（中继 + 隧道）…' -ForegroundColor Cyan
  if (-not (Test-Port 3081)) {
    $bootstrapError = 'DSH 还没启动（127.0.0.1:3081 没在听）。请先打开 DSH，再双击本脚本。'
    Write-Host "  x $bootstrapError" -ForegroundColor Yellow
  } else {
    if (Test-Port 19388) {
      Write-Host '  中继 19388：已在跑' -ForegroundColor Gray
    } else {
      Write-Host '  中继 19388：正在启动…' -ForegroundColor Gray
      & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $Workspace 'phone-access\start-dsh-relay.ps1') | Out-Null
    }
    Write-Host '  隧道：检查/建立中（首次约 15 秒）…' -ForegroundColor Gray
    & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $Workspace 'webhook-projects\github-review\start-webhook-tunnel.ps1') | Out-Null
    Write-Host '  准备完成' -ForegroundColor Green
  }
}

# ---- 2) 生成访问页面 ----
$public = Get-PublicUrl
$lan = Get-LanUrl
$password = Get-Password
$relayState = if (Test-Port 19388) { 'up' } else { 'down' }
$tunnelState = if ((Test-Port 3081) -and $public -and (Get-Process cloudflared -ErrorAction SilentlyContinue)) { 'up' } else { 'down' }

if (-not $public -or -not $password) {
  Write-Host '无法生成访问页面：' -ForegroundColor Yellow
  if (-not $public) { Write-Host '  - 没有公网域名（隧道没起来？DSH 开着吗？）' -ForegroundColor Yellow }
  if (-not $password) { Write-Host '  - 凭据库里读不到 PHONE_ACCESS_PASSWORD' -ForegroundColor Yellow }
  if ($bootstrapError) { Write-Host "  - $bootstrapError" -ForegroundColor Yellow }
  return
}

$pageArgs = @(
  (Join-Path $Workspace 'tools\qrcode\make-access-page.mjs'),
  '--url', $public,
  '--pwd', $password,
  '--out', $AccessPage,
  '--relay', $relayState,
  '--tunnel', $tunnelState
)
if ($lan) { $pageArgs += @('--lan', $lan) }

$pageResult = & node @pageArgs 2>&1
if ($LASTEXITCODE -ne 0) {
  Write-Host '生成访问页面失败：' -ForegroundColor Yellow
  $pageResult | Select-Object -First 3 | ForEach-Object { Write-Host "  $_" -ForegroundColor Yellow }
  return
}

# ---- 3) 打开页面 + 控制台摘要 ----
if (-not $NoOpen) {
  try {
    Start-Process $AccessPage
  } catch {
    Write-Host "打不开浏览器，请手动打开：$AccessPage" -ForegroundColor Yellow
  }
}

Write-Host ''
Write-Host '================ 手机访问 DSH ================' -ForegroundColor Cyan
Write-Host ("  外网地址 : {0}" -f $public) -ForegroundColor Green
Write-Host ("  口令     : {0}" -f $password) -ForegroundColor Yellow
if ($lan) { Write-Host ("  局域网   : {0}" -f $lan) -ForegroundColor Green }
Write-Host ("  状态     : 中继 {0} / 隧道 {1}" -f $relayState, $tunnelState) -ForegroundColor Gray
Write-Host ''
if ($NoOpen) {
  Write-Host '页面已生成（未打开浏览器）。' -ForegroundColor White
} else {
  Write-Host '已打开访问页面：手机扫页面里的二维码即可免口令进入。' -ForegroundColor White
}
Write-Host ("页面文件：{0}" -f $AccessPage) -ForegroundColor DarkGray
Write-Host '（页面看完可以直接关掉；想再看一次就再双击一次本脚本。）' -ForegroundColor DarkGray
