// In release mode, use windows subsystem to avoid console popup on startup.
// Debug builds keep console subsystem for println!/panic output.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

// Set per-monitor v2 DPI awareness before Tauri builder, so WebView2 renders at
// the true DPI of each monitor.
#[cfg(windows)]
fn ensure_dpi_aware() {
    use windows::Win32::UI::HiDpi::{SetProcessDpiAwareness, PROCESS_PER_MONITOR_DPI_AWARE};
    unsafe {
        let _ = SetProcessDpiAwareness(PROCESS_PER_MONITOR_DPI_AWARE);
    }
}

#[cfg(not(windows))]
fn ensure_dpi_aware() {}

fn main() {
    ensure_dpi_aware();
    txuy_studio_lib::run()
}
