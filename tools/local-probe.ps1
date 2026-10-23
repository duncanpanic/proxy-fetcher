#Requires -Version 5.1
<#
.SYNOPSIS
  本机测速：用你自己的网络，从候选池里筛出「现在真的能用」的节点。

.DESCRIPTION
  为什么需要它：
    项目里的 fetch.js 跑在 GitHub Actions 上，探测视角是境外机房。
    机房能连的节点，不等于你在国内能连 —— 实测同一份产物，机房 120/120 通过，
    国内家宽只有 6/120 能连。所以「判活」必须在你自己的网络上做。

  它做什么：
    1. 取候选池（public/pool.json，未探测的清洗结果）
    2. 起一个临时 mihomo 内核，逐个节点真实访问 204 探测页
    3. 只留下真正通了、且延迟在阈值内的节点，按延迟排序
    4. 生成可直接导入客户端的配置 local/nodes.yaml，外加一份可读报告 local/report.txt

  不需要 Node、不需要 npm，只用 PowerShell + mihomo 内核（脚本会自己下载）。

.PARAMETER Pool
  候选池地址或本地文件路径。默认 https://node.lorcan.top/pool.json

.PARAMETER Out
  输出目录，默认 .\local

.PARAMETER MaxDelay
  延迟上限（毫秒），超过就丢弃。默认 2000。0 表示不限制。

.PARAMETER Timeout
  单节点探测超时（毫秒）。默认 5000。

.PARAMETER Top
  最多保留多少个节点。默认 60。

.PARAMETER Concurrency
  并发探测数。默认 32。

.PARAMETER TestUrl
  探测目标。默认 https://cp.cloudflare.com/generate_204
  （也可以用 https://www.gstatic.com/generate_204，但该域名在国内会被解析到
   120.253.253.34 这类国内 CDN，测出来的延迟里多一段绕回国内的绕路）

.PARAMETER ExpectedStatus
  期望状态码，默认 204。不匹配即判失败。

.PARAMETER Force
  强制重新下载 mihomo 内核。

.EXAMPLE
  .\local-probe.ps1

.EXAMPLE
  .\local-probe.ps1 -MaxDelay 1000 -Top 30

.EXAMPLE
  .\local-probe.ps1 -Pool .\pool.json -Out D:\clash\nodes
#>
param(
  [string]$Pool = 'https://node.lorcan.top/pool.json',
  [string]$Out = '.\local',
  [int]$MaxDelay = 2000,
  [int]$Timeout = 5000,
  [int]$Top = 60,
  [int]$Concurrency = 32,
  [string]$TestUrl = 'https://cp.cloudflare.com/generate_204',
  [int]$ExpectedStatus = 204,
  [switch]$Force,
  [switch]$AllowPlaintext
)

# 注意：$Pool 是 [string] 类型约束的参数，直接向它赋值数组会被强制拼成一行空格，
# 所以节点列表一律用 $nodes，池来源单独存一份。
$script:PoolSource = $Pool

$ErrorActionPreference = 'Stop'

# Windows PowerShell 5.1 默认可能还在用 TLS 1.0，下载 GitHub 会失败
try {
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 -bor [Net.SecurityProtocolType]::Tls11
} catch { }

# 统一按 UTF-8 输出，避免中文在重定向/管道里变乱码
try {
  [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
  $OutputEncoding = New-Object System.Text.UTF8Encoding($false)
} catch { }

$script:Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$script:RepoRoot = Split-Path -Parent $script:Root
$script:BinDir = Join-Path $script:Root 'bin'
$script:Bin = Join-Path $script:BinDir 'mihomo.exe'
$script:CacheDir = Join-Path $script:Root '.cache'

# 内核要用的 geo 数据（约 10MB），第一次跑会下载，之后从本地缓存复制
$script:GeoFiles = @('geoip.metadb', 'geosite.dat', 'GeoIP.dat', 'Country.mmdb', 'GeoSite.dat')

function Import-GeoCache($targetDir) {
  if (-not (Test-Path -LiteralPath $script:CacheDir)) { return }
  foreach ($name in $script:GeoFiles) {
    $src = Join-Path $script:CacheDir $name
    if (Test-Path -LiteralPath $src) {
      Copy-Item -LiteralPath $src -Destination (Join-Path $targetDir $name) -Force -ErrorAction SilentlyContinue
    }
  }
}

function Save-GeoCache($sourceDir) {
  New-Item -ItemType Directory -Force -Path $script:CacheDir | Out-Null
  foreach ($name in $script:GeoFiles) {
    $src = Join-Path $sourceDir $name
    if ((Test-Path -LiteralPath $src) -and -not (Test-Path -LiteralPath (Join-Path $script:CacheDir $name))) {
      Copy-Item -LiteralPath $src -Destination (Join-Path $script:CacheDir $name) -Force -ErrorAction SilentlyContinue
    }
  }
}

function Write-Step($msg) { Write-Host "[*] $msg" -ForegroundColor Cyan }
function Write-Ok($msg) { Write-Host "[+] $msg" -ForegroundColor Green }
function Write-Warn2($msg) { Write-Host "[!] $msg" -ForegroundColor Yellow }
function Write-Err2($msg) { Write-Host "[x] $msg" -ForegroundColor Red }

# ---------------------------------------------------------------------------
# 1. 准备 mihomo 内核
# ---------------------------------------------------------------------------
function Get-MihomoArch {
  $arch = $env:PROCESSOR_ARCHITECTURE
  if (-not $arch) { $arch = 'AMD64' }
  switch ($arch.ToUpperInvariant()) {
    'AMD64' { return 'amd64' }
    'ARM64' { return 'arm64' }
    'X86' { return '386' }
    default { return 'amd64' }
  }
}

function Install-Mihomo {
  if ((Test-Path -LiteralPath $script:Bin) -and -not $Force) { return }

  $arch = Get-MihomoArch
  Write-Step "下载 mihomo 内核（windows-$arch），首次运行需要几十秒…"
  New-Item -ItemType Directory -Force -Path $script:BinDir | Out-Null

  $api = 'https://api.github.com/repos/MetaCubeX/mihomo/releases/latest'
  $headers = @{ 'User-Agent' = 'proxy-fetcher-local'; 'Accept' = 'application/vnd.github+json' }
  $rel = Invoke-RestMethod -Uri $api -Headers $headers -UseBasicParsing

  $cands = @($rel.assets | Where-Object { $_.name -like "mihomo-windows-$arch*v*.zip" })
  if (-not $cands -or $cands.Count -eq 0) { throw "找不到适配 windows-$arch 的发行包（tag=$($rel.tag_name)）" }

  # 优先 compatible 版本（兼容性最好），否则取第一个
  $asset = $cands | Where-Object { $_.name -like '*compatible*' } | Select-Object -First 1
  if (-not $asset) { $asset = $cands | Select-Object -First 1 }

  $zip = Join-Path $env:TEMP ("mihomo-" + [Guid]::NewGuid().ToString('N') + '.zip')
  $expanded = Join-Path $env:TEMP ("mihomo-" + [Guid]::NewGuid().ToString('N'))
  try {
    Write-Step "下载 $($asset.name)"
    Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $zip -UseBasicParsing -Headers $headers
    Expand-Archive -LiteralPath $zip -DestinationPath $expanded -Force
    $exe = Get-ChildItem -LiteralPath $expanded -Filter '*.exe' -Recurse | Select-Object -First 1
    if (-not $exe) { throw '压缩包里没有 exe' }
    Copy-Item -LiteralPath $exe.FullName -Destination $script:Bin -Force
    Write-Ok "内核就绪：$script:Bin"
  } finally {
    Remove-Item -LiteralPath $zip -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $expanded -Recurse -Force -ErrorAction SilentlyContinue
  }
}

# ---------------------------------------------------------------------------
# 2. 取候选池
# ---------------------------------------------------------------------------
function Get-Pool {
  Write-Step "读取候选池：$script:PoolSource"
  if ($script:PoolSource -match '^https?://') {
    $raw = Invoke-RestMethod -Uri $script:PoolSource -UseBasicParsing -Headers @{ 'User-Agent' = 'proxy-fetcher-local' }
  } else {
    $p = $script:PoolSource
    if (-not [IO.Path]::IsPathRooted($p)) { $p = Join-Path (Get-Location).Path $p }
    if (-not (Test-Path -LiteralPath $p)) { throw "候选池文件不存在：$p" }
    $raw = Get-Content -LiteralPath $p -Raw -Encoding UTF8 | ConvertFrom-Json
  }
  if (-not $raw -or -not $raw.proxies) { throw '候选池格式不对（需要 { proxies: [...] }）' }
  $list = @($raw.proxies)
  if ($list.Count -eq 0) { throw '候选池是空的' }
  Write-Ok "池内节点：$($list.Count) 个"
  return $list
}

# ---------------------------------------------------------------------------
# 3. 起临时内核
# ---------------------------------------------------------------------------
function Get-FreePort {
  $l = New-Object System.Net.Sockets.TcpListener([System.Net.IPAddress]::Loopback, 0)
  $l.Start()
  $port = $l.LocalEndpoint.Port
  $l.Stop()
  return $port
}

function Start-ProbeCore($proxies, $workDir, $ctrlPort) {
  $cfgPath = Join-Path $workDir 'probe.json'

  # 节点名统一改成 p0..pN，避免重名 / 特殊字符导致内核拒绝
  $named = @()
  $map = @()
  for ($i = 0; $i -lt $proxies.Count; $i++) {
    $copy = @{}
    foreach ($prop in $proxies[$i].PSObject.Properties) { $copy[$prop.Name] = $prop.Value }
    $origName = [string]$copy['name']
    $copy['name'] = "p$i"
    $named += $copy
    $map += [pscustomobject]@{ Index = $i; Alias = "p$i"; Orig = $origName; Type = [string]$copy['type']; Server = [string]$copy['server']; Port = $copy['port'] }
  }

  $cfg = [ordered]@{
    'mixed-port'          = (Get-FreePort)
    'external-controller' = "127.0.0.1:$ctrlPort"
    'secret'              = ''
    'log-level'           = 'warning'
    'allow-lan'           = $false
    'ipv6'                = $false
    proxies               = $named
    'proxy-groups'        = @(
      [ordered]@{
        name      = 'probe'
        type      = 'url-test'
        url       = $TestUrl
        interval  = 3600
        tolerance = 0
        lazy      = $false
        proxies   = @($named | ForEach-Object { $_['name'] })
      }
    )
    rules                 = @('MATCH,DIRECT')
  }

  # 不要用 Set-Content -Encoding UTF8：PS 5.1 会加 BOM，mihomo 解析 JSON 时直接报错
  [IO.File]::WriteAllText($cfgPath, ($cfg | ConvertTo-Json -Depth 30), (New-Object System.Text.UTF8Encoding($false)))

  $errLog = Join-Path $workDir 'core.log'
  $outLog = Join-Path $workDir 'core.out'
  $proc = Start-Process -FilePath $script:Bin -ArgumentList @('-d', $workDir, '-f', $cfgPath) `
    -WindowStyle Hidden -PassThru -RedirectStandardError $errLog -RedirectStandardOutput $outLog

  $deadline = (Get-Date).AddSeconds(25)
  while ((Get-Date) -lt $deadline) {
    Start-Sleep -Milliseconds 400
    if ($proc.HasExited) {
      $tail = @(
        (Get-Content -LiteralPath $errLog -Raw -ErrorAction SilentlyContinue),
        (Get-Content -LiteralPath $outLog -Raw -ErrorAction SilentlyContinue)
      ) -join "`n"
      $tail = ($tail -split "`n" | Select-Object -Last 8) -join "`n"
      $script:LastCoreError = $tail
      throw "内核启动失败：`n$tail"
    }
    try {
      $null = Invoke-RestMethod -Uri "http://127.0.0.1:$ctrlPort/version" -TimeoutSec 2 -UseBasicParsing
      return @{ Proc = $proc; Map = $map; Port = $ctrlPort; WorkDir = $workDir }
    } catch { }
  }
  throw '内核 25 秒内没有就绪'
}

# ---------------------------------------------------------------------------
# 4. 并发探测
# ---------------------------------------------------------------------------
function Invoke-Probe($map, $ctrlPort) {
  # PS 5.1 里 System.Net.Http 默认没加载，必须先 Add-Type
  try { Add-Type -AssemblyName System.Net.Http -ErrorAction Stop } catch { }
  $encUrl = [Uri]::EscapeDataString($TestUrl)
  $handler = New-Object System.Net.Http.HttpClientHandler
  $client = New-Object System.Net.Http.HttpClient($handler)
  $client.Timeout = [TimeSpan]::FromSeconds([Math]::Max(10, [Math]::Ceiling($Timeout / 1000) + 8))

  $results = @{}
  $total = $map.Count
  $done = 0

  for ($i = 0; $i -lt $total; $i += $Concurrency) {
    $end = [Math]::Min($i + $Concurrency - 1, $total - 1)
    $slice = @($map[$i..$end])
    $tasks = New-Object 'System.Collections.Generic.List[System.Threading.Tasks.Task[string]]'
    foreach ($item in $slice) {
      $u = "http://127.0.0.1:$ctrlPort/proxies/$($item.Alias)/delay?url=$encUrl&timeout=$Timeout&expected=$ExpectedStatus"
      $tasks.Add($client.GetStringAsync($u))
    }
    try {
      [System.Threading.Tasks.Task]::WaitAll([System.Threading.Tasks.Task[]]$tasks.ToArray(), ($Timeout + 15000)) | Out-Null
    } catch {
      # 有节点失败会让 WaitAll 抛异常，下面逐个读状态
    }

    for ($k = 0; $k -lt $slice.Count; $k++) {
      $item = $slice[$k]
      $t = $tasks[$k]
      $delay = -1
      if ($t.Status -eq 'RanToCompletion') {
        try {
          $obj = $t.Result | ConvertFrom-Json
          if ($null -ne $obj.delay) { $delay = [int]$obj.delay }
        } catch { $delay = -1 }
      } else {
        # 让异常被观察，避免未观察任务异常
        try { $null = $t.Exception } catch { }
        try { $null = $t.Wait(100) } catch { }
      }
      $results[$item.Index] = $delay
    }

    $done += $slice.Count
    Write-Host ("`r    进度 {0}/{1}" -f $done, $total) -NoNewline
  }
  $client.Dispose()
  Write-Host ''
  return $results
}

# ---------------------------------------------------------------------------
# 5. 生成 YAML（不依赖任何 YAML 库）
# ---------------------------------------------------------------------------
$script:FlagByCode = @{
  HK = [char]::ConvertFromUtf32(0x1F1ED) + [char]::ConvertFromUtf32(0x1F1F0)
  TW = [char]::ConvertFromUtf32(0x1F1F9) + [char]::ConvertFromUtf32(0x1F1FC)
  JP = [char]::ConvertFromUtf32(0x1F1EF) + [char]::ConvertFromUtf32(0x1F1F5)
  SG = [char]::ConvertFromUtf32(0x1F1F8) + [char]::ConvertFromUtf32(0x1F1EC)
  US = [char]::ConvertFromUtf32(0x1F1FA) + [char]::ConvertFromUtf32(0x1F1F8)
  KR = [char]::ConvertFromUtf32(0x1F1F0) + [char]::ConvertFromUtf32(0x1F1F7)
  GB = [char]::ConvertFromUtf32(0x1F1EC) + [char]::ConvertFromUtf32(0x1F1E7)
  DE = [char]::ConvertFromUtf32(0x1F1E9) + [char]::ConvertFromUtf32(0x1F1EA)
  FR = [char]::ConvertFromUtf32(0x1F1EB) + [char]::ConvertFromUtf32(0x1F1F7)
  CA = [char]::ConvertFromUtf32(0x1F1E8) + [char]::ConvertFromUtf32(0x1F1E6)
  AU = [char]::ConvertFromUtf32(0x1F1E6) + [char]::ConvertFromUtf32(0x1F1FA)
  NL = [char]::ConvertFromUtf32(0x1F1F3) + [char]::ConvertFromUtf32(0x1F1F1)
  RU = [char]::ConvertFromUtf32(0x1F1F7) + [char]::ConvertFromUtf32(0x1F1FA)
  IN = [char]::ConvertFromUtf32(0x1F1EE) + [char]::ConvertFromUtf32(0x1F1F3)
  TR = [char]::ConvertFromUtf32(0x1F1F9) + [char]::ConvertFromUtf32(0x1F1F7)
  VN = [char]::ConvertFromUtf32(0x1F1FB) + [char]::ConvertFromUtf32(0x1F1F3)
  TH = [char]::ConvertFromUtf32(0x1F1F9) + [char]::ConvertFromUtf32(0x1F1ED)
  MY = [char]::ConvertFromUtf32(0x1F1F2) + [char]::ConvertFromUtf32(0x1F1FE)
  PH = [char]::ConvertFromUtf32(0x1F1F5) + [char]::ConvertFromUtf32(0x1F1ED)
  ID = [char]::ConvertFromUtf32(0x1F1EE) + [char]::ConvertFromUtf32(0x1F1E9)
  BR = [char]::ConvertFromUtf32(0x1F1E7) + [char]::ConvertFromUtf32(0x1F1F7)
}

function Format-YamlScalar($v) {
  if ($null -eq $v) { return 'null' }
  if ($v -is [bool]) { if ($v) { return 'true' } else { return 'false' } }
  if ($v -is [int] -or $v -is [long] -or $v -is [double] -or $v -is [decimal] -or $v -is [single]) {
    return $v.ToString([Globalization.CultureInfo]::InvariantCulture)
  }
  $s = [string]$v
  if ($s -eq '') { return '""' }
  $need = $false
  if ($s -match '[:#\[\]\{\},&*!\|>''"%@`]') { $need = $true }
  if ($s -match '^\s' -or $s -match '\s$') { $need = $true }
  if ($s -match '^(?i)(true|false|null|yes|no|on|off|~)$') { $need = $true }
  if ($s -match '^[-+]?[0-9.]+([eE][-+]?[0-9]+)?$') { $need = $true }
  if ($s.Contains('\')) { $need = $true }
  if (-not $need) { return $s }
  return '"' + $s.Replace('\', '\\').Replace('"', '\"') + '"'
}

function Write-YamlNode($node, [int]$indent, [System.Collections.ArrayList]$sb) {
  $pad = ' ' * $indent
  if ($node -is [System.Collections.IDictionary]) {
    foreach ($key in $node.Keys) {
      $val = $node[$key]
      if ($null -eq $val) {
        [void]$sb.Add("$pad${key}: null")
      } elseif ($val -is [System.Collections.IDictionary]) {
        [void]$sb.Add("$pad${key}:")
        Write-YamlNode $val ($indent + 2) $sb
      } elseif (($val -is [System.Collections.IEnumerable]) -and -not ($val -is [string])) {
        if (@($val).Count -eq 0) {
          [void]$sb.Add("$pad${key}: []")
        } else {
          [void]$sb.Add("$pad${key}:")
          Write-YamlNode $val ($indent + 2) $sb
        }
      } else {
        [void]$sb.Add("$pad${key}: " + (Format-YamlScalar $val))
      }
    }
    return
  }

  if (($node -is [System.Collections.IEnumerable]) -and -not ($node -is [string])) {
    foreach ($item in $node) {
      if ($item -is [System.Collections.IDictionary]) {
        $first = $true
        foreach ($key in $item.Keys) {
          $val = $item[$key]
          if ($first) { $linePad = "$pad- "; $childPad = $indent + 2 } else { $linePad = (' ' * ($indent + 2)); $childPad = $indent + 4 }
          if ($val -is [System.Collections.IDictionary]) {
            [void]$sb.Add("${linePad}${key}:")
            Write-YamlNode $val ($childPad) $sb
          } elseif ((($val -is [System.Collections.IEnumerable]) -and -not ($val -is [string]))) {
            [void]$sb.Add("${linePad}${key}:")
            Write-YamlNode $val ($childPad) $sb
          } else {
            [void]$sb.Add("${linePad}${key}: " + (Format-YamlScalar $val))
          }
          $first = $false
        }
        if ($first) { [void]$sb.Add("$pad- {}") }
      } else {
        [void]$sb.Add("$pad- " + (Format-YamlScalar $item))
      }
    }
  }
}

function ConvertTo-PlainData($value) {
  # ConvertFrom-Json 出来的是 PSCustomObject，直接序列化会被当成字符串（reality-opts 就是坑），
  # 先统一转成 OrderedDictionary / 数组。
  if ($null -eq $value) { return $null }
  if ($value -is [string] -or $value -is [bool] -or
    $value -is [int] -or $value -is [long] -or $value -is [double] -or
    $value -is [decimal] -or $value -is [single]) { return $value }

  if ($value -is [System.Collections.IDictionary]) {
    $map = [ordered]@{}
    foreach ($key in $value.Keys) { $map[$key] = ConvertTo-PlainData $value[$key] }
    return $map
  }

  if (($value -is [System.Collections.IEnumerable]) -and -not ($value -is [string])) {
    $items = @()
    foreach ($element in $value) { $items += , (ConvertTo-PlainData $element) }
    return , $items
  }

  $obj = [ordered]@{}
  foreach ($prop in $value.PSObject.Properties) { $obj[$prop.Name] = ConvertTo-PlainData $prop.Value }
  return $obj
}

function ConvertTo-YamlText($obj) {
  $plain = ConvertTo-PlainData $obj
  $sb = New-Object System.Collections.ArrayList
  Write-YamlNode $plain 0 $sb
  return ($sb -join "`n")
}

# ---------------------------------------------------------------------------
# 6. 主流程
# ---------------------------------------------------------------------------
$started = Get-Date
Write-Host ''
Write-Host '=== proxy-fetcher 本机测速 ===' -ForegroundColor White
Write-Host ''

# 工作目录放在 tools\.work 而不是 %TEMP%：个别机器上内核在 %TEMP% 里写 geo 数据会被拒
$workRoot = Join-Path $script:Root '.work'
$workDir = Join-Path $workRoot ("probe-" + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $workDir | Out-Null
Import-GeoCache $workDir
$core = $null

try {
  Install-Mihomo
  $nodes = Get-Pool

  # 明文代理（socks5/bash 转发类）在 mihomo 里就是一行密码，任何人不经认证就能用；
  # 除非你明确要，否则不进产物。
  $plainTypes = @('socks5', 'http')
  if (-not $AllowPlaintext) {
    $before = $nodes.Count
    $nodes = @($nodes | Where-Object {
      $tp = $_.PSObject.Properties['type']
      -not ($tp -and ($plainTypes -contains ([string]$tp.Value)))
    })
    if ($nodes.Count -ne $before) {
      Write-Warn2 "跳过 $($before - $nodes.Count) 个明文代理（socks5/http），需要请加 -AllowPlaintext"
    }
  }
  if ($nodes.Count -eq 0) { throw '过滤后没有可探测的节点' }

  $ctrlPort = Get-FreePort
  Write-Step "启动临时内核（控制端口 $ctrlPort）…"
  $core = Start-ProbeCore -proxies $nodes -workDir $workDir -ctrlPort $ctrlPort
  Write-Ok "内核就绪"

  Write-Step "本机并发探测（并发 $Concurrency，超时 ${Timeout}ms，目标 $TestUrl）…"
  $delays = Invoke-Probe -map $core.Map -ctrlPort $ctrlPort

  # 探测结束就先关掉内核：后面 mihomo -t 校验要读同一个目录里的 geo 数据，内核不退出会锁文件
  if ($core -and $core.Proc -and -not $core.Proc.HasExited) {
    try { Stop-Process -Id $core.Proc.Id -Force -ErrorAction SilentlyContinue } catch { }
    Start-Sleep -Milliseconds 400
  }

  # 汇总
  $ok = @()
  foreach ($item in $core.Map) {
    $d = $delays[$item.Index]
    if ($null -eq $d) { $d = -1 }
    if ($d -gt 0) {
      if ($MaxDelay -le 0 -or $d -le $MaxDelay) {
        $ok += [pscustomobject]@{ Delay = $d; Map = $item }
      }
    }
  }
  $ok = @($ok | Sort-Object Delay)
  if ($Top -gt 0 -and $ok.Count -gt $Top) { $ok = @($ok[0..($Top - 1)]) }

  Write-Host ''
  $passCount = @($core.Map | Where-Object { $delays[$_.Index] -gt 0 }).Count
  Write-Ok ("探测结果：$($core.Map.Count) 个节点，能连 $passCount 个，符合阈值 $($ok.Count) 个")
  if ($passCount -gt 0 -and $ok.Count -eq 0) {
    Write-Warn2 "能连但都超过 MaxDelay=$MaxDelay ms，建议加大阈值（如 -MaxDelay 3000）"
  }
  if ($ok.Count -eq 0) { throw '没有任何节点可用，检查网络或换候选池' }

  # 重命名 + 组装配置
  $counter = @{}
  $finalProxies = @()
  $rows = @()
  foreach ($entry in $ok) {
    $m = $entry.Map
    $region = 'XX'
    $mm = [regex]::Match($m.Orig, '([A-Z]{2})-\d+')
    if ($mm.Success) { $region = $mm.Groups[1].Value }
    $n = 0
    if ($counter.ContainsKey($region)) { $n = $counter[$region] } else { $counter[$region] = 0 }
    $n = $n + 1
    $counter[$region] = $n
    $flag = ''
    if ($script:FlagByCode.ContainsKey($region)) { $flag = $script:FlagByCode[$region] }
    $newName = ('{0}{1}-{2}·{3}ms' -f $flag, $region, $n.ToString('000'), $entry.Delay)

    # 字段顺序：name/type 放前面，其余按字母排，产出的 YAML 才好读、好 diff
    $src = $nodes[$m.Index]
    $obj = [ordered]@{}
    $obj['name'] = $newName
    foreach ($prop in ($src.PSObject.Properties | Where-Object { $_.Name -eq 'type' })) { $obj[$prop.Name] = $prop.Value }
    foreach ($prop in ($src.PSObject.Properties | Where-Object { $_.Name -notin @('name', 'type') } | Sort-Object Name)) { $obj[$prop.Name] = $prop.Value }
    $finalProxies += $obj
    $rows += [pscustomobject]@{ Delay = $entry.Delay; Name = $newName; Type = $m.Type; Server = "$($m.Server):$($m.Port)" }
  }

  $names = @($finalProxies | ForEach-Object { $_['name'] })
  $autoGroup = [ordered]@{
    name            = '自动选择'
    type            = 'url-test'
    url             = $TestUrl
    interval        = 300
    tolerance       = 100
    lazy            = $false
    'expected-status' = $ExpectedStatus
    proxies         = $names
  }
  $selectGroup = [ordered]@{
    name    = '节点选择'
    type    = 'select'
    proxies = @(@('自动选择') + $names)
  }

  $doc = [ordered]@{
    'mixed-port'      = 7890
    'allow-lan'       = $false
    mode              = 'rule'
    'log-level'       = 'info'
    ipv6              = $false
    'unified-delay'   = $true
    'tcp-concurrent'  = $true
    profile           = [ordered]@{ 'store-selected' = $true; 'store-fake-ip' = $true }
    dns               = [ordered]@{
      enable          = $true
      ipv6            = $false
      'enhanced-mode' = 'fake-ip'
      'fake-ip-range' = '198.18.0.1/16'
      'fake-ip-filter' = @('*.lan', '*.local', 'localhost.ptlogin2.qq.com')
      'default-nameserver' = @('223.5.5.5', '119.29.29.29')
      nameserver      = @('https://223.5.5.5/dns-query', 'https://1.12.12.12/dns-query')
      fallback        = @('https://8.8.8.8/dns-query', 'https://1.1.1.1/dns-query')
    }
    proxies           = $finalProxies
    'proxy-groups'    = @($selectGroup, $autoGroup)
    rules             = @('GEOIP,CN,DIRECT,no-resolve', 'MATCH,节点选择')
  }

  $outDir = $Out
  if (-not [IO.Path]::IsPathRooted($outDir)) { $outDir = Join-Path (Get-Location).Path $outDir }
  $outDir = [IO.Path]::GetFullPath($outDir).TrimEnd('\')
  New-Item -ItemType Directory -Force -Path $outDir | Out-Null
  $outFile = Join-Path $outDir 'nodes.yaml'

  $header = @(
    "# generated by local-probe.ps1 at $(Get-Date -Format 'yyyy-MM-ddTHH:mm:sszzz')",
    "# nodes: $($finalProxies.Count) · 由本机网络实测 · probe: $TestUrl (expect $ExpectedStatus)"
  ) -join "`n"
  $text = $header + "`n" + (ConvertTo-YamlText $doc) + "`n"
  [IO.File]::WriteAllText($outFile, $text, (New-Object System.Text.UTF8Encoding($false)))

  # 用内核校验生成的配置，避免发出一个自己都读不了的 YAML
  Write-Step '校验生成的配置…'
  $verifyErr = Join-Path $workDir 'verify.log'
  $verifyOut = Join-Path $workDir 'verify.out'
  $verify = Start-Process -FilePath $script:Bin -ArgumentList @('-t', '-d', $workDir, '-f', $outFile) `
    -WindowStyle Hidden -PassThru -Wait -RedirectStandardError $verifyErr -RedirectStandardOutput $verifyOut
  if ($verify.ExitCode -ne 0) {
    $tail = @(
      (Get-Content -LiteralPath $verifyErr -Raw -ErrorAction SilentlyContinue),
      (Get-Content -LiteralPath $verifyOut -Raw -ErrorAction SilentlyContinue)
    ) -join "`n"
    $tail = ($tail -split "`n" | Where-Object { $_.Trim() } | Select-Object -Last 6) -join "`n"
    throw "生成的配置没通过内核校验：`n$tail"
  }
  Write-Ok '配置校验通过'
  Save-GeoCache $workDir

  # 报告
  $reportPath = Join-Path $outDir 'report.txt'
  $lines = @(
    "本机测速报告  $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')",
    "探测目标: $TestUrl  |  超时: ${Timeout}ms  |  延迟阈值: ${MaxDelay}ms",
    "池内 $($core.Map.Count) 个，能连 $passCount 个，保留 $($finalProxies.Count) 个",
    '',
    ('{0,-8} {1,-26} {2,-10} {3}' -f '延迟', '名称', '类型', '服务器')
  )
  foreach ($r in $rows) {
    $lines += ('{0,-8} {1,-26} {2,-10} {3}' -f ("$($r.Delay)ms"), $r.Name, $r.Type, $r.Server)
  }
  [IO.File]::WriteAllLines($reportPath, $lines, (New-Object System.Text.UTF8Encoding($false)))

  Write-Host ''
  Write-Host ('{0,-8} {1,-26} {2,-10} {3}' -f '延迟', '名称', '类型', '服务器') -ForegroundColor DarkGray
  foreach ($r in ($rows | Select-Object -First 15)) {
    Write-Host ('{0,-8} {1,-26} {2,-10} {3}' -f ("$($r.Delay)ms"), $r.Name, $r.Type, $r.Server)
  }
  if ($rows.Count -gt 15) { Write-Host "  … 其余 $($rows.Count - 15) 个见报告" -ForegroundColor DarkGray }

  Write-Host ''
  Write-Ok "配置已生成：$outFile"
  Write-Ok "报告已生成：$reportPath"
  Write-Host ''
  Write-Host ' 客户端里「配置 → 导入本地文件」选这个 nodes.yaml 即可。' -ForegroundColor Gray
  Write-Host " 耗时 $([Math]::Round(((Get-Date) - $started).TotalSeconds, 1)) 秒。" -ForegroundColor DarkGray
} catch {
  Write-Host ''
  Write-Err2 $_.Exception.Message
  if ($_.ScriptStackTrace) { Write-Host $_.ScriptStackTrace -ForegroundColor DarkGray }
  if (Test-Path -LiteralPath $workDir) {
    Write-Host " 排查用的临时目录已保留：$workDir" -ForegroundColor DarkGray
    $script:KeepWork = $true
  }
  exit 1
} finally {
  if ($core -and $core.Proc -and -not $core.Proc.HasExited) {
    try { Stop-Process -Id $core.Proc.Id -Force -ErrorAction SilentlyContinue } catch { }
  }
  if (-not $script:KeepWork) {
    Start-Sleep -Milliseconds 200
    Remove-Item -LiteralPath $workDir -Recurse -Force -ErrorAction SilentlyContinue
  }
}
