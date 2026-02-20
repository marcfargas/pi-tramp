# Task: Architecture Review of Decomposed Pieces

Read these files in order:
1. `C:/dev/mypi/experiments/pi-tramp/DESIGN.md` — the full design
2. `C:/dev/mypi/experiments/pi-tramp/reviews/stage-1/synthesis.md` — Stage 1 review synthesis
3. `C:/dev/mypi/experiments/pi-tramp/reviews/stage-1/decisions.md` — author's decisions

Stage 1 produced a decomposition into pieces. The author overrode some recommendations:
- SSH + Docker together (NOT Docker-first) — validates architecture faster
- ALL four tool overrides (read/write/edit/bash) in Phase 1 — core of the project
- `/target switch` bypasses requireEntryConfirmation when user-issued
- SSH keys only, no passwords

Now review **each piece's interface and contract**. For each of these components, evaluate:

## Components to Review

1. **Transport Interface** — Is the contract (`exec`, `readFile`, `writeFile`, `close`) complete? What's missing given that SSH and Docker will be built together? Does it need lifecycle hooks?

2. **ShellDriver (BashDriver + PwshDriver)** — Given that all 4 tools (read/write/edit/bash) must work, are the shell commands for `edit` (diff-based patching remotely) well-defined? What about atomic writes?

3. **TargetManager** — Config schema, merge precedence (global vs project), CRUD. Is it clean enough?

4. **ConnectionPool** — Lifecycle, keepalive, reconnect. How does this work when SSH and Docker connections have fundamentally different lifecycles?

5. **operations-remote** — Maps pi's Operations interfaces to remote execution. The `edit` operation is the hardest — how do you do diff-based patching remotely? Does the remote need `sed`? A temp file dance? What's the strategy?

6. **tool-overrides** — All four tools override simultaneously. How do they coordinate? What's the routing logic when no target is active (pass-through to local)?

7. **target-tool** — CRUD + switch + status. How does it interact with confirmation gates and connection lifecycle?

8. **Sentinel Protocol** (SSH-specific) — Given concurrent SSH+Docker development, how does the sentinel differ between transports? Docker exec returns naturally; SSH needs sentinels. Should this be transport-specific or shared?

## Output Format

For each component:
```
### [Component Name]

**Interface**: Is it complete? What's missing?
**Coupling**: What does it depend on? Does it know too much about others?
**Testing seam**: How do you test this in isolation?
**Risk**: What will break first?
**Recommendation**: What to change before implementation.
```

Then add:

### Cross-Component Issues
Problems that only emerge when pieces interact.

### Revised Build Order
Given SSH+Docker together and all 4 tool overrides, what's the right implementation sequence?
