# @marcfargas/pi-tramp

## 0.2.0

### Minor Changes

- [`804a763`](https://github.com/marcfargas/pi-tramp/commit/804a763d7b5fa831a6ca9f1d0c31cd1f6bfe4ab8) Thanks [@marcfargas](https://github.com/marcfargas)! - Initial alpha release — TRAMP-like transparent remote execution for pi.

  **Core features:**

  - SSH and Docker transports — pi stays local, tools execute remotely
  - All 4 pi tools overridden: `read`, `write`, `edit`, `bash`
  - Sentinel protocol for reliable SSH command demarcation
  - Serial command queue prevents concurrent session corruption
  - Shell escaping for bash and PowerShell targets
  - Base64 file I/O with 10MB limit
  - Connection pooling with lazy connect and dead connection eviction

  **Target management:**

  - `target` tool with list/switch/status/add/remove actions
  - Project and global config via `.pi/targets.json`
  - Context injection on target switch (system prompt + remote AGENTS.md)
  - Status bar indicator (🔗 SSH / 🐳 Docker)

  **Public API:**

  - `trampExec()` for other extensions to execute on remote targets

  **PowerShell support:**

  - Docker: direct pwsh exec with `.NET` method quoting fix
  - SSH: bash outer shell with `pwsh -NonInteractive -Command` wrapping
  - Per-command `$PSStyle`, `$ProgressPreference`, `$LASTEXITCODE` setup

- [`ae85278`](https://github.com/marcfargas/pi-tramp/commit/ae8527897c2cf1cfda17098fc2bc6603aff21202) Thanks [@marcfargas](https://github.com/marcfargas)! - Shell detection hardening and SSH shell requirement.

  **BREAKING CHANGE: SSH targets now require explicit `shell` configuration.**

  SSH targets must include `shell: "bash"`, `shell: "pwsh"`, or `shell: "sh"` in their
  config. Auto-detection has been removed — it proved unreliable across cmd.exe, PowerShell
  Desktop/Core, and bash on different platforms.

  **Shell parser hardening:**

  - `parseShellName()` handles Windows backslash paths and `.exe` suffix
  - `parsePlatform()` recognizes `Windows_NT` output
  - `parsePwshVersion()` strict digit-only validation (rejects garbage like "7junk")
  - All parsers strip ANSI escape codes
  - `parseArch()` rejects absurdly long values

  **Bug fixes:**

  - `access()` now checks exit code, not just stdout string
  - `cmd` removed from `ShellTypeSchema` (no CmdDriver exists)
  - SSH stderr limitation documented (PTY multiplexing, always empty)
  - Serialization test now proves non-overlap with timing assertions
  - `afterAll` guards prevent teardown crashes when setup fails

  **CI improvements:**

  - Test containers cached in GHCR (pull-or-build pattern, ~5 min saved per run)
  - Fork PRs build locally without push (read-only GITHUB_TOKEN)
  - GHCR owner lowercased for compatibility

## 0.2.0-beta.0

### Minor Changes

- [`804a763`](https://github.com/marcfargas/pi-tramp/commit/804a763d7b5fa831a6ca9f1d0c31cd1f6bfe4ab8) Thanks [@marcfargas](https://github.com/marcfargas)! - Initial alpha release — TRAMP-like transparent remote execution for pi.

  **Core features:**

  - SSH and Docker transports — pi stays local, tools execute remotely
  - All 4 pi tools overridden: `read`, `write`, `edit`, `bash`
  - Sentinel protocol for reliable SSH command demarcation
  - Serial command queue prevents concurrent session corruption
  - Shell escaping for bash and PowerShell targets
  - Base64 file I/O with 10MB limit
  - Connection pooling with lazy connect and dead connection eviction

  **Target management:**

  - `target` tool with list/switch/status/add/remove actions
  - Project and global config via `.pi/targets.json`
  - Context injection on target switch (system prompt + remote AGENTS.md)
  - Status bar indicator (🔗 SSH / 🐳 Docker)

  **Public API:**

  - `trampExec()` for other extensions to execute on remote targets

  **PowerShell support:**

  - Docker: direct pwsh exec with `.NET` method quoting fix
  - SSH: bash outer shell with `pwsh -NonInteractive -Command` wrapping
  - Per-command `$PSStyle`, `$ProgressPreference`, `$LASTEXITCODE` setup

- [`ae85278`](https://github.com/marcfargas/pi-tramp/commit/ae8527897c2cf1cfda17098fc2bc6603aff21202) Thanks [@marcfargas](https://github.com/marcfargas)! - Shell detection hardening and SSH shell requirement.

  **BREAKING CHANGE: SSH targets now require explicit `shell` configuration.**

  SSH targets must include `shell: "bash"`, `shell: "pwsh"`, or `shell: "sh"` in their
  config. Auto-detection has been removed — it proved unreliable across cmd.exe, PowerShell
  Desktop/Core, and bash on different platforms.

  **Shell parser hardening:**

  - `parseShellName()` handles Windows backslash paths and `.exe` suffix
  - `parsePlatform()` recognizes `Windows_NT` output
  - `parsePwshVersion()` strict digit-only validation (rejects garbage like "7junk")
  - All parsers strip ANSI escape codes
  - `parseArch()` rejects absurdly long values

  **Bug fixes:**

  - `access()` now checks exit code, not just stdout string
  - `cmd` removed from `ShellTypeSchema` (no CmdDriver exists)
  - SSH stderr limitation documented (PTY multiplexing, always empty)
  - Serialization test now proves non-overlap with timing assertions
  - `afterAll` guards prevent teardown crashes when setup fails

  **CI improvements:**

  - Test containers cached in GHCR (pull-or-build pattern, ~5 min saved per run)
  - Fork PRs build locally without push (read-only GITHUB_TOKEN)
  - GHCR owner lowercased for compatibility
