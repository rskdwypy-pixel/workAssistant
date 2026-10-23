#
# 禅道助手 · Windows 一条命令安装 / 升级 / 卸载
#
#   安装 / 升级（在 PowerShell 里粘贴运行）：
#     curl.exe -fsSL -o "$env:TEMP\wa-install.ps1" https://gitee.com/iTreeNewBee/work-assistant/raw/main/installer/install.ps1; powershell -NoProfile -ExecutionPolicy Bypass -File "$env:TEMP\wa-install.ps1"
#   （Gitee 连不上时，把上面地址换成 https://github.com/rskdwypy-pixel/workAssistant/... 即可）
#   卸载：在上面命令末尾加 -Uninstall（保留数据），或 -Uninstall -Purge（连数据一起删）
#
# 不问任何问题，不需要管理员权限：禅道账号在插件的登录卡片里填，AI 在设置里配（或在插件里导入加密配置文件）。
#
# 安装后的目录（与程序分开存放数据，更新和回滚不碰数据）：
#   %LOCALAPPDATA%\WorkAssistant\
#     runtime\node\        自带的 Node（不需要另装 Node）
#     versions\<版本>\     程序（保留上一个版本，用于回滚）
#     current.txt          当前版本
#     extension\           浏览器加载的扩展（位置固定，更新时替换里面的文件）
#     bin\                 固定入口：workassistant.vbs（隐藏窗口启动守护进程）、supervisor.cjs（守护进程）、
#                          native-host.cmd（浏览器拉起后台）
#     data\                配置（.env）、任务、报告、附件
#     logs\backend.log     后台日志
#
# 开机自启：当前用户的启动项（HKCU\...\Run\WorkAssistant）；浏览器宿主：Chrome / Edge / Brave / Chromium / Vivaldi
#
# 参数（一般用不到）：
#   -Package <文件或地址>   使用指定的安装包（默认下载 GitHub 上的最新版本）；内网 / GitHub 连不上时，
#                           先在能联网的机器上拿到 workassistant.tar.gz（+ .sha256），拷到本机后用它离线安装
#   -NodeZip <文件>         使用本地的 Node 压缩包（node-v<版本>-win-x64.zip），彻底离线时用；
#                           不填则按默认从 nodejs.org / 国内镜像下载
#   -NoService              只安装文件，不注册开机自启 / 宿主程序、不启动服务（测试用）
#   -MigrateFrom <目录>     从旧的仓库目录迁移配置和数据（.env 与 data\）
#   -Uninstall [-Purge]     卸载（-Purge 连数据一起删）
#
# 内网 / 连不上 GitHub 时的离线安装（三样文件拷到本机同一目录）：
#   install.ps1、workassistant.tar.gz、workassistant.tar.gz.sha256
#   powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1 -Package .\workassistant.tar.gz
#   若连 Node 镜像也下不动，再加 -NodeZip .\node-v22.20.0-win-x64.zip
#
# 注意：本文件必须保存为 UTF-8 带 BOM、CRLF 换行，Windows PowerShell 5.1 才能正确读取中文。
#
param(
  [string]$Package = '',
  [string]$NodeZip = '',
  [switch]$NoService,
  [string]$MigrateFrom = '',
  [switch]$Uninstall,
  [switch]$Purge
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

# 从 PowerShell 7 里运行时，Windows PowerShell 5.1 会继承 7 的模块路径，Get-CimInstance、ConvertTo-Json
# 等自带命令就加载不上（"is not recognized"）。恢复成 5.1 自己的模块路径。
if ($PSVersionTable.PSEdition -ne 'Core') {
  $machinePaths = [Environment]::GetEnvironmentVariable('PSModulePath', 'Machine')
  $env:PSModulePath = (@((Join-Path $PSHOME 'Modules'), $machinePaths) | Where-Object { $_ }) -join ';'
}

# 发布源：默认先 Gitee（国内 / 内网更稳），连不上再回退 GitHub
$ReleaseBases = @(
  'https://gitee.com/iTreeNewBee/work-assistant/releases/latest/download',
  'https://github.com/rskdwypy-pixel/workAssistant/releases/latest/download'
)
$NodeVersion = '22.20.0'
$AppName = 'WorkAssistant'
$HostName = 'com.workassistant.backend'
$Port = 3721
if ($env:WORKASSISTANT_PORT) { $Port = [int]$env:WORKASSISTANT_PORT }
if ($env:WA_HOME) { $WaHome = $env:WA_HOME } else { $WaHome = Join-Path $env:LOCALAPPDATA 'WorkAssistant' }
$RunKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
$BrowserKeys = @(
  'HKCU:\Software\Google\Chrome\NativeMessagingHosts',
  'HKCU:\Software\Microsoft\Edge\NativeMessagingHosts',
  'HKCU:\Software\BraveSoftware\Brave-Browser\NativeMessagingHosts',
  'HKCU:\Software\Chromium\NativeMessagingHosts',
  'HKCU:\Software\Vivaldi\NativeMessagingHosts'
)

function Step($msg) { Write-Host ''; Write-Host "> $msg" -ForegroundColor White }
function Ok($msg) { Write-Host "  [OK] $msg" -ForegroundColor Green }
function Warn($msg) { Write-Host "  [!] $msg" -ForegroundColor Yellow }
function Die($msg) {
  Write-Host ''
  Write-Host "[X] $msg" -ForegroundColor Red
  exit 1
}

# 文本文件一律写 UTF-8 无 BOM：current.txt 等由 Node 读取，带 BOM 会把版本号读错；浏览器也不认带 BOM 的宿主清单
function Write-Text($file, $text) {
  [IO.File]::WriteAllText($file, $text, (New-Object Text.UTF8Encoding $false))
}
function Read-Text($file) {
  if (Test-Path -LiteralPath $file) { return ([IO.File]::ReadAllText($file)).Trim() }
  return ''
}

# 下载用系统自带的 curl.exe（Windows 10 1803 起都有；走代理设置，与自动更新一致）
# Gitee 不支持 .../releases/latest/download/<文件>（404），但 .../releases/latest 会跳到 .../releases/tag/vX.Y.Z，
# .../releases/download/vX.Y.Z/<文件> 能下载（GitHub 两种都行）：先解析出具体版本再下载
function Resolve-ReleaseBase($b) {
  if ($b -match '^(.*/releases)/latest/download$') {
    $root = $Matches[1]
    # 只看第一跳的 Location（跟到底的话 Gitee 会落到源码压缩包）
    $head = (& curl.exe -sI --connect-timeout 10 --max-time 25 "$root/latest" 2>$null) -join "`n"
    if ($head -match '(?im)^location:\s*\S*/releases/tag/(v\d[\d.]*)\s*$') { return "$root/download/$($Matches[1])" }
  }
  return $b
}

function Download($url, $out) {
  & curl.exe -fL --retry 3 --retry-delay 2 --connect-timeout 15 --progress-bar -o $out $url
  return ($LASTEXITCODE -eq 0)
}

# Windows 自带的 tar.exe 打不开含中文的路径（用户名是中文时临时目录就含中文）：
# 在目标目录里运行，只传 ASCII 的相对文件名
function Expand-Tar($dir, $archive, $into, $flags) {
  Push-Location -LiteralPath $dir
  try {
    & tar.exe $flags $archive -C $into
    return ($LASTEXITCODE -eq 0)
  } finally { Pop-Location }
}

function Get-Sha256($file) {
  $sha = [Security.Cryptography.SHA256]::Create()
  $stream = [IO.File]::OpenRead($file)
  try { return (($sha.ComputeHash($stream) | ForEach-Object { $_.ToString('x2') }) -join '') }
  finally { $stream.Dispose(); $sha.Dispose() }
}

function Backend-Version {
  $out = & curl.exe -s -m 2 --noproxy '*' "http://127.0.0.1:$Port/health" 2>$null
  if ($LASTEXITCODE -ne 0 -or -not $out) { return '' }
  try {
    $j = ($out -join '') | ConvertFrom-Json
    if ($j.app -eq 'workassistant') { return [string]$j.version }
  } catch { }
  return ''
}

function Port-Owner {
  try {
    $c = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction Stop | Select-Object -First 1
    if ($c) { return [int]$c.OwningProcess }
  } catch { }
  return 0
}

# 停掉本安装目录里运行的守护进程和后台（node.exe 位于 WorkAssistant\runtime 下）
function Stop-Installed {
  $runtime = (Join-Path $WaHome 'runtime').ToLower()
  $procs = Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.ExecutablePath -and $_.ExecutablePath.ToLower().StartsWith($runtime) }
  # 先停守护进程（否则它会把后台重新拉起来），再停后台
  $sup = @($procs | Where-Object { $_.CommandLine -like '*supervisor.cjs*' })
  $rest = @($procs | Where-Object { $_.CommandLine -notlike '*supervisor.cjs*' })
  foreach ($p in ($sup + $rest)) {
    try { Stop-Process -Id $p.ProcessId -Force -ErrorAction Stop } catch { }
  }
  for ($i = 0; $i -lt 40; $i++) {
    if ((Port-Owner) -eq 0) { break }
    Start-Sleep -Milliseconds 250
  }
  Remove-Item -LiteralPath (Join-Path $WaHome 'supervisor.pid') -Force -ErrorAction SilentlyContinue
}

function Show-Diagnose {
  Write-Host ''
  Write-Host '---------------- 排查信息 ----------------'
  $owner = Port-Owner
  if ($owner) {
    $p = Get-CimInstance Win32_Process -Filter "ProcessId=$owner" -ErrorAction SilentlyContinue
    Write-Host "端口 ${Port}：PID $owner  $($p.CommandLine)"
  } else {
    Write-Host "端口 ${Port}：没有程序在监听"
  }
  $log = Join-Path $WaHome 'logs\backend.log'
  if (Test-Path -LiteralPath $log) {
    Write-Host "日志末尾（$log）："
    Get-Content -LiteralPath $log -Tail 15 -Encoding UTF8 | ForEach-Object { Write-Host "  $_" }
  }
  Write-Host '------------------------------------------'
}

if ([Environment]::OSVersion.Platform -ne 'Win32NT') { Die '这个安装脚本只支持 Windows（Mac 请用 install.sh）' }
if (-not (Get-Command curl.exe -ErrorAction SilentlyContinue) -or -not (Get-Command tar.exe -ErrorAction SilentlyContinue)) {
  Die '需要 Windows 10 1803 或更高版本（系统自带 curl.exe 和 tar.exe）'
}

$Tmp = Join-Path ([IO.Path]::GetTempPath()) ("wa-install-" + [Guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Path $Tmp -Force | Out-Null

try {

# ==================== 卸载 ====================
if ($Uninstall) {
  Step '卸载禅道助手'
  Stop-Installed
  Remove-ItemProperty -Path $RunKey -Name $AppName -ErrorAction SilentlyContinue
  Ok '已移除开机自启'
  foreach ($k in $BrowserKeys) { Remove-Item -Path "$k\$HostName" -Force -ErrorAction SilentlyContinue }
  Ok '已移除浏览器宿主注册'
  if ($Purge) {
    Remove-Item -LiteralPath $WaHome -Recurse -Force -ErrorAction SilentlyContinue
    Ok "已删除 $WaHome（含数据）"
  } else {
    foreach ($n in @('runtime', 'versions', 'bin', 'extension', 'downloads', 'current.txt', 'previous.txt', 'update-pending', 'update-bad.txt', 'supervisor.pid')) {
      Remove-Item -LiteralPath (Join-Path $WaHome $n) -Recurse -Force -ErrorAction SilentlyContinue
    }
    Ok "程序已删除；数据和配置保留在 $WaHome\data（重新安装后自动使用）"
  }
  Write-Host ''
  Write-Host '  别忘了在浏览器扩展页移除「禅道助手」扩展。'
  exit 0
}

foreach ($d in @('runtime', 'versions', 'bin', 'data', 'backups', 'logs')) {
  New-Item -ItemType Directory -Path (Join-Path $WaHome $d) -Force | Out-Null
}

# 替换文件前先停掉正在运行的旧版本（Windows 上运行中的 node.exe 不能被覆盖）
if (-not $NoService) { Stop-Installed }

# ==================== 1. Node 运行环境 ====================
Step "准备 Node 运行环境（v$NodeVersion）"
$Arch = 'x64'
if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64' -or $env:PROCESSOR_ARCHITEW6432 -eq 'ARM64') { $Arch = 'arm64' }
$NodeDir = Join-Path $WaHome 'runtime\node'
$Node = Join-Path $NodeDir 'node.exe'
$haveNode = $false
if (Test-Path -LiteralPath $Node) {
  $v = & $Node -v 2>$null
  if ($v -eq "v$NodeVersion") { $haveNode = $true }
}
if ($haveNode) {
  Ok "已就绪（$Arch）"
} elseif ($NodeZip) {
  # 彻底离线：用本地提供的 Node 压缩包（信任本地文件，不再校验远端 SHASUMS）
  if (-not (Test-Path -LiteralPath $NodeZip)) { Die "找不到指定的 Node 压缩包：$NodeZip" }
  $zipName = "node-v$NodeVersion-win-$Arch.zip"
  $zip = Join-Path $Tmp $zipName
  Copy-Item -LiteralPath (Resolve-Path -LiteralPath $NodeZip).Path -Destination $zip -Force
  $unzip = Join-Path $Tmp 'node'
  New-Item -ItemType Directory -Path $unzip -Force | Out-Null
  if (-not (Expand-Tar $Tmp $zipName 'node' '-xf')) { Expand-Archive -LiteralPath $zip -DestinationPath $unzip -Force }
  $extracted = Join-Path $unzip "node-v$NodeVersion-win-$Arch"
  if (-not (Test-Path -LiteralPath (Join-Path $extracted 'node.exe'))) { Die "本地 Node 压缩包不是 node-v$NodeVersion-win-$Arch（解压后没找到 node.exe）" }
  if (Test-Path -LiteralPath $NodeDir) { Remove-Item -LiteralPath $NodeDir -Recurse -Force }
  Move-Item -LiteralPath $extracted -Destination $NodeDir
  Ok "已安装（$Arch，来自本地文件）"
} else {
  $zipName = "node-v$NodeVersion-win-$Arch.zip"
  $got = $false
  # 官方源优先，连不上时用国内镜像；两边都用官方发布的 SHASUMS256 校验
  foreach ($base in @('https://nodejs.org/dist', 'https://npmmirror.com/mirrors/node')) {
    Write-Host "  下载 $base/v$NodeVersion/$zipName"
    $zip = Join-Path $Tmp $zipName
    $sums = Join-Path $Tmp 'SHASUMS256.txt'
    if ((Download "$base/v$NodeVersion/$zipName" $zip) -and (Download "$base/v$NodeVersion/SHASUMS256.txt" $sums)) {
      $line = Get-Content -LiteralPath $sums | Where-Object { $_ -match "  $([regex]::Escape($zipName))$" } | Select-Object -First 1
      $expect = ''
      if ($line) { $expect = ($line -split '\s+')[0].ToLower() }
      if ($expect -and $expect -eq (Get-Sha256 $zip)) { $got = $true; break }
      Warn '校验不通过，换一个下载源'
    }
  }
  if (-not $got) { Die 'Node 运行环境下载失败（请检查网络后重试）' }
  $unzip = Join-Path $Tmp 'node'
  New-Item -ItemType Directory -Path $unzip -Force | Out-Null
  if (-not (Expand-Tar $Tmp $zipName 'node' '-xf')) { Expand-Archive -LiteralPath $zip -DestinationPath $unzip -Force }
  $extracted = Join-Path $unzip "node-v$NodeVersion-win-$Arch"
  if (-not (Test-Path -LiteralPath (Join-Path $extracted 'node.exe'))) { Die 'Node 运行环境解压失败' }
  if (Test-Path -LiteralPath $NodeDir) { Remove-Item -LiteralPath $NodeDir -Recurse -Force }
  Move-Item -LiteralPath $extracted -Destination $NodeDir
  Ok "已安装（$Arch，已校验）"
}

# ==================== 2. 程序 ====================
Step '安装禅道助手'
$pkgSha = ''
if ($Package -and (Test-Path -LiteralPath $Package)) {
  # 指定了本地安装包
  $pkgFile = (Resolve-Path -LiteralPath $Package).Path
  if (Test-Path -LiteralPath "$pkgFile.sha256") { $pkgSha = ((Read-Text "$pkgFile.sha256") -split '\s+')[0].ToLower() }
} elseif ($Package) {
  # 指定了下载地址
  $pkgFile = Join-Path $Tmp 'workassistant.tar.gz'
  Write-Host "  下载 $Package"
  if (-not (Download $Package $pkgFile)) { Die '安装包下载失败（请检查网络后重试）' }
  if (-not (Download "$Package.sha256" "$pkgFile.sha256")) { Die '安装包校验文件下载失败' }
  $pkgSha = ((Read-Text "$pkgFile.sha256") -split '\s+')[0].ToLower()
} else {
  # 默认：Gitee 优先，连不上回退 GitHub
  $pkgFile = Join-Path $Tmp 'workassistant.tar.gz'
  $got = $false
  foreach ($b in $ReleaseBases) {
    $srcHost = ($b -split '/')[2]
    $b = Resolve-ReleaseBase $b
    Write-Host "  下载安装包（$srcHost）"
    if ((Download "$b/workassistant.tar.gz" $pkgFile) -and (Download "$b/workassistant.tar.gz.sha256" "$pkgFile.sha256")) {
      $pkgSha = ((Read-Text "$pkgFile.sha256") -split '\s+')[0].ToLower()
      $got = $true; break
    }
    Warn "$srcHost 下载失败，换下一个源"
  }
  if (-not $got) { Die '安装包下载失败（Gitee 和 GitHub 都连不上，请检查网络或用 -Package 指定本地包）' }
}
if ($pkgSha) {
  if ((Get-Sha256 $pkgFile) -ne $pkgSha) { Die '安装包校验不通过（文件不完整或被改动）' }
  Ok '安装包已校验'
}
$pkgRoot = Join-Path $Tmp 'pkg'
New-Item -ItemType Directory -Path $pkgRoot -Force | Out-Null
$pkgLocal = Join-Path $Tmp 'workassistant.tar.gz'
if ($pkgFile -ne $pkgLocal) { Copy-Item -LiteralPath $pkgFile -Destination $pkgLocal -Force }
if (-not (Expand-Tar $Tmp 'workassistant.tar.gz' 'pkg' '-xzf')) { Die '安装包解压失败' }
$pkgDir = Get-ChildItem -LiteralPath $pkgRoot -Directory | Select-Object -First 1
if (-not $pkgDir -or -not (Test-Path -LiteralPath (Join-Path $pkgDir.FullName '.wa-package'))) { Die '不是禅道助手的安装包' }
$info = (Read-Text (Join-Path $pkgDir.FullName '.wa-package')) | ConvertFrom-Json
$Version = [string]$info.version
$Previous = Read-Text (Join-Path $WaHome 'current.txt')

$verDir = Join-Path $WaHome "versions\$Version"
if (Test-Path -LiteralPath $verDir) { Remove-Item -LiteralPath $verDir -Recurse -Force }
Move-Item -LiteralPath $pkgDir.FullName -Destination $verDir
Write-Text (Join-Path $WaHome 'current.txt') "$Version`n"
if ($Previous -and $Previous -ne $Version) { Write-Text (Join-Path $WaHome 'previous.txt') "$Previous`n" }
# 只保留当前和上一个版本
$keepPrev = Read-Text (Join-Path $WaHome 'previous.txt')
Get-ChildItem -LiteralPath (Join-Path $WaHome 'versions') -Directory | ForEach-Object {
  if ($_.Name -ne $Version -and $_.Name -ne $keepPrev) { Remove-Item -LiteralPath $_.FullName -Recurse -Force }
}
if ($Previous -and $Previous -ne $Version) { Ok "版本 $Version（上一个版本 $Previous 保留，可回滚）" }
elseif ($Previous -eq $Version) { Ok "版本 $Version（重新安装）" }
else { Ok "版本 $Version" }

# 扩展放在固定位置：更新时替换里面的文件，浏览器里不用重新加载另一个目录
$extDir = Join-Path $WaHome 'extension'
if (Test-Path -LiteralPath $extDir) { Remove-Item -LiteralPath $extDir -Recurse -Force }
Copy-Item -LiteralPath (Join-Path $verDir 'extension') -Destination $extDir -Recurse
Ok "扩展文件：$extDir"

# 固定入口：切换版本只改 current.txt，开机自启和浏览器宿主注册都不用改（自动更新时同样会刷新）
foreach ($f in @('workassistant.vbs', 'supervisor.cjs', 'native-host.cmd', 'native-host.cjs')) {
  Copy-Item -LiteralPath (Join-Path $verDir "scripts\bin\$f") -Destination (Join-Path $WaHome "bin\$f") -Force
}
Remove-Item -LiteralPath (Join-Path $WaHome 'update-pending') -Force -ErrorAction SilentlyContinue

# ==================== 3. 数据与配置 ====================
Step '数据与配置'
$dataDir = Join-Path $WaHome 'data'
if ((Test-Path -LiteralPath (Join-Path $dataDir '.env')) -or (Test-Path -LiteralPath (Join-Path $dataDir 'tasks.json'))) {
  Ok "沿用已有数据：$dataDir"
} elseif ($MigrateFrom) {
  if (-not (Test-Path -LiteralPath $MigrateFrom)) { Die "找不到要迁移的目录：$MigrateFrom" }
  $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
  $backup = Join-Path $WaHome "backups\before-migrate-$stamp"
  New-Item -ItemType Directory -Path $backup -Force | Out-Null
  $any = $false
  if (Test-Path -LiteralPath (Join-Path $MigrateFrom '.env')) {
    Copy-Item -LiteralPath (Join-Path $MigrateFrom '.env') -Destination $backup
    Copy-Item -LiteralPath (Join-Path $MigrateFrom '.env') -Destination (Join-Path $dataDir '.env') -Force
    $any = $true
  }
  if (Test-Path -LiteralPath (Join-Path $MigrateFrom 'data')) {
    Copy-Item -LiteralPath (Join-Path $MigrateFrom 'data') -Destination (Join-Path $backup 'data') -Recurse
    Get-ChildItem -LiteralPath (Join-Path $MigrateFrom 'data') -Force | Copy-Item -Destination $dataDir -Recurse -Force
    $any = $true
  }
  if ($any) { Ok "已从 $MigrateFrom 迁移配置和数据（迁移前的备份：$backup；原目录未改动）" }
  else { Warn "$MigrateFrom 里没有配置和数据，按全新安装处理" }
} else {
  Ok '全新安装：打开插件后在登录卡片里登录禅道即可'
}

# ==================== 4. 开机自启、浏览器宿主、启动 ====================
if ($NoService) {
  Step '跳过开机自启和启动（-NoService）'
} else {
  Step '注册开机自启并启动后台服务'
  $owner = Port-Owner
  if ($owner) {
    $p = Get-CimInstance Win32_Process -Filter "ProcessId=$owner" -ErrorAction SilentlyContinue
    $desc = "$($p.Name)  $($p.CommandLine)"
    if ($desc.Length -gt 160) { $desc = $desc.Substring(0, 160) }
    Die "端口 $Port 被另一个程序占用：PID $owner  $desc。请关闭它后重新安装"
  }
  $vbs = Join-Path $WaHome 'bin\workassistant.vbs'
  # 新建的用户配置里可能还没有 Run 这个键
  if (-not (Test-Path -Path $RunKey)) { New-Item -Path $RunKey -Force | Out-Null }
  New-ItemProperty -Path $RunKey -Name $AppName -Value "wscript.exe `"$vbs`"" -PropertyType String -Force | Out-Null
  Ok '开机自启已注册（当前用户的启动项）'

  # 浏览器宿主：清单里只允许本扩展（ID 由 manifest.json 里的公钥算出，与安装位置无关）
  $extId = & $Node -e "const c=require('crypto');const k=JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')).key;const h=c.createHash('sha256').update(Buffer.from(k,'base64')).digest('hex');process.stdout.write([...h.slice(0,32)].map(x=>String.fromCharCode(97+parseInt(x,16))).join(''))" (Join-Path $extDir 'manifest.json')
  if ($LASTEXITCODE -ne 0 -or -not $extId) { Die '读取扩展 ID 失败' }
  $hostManifest = Join-Path $WaHome "bin\$HostName.json"
  $json = [ordered]@{
    name = $HostName
    description = 'WorkAssistant backend launcher'
    path = (Join-Path $WaHome 'bin\native-host.cmd')
    type = 'stdio'
    allowed_origins = @("chrome-extension://$extId/")
  } | ConvertTo-Json
  Write-Text $hostManifest $json
  foreach ($k in $BrowserKeys) {
    New-Item -Path "$k\$HostName" -Force | Out-Null
    Set-Item -Path "$k\$HostName" -Value $hostManifest
  }
  Ok '浏览器宿主已注册（插件可按需拉起后台）'

  Start-Process -FilePath 'wscript.exe' -ArgumentList "`"$vbs`"" -WorkingDirectory $WaHome
  $running = ''
  for ($i = 0; $i -lt 120; $i++) {
    $running = Backend-Version
    if ($running) { break }
    Start-Sleep -Milliseconds 500
  }
  if (-not $running) { Show-Diagnose; Die '后台服务 60 秒内没有启动（排查信息见上）' }
  if ($running -ne $Version) { Show-Diagnose; Die "后台服务版本是 $running，应为 $Version" }
  Ok "后台服务已启动（版本 $Version）"
}

# ==================== 5. 加载浏览器扩展 ====================
Step '加载浏览器扩展'
if (-not $NoService) {
  try { Set-Clipboard -Value $extDir; Ok '扩展目录已复制到剪贴板' } catch { }
}
$browser = ''
$candidates = @(
  @{ name = 'Chrome'; url = 'chrome://extensions/'; paths = @("$env:ProgramFiles\Google\Chrome\Application\chrome.exe", "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe", "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe") },
  @{ name = 'Edge'; url = 'edge://extensions/'; paths = @("${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe", "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe") },
  @{ name = 'Brave'; url = 'brave://extensions/'; paths = @("$env:ProgramFiles\BraveSoftware\Brave-Browser\Application\brave.exe", "$env:LOCALAPPDATA\BraveSoftware\Brave-Browser\Application\brave.exe") }
)
foreach ($c in $candidates) {
  $exe = $c.paths | Where-Object { $_ -and (Test-Path -LiteralPath $_) } | Select-Object -First 1
  if ($exe) {
    $browser = $c.name
    if (-not $NoService) { try { Start-Process -FilePath $exe -ArgumentList $c.url } catch { } }
    break
  }
}
if (-not $browser) { $browser = 'Chrome / Edge 等，地址 chrome://extensions' }
Write-Host ''
Write-Host "  在浏览器的扩展页（$browser）："
Write-Host '    1. 打开「开发者模式」（只需一次）'
Write-Host '    2. 如果以前加载过「工作助手」或「禅道助手」，先把旧的移除'
Write-Host '    3. 点「加载已解压的扩展程序」，在地址栏粘贴目录（已在剪贴板）后选择文件夹：'
Write-Host "       $extDir"
Write-Host '  然后打开一个新标签页：登录禅道，或在登录卡片上导入加密配置文件。'
Write-Host ''
Ok "安装完成：禅道助手 $Version"

} finally {
  Remove-Item -LiteralPath $Tmp -Recurse -Force -ErrorAction SilentlyContinue
}
# 显式以 0 结束：否则脚本的退出码是最后一个外部命令留下的 $LASTEXITCODE
exit 0
