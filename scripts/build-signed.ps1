# 带 updater 签名的打包入口:两步式(build 关内置签名 + 事后 signer 补签)。
# 私钥约定(PROGRESS #108):仅本机 ~/.tauri/txuystudio.key,密码空(--ci 生成),
# 绝不进仓库/公开 mirror;公钥已嵌 tauri.conf.json。
# **私钥丢失勿重新生成密钥对**——会使已发版用户更新验签全部失败,只能从备份恢复。
#
# 为何两步式(2026-11-11 实测,tauri-cli 2.11.3,无 TTY 后台环境):
# - tauri build 内置 updater 签名(bundler 路径)挂死在 "expect a prompt for password"
#   (rpassword 等 stdin,PASSWORD 环境变量设不设、设什么都拦不住);
# - `tauri signer sign` 单命令不传 -p 同样挂("Signing without password." 后死寂,喂 stdin 无效);
# - 唯一实证秒过:显式 `-p ''` 空密码参数。故 build 时 --config 覆盖关掉
#   createUpdaterArtifacts,事后 signer -p '' 补签,产物与内置签名完全一致(.sig 424B)。
$ErrorActionPreference = "Stop"

$keyPath = Join-Path $env:USERPROFILE ".tauri\txuystudio.key"
if (-not (Test-Path $keyPath)) {
  Write-Error "未找到私钥 $keyPath。若已丢失:先找备份;确认彻底丢失才考虑重生成密钥对并发版说明(老用户需手动重装)。"
}

# 空 key 无密码:签名走显式 -p '' 传参;清掉 PASSWORD 环境残留防干扰
$env:TAURI_SIGNING_PRIVATE_KEY = Get-Content $keyPath -Raw
Remove-Item Env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD -ErrorAction SilentlyContinue

# build:override 关掉内置签名(挂死点),NSIS 本身照常产出
$cfgOverride = Join-Path $env:TEMP "tauri-build-nosign.json"
'{"bundle":{"createUpdaterArtifacts":false}}' | Set-Content -Encoding ascii $cfgOverride
Write-Host "[build-signed] 私钥已注入,开始 tauri build(内置签名已关,build 后补签)..."
bun run tauri build --config $cfgOverride
if ($LASTEXITCODE -ne 0) { Write-Error "tauri build 失败(exit $LASTEXITCODE)" }

# 补签:从 conf 读版本定位 NSIS 产物,signer -p '' 秒签。
# 注意必须 bun 直跑 cli 的 js 入口:bunx 会把 -p 当自己的 --package 短参数吞掉,参数错乱
$conf = Get-Content "src-tauri/tauri.conf.json" -Raw | ConvertFrom-Json
$setup = "src-tauri/target/release/bundle/nsis/txuyStudio_$($conf.version)_x64-setup.exe"
if (-not (Test-Path $setup)) { Write-Error "未找到 NSIS 产物 $setup" }

bun node_modules/@tauri-apps/cli/tauri.js signer sign -p '' $setup
if ($LASTEXITCODE -ne 0) { Write-Error "签名失败(exit $LASTEXITCODE)" }

Write-Host "[build-signed] 完成: $setup (+ .sig)"
