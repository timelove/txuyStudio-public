//! PTY 会话(Tauri 壳层):领域模型与 spawn 核心已抽至 `txuy-core`(P0),此处
//! re-export 保持 `crate::pty::*` 引用路径稳定;Tauri command 壳见 [`commands`]。

pub mod commands;

pub use txuy_core::pty::{PtyOutput, PtyOutputSink, PtyRegistry, PtySpawnConfig};
