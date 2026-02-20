# Design Review Takeaways

3-stage design review conducted 2026-02-20.
Reviewers: `_arch-reviewer` (claude-sonnet-4-5), `_impl-reviewer` (claude-sonnet-4-6), `_synthesizer` (claude-sonnet-4-5).

## Verdict

**Architecture is sound. Ready to implement after spec work.**

The TRAMP vision (pi stays local, tools execute remotely, agent is boundary-aware) survives decomposition and recomposition intact. The Operations abstraction is the correct boundary. The dependency graph is a clean DAG with zero cycles.

## Critical Findings

### Must Specify Before Coding (8 specs)

1. **Sentinel Protocol Algorithm** — UUID-based sentinel, line-buffered stdout reader, timeout behavior, pwsh color suppression
2. **Shell Detection Commands** — `echo "$0"` + `$PSVersionTable` probe, parsing rules, dash vs bash distinction
3. **Shell Escaping Algorithm** — BashDriver + PwshDriver concrete implementations, tested against real shells
4. **CRLF Handling Policy** — Preserve exact bytes, normalize oldText for matching, clear error messages
5. **Atomic Write Strategy** — Bash: temp + mv (POSIX atomic). Pwsh: temp + Move-Item (best-effort)
6. **TargetConfig Zod Schema** — Full config validation with clear error messages
7. **trampExec() Public API** — `trampExec(command, options?)` signature locked before v1.0
8. **Error Message Format** — Standardized across all 4 tools for LLM consumption

### Interface Gaps (3 additions to design)

1. **Initial target selection** — Add `default` field to targets.json config
2. **Context injection trigger** — TargetManager emits `target_switched` event → extension calls `sendMessage`
3. **Temp file cleanup** — UUID-based tmp filenames to prevent collisions

### Key Risks (ordered by severity)

1. 🔴 PowerShell ANSI color codes corrupt sentinel output
2. 🔴 Shell escaping breaks on first non-trivial path
3. 🔴 Concurrent tool calls corrupt SSH session (serial queue is non-negotiable)
4. 🟡 CRLF mismatch in edit on Windows targets
5. 🟡 SSH reconnect leaves tool calls hanging
6. 🟢 Tool override silently overwritten by another extension
7. 🟢 Token budget blowup with large remote AGENTS.md

### Author's Scope Decisions (overriding reviewers)

- **SSH + Docker together** — validates common architecture against both transports
- **All 4 tool overrides** — read/write/edit/bash are the core, not optional
- **SSH keys only** — no password auth complexity
- **`/target switch` bypasses confirmation** — blocked upstream (needs `ctx.isUserInitiated` from pi)

## Timeline

**7-9 weeks** for Phase 1 (SSH + Docker + all 4 tool overrides).

| Week | Deliverable |
|------|-------------|
| 1 | Interfaces, TargetManager, ShellDrivers |
| 2 | DockerTransport, ConnectionPool |
| 3-4 | SshTransport, sentinel protocol, lifecycle |
| 5 | operations-remote (all 4 ops) |
| 5.5 | tool-overrides, target-tool |
| 6 | System prompt, context injection, status bar |
| 7-9 | Integration debugging, dog-fooding, docs |

## Build Order

```
Tier 0: Transport + ShellDriver interfaces
Tier 1: BashDriver, PwshDriver, TargetManager (pure logic)
Tier 2: DockerTransport, SshTransport (transport implementations)
Tier 3: ConnectionPool (lifecycle manager)
Tier 4: RemoteReadOps, RemoteWriteOps, RemoteEditOps, RemoteBashOps
Tier 5: tool-overrides, target-tool (pi runtime boundary)
Tier 6: system-prompt, context-injection, status-bar, trampExec
Tier 7: extension.ts entry point
```

## One Prototype First

Before any extension code: standalone SSH sentinel protocol script (~100 lines).
Validates the hardest assumption in 2-4 hours. If it takes >1 day, the approach needs revision.

## Full Review Artifacts

- `docs/reviews/stage-1/` — Overall design review + decomposition
- `docs/reviews/stage-2/` — Component-level review + interface specs
- `docs/reviews/stage-3/` — Composition integrity + build plan
