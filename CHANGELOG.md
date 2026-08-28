# Changelog

All notable changes to txuyStudio are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.6] - 2026-08-28

Input / terminal / session polish release.

### Added

- **Alt+Enter hard line break** in the AI input boxes (Claude & Codex) — never triggers send or panel selection; IME-safe.
- **Auto-growing input box** — `field-sizing` grows the textarea with content up to 160px; the ugly native scrollbar is gone (wheel / arrow keys still scroll).
- **Ctrl+A smart select** — with the caret inside a tool output / code `<pre>` block in the message stream, Ctrl+A selects just that block for a one-keystroke copy.
- **Session title fallback** — untitled sessions (no AI title / no user_message event) now show the first real user message (trimmed to 60 chars) instead of "(untitled) + id" in the resume dropdowns and session browser.
- **Stepper buttons on settings sliders** — font size, background blur and dim sliders get −/+ buttons (float steps quantized, endpoints auto-disable).
- **Reveal in folder** — clicking a file path in tool cards (and `/memory`, `/agents`, `/skills`, `/mcp`, codex `/init`) opens Explorer with the file selected; no editor involved.

### Fixed

- **Detached project window drag** — the inner title-bar flex layer now carries the drag region, so the detached window can be dragged again (Tauri's bare-attribute rule only honors the direct click target).
- **Background-task notices wrap** — long command strings in completion / failure notices no longer force a horizontal scrollbar on the message stream.
- **Thinking block height cap** — expanded thinking scrolls internally (max ~320px) and auto-follows the latest output; scrolling up pauses follow, scrolling back to bottom resumes.
- **Terminal padding unified** — whitespace lives on the `.xterm` element itself, so the terminal background is one continuous block (no color seam with glass/blur backgrounds).
- **Status line font scaling** — the busy/thinking status line above the input box now scales with the global font size (matches the card footer bar).

### Changed

- "Back to main window" is now an icon-only button with a tooltip (no more wrapped text).

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

[Unreleased]: https://github.com/timelove/txuyStudio-public/compare/v0.1.6...HEAD
[0.1.6]: https://github.com/timelove/txuyStudio-public/compare/v0.1.0...v0.1.6
[0.1.0]: https://github.com/timelove/txuyStudio-public/releases/tag/v0.1.0
