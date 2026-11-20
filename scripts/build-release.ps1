# Build release bundles with the packaged update source injected at compile time.
#
# Desktop: TXUY_UPDATE_ENDPOINT feeds updater.rs option_env! (default endpoints =
# GitHub when omitted). Android: TXUY_UPDATE_SOURCE becomes a Dart const via
# --dart-define. Both default to GitHub when -BaseUrl is not provided.
#
# 2026-11-19: MinIO 注入链路整体搁置(用户拍板)——日常构建不带 -BaseUrl 走 GitHub;
# 重新启用时:先跑 publish-updates.ps1 上传产物,再本脚本带 -BaseUrl <app 级地址>。
# BaseUrl semantics (differs from publish-updates.ps1 by one segment!): point at
# the app prefix under the bucket, e.g. https://<your-minio>/<path>/txuy/app
# - clients fetch {BaseUrl}/desktop/latest.json and {BaseUrl}/android/latest.json.
# The publisher's --base-url is the bucket root (it appends app/ itself).
#
# Updater signing follows build-signed.ps1's proven two-step path (2026-11-11):
# tauri build's built-in signing hangs on the password prompt in non-TTY shells,
# so we disable createUpdaterArtifacts via --config override, then re-sign with
# `signer sign --password=''` (empty-password key, explicit param = instant).
param(
  [string]$BaseUrl,
  [string]$Flutter = 'D:\work\Android\flutterVersion\flutter3.47.7\bin\flutter.bat',
  [switch]$SkipDesktop,
  [switch]$SkipAndroid,
  [switch]$SkipSign
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot

if ($BaseUrl) {
  if ($BaseUrl -notmatch '^https?://') { throw "BaseUrl must be an http(s) URL: $BaseUrl" }
  $env:TXUY_UPDATE_ENDPOINT = $BaseUrl.Trim().TrimEnd('/')
  Write-Host "update source: $env:TXUY_UPDATE_ENDPOINT"
} else {
  Write-Host "update source: GitHub (default, no injection)"
}

# Updater signing key (private repo secret; passwordless --ci key).
$keyPath = Join-Path $root 'secrets\txuystudio.key'
if (-not (Test-Path $keyPath)) { Write-Warning "updater key missing: $keyPath (skip signing)" }

Push-Location $root
try {
  if (-not $SkipDesktop) {
    if ($keyPath -and (Test-Path $keyPath)) {
      # Built-in signing off (hang point), re-sign after build.
      Remove-Item Env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD -ErrorAction SilentlyContinue
      $cfg = Join-Path $env:TEMP 'tauri-build-nosign.json'
      '{"bundle":{"createUpdaterArtifacts":false}}' | Set-Content -Encoding ascii $cfg
      bun run tauri build --config $cfg
    } else {
      bun run tauri build
    }
    if ($LASTEXITCODE -ne 0) { throw "tauri build failed (exit $LASTEXITCODE)" }

    # Re-sign (explicit --password='' is the only proven non-hanging form).
    if ($keyPath -and (Test-Path $keyPath) -and -not $SkipSign) {
      $env:TAURI_SIGNING_PRIVATE_KEY = (Get-Content $keyPath -Raw)
      $conf = Get-Content src-tauri/tauri.conf.json -Raw | ConvertFrom-Json
      $setup = "src-tauri/target/release/bundle/nsis/txuyStudio_$($conf.version)_x64-setup.exe"
      bun node_modules/@tauri-apps/cli/tauri.js signer sign --password='' $setup
      if ($LASTEXITCODE -ne 0) { throw "signing failed (exit $LASTEXITCODE)" }
      Remove-Item Env:TAURI_SIGNING_PRIVATE_KEY -ErrorAction SilentlyContinue
    }
  }
  if (-not $SkipAndroid) {
    $dart = @('build', 'apk', '--release')
    if ($env:TXUY_UPDATE_ENDPOINT) { $dart += "--dart-define=TXUY_UPDATE_SOURCE=$env:TXUY_UPDATE_ENDPOINT" }
    & $Flutter @dart
    if ($LASTEXITCODE -ne 0) { throw "flutter build apk failed (exit $LASTEXITCODE)" }
  }
} finally {
  Pop-Location
}
