# pi-tramp — Handoff Document

## Status: Phase 1 Implementation Complete

All 7 implementation tiers are done. 204 tests passing (131 unit + 73 integration).

## Architecture

```
src/
  types.ts                      Tier 0: Interfaces, Zod schemas, error types
  shell/
    bash-driver.ts              Tier 1: POSIX shell escaping + command gen
    pwsh-driver.ts              Tier 1: PowerShell escaping + command gen
  target-manager.ts             Tier 1: Config loading, CRUD, switching, events
  transport/
    command-queue.ts            Tier 2: Serial execution queue
    shell-detect.ts             Tier 2: Remote shell/platform probing
    docker-transport.ts         Tier 2: One-shot docker exec
    ssh-transport.ts            Tier 2: Persistent SSH + sentinel protocol
  connection-pool.ts            Tier 3: Lazy connect, cache, reconnect
  operations/
    remote-ops.ts               Tier 4: pi's Read/Write/Edit/BashOperations
  tool-overrides.ts             Tier 5: Conditional read/write/edit/bash routing
  target-tool.ts                Tier 5: target list/switch/status/add/remove
  context-injection.ts          Tier 6: System prompt, AGENTS.md, status bar
  tramp-exec.ts                 Tier 6: Public API for other extensions
  extension.ts                  Tier 7: Entry point wiring everything

test/
  types.test.ts                 16 tests: Zod schemas, error classes
  shell-escaping.test.ts        67 tests: Real shell round-trips (bash + pwsh)
  shell-detect.test.ts          14 tests: Shell/platform/arch parsing
  target-manager.test.ts        25 tests: Config, CRUD, switching, events
  command-queue.test.ts          5 tests: Serial execution, drain, errors
  connection-pool.test.ts        4 tests: Error cases, empty pool
  docker-transport.integration   16 tests: Real Docker container
  ssh-transport.integration      17 tests: Real SSH via Docker
  remote-ops.integration         10 tests: Operations via Docker
  e2e.integration                30 tests: Full stack × both transports
```

## Key Design Decisions

1. **RuntimeState pattern**: Extension recreates TargetManager/Pool on session_start
   (gets cwd from pi). Tool closures reference `state.pool` / `state.targetManager`.
2. **No mocks for shell tests**: All escaping tests run against real bash and pwsh.
3. **Sentinel protocol**: UUID-based markers delimit SSH command output. `-T` (no PTY).
4. **Windows SSH**: Uses `C:\Windows\System32\OpenSSH\ssh.exe` for agent key access.
5. **Serial queue**: Commands are serialized per transport to prevent SSH corruption.
6. **createXxxTool pattern**: Tool overrides spread local tool's schema/render, override execute.

## What's Left

### Must-do before v1.0 ship
- [ ] Dog-food on a real project
- [ ] Handle CRLF in edit operations (line ending detection + normalization)
- [ ] walkman (pwsh) e2e tests (currently only bash targets tested in CI)

### Upstream blockers (filed, not blocking v1.0)
- `registerTool` multi-override rendering bug (TODO-e4709f1f)
- `ctx.isUserInitiated` for confirmation bypass (TODO-b6b49b8a)

### Phase 2 (post v1.0)
- Port forwarding
- ControlMaster (Unix SSH multiplexing)
- WSL transport
- PSRemote transport
- Credential forwarding

## Test Infrastructure

Docker image: `pi-tramp-ssh-test` (built from `test/fixtures/ssh-server/Dockerfile`)
```bash
docker build -t pi-tramp-ssh-test test/fixtures/ssh-server/
docker run -d --name pi-tramp-ssh-test -p 2222:22 pi-tramp-ssh-test
```

SSH test key at `$TEMP/pi-tramp-test-key` (extracted from container on test run).

walkman (Windows + pwsh): `marc@walkman.blegal.cloud:212` — for pwsh integration tests.
