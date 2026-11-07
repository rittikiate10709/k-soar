<#
  Smart Topology NOC - Computer Inventory Agent for Windows
  Version 1.0.0

  Collects hardware / OS / software details and sends them to
  Smart Topology:  POST <Server>/api/v1/inventory/report   (Authorization: Bearer <agent API key>)

  Supports Windows 7 SP1 (with WMF 5.1) / 8.1 / 10 / 11 / Server 2012 R2+  (PowerShell 3.0 or newer)
  Runs as SYSTEM from a scheduled task created by install-agent.ps1

  Usage:
    powershell -ExecutionPolicy Bypass -File smart-topology-agent.ps1                   # use config.json next to this file
    powershell -ExecutionPolicy Bypass -File smart-topology-agent.ps1 -Print            # show collected JSON only (no send)
    powershell -ExecutionPolicy Bypass -File smart-topology-agent.ps1 -Server https://noc:3000 -Key stk_xxx
#>
[CmdletBinding()]
param(
  [string]$Server = '',
  [string]$Key = '',
  [switch]$Print,
  [switch]$SkipCertCheck,
  [switch]$NoSoftware,
  [string]$ConfigPath = ''
)

$ErrorActionPreference = 'Stop'
$AgentVersion = '1.0.0'
$BaseDir = Join-Path $env:ProgramData 'SmartTopology'
if (-not $ConfigPath) { $ConfigPath = Join-Path $BaseDir 'config.json' }
$LogFile = Join-Path $BaseDir 'agent.log'

function Write-Log([string]$msg) {
  $line = '{0} {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $msg
  if ($Print) { Write-Host $line; return }
  try {
    if (-not (Test-Path $BaseDir)) { New-Item -ItemType Directory -Path $BaseDir -Force | Out-Null }
    if ((Test-Path $LogFile) -and ((Get-Item $LogFile).Length -gt 1MB)) { Move-Item $LogFile "$LogFile.old" -Force }
    Add-Content -Path $LogFile -Value $line -Encoding UTF8
  } catch { }
}

# ---------- config (parameters override config.json)
$cfg = @{ server = ''; key = ''; skipCertCheck = $false; software = $true }
if (Test-Path $ConfigPath) {
  try {
    $j = Get-Content $ConfigPath -Raw | ConvertFrom-Json
    foreach ($n in 'server', 'key', 'skipCertCheck', 'software') { if ($null -ne $j.$n) { $cfg[$n] = $j.$n } }
  } catch { Write-Log "WARN cannot read ${ConfigPath}: $($_.Exception.Message)" }
}
if ($Server) { $cfg.server = $Server }
if ($Key) { $cfg.key = $Key }
if ($SkipCertCheck) { $cfg.skipCertCheck = $true }
if ($NoSoftware) { $cfg.software = $false }

# ---------- helpers
$UseCim = [bool](Get-Command Get-CimInstance -ErrorAction SilentlyContinue)
function Q([string]$class, [string]$ns = 'root\cimv2', [string]$filter = '') {
  try {
    if ($UseCim) {
      if ($filter) { return @(Get-CimInstance -ClassName $class -Namespace $ns -Filter $filter -ErrorAction Stop) }
      return @(Get-CimInstance -ClassName $class -Namespace $ns -ErrorAction Stop)
    }
    if ($filter) { return @(Get-WmiObject -Class $class -Namespace $ns -Filter $filter -ErrorAction Stop) }
    return @(Get-WmiObject -Class $class -Namespace $ns -ErrorAction Stop)
  } catch { return @() }
}
function T($v) { if ($null -eq $v) { return '' }; return ([string]$v).Trim() }
function ToDate($v) {
  if ($null -eq $v -or $v -eq '') { return '' }
  try {
    if ($v -is [datetime]) { return $v.ToString('s') }
    return ([Management.ManagementDateTimeConverter]::ToDateTime([string]$v)).ToString('s')
  } catch { return '' }
}
function RegVal([string]$path, [string]$name) {
  try { return (Get-ItemProperty -Path $path -Name $name -ErrorAction Stop).$name } catch { return $null }
}
$MemType = @{ 20 = 'DDR'; 21 = 'DDR2'; 24 = 'DDR3'; 26 = 'DDR4'; 34 = 'DDR5'; 0 = '' }

# ---------- collect
function Get-Inventory {
  $cs = Q 'Win32_ComputerSystem' | Select-Object -First 1
  $os = Q 'Win32_OperatingSystem' | Select-Object -First 1
  $bios = Q 'Win32_BIOS' | Select-Object -First 1
  $prod = Q 'Win32_ComputerSystemProduct' | Select-Object -First 1
  $enc = Q 'Win32_SystemEnclosure' | Select-Object -First 1
  $cv = 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion'

  # OS
  $release = RegVal $cv 'DisplayVersion'; if (-not $release) { $release = RegVal $cv 'ReleaseId' }
  $ubr = RegVal $cv 'UBR'
  $build = T $os.BuildNumber; if ($ubr -ne $null) { $build = "$build.$ubr" }
  $osName = T $os.Caption
  if ($osName -match 'Windows 10' -and [int](T $os.BuildNumber) -ge 22000) { $osName = $osName -replace 'Windows 10', 'Windows 11' }

  # CPU
  $cpus = Q 'Win32_Processor'
  $cpu0 = $cpus | Select-Object -First 1
  $cores = 0; $threads = 0
  foreach ($c in $cpus) { $cores += [int]$c.NumberOfCores; $threads += [int]$c.NumberOfLogicalProcessors }

  # RAM
  $ram = @()
  foreach ($m in (Q 'Win32_PhysicalMemory')) {
    $t = 0; if ($m.SMBIOSMemoryType) { $t = [int]$m.SMBIOSMemoryType } elseif ($m.MemoryType) { $t = [int]$m.MemoryType }
    $speed = $m.ConfiguredClockSpeed; if (-not $speed) { $speed = $m.Speed }
    $ram += @{ sizeMB = [math]::Round([double]$m.Capacity / 1MB); speed = $speed; type = $MemType[$t]; manufacturer = T $m.Manufacturer; part = T $m.PartNumber; slot = T $m.DeviceLocator }
  }

  # Physical disks (Storage module on Win8+, fallback Win32_DiskDrive)
  $disks = @()
  $pd = Q 'MSFT_PhysicalDisk' 'root\Microsoft\Windows\Storage'
  if ($pd.Count -gt 0) {
    $media = @{ 3 = 'HDD'; 4 = 'SSD'; 5 = 'SCM' }
    $bus = @{ 1 = 'SCSI'; 3 = 'ATA'; 6 = 'FibreChannel'; 7 = 'USB'; 8 = 'RAID'; 10 = 'SAS'; 11 = 'SATA'; 12 = 'SD'; 13 = 'MMC'; 17 = 'NVMe' }
    $health = @{ 0 = 'Healthy'; 1 = 'Warning'; 2 = 'Unhealthy'; 5 = 'Unknown' }
    foreach ($d in $pd) {
      if ([int]$d.BusType -eq 7) { continue }   # skip USB drives
      $type = $media[[int]$d.MediaType]; if ([int]$d.BusType -eq 17) { $type = 'NVMe' }
      $disks += @{ model = T $d.FriendlyName; sizeGB = [math]::Round([double]$d.Size / 1e9); type = $type; bus = $bus[[int]$d.BusType]; serial = T $d.SerialNumber; health = $health[[int]$d.HealthStatus] }
    }
  } else {
    foreach ($d in (Q 'Win32_DiskDrive')) {
      if ((T $d.InterfaceType) -eq 'USB' -or (T $d.MediaType) -match 'Removable') { continue }
      $type = ''; if ((T $d.Model) -match 'SSD|NVMe') { $type = 'SSD' }
      $disks += @{ model = T $d.Model; sizeGB = [math]::Round([double]$d.Size / 1e9); type = $type; bus = T $d.InterfaceType; serial = T $d.SerialNumber; health = T $d.Status }
    }
  }

  # Volumes
  $vols = @()
  foreach ($v in (Q 'Win32_LogicalDisk' 'root\cimv2' 'DriveType=3')) {
    $vols += @{ mount = T $v.DeviceID; fs = T $v.FileSystem; label = T $v.VolumeName; sizeGB = [math]::Round([double]$v.Size / 1GB, 1); freeGB = [math]::Round([double]$v.FreeSpace / 1GB, 1) }
  }

  # GPU (AdapterRAM is capped at 4 GB - read qwMemorySize from registry when available)
  $gpus = @()
  $gpuReg = @()
  try { $gpuReg = @(Get-ItemProperty 'HKLM:\SYSTEM\ControlSet001\Control\Class\{4d36e968-e325-11ce-bfc1-08002be10318}\0*' -ErrorAction Stop) } catch { }
  foreach ($g in (Q 'Win32_VideoController')) {
    $name = T $g.Name
    if ($name -match 'Remote Desktop|Remote Display|Microsoft Basic Display|Mirror|DameWare|Citrix|Parsec|Virtual') { continue }
    $vram = 0
    $r = $gpuReg | Where-Object { $_.DriverDesc -eq $name } | Select-Object -First 1
    if ($r -and $r.'HardwareInformation.qwMemorySize') { $vram = [math]::Round([double]$r.'HardwareInformation.qwMemorySize' / 1MB) }
    elseif ($g.AdapterRAM) { $vram = [math]::Round([double][uint32]$g.AdapterRAM / 1MB) }
    $gpus += @{ name = $name; vramMB = $vram; driver = T $g.DriverVersion }
  }

  # Network
  $net = @()
  foreach ($n in (Q 'Win32_NetworkAdapterConfiguration' 'root\cimv2' 'IPEnabled=True')) {
    $ips = @($n.IPAddress | Where-Object { $_ -match '^\d+\.\d+\.\d+\.\d+$' })
    $gw = ''; if ($n.DefaultIPGateway) { $gw = @($n.DefaultIPGateway | Where-Object { $_ -match '^\d+\.\d+\.\d+\.\d+$' })[0] }
    $net += @{ name = T $n.Description; mac = T $n.MACAddress; ipv4 = $ips; gateway = T $gw; dhcp = [bool]$n.DHCPEnabled }
  }

  # Antivirus (workstations only - SecurityCenter2 is not available on Windows Server)
  $av = @()
  foreach ($a in (Q 'AntiVirusProduct' 'root\SecurityCenter2')) {
    $state = [int]$a.productState
    $av += @{ name = T $a.displayName; enabled = ((($state -shr 12) -band 0xF) -eq 1); updated = ((($state -shr 4) -band 0xF) -eq 0) }
  }

  # Monitors
  $mons = @()
  foreach ($m in (Q 'WmiMonitorID' 'root\wmi')) {
    $dec = { param($a) if ($a) { (($a | Where-Object { $_ -ne 0 } | ForEach-Object { [char]$_ }) -join '').Trim() } else { '' } }
    $mons += @{ name = (& $dec $m.UserFriendlyName); serial = (& $dec $m.SerialNumberID) }
  }

  # Software (Uninstall registry - 64 / 32 bit)
  $sw = $null
  if ($cfg.software) {
    $sw = @()
    $seen = @{}
    $paths = 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*', 'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*'
    foreach ($p in $paths) {
      try {
        foreach ($s in (Get-ItemProperty $p -ErrorAction Stop)) {
          $n = T $s.DisplayName
          if (-not $n -or $s.SystemComponent -eq 1 -or $s.ParentKeyName -or $n -match '^(Security Update|Update for|Hotfix for)') { continue }
          if ($seen.ContainsKey($n)) { continue }
          $seen[$n] = 1
          $sw += @{ name = $n; version = T $s.DisplayVersion; publisher = T $s.Publisher }
        }
      } catch { }
    }
  }

  $chassisType = ''
  if ($enc -and $enc.ChassisTypes) {
    $ct = [int]@($enc.ChassisTypes)[0]
    if (@(8, 9, 10, 14, 30, 31, 32) -contains $ct) { $chassisType = 'laptop' } elseif (@(3, 4, 5, 6, 7, 13, 15, 16, 35) -contains $ct) { $chassisType = 'desktop' } elseif (@(17, 23, 28) -contains $ct) { $chassisType = 'server' }
  }

  return [ordered]@{
    agentId      = $script:AgentId
    agentVersion = $AgentVersion
    platform     = 'windows'
    collectedAt  = (Get-Date).ToString('s')
    hostname     = $env:COMPUTERNAME
    domain       = T $cs.Domain
    user         = T $cs.UserName
    os           = @{ name = $osName; version = T $os.Version; build = $build; release = T $release; arch = T $os.OSArchitecture; installDate = (ToDate $os.InstallDate); lastBoot = (ToDate $os.LastBootUpTime) }
    cpu          = @{ model = T $cpu0.Name; cores = $cores; threads = $threads; mhz = $cpu0.MaxClockSpeed; sockets = @($cpus).Count }
    ramMB        = [math]::Round([double]$cs.TotalPhysicalMemory / 1MB)
    ramModules   = $ram
    disks        = $disks
    volumes      = $vols
    gpus         = $gpus
    net          = $net
    system       = @{ manufacturer = T $cs.Manufacturer; model = T $cs.Model; serial = T $bios.SerialNumber; uuid = T $prod.UUID; bios = T $bios.SMBIOSBIOSVersion; biosDate = (ToDate $bios.ReleaseDate); chassis = $chassisType }
    antivirus    = $av
    monitors     = $mons
    software     = $sw
  }
}

# ---------- agent id (persists across runs, survives renaming the computer)
$idFile = Join-Path $BaseDir 'agent-id'
$script:AgentId = ''
try { if (Test-Path $idFile) { $script:AgentId = (Get-Content $idFile -Raw).Trim() } } catch { }
if ($script:AgentId -notmatch '^[0-9a-fA-F-]{36}$') {
  $script:AgentId = [guid]::NewGuid().ToString()
  if (-not $Print) { try { New-Item -ItemType Directory -Path $BaseDir -Force | Out-Null; Set-Content -Path $idFile -Value $script:AgentId -Encoding ASCII } catch { } }
}

try {
  $inv = Get-Inventory
  if ($inv.software -eq $null) { $inv.Remove('software') }
  $json = $inv | ConvertTo-Json -Depth 6 -Compress
} catch {
  Write-Log "ERROR collect: $($_.Exception.Message)"
  exit 1
}

if ($Print) { $inv | ConvertTo-Json -Depth 6; exit 0 }

if (-not $cfg.server -or -not $cfg.key) { Write-Log 'ERROR server / key not configured (run install-agent.ps1)'; exit 2 }

# ---------- send
try {
  [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
} catch { }
if ($cfg.skipCertCheck) {
  if ($PSVersionTable.PSVersion.Major -lt 6) {
    if (-not ('StTrustAll' -as [type])) {
      Add-Type -TypeDefinition 'using System.Net; using System.Security.Cryptography.X509Certificates; public class StTrustAll : ICertificatePolicy { public bool CheckValidationResult(ServicePoint s, X509Certificate c, WebRequest r, int p) { return true; } }'
    }
    [Net.ServicePointManager]::CertificatePolicy = New-Object StTrustAll
  }
}
$url = ($cfg.server.TrimEnd('/')) + '/api/v1/inventory/report'
$body = [Text.Encoding]::UTF8.GetBytes($json)
$headers = @{ Authorization = "Bearer $($cfg.key)" }
$ok = $false
for ($i = 1; $i -le 3 -and -not $ok; $i++) {
  try {
    $p = @{ Uri = $url; Method = 'Post'; Headers = $headers; Body = $body; ContentType = 'application/json; charset=utf-8'; TimeoutSec = 30; UseBasicParsing = $true }
    if ($cfg.skipCertCheck -and $PSVersionTable.PSVersion.Major -ge 6) { $p.SkipCertificateCheck = $true }
    $r = Invoke-RestMethod @p
    $ok = $true
    Write-Log ("OK sent {0} bytes - asset #{1}{2}, {3} change(s)" -f $body.Length, $r.assetId, $(if ($r.isNew) { ' (new)' } else { '' }), $r.changes)
    # remember server-side software setting for next run
    if ($r.config -and $null -ne $r.config.software -and [bool]$r.config.software -ne [bool]$cfg.software -and (Test-Path $ConfigPath)) {
      try { $c = Get-Content $ConfigPath -Raw | ConvertFrom-Json; $c | Add-Member -NotePropertyName software -NotePropertyValue ([bool]$r.config.software) -Force; ($c | ConvertTo-Json) | Set-Content $ConfigPath -Encoding UTF8 } catch { }
    }
  } catch {
    $code = ''
    try { $code = [int]$_.Exception.Response.StatusCode } catch { }
    Write-Log ("ERROR send attempt {0}: HTTP {1} {2}" -f $i, $code, $_.Exception.Message)
    if ($code -in 400, 401, 403) { break }
    Start-Sleep -Seconds ([int](Get-Random -Minimum 5 -Maximum 20))
  }
}
if ($ok) { exit 0 } else { exit 1 }
