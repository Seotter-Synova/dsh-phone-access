# Relay service: start the phone/GUI relay (port 19388) if it is not already listening.
#
# This is intentionally tiny and does ONE thing. It used to also start the tunnel and poll for
# DSH, but that is now the DSH plugin's job (plugins/dsh-tunnel-boot fires on DSH boot), so the
# login hook no longer needs to guess when DSH is up.
#
# Why it is still needed: the relay must exist independently of DSH boot. If nothing starts it
# at logon, the tunnel would come up with nothing behind it.
#
# Idempotent, safe to run any time. ASCII only (PowerShell 5.1 reads BOM-less .ps1 as ANSI).

$ErrorActionPreference = 'Continue'
$Workspace = if ($env:DSH_WORKSPACE) { $env:DSH_WORKSPACE } else { Split-Path -Parent (Split-Path -Parent $PSCommandPath) }
$RuntimeDir = "$env:USERPROFILE\.dsh\logs"
$Log = Join-Path $RuntimeDir 'dsh-relay.log'
$Port = 19388

New-Item -ItemType Directory -Force -Path $RuntimeDir | Out-Null

function Write-Log([string]$Message) {
  Add-Content -Path $Log -Value ("{0}  {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Message) -Encoding utf8
}

# Get-NetTCPConnection is denied in the DSH sandbox, so probe with a real TCP connect.
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

if (Test-Port $Port) {
  Write-Log ("relay already listening on {0}" -f $Port)
  exit 0
}

Write-Log ("starting relay on {0}" -f $Port)
Start-Process -FilePath 'node' `
  -ArgumentList @((Join-Path $Workspace 'tools\dsh-auth-relay.mjs'), '--listen', "0.0.0.0:$Port",
    '--target', '127.0.0.1:19387', '--webhook', '127.0.0.1:3081') `
  -WorkingDirectory $Workspace -WindowStyle Hidden
Start-Sleep -Seconds 3
Write-Log ("relay listening after start: {0}" -f (Test-Port $Port))
