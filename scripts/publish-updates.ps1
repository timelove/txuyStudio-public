param(
  [Parameter(Mandatory = $true)][string]$Version,
  [Parameter(Mandatory = $true)][string]$BaseUrl,
  [string]$Credentials = 'secrets\minio\credentials.json',
  [string]$NotesFile = ".work\release-notes-v$Version.md",
  [string]$DesktopSetup = "src-tauri\target\release\bundle\nsis\txuyStudio_${Version}_x64-setup.exe",
  [string]$DesktopSignature = "src-tauri\target\release\bundle\nsis\txuyStudio_${Version}_x64-setup.exe.sig",
  [string]$AndroidApk = "companion\app\build\app\outputs\flutter-apk\txuyStudio-companion_${Version}.apk",
  [switch]$SkipAndroid,
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$resolveInput = {
  param([string]$Path)
  if ([System.IO.Path]::IsPathRooted($Path)) { return $Path }
  return (Join-Path $root $Path)
}
$args = @('--bin', 'release_publisher', '--', '--credentials', $Credentials,
  '--bucket', 'txuy', '--base-url', $BaseUrl, '--version', $Version,
  '--notes-file', (& $resolveInput $NotesFile),
  '--desktop-setup', (& $resolveInput $DesktopSetup),
  '--desktop-signature', (& $resolveInput $DesktopSignature))
if (-not $SkipAndroid) { $args += @('--android-apk', (& $resolveInput $AndroidApk)) }
if ($DryRun) { $args += '--dry-run' }

Push-Location $root
try {
  cargo run --manifest-path crates\release-publisher\Cargo.toml @args
  if ($LASTEXITCODE -ne 0) { throw "发布工具失败(exit $LASTEXITCODE)" }
} finally {
  Pop-Location
}
