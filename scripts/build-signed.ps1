# 带 updater 签名的打包入口:注入 TAURI_SIGNING_PRIVATE_KEY 后跑 tauri build。
# 私钥约定(PROGRESS #108):仅本机 ~/.tauri/txuystudio.key,密码空(--ci 生成),
# 绝不进仓库/公开 mirror;公钥已嵌 tauri.conf.json。
# **私钥丢失勿重新生成密钥对**——会使已发版用户更新验签全部失败,只能从备份恢复。
$ErrorActionPreference = "Stop"

$keyPath = Join-Path $env:USERPROFILE ".tauri\txuystudio.key"
if (-not (Test-Path $keyPath)) {
  Write-Error "未找到私钥 $keyPath。若已丢失:先找备份;确认彻底丢失才考虑重生成密钥对并发版说明(老用户需手动重装)。"
}

# 密码为空:显式设空串免交互(不设时 bundler 会 prompt "Decrypting updater signing key")。
$env:TAURI_SIGNING_PRIVATE_KEY = Get-Content $keyPath -Raw
$env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = ""

Write-Host "[build-signed] 私钥已注入,开始 tauri build..."
bun run tauri build
