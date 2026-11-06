//! 应用设置(#156):主题/终端字号/背景图(path+blur+dim)/亚克力磨砂。
//!
//! 持久化 `%APPDATA%\com.txuystudio.terminal\txuyStudio-dev\settings-gpui.json`
//! (debug 域,与 state-gpui.json 同目录;release 域换 txuyStudio 子目录)。
//! 读写小 json,整体落盘——设置项少,不值得增量。

use serde::{Deserialize, Serialize};

#[derive(Clone, Serialize, Deserialize)]
pub struct Settings {
    /// 主题 id(theme::THEME_IDS 同串;未知值回 midnight)。
    pub theme: String,
    /// 终端字号 px(11-20,clamp 在 theme::set_terminal_font_size)。
    pub font_size: f32,
    /// 亚克力磨砂(ACCENT_ENABLE_ACRYLICBLURBEHIND + 玻璃变体主题)。
    pub acrylic: bool,
    /// 背景图绝对路径(空 = 关)。
    pub bg_path: String,
    /// 背景图高斯模糊半径 px(0-40;加载时 CPU 预处理)。
    pub bg_blur: u8,
    /// 背景图暗化 0-85(%)。
    pub bg_dim: u8,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            theme: "midnight".to_string(),
            font_size: 14.,
            acrylic: false,
            bg_path: String::new(),
            bg_blur: 0,
            bg_dim: 40,
        }
    }
}

/// 设置文件路径(None = 无 APPDATA 环境,不持久化)。
pub fn settings_path() -> Option<std::path::PathBuf> {
    let sub = if cfg!(debug_assertions) { "txuyStudio-dev" } else { "txuyStudio" };
    let mut p = std::path::PathBuf::from(std::env::var_os("APPDATA")?);
    p.push("com.txuystudio.terminal");
    p.push(sub);
    p.push("settings-gpui.json");
    Some(p)
}

/// 读设置(缺失/损坏/未知主题 → 对应字段回默认,不整体失败)。
pub fn load() -> Settings {
    let Some(path) = settings_path() else { return Settings::default() };
    let Ok(raw) = std::fs::read_to_string(&path) else {
        return Settings::default();
    };
    match serde_json::from_str::<Settings>(&raw) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("[settings] parse failed ({e}), fallback default");
            Settings::default()
        }
    }
}

/// 写设置(失败仅日志)。
pub fn save(s: &Settings) {
    let Some(path) = settings_path() else { return };
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    match serde_json::to_string_pretty(s) {
        Ok(json) => {
            if let Err(e) = std::fs::write(&path, json) {
                eprintln!("[settings] save failed: {e}");
            }
        }
        Err(e) => eprintln!("[settings] serialize failed: {e}"),
    }
}

#[test]
fn settings_roundtrip() {
    let mut s = Settings::default();
    s.theme = "one-dark".into();
    s.font_size = 16.;
    s.acrylic = true;
    s.bg_path = "C:/x/y.png".into();
    s.bg_blur = 12;
    s.bg_dim = 55;
    let json = serde_json::to_string(&s).unwrap();
    let back: Settings = serde_json::from_str(&json).unwrap();
    assert_eq!(back.theme, "one-dark");
    assert_eq!(back.bg_blur, 12);
    assert_eq!(back.bg_dim, 55);
    assert!(back.acrylic);
    // 未知主题字段可解析(归一在消费侧 theme_index_by_id)。
    let raw = r#"{"theme":"nope","font_size":14.0,"acrylic":false,"bg_path":"","bg_blur":0,"bg_dim":40}"#;
    let s2: Settings = serde_json::from_str(raw).unwrap();
    assert_eq!(s2.theme, "nope");
}
