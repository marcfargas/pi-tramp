# pi-tramp — Handoff

Current state for future sessions. Read this first.

## Status: v1.0 Feature Complete, CI Hardening

All code is implemented and tested locally. CI matrix covers Linux + Windows.
Windows container SSH tests may still need iteration (ssh-keygen passphrase quoting).

## Branch Structure

- **`main`** — clean, release-ready. Release workflow publishes from here.
- **`develop`** — active development. PR to main for releases.

## Test Status

- **128 unit tests** — pass on Linux + Windows × Node 20/22/24
- **49 e2e integration tests** — parameterized 4 scenarios: Docker×bash, Docker×pwsh, SSH×bash, SSH×pwsh
- **Linux CI integration**: ✅ all green
- **Windows CI integration**: Docker tests pass, SSH tests pending (key generation issue)

## Key Files

| File | Purpose |
|------|---------|
| `src/types.ts` | All interfaces + Zod schemas |
| `src/transport/ssh-transport.ts` | Persistent SSH with sentinel protocol |
| `src/transport/docker-transport.ts` | One-shot docker exec |
| `src/shell/bash-driver.ts` | Bash shell escaping + command generation |
| `src/shell/pwsh-driver.ts` | PowerShell escaping + .NET API commands |
| `src/operations/remote-ops.ts` | Read/Write/Edit/Bash operations |
| `src/connection-pool.ts` | Lazy connect, caching, dead eviction |
| `src/target-manager.ts` | Config CRUD, switching, events |
| `src/target-tool.ts` | The `target` tool (list/switch/add/remove/status) |
| `src/tool-overrides.ts` | Conditional routing: local vs remote |
| `src/extension.ts` | Entry point wiring everything together |
| `test/helpers/platform.ts` | Cross-platform test helpers |
| `test/fixtures/ssh-server/Dockerfile` | Linux test container (bash + pwsh) |
| `test/fixtures/windows-ssh-server/Dockerfile` | Windows test container (Server Core) |

## Known Issues

1. **Windows SSH key in CI** — PowerShell mangles empty string to ssh-keygen `-N ""`.
   Current fix: `SHELL ["cmd"]` for that one step. May need more iteration.

2. **`registerTool` rendering** — upstream pi bug. When pi-tramp overrides tools,
   the tool description in the TUI can render incorrectly. `TODO-e4709f1f`.

3. **`ctx.isUserInitiated`** — upstream pi. Tool overrides should skip confirmation
   when the user invoked the tool directly. `TODO-b6b49b8a`.

4. **BashDriver requires `base64`** — MinGit on Windows doesn't include it.
   Full Git for Windows or Linux coreutils required. Could add fallback (certutil,
   python, perl) in Phase 2.

## Architecture Decisions

- **Windows SSH binary**: Always use `C:\Windows\System32\OpenSSH\ssh.exe` for agent access
- **pwsh over SSH**: bash is the outer shell (sentinel protocol). pwsh commands wrapped in `pwsh -NoProfile -NonInteractive -Command '...'`
- **Shell auto-detection**: Marker-based probe (`PITRAMP_PWSH_<uuid>`), not version parsing
- **Reconnect on pwsh detect**: Kill SSH and respawn with clean flags after auto-detecting pwsh login shell
- **cwd optional**: Auto-detected from remote home directory on connect
- **CRLF**: Handled by pi's `createEditTool` transparently — no pi-tramp code needed
- **Exit codes in tests**: Docker pwsh uses `exit N` (ephemeral). SSH pwsh spawns child `pwsh -c 'exit N'` (persistent session)
