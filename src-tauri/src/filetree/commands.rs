//! 文件树 Tauri 命令边界:list_dir(只读列一层)+ start_fs_watch/stop_fs_watch(notify 实时监听)。
//!
//! 三命令范式照 `system::commands` 与 `pty::commands`:
//! - 路径校验:绝对路径 + 词法 `..` 拒绝(纵深防御,与 list_ai_cli_sessions/get_git_branch 同思路)。
//!   不 canonicalize:本场景不喂 ConPTY,verbatim 前缀无意义,且 canonicalize 要求路径可访问会让
//!   暂时不可达的正常路径误判。
//! - 阻塞 IO(目录遍历/notify 事件循环)丢 `spawn_blocking` 或独立线程,不阻塞 async runtime。

use std::collections::HashSet;
use std::path::{Component, Path};

use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use tauri::{AppHandle, Emitter, State};

use super::{DirEntry, FsChange, FsWatcherRegistry, ReadFileResult, WatcherHandle};

/// 列出指定目录的一层条目(不递归)。前端 react-arborist 懒加载:展开目录时逐层调本命令。
///
/// 路径校验:绝对 + 词法 `..` 拒绝。目录条目在前、文件在后,各自不区分大小写字母序(Windows 习惯)。
/// 单条目读取失败(权限/损坏)跳过,不阻断整列。`spawn_blocking` 包裹避免阻塞 async runtime。
#[tauri::command]
pub async fn list_dir(path: String) -> Result<Vec<DirEntry>, String> {
    let normalized = validate_path(&path)?;
    tokio::task::spawn_blocking(move || {
        let rd = std::fs::read_dir(&normalized).map_err(|e| e.to_string())?;
        let mut dirs: Vec<DirEntry> = Vec::new();
        let mut files: Vec<DirEntry> = Vec::new();
        for entry in rd.flatten() {
            let ft = match entry.file_type() {
                Ok(t) => t,
                Err(_) => continue,
            };
            let name = entry.file_name().to_string_lossy().into_owned();
            let id = entry.path().to_string_lossy().into_owned();
            let meta = entry.metadata().ok();
            let (kind, size) = if ft.is_dir() {
                ("dir".to_string(), None)
            } else {
                ("file".to_string(), meta.as_ref().map(|m| m.len()))
            };
            let modified = meta
                .as_ref()
                .and_then(|m| m.modified().ok())
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_secs());
            let item = DirEntry {
                id,
                name,
                kind,
                size,
                modified,
            };
            if ft.is_dir() {
                dirs.push(item);
            } else {
                files.push(item);
            }
        }
        dirs.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
        files.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
        dirs.append(&mut files);
        Ok(dirs)
    })
    .await
    .map_err(|e| format!("join list_dir: {e}"))?
}

/// 文本预览截断阈值:512KB(够预览又不卡 Monaco 渲染)。
const READ_MAX: u64 = 512 * 1024;

/// 读取文件内容(只读预览)。前端 FilePreview 按 path 扩展名先判图片/文本再调本命令,
/// 故本命令也按扩展名分两路(前后端图片扩展名集合需保持一致,见前端 `IMAGE_EXTS`):
///
/// - 图片:整文件读字节 → base64(`mime` 填扩展名推的 MIME),前端拼 data URL 喂 `<img>`;不截断。
/// - 文本:读前 `READ_MAX` 字节 → NUL 检测 / `from_utf8` 判是否可预览。含 NUL 或非 UTF-8 → `binary=true`;
///   否则返回文本(>阈值时 `truncated=true`)。
/// 路径校验 + `spawn_blocking` 范式同 `list_dir`。
#[tauri::command]
pub async fn read_file(path: String) -> Result<ReadFileResult, String> {
    let normalized = validate_path(&path)?;
    let is_image = is_image_ext(&path);
    let mime = if is_image {
        mime_of(&path)
    } else {
        None
    };
    tokio::task::spawn_blocking(move || {
        let meta = std::fs::metadata(&normalized).map_err(|e| e.to_string())?;
        let size = meta.len();
        if is_image {
            // 图片:整文件读字节 → base64,不截断(图片通常 < 几 MB)。
            let bytes = std::fs::read(&normalized).map_err(|e| e.to_string())?;
            let b64 = BASE64_STANDARD.encode(&bytes);
            return Ok(ReadFileResult {
                content: Some(b64),
                mime,
                binary: false,
                truncated: false,
                size,
            });
        }
        // 文本:只读前 READ_MAX 字节(避免大文件全读进内存)。
        let read_len = (size.min(READ_MAX)) as usize;
        let bytes = std::fs::File::open(&normalized)
            .and_then(|mut f| {
                use std::io::Read;
                let mut buf = vec![0u8; read_len];
                let n = f.read(&mut buf)?;
                buf.truncate(n);
                Ok(buf)
            })
            .map_err(|e| e.to_string())?;
        // 含 NUL 字节即判二进制(简单可靠,合法 UTF-8 文本不含 NUL;与 file(1) 启发式一致)。
        if bytes.iter().any(|&b| b == 0) {
            return Ok(ReadFileResult {
                content: None,
                mime: None,
                binary: true,
                truncated: size > READ_MAX,
                size,
            });
        }
        match String::from_utf8(bytes) {
            Ok(s) => Ok(ReadFileResult {
                content: Some(s),
                mime: None,
                binary: false,
                truncated: size > READ_MAX,
                size,
            }),
            Err(_) => Ok(ReadFileResult {
                content: None,
                mime: None,
                binary: true,
                truncated: size > READ_MAX,
                size,
            }),
        }
    })
    .await
    .map_err(|e| format!("join read_file: {e}"))?
}

/// 写文件内容(M2 编辑落盘)。与 `read_file` 对称的写路径:路径校验同 `validate_path`,
/// 阻塞 IO 丢 `spawn_blocking`。
///
/// **原子写**:先写 `<path>.tmp` 再 `rename` 覆盖原文件,防写到一半崩溃损坏原文件。
/// Windows 下 `std::fs::rename` 走 `MoveFileExW` + `MOVEFILE_REPLACE_EXISTING`,可覆盖现有文件
/// (不必先 remove——先 remove 再 rename 有 remove 后崩溃丢文件的窗口)。`rename` 失败兜底
/// 直接 `fs::write`(非原子但不致写失败,异常路径如跨卷 tmp;此时 .tmp 残留由下一次写覆盖)。
///
/// 后端不做"是否文本"校验:前端只对 text kind 调用,后端只管路径安全 + 写。
#[tauri::command]
pub async fn write_file(path: String, content: String) -> Result<(), String> {
    let normalized = validate_path(&path)?;
    tokio::task::spawn_blocking(move || {
        // 临时文件:原路径 + ".tmp"(用字符串拼接而非 with_extension,避免 foo.ts→foo.tmp 替换扩展名)。
        let tmp: std::path::PathBuf = format!("{}.tmp", normalized.to_string_lossy()).into();
        std::fs::write(&tmp, content.as_bytes()).map_err(|e| e.to_string())?;
        // 原子覆盖:rename(Windows 可覆盖现有文件)。失败兜底直接写目标。
        if let Err(e) = std::fs::rename(&tmp, &normalized) {
            // 兜底:直接写(非原子),再清理 .tmp 残留。
            std::fs::write(&normalized, content.as_bytes()).map_err(|e2| e2.to_string())?;
            let _ = std::fs::remove_file(&tmp);
            log::warn!("write_file: rename failed ({e}), fell back to direct write");
        }
        Ok(())
    })
    .await
    .map_err(|e| format!("join write_file: {e}"))?
}

/// 由扩展名(小写)判断是否图片(与前端 `IMAGE_EXTS` 保持一致)。
fn is_image_ext(path: &str) -> bool {
    match Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .as_deref()
    {
        Some("png") | Some("jpg") | Some("jpeg") | Some("gif") | Some("webp") | Some("bmp")
        | Some("ico") => true,
        // SVG 走文本分支(Monaco 显示 XML 源码,M1 不渲染图形),不在此列。
        _ => false,
    }
}

/// 图片扩展名 → MIME(仅 `is_image_ext` 为真时调用)。
fn mime_of(path: &str) -> Option<String> {
    let ext = Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())?;
    let mime = match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "bmp" => "image/bmp",
        "ico" => "image/x-icon",
        _ => return None,
    };
    Some(mime.to_string())
}

/// 为项目启动文件变更监听(notify `RecommendedWatcher`,`RecursiveMode::Recursive` 覆盖整个项目树)。
///
/// 引用计数:同项目已存在 watcher 则 count++,复用;否则新建。多个 filetree pane(同项目)共享。
/// 事件循环在独立线程:`recv_timeout` 聚合 500ms 窗口内事件(防抖)→ emit `fs-change{projectId,paths}`。
/// watcher 创建(可能阻塞)在锁外;短锁仅 insert/peek。
#[tauri::command]
pub async fn start_fs_watch(
    app: AppHandle,
    state: State<'_, FsWatcherRegistry>,
    project_id: String,
    root_path: String,
) -> Result<(), String> {
    let normalized = validate_path(&root_path)?;

    // 短锁:已存在则 count++ 复用。
    {
        let mut by_project = state.by_project.lock().map_err(|e| e.to_string())?;
        if let Some(h) = by_project.get_mut(&project_id) {
            h.count = h.count.saturating_add(1);
            log::info!("fs_watch: reuse {project_id} count={}", h.count);
            return Ok(());
        }
    }

    // 锁外创建 watcher + 启事件线程(notify::new/watch 可能阻塞)。
    let (tx, rx) = std::sync::mpsc::channel::<notify::Result<notify::Event>>();
    let mut watcher = RecommendedWatcher::new(
        move |res: notify::Result<notify::Event>| {
            let _ = tx.send(res);
        },
        notify::Config::default(),
    )
    .map_err(|e| e.to_string())?;
    watcher
        .watch(&normalized, RecursiveMode::Recursive)
        .map_err(|e| e.to_string())?;

    let app_handle = app.clone();
    let pid = project_id.clone();
    std::thread::spawn(move || debounce_loop(rx, app_handle, pid));

    // 短锁:注册(count=1)。
    {
        let mut by_project = state.by_project.lock().map_err(|e| e.to_string())?;
        by_project.insert(
            project_id.clone(),
            WatcherHandle {
                watcher,
                count: 1,
            },
        );
    }
    log::info!("fs_watch: start {project_id} root={}", normalized.display());
    Ok(())
}

/// 停止项目的文件监听(引用计数:count-- 到 0 才真正 remove drop watcher)。
///
/// 短锁:count--;到 0 则 remove(watcher 在本函数结束、handle 越过锁作用域后 drop →
/// 停止监听 → 事件线程收 Disconnected 退出)。
#[tauri::command]
pub async fn stop_fs_watch(
    state: State<'_, FsWatcherRegistry>,
    project_id: String,
) -> Result<(), String> {
    let dropped = {
        let mut by_project = state.by_project.lock().map_err(|e| e.to_string())?;
        let h = by_project
            .get_mut(&project_id)
            .ok_or_else(|| format!("watcher not found: {project_id}"))?;
        h.count = h.count.saturating_sub(1);
        if h.count == 0 {
            by_project.remove(&project_id)
        } else {
            log::info!("fs_watch: release {project_id} count={}", h.count);
            None
        }
    };
    if dropped.is_some() {
        log::info!("fs_watch: stop {project_id}");
    }
    Ok(())
}

/// 防抖事件循环:收到事件加入 pending,静默 500ms 后 flush emit `fs-change`。
///
/// 逻辑:`recv_timeout(WINDOW)` 等首个事件 → 收到后继续 drain(每有事件重置 WINDOW)→
/// WINDOW 内无新事件(`recv_timeout` 超时)→ flush pending → 回到等首个事件。
/// watcher drop 后 channel 断开 → `Disconnected` → 退出线程。
fn debounce_loop(
    rx: std::sync::mpsc::Receiver<notify::Result<notify::Event>>,
    app: AppHandle,
    project_id: String,
) {
    const WINDOW: std::time::Duration = std::time::Duration::from_millis(500);
    let mut pending: HashSet<String> = HashSet::new();
    loop {
        match rx.recv_timeout(WINDOW) {
            Ok(res) => {
                if let Ok(ev) = res {
                    for p in ev.paths {
                        pending.insert(p.to_string_lossy().into_owned());
                    }
                }
                // drain 窗口内后续事件(每收一个重置等待 WINDOW)。
                while let Ok(more) = rx.recv_timeout(WINDOW) {
                    if let Ok(ev) = more {
                        for p in ev.paths {
                            pending.insert(p.to_string_lossy().into_owned());
                        }
                    }
                }
                flush(&app, &project_id, &mut pending);
            }
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                // 窗口内无事件;pending 通常已 flush,保险再 flush 一次(幂等)。
                flush(&app, &project_id, &mut pending);
            }
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
        }
    }
}

/// flush pending 到 `fs-change` 事件;pending 为空则不发(避免无谓广播)。
fn flush(app: &AppHandle, project_id: &str, pending: &mut HashSet<String>) {
    if pending.is_empty() {
        return;
    }
    let paths: Vec<String> = pending.drain().collect();
    let _ = app.emit(
        "fs-change",
        FsChange {
            project_id: project_id.to_string(),
            paths,
        },
    );
}

/// 路径校验:绝对路径 + 词法 `..` 拒绝(与 `system::commands::get_git_branch` 同思路,不 canonicalize)。
/// 递归列出指定目录下的所有文件(@文件引用用),跳过 .git/node_modules/target 等忽略目录,
/// 限深度(默认 4,上限 8)+ 限总数 2000(巨项目保护)。返回 DirEntry(id=绝对路径, kind="file")。
#[tauri::command]
pub async fn list_files(path: String, max_depth: Option<usize>) -> Result<Vec<DirEntry>, String> {
    let root = validate_path(&path)?;
    let max = max_depth.unwrap_or(4).min(8);
    tokio::task::spawn_blocking(move || -> Result<Vec<DirEntry>, String> {
        let mut out: Vec<DirEntry> = Vec::new();
        collect_files(&root, &root, 0, max, &mut out);
        Ok(out)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// list_files 的递归收集(同步,spawn_blocking 内)。
fn collect_files(
    root: &std::path::Path,
    dir: &std::path::Path,
    depth: usize,
    max: usize,
    out: &mut Vec<DirEntry>,
) {
    if depth > max || out.len() >= 2000 {
        return;
    }
    let rd = match std::fs::read_dir(dir) {
        Ok(r) => r,
        Err(_) => return,
    };
    for entry in rd.flatten() {
        if out.len() >= 2000 {
            return;
        }
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().into_owned();
        if IGNORED_DIRS.contains(&name.as_str()) {
            continue;
        }
        let ft = match entry.file_type() {
            Ok(t) => t,
            Err(_) => continue,
        };
        if ft.is_dir() {
            collect_files(root, &path, depth + 1, max, out);
        } else {
            let id = path.to_string_lossy().into_owned();
            let size = entry.metadata().ok().map(|m| m.len());
            out.push(DirEntry {
                id,
                name,
                kind: "file".to_string(),
                size,
                modified: None,
            });
        }
    }
}

/// list_files 递归时跳过的目录(体积大/无关,避免巨项目卡)。
const IGNORED_DIRS: &[&str] = &[
    ".git",
    "node_modules",
    "target",
    "dist",
    ".next",
    ".cache",
    "__pycache__",
    ".venv",
    ".claude",
];

fn validate_path(raw: &str) -> Result<std::path::PathBuf, String> {
    let p = Path::new(raw);
    if !p.is_absolute() {
        return Err(format!("not absolute: {raw}"));
    }
    let normalized = lexical_normalize(p);
    if normalized
        .components()
        .any(|c| matches!(c, Component::ParentDir))
    {
        return Err(format!("escapes via ..: {raw}"));
    }
    Ok(normalized)
}

/// 词法规范化:解析 `.`/`..` 段但不要求路径存在(与 `pty::commands`/`system::commands` 同实现,
/// 此处内联保持最小 diff;M6 危险命令保护统一提取共享 `path_util` 时再合并)。
fn lexical_normalize(p: &Path) -> std::path::PathBuf {
    use std::path::Component::{self, CurDir, Normal, ParentDir, Prefix, RootDir};
    let mut out = std::path::PathBuf::new();
    for comp in p.components() {
        match comp {
            Prefix(_) | RootDir => out.push(comp),
            CurDir => {}
            ParentDir => {
                if matches!(out.components().next_back(), Some(Component::Normal(_))) {
                    out.pop();
                } else {
                    out.push("..");
                }
            }
            Normal(s) => out.push(s),
        }
    }
    out
}
