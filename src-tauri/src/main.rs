// 在 release 下使用 windows 子系统，避免安装后启动时弹出控制台黑窗。
// debug 构建保留 console 子系统，方便看 println!/panic 输出。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    txuy_studio_lib::run()
}
