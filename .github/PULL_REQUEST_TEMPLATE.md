## Description

<!-- Briefly describe what this PR does and why. 简要描述这个 PR 做了什么、为什么。 -->

## Type of Change

- [ ] Bug fix (non-breaking change which fixes an issue)
- [ ] New feature (non-breaking change which adds functionality)
- [ ] Breaking change (fix or feature that would cause existing functionality not to work as expected)
- [ ] Documentation update
- [ ] Refactor / code quality

## Checklist

- [ ] I have read [CONTRIBUTING.md](https://github.com/timelove/txuyStudio-public/blob/main/CONTRIBUTING.md)
- [ ] `bun run build` passes (tsc + vite build)
- [ ] `cargo check` passes (inside `src-tauri/`)
- [ ] My changes follow the existing code style in the surrounding file
- [ ] The `TerminalTransport` boundary is respected (frontend components do **not** call Tauri PTY commands directly)

## Related Issue

<!-- e.g. closes #123 -->
