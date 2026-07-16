# Changelog

All notable changes to txuyStudio are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-07-16

First public release (MVP).

### Added

- **Real PTY backend** — `portable-pty` / Windows ConPTY, pooled `TauriPtyTransport`, with per-project PTY isolation (closing a project kills its PTY).
- **Multi-project workspace** — switch projects from the top bar; each project keeps its own shell layout and restores on reopen.
- **Detachable project windows** — right-click a project → open in an independent native window (move semantics); re-docks on restart.
- **Windows-Terminal-style pane splitting** — split right/down (nestable), close-to-refill, directional focus switching. Binary `paneTree` model persisted to `state.json`.
- **Per-pane multi-tab** — each pane holds a tab stack; switching tabs preserves xterm scrollback and input history.
- **Multiple shells per project** — PowerShell, `claude`, `codex`, and TUI tools (`lazygit` / `yazi` / `fresh`); uninstalled tools prompt with install commands (winget / scoop / npm).
- **Bundled prompt + font** — ships `oh-my-posh.exe` + a Tokyo Night theme + CaskaydiaCove Nerd Font for a consistent prompt on any Windows machine.
- **WT-style keyboard shortcuts** — `Alt+Shift+-` / `+` / arrows / `W`, `Ctrl+Shift+T` / `W`, `Ctrl+Tab`, `Ctrl+Alt+1…9`.
- **Status bar** — focused project path + git branch, live memory %, dismissible health reminder on a 30-min rotation.
- **Persisted layout & window bounds** — restored on reopen (`state.json`).
- **File tree + Monaco editor** — embedded file tree with Monaco-based preview/edit, lazy-loaded to keep first paint fast.
- **AI CLI session browser** — scan and resume `claude` / `codex` sessions.
- **i18n** — English / 中文.

[Unreleased]: https://github.com/timelove/txuyStudio-public/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/timelove/txuyStudio-public/releases/tag/v0.1.0
