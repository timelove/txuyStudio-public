//! Fleet Worker:git 命令薄封装。
//!
//! 全部走 [`txuy_core::proc::command_no_window`](CREATE_NO_WINDOW,防 release GUI 下
//! spawn `git` 弹黑窗),cwd 固定主仓根。git 调用是阻塞 IO,一律在 command 层丢
//! `spawn_blocking`,本模块保持纯同步函数。失败返回 `Err(String)` 带 stderr,前端 toast。

use std::path::Path;

/// 在 `cwd` 下跑 git,吃 stdout,失败 Err 带 stderr。
pub fn git(cwd: &Path, args: &[&str]) -> Result<String, String> {
    let out = txuy_core::proc::command_no_window("git")
        .args(args)
        .current_dir(cwd)
        .output()
        .map_err(|e| format!("git {}: {e}", args.join(" ")))?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
        return Err(format!(
            "git {} failed: {}",
            args.join(" "),
            if stderr.is_empty() { out.status.to_string() } else { stderr }
        ));
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

/// 同 [`git`],但输出按行收集(trim 后过滤空行)。
pub fn git_lines(cwd: &Path, args: &[&str]) -> Result<Vec<String>, String> {
    Ok(git(cwd, args)?
        .lines()
        .map(|l| l.trim().to_string())
        .filter(|l| !l.is_empty())
        .collect())
}

/// 判断路径是否在 git 仓内(仓库根即 `git rev-parse --show-toplevel` 成功)。
/// worktree 的 toplevel 会返回 worktree 根,但主仓根路径传进来即主仓根。
pub fn repo_root(root: &Path) -> Result<String, String> {
    git(root, &["rev-parse", "--show-toplevel"])
}

/// `git worktree add <path> -b <branch>`(从当前 HEAD 拉新分支)。
/// 主仓根 cwd 调用,worktree 目录在项目外兄弟目录。
pub fn worktree_add(root: &Path, path: &Path, branch: &str) -> Result<(), String> {
    git(
        root,
        &[
            "worktree",
            "add",
            &path.to_string_lossy(),
            "-b",
            branch,
        ],
    )
    .map(|_| ())
}

/// `git worktree remove`(--force 容忍未提交改动/锁)。worktree 已不存在时幂等成功。
pub fn worktree_remove(root: &Path, path: &Path) -> Result<(), String> {
    let s = path.to_string_lossy().into_owned();
    let res = git(root, &["worktree", "remove", "--force", &s]);
    match res {
        Ok(_) => Ok(()),
        Err(e) => {
            // 「not a working tree」= 已被外部移除 → 幂等 Ok。
            if e.contains("is not a working tree") || e.contains("not a working tree") {
                Ok(())
            } else {
                // 目录可能被外部占用(--force 仍失败):目录在就直接 fs 删掉再 prune,
                // 不让垃圾目录卡住 worker 回收。
                if path.exists() {
                    let _ = std::fs::remove_dir_all(path);
                    git(root, &["worktree", "prune"]).map(|_| ())?;
                }
                Err(e)
            }
        }
    }
}

/// `git worktree list --porcelain`:返回每条 (worktree 路径, 分支名)。detached
/// HEAD 无分支 → None;主仓本身也是第一条(路径 = 仓根),调用方自行过滤。
pub fn worktree_list(root: &Path) -> Result<Vec<(String, Option<String>)>, String> {
    let out = git(root, &["worktree", "list", "--porcelain"])?;
    let mut list: Vec<(String, Option<String>)> = Vec::new();
    let mut path: Option<String> = None;
    let mut branch: Option<String> = None;
    for line in out.lines() {
        if let Some(p) = line.strip_prefix("worktree ") {
            if let Some(prev) = path.take() {
                list.push((prev, branch.take()));
            }
            path = Some(p.trim().to_string());
        } else if let Some(b) = line.strip_prefix("branch ") {
            // 形如 refs/heads/fleet/foo → 去 refs/heads/ 前缀留短名。
            branch = b.trim().strip_prefix("refs/heads/").map(str::to_string);
        }
        // HEAD / detached / bare 行不关心。
    }
    if let Some(prev) = path.take() {
        list.push((prev, branch.take()));
    }
    Ok(list)
}

/// `git branch -D <branch>`(丢弃分支)。分支不存在时幂等成功。
pub fn branch_delete(root: &Path, branch: &str) -> Result<(), String> {
    match git(root, &["branch", "-D", branch]) {
        Ok(_) => Ok(()),
        Err(e) if e.contains("not found") || e.contains("did not match") => Ok(()),
        Err(e) => Err(e),
    }
}

/// worker 分支相对主仓 HEAD 的 diff 统计(`git diff --numstat base..branch`)。
/// 返回 (文件数, 增行, 删行)。
pub fn diff_stat(root: &Path, base: &str, branch: &str) -> Result<(usize, u64, u64), String> {
    let lines = git_lines(root, &["diff", "--numstat", &format!("{base}...{branch}")])?;
    let mut files = 0usize;
    let mut added = 0u64;
    let mut removed = 0u64;
    for l in &lines {
        // --numstat 行格式: "<added>\t<removed>\t<path>",二进制文件为 "-\t-\t<path>"。
        let mut parts = l.split('\t');
        let a = parts.next().unwrap_or("0");
        let r = parts.next().unwrap_or("0");
        files += 1;
        added += a.parse::<u64>().unwrap_or(0);
        removed += r.parse::<u64>().unwrap_or(0);
    }
    Ok((files, added, removed))
}

/// `git merge-tree`(干跑)预判合并冲突。返回冲突文件列表(空 = 可干净合并)。
///
/// 用 `--write-tree` 两分支形态(git 2.38+):`merge-tree <branch1> <branch2>`
/// 自动取 merge-base 干跑合并。干净时输出 tree oid、退出码 0;有冲突时退出码 1
/// 且输出含冲突文件列表(`--name-only` 只列文件)。老 git 不支持时返回 Err,
/// 由调用方决定降级(提示用户直接试合并)。
/// (2026-11-18 修:曾写成 `base...theirs` 三点 range 语法——那是 diff/log 的
/// 语法,merge-tree 不认,usage 报错被下面的老版本探测误抓成「requires git
/// 2.38+」,用户 git 2.45 也被拦。)
pub fn merge_tree_conflicts(root: &Path, base: &str, theirs: &str) -> Result<Vec<String>, String> {
    let out = txuy_core::proc::command_no_window("git")
        .args([
            "merge-tree",
            "--write-tree",
            "--name-only",
            base,
            theirs,
        ])
        .current_dir(root)
        .output()
        .map_err(|e| format!("git merge-tree: {e}"))?;
    // 退出码:0 干净 / 1 冲突 / 其他错误。
    if out.status.success() {
        return Ok(Vec::new());
    }
    let stderr = String::from_utf8_lossy(&out.stderr);
    // 老版本 git(无 --write-tree)会打 usage 到 stderr。
    if stderr.contains("usage:") || stderr.contains("unknown option") {
        return Err("merge-tree --write-tree requires git 2.38+".into());
    }
    if out.status.code() == Some(1) {
        // --name-only:首行冲突 tree oid,其后每行一个冲突文件;文件列表后以空行
        // 结束,再往后是 Auto-merging/CONFLICT 信息段(2026-11-18 实测:无脑收非空
        // 行会把信息行混进冲突列表)——取到首个空行为止。
        let files: Vec<String> = String::from_utf8_lossy(&out.stdout)
            .lines()
            .skip(1)
            .map(|l| l.trim().to_string())
            .take_while(|l| !l.is_empty())
            .collect();
        return Ok(files);
    }
    Err(format!(
        "git merge-tree failed: {}",
        if stderr.trim().is_empty() { out.status.to_string() } else { stderr.trim().to_string() }
    ))
}

/// 在主仓根把 worker 分支 merge 进当前分支(`--no-ff` 保留 worker 边界,merge commit
/// 消息标注 taskId)。要求工作区干净由调用方预检(`has_uncommitted`)。
pub fn merge_branch(root: &Path, branch: &str, message: &str) -> Result<(), String> {
    git(root, &["merge", "--no-ff", branch, "-m", message]).map(|_| ())
}

/// 主仓当前分支是否有未提交改动(merge 前预检)。
pub fn has_uncommitted(root: &Path) -> Result<bool, String> {
    let out = git(root, &["status", "--porcelain"])?;
    Ok(!out.is_empty())
}
