# make-latest-json.ps1
# 从 tauri build 产物生成 tauri-plugin-updater 的 latest.json(发版时上传到 GitHub Release
# 作为固定名资产,endpoints 指 releases/latest/download/latest.json)。
#
# 前提:tauri build 时设置了签名环境变量(TAURI_SIGNING_PRIVATE_KEY[_PASSWORD]),
# NSIS 产物旁会生成同名 .sig 文件;createUpdaterArtifacts 在 tauri.conf.json 已开。
#
# 用法:pwsh scripts/make-latest-json.ps1 [-Version 0.1.7] [-NotesFile release-notes.md]
# 产物:src-tauri/target/release/bundle/nsis/latest.json

param(
  [Parameter(Mandatory = $true)][string]$Version,
  [Parameter(Mandatory = $true)][string]$NotesFile,
  [string]$Repo = "timelove/txuyStudio-public"
)
$ErrorActionPreference = "Stop"

$bundleDir = Join-Path $PSScriptRoot "..\src-tauri\target\release\bundle\nsis"
$setup = Join-Path $bundleDir "txuyStudio_${Version}_x64-setup.exe"
$sigFile = "${setup}.sig"

if (-not (Test-Path $setup)) { Write-Error "未找到安装包: $setup"; exit 1 }
if (-not (Test-Path $sigFile)) {
  Write-Error @`
    "未找到签名文件: $sigFile
    请用签名环境变量重新打包(TAURI_SIGNING_PRIVATE_KEY / TAURI_SIGNING_PRIVATE_KEY_PASSWORD)。"
  exit 1
}
if (-not (Test-Path $NotesFile)) { Write-Error "未找到更新日志: $NotesFile"; exit 1 }

# pubDate 需 ISO8601;notes 保持 markdown 原文(updater 前端按行展示)。
$pubDate = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
$notes = (Get-Content -Raw -Encoding UTF8 $NotesFile)
$sig = (Get-Content -Raw $sigFile).Trim()

# 下载 URL 用 github Releases 固定下载路径(资产名含版本号,latest.json 每版重写)。
$downloadUrl = "https://github.com/$Repo/releases/download/v$Version/txuyStudio_${Version}_x64-setup.exe"

$manifest = [ordered]@{
  version   = $Version
  notes     = $notes
  pub_date  = $pubDate
  platforms = [ordered]@{
    "windows-x86_64" = [ordered]@{
      signature = $sig
      url       = $downloadUrl
    }
  }
}

$out = Join-Path $bundleDir "latest.json"
$manifest | ConvertTo-Json -Depth 5 | Out-File -FilePath $out -Encoding utf8NoBOM
Write-Output "✅ $out (v$Version)"
