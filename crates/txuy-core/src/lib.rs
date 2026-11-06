//! txuy-core —— txuyStudio 业务核心(纯逻辑,零 UI 框架依赖)。
//!
//! GPUI 改造 P0 抽取的第一批:state(持久化快照)/ pty(ConPTY 会话)/ proc(子进程
//! 与 Windows 路径工具)。Tauri 壳(src-tauri)与未来的 GPUI 壳(src-gpui)共用本 crate,
//! 拒绝复制粘贴式分叉。框架耦合点全部注入化:输出回调(`PtyOutputSink`)、资源路径
//! (`omp` 参数)、数据目录(路径参数)。
//!
//! 设计文档:.work/design/20261014-gpui-port/plan-v1.md(P0)。

pub mod proc;
pub mod pty;
pub mod state;

pub use state::{AppSnapshot, AppState};
