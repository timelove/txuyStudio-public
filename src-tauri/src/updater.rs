//! 应用更新(自定义更新源,2026-11-18 MinIO 更新发布器收尾)。
//!
//! **2026-11-19 起 MinIO 注入链路搁置**:发行版构建不带 `TXUY_UPDATE_ENDPOINT`
//! (走 GitHub 默认);机制保留,重新启用见 `scripts/build-release.ps1` 头注释。
//!
//! 更新源在**打包时注入**(2026-11-18 用户定调:不发版后靠设置切换,发行版自带):
//! 构建桌面端时设环境变量 `TXUY_UPDATE_ENDPOINT`(http(s) base URL),经
//! `option_env!` 编进二进制作为默认 endpoints——`bun run tauri build` 前设
//! `$env:TXUY_UPDATE_ENDPOINT="https://updates.example.com/txuy"`;不设 = GitHub
//! 公开仓默认。运行期无任何切换入口。约定:`{endpoint}` 拼 `/desktop/latest.json`
//! (与 release_publisher 对象布局对齐),base 归一化去尾斜杠。
//!
//! 为何不走 JS `check()`:插件 JS API 不支持动态 endpoints,且 Rust 侧 `Update`
//! 不可序列化回前端——check 与 download+install 都在 Rust 侧完成,前端只拿可序列化
//! 摘要与进度事件(`updater-progress`)。

use serde::Serialize;
use tauri::{AppHandle, Emitter};
use tauri_plugin_updater::UpdaterExt;

/// 打包注入的更新源 base URL(空 = GitHub conf 默认)。option_env!:开发/未设时 None。
const PACKAGED_ENDPOINT: Option<&str> = option_env!("TXUY_UPDATE_ENDPOINT");

/// 检查结果摘要(可序列化回前端;`available=false` 时其余字段缺省)。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    pub available: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub current_version: Option<String>,
    /// 更新日志(latest.json notes,markdown 原文)。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub body: Option<String>,
}

/// 下载进度事件 payload(`updater-progress` 事件;total 无 content-length 时 null)。
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DownloadProgress {
    pub received: u64,
    pub total: Option<u64>,
}

/// 打包注入的更新源(None/空/非法 → None = 用 conf 默认)。
fn packaged_endpoint() -> Option<tauri::Url> {
    let url = PACKAGED_ENDPOINT?.trim().trim_end_matches('/');
    if !(url.starts_with("https://") || url.starts_with("http://")) || url.len() <= 8 {
        log::warn!("updater: 打包注入的更新源非法,回退默认 endpoints: {url}");
        return None;
    }
    tauri::Url::parse(url).ok().map(|mut u| {
        u.set_path(format!("{}/desktop/latest.json", u.path().trim_matches('/')).as_str());
        u
    })
}

/// 构造 updater:打包注入源时替换 endpoints,否则 conf 默认。
fn build_updater(app: &AppHandle) -> tauri_plugin_updater::Result<tauri_plugin_updater::Updater> {
    let builder = app.updater_builder();
    match packaged_endpoint() {
        Some(endpoint) => {
            log::info!("updater: 使用打包注入更新源: {endpoint}");
            builder.endpoints(vec![endpoint])
        }
        None => Ok(builder),
    }?
    .build()
}

/// 检查更新(手动/启动自动共用)。Ok(None 的 available=false)= 已是最新。
#[tauri::command]
pub async fn check_for_updates(app: AppHandle) -> Result<UpdateInfo, String> {
    let update = build_updater(&app)
        .map_err(|e| format!("构建 updater 失败: {e}"))?
        .check()
        .await
        .map_err(|e| format!("检查更新失败: {e}"))?;
    Ok(match update {
        Some(u) => UpdateInfo {
            available: true,
            version: Some(u.version.clone()),
            current_version: Some(u.current_version.clone()),
            body: u.body.clone(),
        },
        None => UpdateInfo { available: false, version: None, current_version: None, body: None },
    })
}

/// 下载并安装(前端点「下载并安装」触发)。进度经 `updater-progress` 事件回推;
/// 安装完成返回 Ok,重启生效由前端 relaunch(与原 JS downloadAndInstall 流程同构)。
///
/// 注:命令内重新 check 拿 `Update`(Rust 侧对象不可跨命令存活)——latest.json 在
/// 检查与安装间隙被覆盖的竞态忽略不计(发布器 latest.json 最后上传,天然原子切版)。
#[tauri::command]
pub async fn download_and_install_update(app: AppHandle) -> Result<(), String> {
    let update = build_updater(&app)
        .map_err(|e| format!("构建 updater 失败: {e}"))?
        .check()
        .await
        .map_err(|e| format!("检查更新失败: {e}"))?
        .ok_or_else(|| "已是最新版本,无需安装".to_string())?;
    let app2 = app.clone();
    let mut received: u64 = 0;
    let bytes = update
        .download(
            |chunk, total| {
                received += chunk as u64;
                let _ = app2.emit("updater-progress", DownloadProgress { received, total });
            },
            || {},
        )
        .await
        .map_err(|e| format!("下载更新失败: {e}"))?;
    update
        .install(bytes)
        .map_err(|e| format!("安装更新失败: {e}"))?;
    Ok(())
}
