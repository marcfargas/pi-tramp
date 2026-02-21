---
"@marcfargas/pi-tramp": minor
---

Initial alpha release — TRAMP-like transparent remote execution for pi.

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
