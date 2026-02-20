# pi-tramp Handoff

**Date**: 2026-02-20
**From**: Design session (Opus 4.6 on mypi)
**To**: Implementation agents on pi-tramp

## What Is This

pi-tramp is a pi extension for TRAMP-like transparent remote execution. Pi stays local, tools (read/write/edit/bash) execute on remote targets via SSH or Docker exec.

## Current State

- ✅ Design document complete: `docs/DESIGN.md`
- ✅ 3-stage design review complete: `docs/reviews/`
- ✅ Takeaways distilled: `docs/TAKEAWAYS.md`
- ✅ Author decisions recorded: `docs/reviews/stage-1/decisions.md`
- ✅ TODOs created for all remaining work
- ❌ 8 specifications not yet written (see TODO list, tag: `spec`)
- ❌ 3 interface gaps not yet addressed (see TODO list, tag: `gap`)
- ❌ SSH sentinel prototype not yet built (see TODO list, tag: `prototype`)
- ❌ Project not yet scaffolded (no package.json, no tsconfig)

## How To Start

### Step 1: Read Context (30 min)
1. `docs/DESIGN.md` — the full vision
2. `docs/TAKEAWAYS.md` — distilled from 3-stage review
3. `docs/reviews/stage-1/decisions.md` — author's scope decisions
4. `todo list` — see all open work items

### Step 2: Write Specs (Day -3 to Day -1)
8 specs must be written before any code. Each has a TODO with exact requirements:
- Sentinel protocol algorithm
- Shell escaping algorithm
- Shell detection commands
- CRLF handling policy
- Atomic write strategy
- TargetConfig Zod schema
- Error message format
- trampExec() public API

These can be parallelized — each spec is independent.

### Step 3: Fill Interface Gaps (Day -2)
3 gaps found in Stage 3 review. Each has a TODO:
- Initial target selection (default field)
- Context injection trigger (TargetManager event)
- Temp file cleanup (UUID naming)

### Step 4: Prototype (Day -1)
Build `prototype/ssh-sentinel.mjs` — standalone Node.js script.
Validates the hardest assumption. Must pass in 2-4 hours.
If it takes >1 day, the sentinel approach needs revision.

### Step 5: Scaffold (Day 0)
Set up package.json, tsconfig, vitest, Dockerfiles, .gitignore.

### Step 6: Implement (Weeks 1-6)
Follow the build order in TAKEAWAYS.md:
1. Interfaces → TargetManager → ShellDrivers (Week 1)
2. DockerTransport + ConnectionPool (Week 2)
3. SshTransport + sentinel (Weeks 3-4)
4. operations-remote + tool-overrides + target-tool (Week 5)
5. Context injection + status bar + extension.ts (Week 6)

### Step 7: Integrate & Ship (Weeks 7-9)
End-to-end tests, dog-fooding, bug fixes, docs.

## Key Design Decisions (Non-Negotiable)

These were decided by the author and must not be revisited:

1. **SSH + Docker together** — both transports ship in Phase 1
2. **All 4 tool overrides** — read/write/edit/bash are the core
3. **SSH keys only** — no password auth
4. **Serial command queue** — per-target, from day one
5. **`sendMessage` for context injection** — not system prompt duplication
6. **10MB binary limit** — fail fast with clear error
7. **Edit = read-apply-write** — 2 round trips, preserve exact bytes
8. **Shell detection on connect** — no probing for alternatives
9. **pi-tramp must be the ONLY extension overriding core tools**

## What NOT To Do

- ❌ Don't start with Docker-only (reviewers suggested it, author rejected it)
- ❌ Don't build both context injection approaches
- ❌ Don't abstract BashDriver and PwshDriver (separate implementations, no shared logic)
- ❌ Don't skip shell escaping tests against real shells
- ❌ Don't defer token measurement to later phases
- ❌ Don't assume `ctx.isUserInitiated` exists (it doesn't — blocked upstream)

## TODO Tags Guide

| Tag | Meaning |
|-----|---------|
| `master` | Master tracking TODO |
| `spec` | Specification to write before coding |
| `gap` | Interface gap to fill before coding |
| `prototype` | Prototype to build before coding |
| `scaffold` | Project setup |
| `impl` | Implementation task |
| `tier-N` | Dependency tier (build bottom-up: 0→7) |
| `week-N` | Estimated week |
| `test` | Testing task |
| `docs` | Documentation task |
| `upstream` | Upstream pi issue/feature request |

## File Structure (Target)

```
pi-tramp/
├── .pi/
│   ├── AGENTS.md
│   └── .project-owner
├── docs/
│   ├── DESIGN.md
│   ├── TAKEAWAYS.md
│   └── reviews/          (3-stage review artifacts)
├── specs/                 (8 specs, to be written)
├── prototype/             (SSH sentinel prototype)
├── src/
│   ├── types.ts           (Tier 0: interfaces)
│   ├── target-manager.ts  (Tier 1)
│   ├── shell/
│   │   ├── bash-driver.ts (Tier 1)
│   │   └── pwsh-driver.ts (Tier 1)
│   ├── transport/
│   │   ├── command-queue.ts  (Tier 2)
│   │   ├── docker-transport.ts (Tier 2)
│   │   └── ssh-transport.ts    (Tier 2)
│   ├── connection-pool.ts (Tier 3)
│   ├── operations/
│   │   ├── remote-read.ts  (Tier 4)
│   │   ├── remote-write.ts (Tier 4)
│   │   ├── remote-edit.ts  (Tier 4)
│   │   └── remote-bash.ts  (Tier 4)
│   ├── tool-overrides.ts  (Tier 5)
│   ├── target-tool.ts     (Tier 5)
│   ├── context-injection.ts (Tier 6)
│   └── extension.ts       (Tier 7: entry point)
├── test/
│   ├── fixtures/
│   │   ├── docker-target/Dockerfile
│   │   ├── ssh-server/Dockerfile
│   │   └── pwsh-target/Dockerfile
│   └── ...
├── HANDOFF.md
├── README.md
├── package.json
└── tsconfig.json
```
