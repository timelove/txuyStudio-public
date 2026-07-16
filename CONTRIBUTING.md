# Contributing to txuyStudio

Thanks for your interest in contributing! txuyStudio is an AI CLI terminal workspace for Windows developers (Tauri + Rust + React + xterm.js).

## Development Setup

**Prerequisites**

- [Bun](https://bun.sh) — package manager & script runner (npm/yarn are not used)
- [Rust toolchain](https://rustup.rs) — Tauri backend
- Node.js 20.19+ (required by Vite; the `dev` script pins Node 22 via [Volta](https://volta.sh) — see `package.json`)
- Windows (the PTY backend uses ConPTY)

**Get it running**

```powershell
git clone https://github.com/timelove/txuyStudio-public.git
cd txuyStudio-public
bun install
bun run tauri dev    # launches Vite (:1420) + the Tauri window
```

> In a fresh PowerShell session, Rust may not be on `PATH`. Add it if needed:
> `$env:Path += ";$env:USERPROFILE\.cargo\bin"`

## Read This First

Read [`README.md`](README.md) — especially the **Architecture Note** on the `TerminalTransport` interface. It is the key seam between the frontend and the PTY backend, and the most important convention to respect:

- **Frontend** (`src/`) talks to the PTY **only** through the `TerminalTransport` interface (`src/domain/terminalTransport.ts`). Do **not** call Tauri PTY commands directly from components.
- **Backend** (`src-tauri/src/`) keeps PTY sessions in a registry. Every command clones / finishes its synchronous work inside the lock scope and **never** holds a `std::sync::Mutex` across an `.await`.

## Before Submitting a Pull Request

- [ ] `bun run build` passes (tsc type-check + vite build)
- [ ] `cargo check` passes (run inside `src-tauri/`)
- [ ] Changes are focused — one concern per PR
- [ ] Existing code style in the surrounding file is followed

## Issues vs Security

Use [GitHub Issues](https://github.com/timelove/txuyStudio-public/issues) for bugs and feature requests. For security issues, follow [`SECURITY.md`](SECURITY.md) instead — do **not** file a public issue.

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE).
