<#
  Smart Topology NOC - install / uninstall the Windows inventory agent
  Run as Administrator (or as a GPO computer Startup Script).

    install-agent.ps1 -Server https://noc.hospital.local:3000 -Key stk_xxxxxxxx [-IntervalMinutes 60] [-SkipCertCheck]
    install-agent.ps1 -Uninstall

  What it does
    1. Copies smart-topology-agent.ps1 to C:\ProgramData\SmartTopology  (downloads it from the server if it is not next to this file)
    2. Writes config.json (server + key) and restricts the folder to SYSTEM and Administrators
    3. Creates 2 scheduled tasks running as SYSTEM:  every N minutes  +  2 minutes after startup
    4. Sends the first report immediately
#>
[CmdletBinding()]
param(
  [string]$Server = '',
  [string]$Key = '',
  [int]$IntervalMinutes = 60,
  [switch]$SkipCertCheck,
  [switch]$NoSoftware,
  [switch]$Uninstall
)
$ErrorActionPreference = 'Stop'
$Dir = Join-Path $env:ProgramData 'SmartTopology'
$Agent = Join-Path $Dir 'smart-topology-agent.ps1'
$Task = 'SmartTopology Agent'
$TaskBoot = 'SmartTopology Agent (Startup)'

$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $admin) { Write-Host 'Please run this script as Administrator.' -ForegroundColor Red; exit 1 }
if ($PSVersionTable.PSVersion.Major -lt 3) { Write-Host 'PowerShell 3.0 or newer is required (install WMF 5.1 on Windows 7).' -ForegroundColor Red; exit 1 }

if ($Uninstall) {
  schtasks.exe /Delete /TN "$Task" /F 2>$null | Out-Null
  schtasks.exe /Delete /TN "$TaskBoot" /F 2>$null | Out-Null
  if (Test-Path $Dir) { Remove-Item $Dir -Recurse -Force }
  Write-Host 'Smart Topology agent removed.' -ForegroundColor Green
  exit 0
}

if (-not $Server -or -not $Key) { Write-Host 'Usage: install-agent.ps1 -Server https://noc:3000 -Key stk_xxxxxxxx' -ForegroundColor Yellow; exit 1 }
if ($Key -notmatch '^stk_[A-Za-z0-9_-]{20,}$') { Write-Host 'The key does not look like a Smart Topology API key (stk_...).' -ForegroundColor Red; exit 1 }
if ($IntervalMinutes -lt 5) { $IntervalMinutes = 5 }
if ($IntervalMinutes -gt 1439) { $IntervalMinutes = 1439 }
$Server = $Server.TrimEnd('/')

New-Item -ItemType Directory -Path $Dir -Force | Out-Null

# 1) agent script
$src = Join-Path $PSScriptRoot 'smart-topology-agent.ps1'
if ($PSScriptRoot -and (Test-Path $src)) {
  Copy-Item $src $Agent -Force
} else {
  try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12 } catch { }
  if ($SkipCertCheck -and $PSVersionTable.PSVersion.Major -lt 6 -and -not ('StTrustAll' -as [type])) {
    Add-Type -TypeDefinition 'using System.Net; using System.Security.Cryptography.X509Certificates; public class StTrustAll : ICertificatePolicy { public bool CheckValidationResult(ServicePoint s, X509Certificate c, WebRequest r, int p) { return true; } }'
    [Net.ServicePointManager]::CertificatePolicy = New-Object StTrustAll
  }
  Write-Host "Downloading agent from $Server ..."
  Invoke-WebRequest -Uri "$Server/agent/windows/smart-topology-agent.ps1" -OutFile $Agent -UseBasicParsing
}

# 2) config + permissions (the key is readable only by SYSTEM / Administrators)
$cfg = [ordered]@{ server = $Server; key = $Key; skipCertCheck = [bool]$SkipCertCheck; software = -not $NoSoftware; intervalMinutes = $IntervalMinutes; installedAt = (Get-Date).ToString('s') }
($cfg | ConvertTo-Json) | Set-Content -Path (Join-Path $Dir 'config.json') -Encoding UTF8
icacls.exe "$Dir" /inheritance:r /grant:r "*S-1-5-18:(OI)(CI)F" "*S-1-5-32-544:(OI)(CI)F" /T /C /Q | Out-Null

# 3) scheduled tasks (schtasks.exe works on Windows 7 - 11)
$cmd = "powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$Agent`""
schtasks.exe /Create /TN "$Task" /TR "$cmd" /SC MINUTE /MO $IntervalMinutes /RU SYSTEM /RL HIGHEST /F | Out-Null
if ($LASTEXITCODE -ne 0) { Write-Host 'Cannot create scheduled task.' -ForegroundColor Red; exit 1 }
schtasks.exe /Create /TN "$TaskBoot" /TR "$cmd" /SC ONSTART /DELAY 0002:00 /RU SYSTEM /RL HIGHEST /F | Out-Null

# 4) first report now
Write-Host 'Sending first report ...'
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$Agent"
$code = $LASTEXITCODE
$log = Join-Path $Dir 'agent.log'
if (Test-Path $log) { Get-Content $log -Tail 3 }
if ($code -eq 0) {
  Write-Host "Installed. The agent reports every $IntervalMinutes minutes and at startup." -ForegroundColor Green
} else {
  Write-Host "Installed, but the first report failed (exit $code). Check $log" -ForegroundColor Yellow
}
exit $code
