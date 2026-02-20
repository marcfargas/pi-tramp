# Task: Implementation Review of Decomposed Pieces

Read these files in order:
1. `C:/dev/mypi/experiments/pi-tramp/DESIGN.md` — the full design
2. `C:/dev/mypi/experiments/pi-tramp/reviews/stage-1/synthesis.md` — Stage 1 review synthesis
3. `C:/dev/mypi/experiments/pi-tramp/reviews/stage-1/decisions.md` — author's decisions

Stage 1 produced a decomposition. The author made key decisions:
- SSH + Docker together (NOT Docker-first) — validates architecture faster
- ALL four tool overrides (read/write/edit/bash) in Phase 1 — core of the project
- `/target switch` bypasses requireEntryConfirmation when user-issued
- SSH keys only, no passwords

Now review the **implementation reality** of each piece. Focus on what's hard to build, what will break, and where specs are missing.

## Components to Review

For each component, answer:

### 1. Transport Interface
- What's the exact TypeScript signature? Are generics needed?
- SSH returns stdout/stderr from a persistent shell. Docker exec returns from a subprocess. Can one interface cover both without leaking abstractions?
- Error types: connection lost vs command failed vs timeout — are these distinguishable?

### 2. ShellDriver (BashDriver + PwshDriver)
- `shellEscape(arg)` — concrete algorithm for bash and pwsh. Show examples of tricky cases (paths with spaces, quotes, dollar signs, backticks).
- Command construction for `edit`: the agent sends oldText/newText. How does this become a remote command? Options: sed, awk, python one-liner, temp files. What works across bash AND pwsh?
- Atomic writes: `write` must not leave partial files. What's the strategy per shell?

### 3. TargetManager
- Config schema — propose a concrete `targets.json` with all fields. Include SSH and Docker examples.
- Merge algorithm — what happens when global says `requireEntryConfirmation: true` but project says `false`?

### 4. ConnectionPool
- Connection reuse when target is switched away and back — reconnect or cache?
- Max connections? Timeout for idle connections?
- Error recovery: SSH drops mid-command. What state is the pool in? What does the agent see?

### 5. operations-remote — The Edit Problem
This is the hardest piece. `edit` receives `{path, oldText, newText}`. On local, pi reads the file, finds the exact match, replaces, writes back. Remotely:
- Option A: Read file → local edit → write back (2 round trips)
- Option B: Send a `sed` command (escaping nightmare)
- Option C: Write a helper script to the remote, invoke it
- Which option? Why? What are the failure modes?

### 6. tool-overrides
- When no target is active, calls pass through to local. How? Does pi-tramp register tools that check state, or does it conditionally register/unregister?
- Registration order: pi-tramp must be last. How is this enforced?

### 7. target-tool
- What happens if the agent calls `target create` with an SSH host that's unreachable? Fail immediately? Fail on first use?
- Confirmation gate UX: agent calls `target switch production`, confirmation is required. What does the tool return to the agent? An error? A pending state?

### 8. Sentinel Protocol (SSH)
- Propose the exact sentinel format and parsing algorithm.
- How do you handle binary output that happens to contain the sentinel string?
- Timeout: what's the default? Is it configurable per-target?

## Output Format

For each component, provide:
- **Proposed interface** (TypeScript signatures where applicable)
- **Hard problems** (what's non-obvious)
- **Implementation sketch** (pseudocode for the tricky parts)
- **Test strategy** (how to test in isolation, what mocks are needed)

Then:
### Integration Risks
What breaks when you wire these together?

### Implementation Timeline
Given SSH+Docker together and all 4 tool overrides, realistic week-by-week estimate.
