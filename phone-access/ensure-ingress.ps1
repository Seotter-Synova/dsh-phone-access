# Ensure the phone/GUI ingress is up: DSH webhook listener -> relay -> Cloudflare tunnel.
#
# Two modes:
#   -RunOnce            : check and fix once, then exit (for manual runs / a fixed schedule).
#   (default)           : idle loop, checking every IntervalSeconds forever. This is what the
#                         logon launcher starts; the process sits idle between checks.
#
# Why a watcher instead of a DSH plugin hook: on 2026-10-09 the plugin-hook attempts never fired
# in the real Electron app (no log line at any restart), and registering a Scheduled Task needs
# admin rights this session does not have. A logon-launched idle watcher needs no permissions and
# survives DSH starting late, which is exactly the failure we kept hitting.
#
# Idempotent and cheap when healthy (a few port probes + one log line). ASCII only.

param(
  [int]$IntervalSeconds = 300,
  [switch]$RunOnce
)

$ErrorActionPreference = 'Continue'
$Workspace = if ($env:DSH_WORKSPACE) { $env:DSH_WORKSPACE } else { Split-Path -Parent (Split-Path -Parent $PSCommandPath) }
$RuntimeDir = "$env:USERPROFILE\.dsh\logs"
$Log = Join-Path $RuntimeDir 'ingress-supervisor.log'
$RelayScript = Join-Path $Workspace 'phone-access\start-dsh-relay.ps1'
$TunnelScript = Join-Path $Workspace 'webhook-projects\github-review\start-webhook-tunnel.ps1'
$ProbePort = 3081
$RelayPort = 19388

New-Item -ItemType Directory -Force -Path $RuntimeDir | Out-Null

function Write-Log([string]$Message) {
  Add-Content -Path $Log -Value ("{0}  {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Message) -Encoding utf8
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

function Invoke-Check {
  Write-Log '--- check ---'

  # DSH must be running: without its webhook listener there is nothing to tunnel to.
  if (-not (Test-Port $ProbePort)) {
    Write-Log ("DSH webhook listener on {0} is not up (DSH closed?) -- nothing to do" -f $ProbePort)
    return
  }

  if (Test-Port $RelayPort) {
    Write-Log ("relay on {0}: up" -f $RelayPort)
  } else {
    Write-Log ("relay on {0}: down -> starting" -f $RelayPort)
    & powershell -NoProfile -ExecutionPolicy Bypass -File $RelayScript
  }

  Write-Log 'checking tunnel'
  & powershell -NoProfile -ExecutionPolicy Bypass -File $TunnelScript

  $urlFile = Join-Path $RuntimeDir 'webhook-tunnel-url.txt'
  if (Test-Path $urlFile) { Write-Log ("public URL: {0}" -f (Get-Content $urlFile -Raw).Trim()) }
}

if ($RunOnce) {
  Invoke-Check
  exit 0
}

Write-Log ("watcher started (interval {0}s, pid {1})" -f $IntervalSeconds, $PID)
while ($true) {
  try { Invoke-Check } catch { Write-Log ("check failed: {0}" -f $_.Exception.Message) }
  Start-Sleep -Seconds $IntervalSeconds
}
