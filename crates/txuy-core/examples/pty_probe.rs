//! ConPTY 排版探针(临时诊断工具):验证「给定 cols 下 pwsh 的 RawUI 报数与 ls 排版形态」。
//! 当前验证:Format-Table -AutoSize 紧凑 ls 在窄 console 下的列宽收益。
//! cargo run --example pty_probe [cols]
use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use std::io::{Read, Write};
use std::sync::mpsc;
use std::time::Duration;

/// 剥 ANSI 转义序列(CSI/OSC/单字符 ESC),保留可读文本与换行。
fn strip_ansi(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = String::with_capacity(s.len());
    let mut i = 0;
    while i < b.len() {
        match b[i] {
            0x1b => {
                i += 1;
                if i >= b.len() {
                    break;
                }
                if b[i] == b'[' {
                    i += 1;
                    while i < b.len() && !(0x40..=0x7e).contains(&b[i]) {
                        i += 1;
                    }
                    i += 1;
                } else if b[i] == b']' {
                    i += 1;
                    while i < b.len() && b[i] != 0x07 {
                        i += 1;
                    }
                    i += 1;
                } else {
                    i += 1;
                }
            }
            b'\r' => {
                out.push('\n');
                i += 1;
            }
            0x08 => {
                i += 1;
            }
            c if c < 0x20 && c != b'\n' => {
                i += 1;
            }
            _ => {
                let mut j = i + 1;
                while j < b.len() && b[j] & 0xc0 == 0x80 {
                    j += 1;
                }
                out.push_str(&String::from_utf8_lossy(&b[i..j]));
                i = j;
            }
        }
    }
    out
}

fn main() {
    let cols: u16 = std::env::args().nth(1).and_then(|s| s.parse().ok()).unwrap_or(60);
    let cwd = r"D:\work\web\wireless\yigouCode\yigou-8.1.4";
    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize { rows: 30, cols, pixel_width: 0, pixel_height: 0 })
        .expect("openpty");
    let mut cmd = CommandBuilder::new("pwsh.exe");
    cmd.arg("-NoLogo");
    cmd.arg("-NoProfile");
    cmd.cwd(cwd);
    let mut child = pair.slave.spawn_command(cmd).expect("spawn pwsh");
    drop(pair.slave);

    let mut reader = pair.master.try_clone_reader().expect("reader");
    let (tx, rx) = mpsc::channel::<Vec<u8>>();
    std::thread::spawn(move || {
        let mut buf = [0u8; 16384];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    let _ = tx.send(buf[..n].to_vec());
                }
            }
        }
    });
    let mut writer = pair.master.take_writer().expect("writer");

    let drain = |quiet_ms: u64| -> String {
        std::thread::sleep(Duration::from_millis(quiet_ms));
        let mut acc: Vec<u8> = Vec::new();
        while let Ok(chunk) = rx.try_recv() {
            acc.extend_from_slice(&chunk);
        }
        String::from_utf8_lossy(&acc).into_owned()
    };

    let _ = drain(3000); // 等启动,丢历史

    let run = |writer: &mut Box<dyn Write + Send>, cmd: &str| {
        let _ = writer.write_all(format!("{cmd}\r").as_bytes());
        let _ = writer.flush();
    };

    println!("=== cols={cols}:默认 ls ===");
    run(&mut writer, "ls");
    println!("{}", strip_ansi(&drain(2500)));

    println!("=== cols={cols}:AutoSize 紧凑 ls(删别名+function 遮蔽) ===");
    run(
        &mut writer,
        "Remove-Item Alias:ls,Alias:dir -Force -ErrorAction SilentlyContinue ; function ls { $i = Get-ChildItem @args ; if ($i -and ($i | Select-Object -First 1).PSProvider.Name -eq 'FileSystem') { $i | Format-Table Mode,LastWriteTime,Length,Name -AutoSize } else { $i } } ; function dir { ls @args }",
    );
    let _ = drain(1500);
    run(&mut writer, "ls");
    println!("{}", strip_ansi(&drain(4000)));
    // 再收一轮(长列表输出可能分批)
    println!("{}", strip_ansi(&drain(2000)));

    println!("=== cols={cols}:大目录(node_modules)流式性 ===");
    run(
        &mut writer,
        "cd D:\\work\\rust\\muxy_rust\\node_modules ; (Get-ChildItem).Count ; ls",
    );
    let out = drain(6000);
    // 只打印行数与前 8 行(大目录不刷屏),验证不卡、行宽正常
    let text = strip_ansi(&out);
    let lines: Vec<&str> = text.lines().collect();
    println!("(总行数 {}) 前 10 行:", lines.len());
    for l in lines.iter().take(10) {
        println!("{l}");
    }

    let _ = child.kill();
}
