# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in txuyStudio, please report it **privately** — do **not** open a public GitHub issue.

**Preferred:** open a private security advisory via GitHub:

👉 https://github.com/timelove/txuyStudio-public/security/advisories/new

Please include:

- A description of the issue and its potential impact
- Steps to reproduce / a minimal proof of concept
- The affected version (see `package.json` / `tauri.conf.json`)

You should receive an initial response within 72 hours. Please do not disclose the issue publicly until it has been triaged and addressed.

## Scope

txuyStudio spawns local shell processes (PTY via Windows ConPTY), reads and writes local files, and executes commands on the user's machine. Vulnerabilities that enable **arbitrary command execution, privilege escalation, or unintended filesystem access** from untrusted input are in scope.

## Out of Scope

- A user deliberately running a destructive command in their own terminal. txuyStudio is a terminal — running `Remove-Item`, `git reset --hard`, etc. is expected behavior. (Destructive-command interception is on the roadmap; see `README.md`.)
- Vulnerabilities in bundled third-party tools (oh-my-posh, the Cascadia Code Nerd Font). Report those upstream — see `THIRD_PARTY_NOTICES.md`.
