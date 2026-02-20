## Summary Verdict

Pi-tramp is conceptually sound and architecturally well-motivated. The Emacs TRAMP analogy is apt. The design is buildable in phases, but Phase 1 contains one genuinely hard engineering problem — the persistent SSH stdin/stdout multiplexing — that the document largely hand-waves. The tool-override strategy is workable but fragile in a specific, documented way. Everything else is medium-difficulty plumbing. Phase 1 as scoped is achievable, but the SSH transport will take 2-3x longer than the Docker one, so the sequencing matters.

---

## Hard Problems

### 1. Concurrent Command Execution Over a Single Persistent SSH Shell

**What's hard:** The design says commands are "piped through stdin/stdout" of a persistent SSH process. This is the classic "fake terminal over a shell session" problem. To serialize commands and know when each one ends, you need a sentinel pattern:

```bash
command; echo "DONE_SENTINEL_$?"
```

This works for serial execution. But if the agent calls `bash` (long-running — e.g., `npm install`) and simultaneously calls `read` (because the LLM decided it needs a file), you have two commands competing for the same stdin/stdout pipe. There is no native multiplexing here.

**Why:** The `SshConnection` interface exposes a single `exec()` — implying serial execution is the intended model. That's the right call for Phase 1, but the code needs to enforce it with a command queue. If it doesn't, concurrent tool calls will corrupt the session.

**How to approach it:** Implement a serial command queue with a mutex on the connection. All `exec()` calls are queued and executed one at a time. Long-running `bash` calls hold the lock. Document this limitation explicitly in the system prompt injection ("avoid parallel tool use on remote targets"). This is fine for Phase 1 — LLMs rarely fan out tool calls to remote targets. Revisit in Phase 2 with ControlMaster (which would allow real multiplexing via separate channels).

### 2. Detecting End-of-Command in a Raw Shell Session

**What's hard:** How does `exec()` know a command has finished? The shell doesn't send a special EOF; it just sits there waiting for the next command. The sentinel pattern (`echo SENTINEL_$?`) works — but only if the command doesn't eat stdout, the sentinel doesn't appear in the command's output, and the shell prompt doesn't interfere.

Edge cases that break this:
- Command produces binary output (stdout contains the sentinel string by coincidence)
- The shell is in some mode that transforms output (PS `Out-Default` color codes)
- Network hiccup causes a partial write of the sentinel
- Interactive command (like a REPL) never terminates

**How to approach it:** Use a long, unique, per-invocation UUID as the sentinel. Never send binary commands through `exec()` — use the base64 encode/decode pattern for file I/O only. For the "never terminates" case: require a timeout config on the target, default 60s. On timeout, kill the session and reconnect. This is not elegant but it's correct.

### 3. Shell-Specific File Operations

**What's hard:** The design mentions `cat` for bash targets and `Get-Content` for pwsh. But the implementation delta is larger than it appears:

- **Reading binary files**: bash: `cat file | base64`; pwsh: `[Convert]::ToBase64String([IO.File]::ReadAllBytes("file"))` — different, but manageable.
- **Writing files**: bash: `echo ... | base64 -d > file`; pwsh: Needs `[IO.File]::WriteAllBytes(...)`. This gets long for large files and needs careful escaping.
- **Path separators**: Windows targets use `\`, Unix use `/`. `cwd` joins become a minefield.
- **Error output**: `cat: no such file` vs `Get-Content: Cannot find path`. Parsing stderr for structured errors is shell-specific.

**How to approach it:** Define a `ShellDriver` interface with methods like `readFile(path)`, `writeFile(path, base64)`, `exists(path)`, `listDir(path)` that return structured results. Implement `BashDriver` and `PwshDriver` separately from day one. Don't try to share code between them — the command strings are different enough that abstraction adds overhead without real savings. Two concrete implementations are cleaner than one parameterized mess.

### 4. The `registerTool` Override Bug (TODO-f1379fc7)

**What's hard:** The design says pi-tramp must be the ONLY extension overriding `bash`, `read`, `write`, `edit`. Last-writer-wins means any other extension that overrides these (for any reason) silently defeats pi-tramp's routing. The bug tracking todo is `TODO-f1379fc7` — meaning this is a known upstream issue with no fix timeline.

**Why this matters:** A user adds `pi-sandbox` or any other extension that wraps `bash` → pi-tramp's routing breaks with no error, no warning. The agent happily runs bash locally while thinking it's on the remote target.

**How to approach it:** In pi-tramp's extension init, check if any tool you're about to override already has a non-default implementation. If yes, log a warning to the TUI: "pi-tramp: WARNING — another extension has already overridden `bash`. Remote routing may not work." This at least makes the failure visible. Long-term, this requires the upstream fix.

### 5. Docker Exec Latency

**What's hard:** The design asks "is spawning `docker exec` per operation fast enough?" — and then defers it. For `bash` calls (run a command), one `docker exec` per call is ~50-100ms overhead on a local Docker instance. That's tolerable. But `read` (file access) is called constantly — syntax highlighting, file listing, etc. — and a `docker exec cat file` per read adds up.

**How to approach it:** Phase 1: accept it. For Phase 2, keep a persistent exec session for the docker backend the same way SSH does. The `docker exec -it container bash` shell pattern works identically.

---

## What Will Break First

1. **SSH session desynchronization** — A command errors in an unexpected way (exits with no output, hangs, network glitch mid-sentinel), the connection state machine gets confused, subsequent commands get each other's output. This will happen in the first week of real use. Need a "session health check" and auto-reconnect path.

2. **Quoting and escaping in remote commands** — Sending a command like `cat "file with spaces.txt"` through stdin of a shell requires correct quoting at two levels: the local string, and the remote shell interpretation. The design doesn't address this. Pwsh adds a third layer (`-Command` quoting rules). First production incident: a filename with a space or a quote character in content.

3. **The `requireEntryConfirmation` UX** — The design says "triggers `ctx.ui.confirm()`." This works if the LLM initiates the switch. But if the user runs `/target switch production` directly, the design says that "could bypass" confirmation. Undefined behavior in a production-context guard is a liability.

4. **System prompt context budget** — Injecting target info on every `before_agent_start` turn. If the target block is 200 tokens and the session has 50 turns, that's 10,000 tokens of repeated injection that the model carries. The open question (#1) in the design is the right concern — but it needs an answer before Phase 1 ships, not Phase 3.

---

## Scope Reality Check

**Phase 1 as scoped is achievable** for a single developer in 3-4 weeks for the Docker backend and target tool CRUD. The SSH transport adds another 2-3 weeks of real work (connection lifecycle, sentinel protocol, error recovery, shell drivers). The system prompt injection and context filter are 1-2 days each.

**Should be cut for MVP:** WSL and PSSession (already in Phase 2 — correct). Port forwarding (already Phase 2 — correct). `trampExec()` can be stubbed — just log a warning that extension tools don't route yet.

**The real MVP** is: Docker exec + `target` tool (switch + list) + `bash` override + `read` override. That proves the concept end-to-end. SSH comes after Docker works cleanly.

---

## Implementation Sequence

1. **Transport interface** (S) — Define `Transport`, `ShellDriver` (bash + pwsh), and `TargetSession` interfaces. No implementation. This is the contract everything else implements against. Can be tested with mocks.

2. **`target` tool — CRUD only, local** (S) — Implement config loading (`targets.json` global + project merge), `target({ action: "list/status" })`. No actual connections yet. Tests: config parsing, merge precedence, requireEntryConfirmation flag presence.

3. **Docker exec backend** (M) — Implement `DockerTransport` with `exec()`, `readFile()`, `writeFile()`. Serial command queue from day one (not as an afterthought). Tests: unit tests with a real Docker container (this is actually easy to set up in CI). This is the **proof-of-concept vertical slice**.

4. **`bash` and `read` overrides routed to Docker** (S) — Wire the tool overrides to use the active transport. Now you can `target switch odoo-dev` and `bash` runs in the container. This is the first thing a user can experience end-to-end.

5. **System prompt injection** (S) — `before_agent_start` block with target info. Measure token cost immediately on first integration test.

6. **Shell detection** (S) — Probe on connect, set `ShellDriver` accordingly. Test with a container running pwsh to verify the pwsh driver path works.

7. **SSH transport — bash/pwsh driver + sentinel protocol** (L) — The hardest piece. Build it now (early fail-fast), after Docker proves the interface. Tests need a real SSH target (can use a local Docker container with sshd).

8. **SSH connection lifecycle** (M) — Keepalive, reconnect on drop, health check. This is where most SSH reliability work lives.

9. **Context injection on target switch** (S) — `sendMessage` + `context` filter. Wire in AGENTS.md reading from the remote target on switch.

10. **Status bar widget** (S) — Show `@target-name` in TUI. Pure cosmetic but important for user orientation.

---

## Missing from the Design

1. **Command queuing / concurrency contract** — Must be specified: is `exec()` serial? What happens if the agent makes two simultaneous tool calls? The implementation needs to decide this before writing any transport code.

2. **Quoting/escaping strategy** — How are remote commands constructed? Is there a `shellEscape(arg)` utility? The design shows `exec(command: string)` but doesn't say who is responsible for making that string safe for the target shell.

3. **File size limits** — Base64 over stdout is fine for source files. What's the cutoff above which it becomes a problem? 1MB? 10MB? What happens when a user asks to read a 500MB log file on a remote target?

4. **Connection credentials** — SSH targets: the design assumes `ssh user@host` works (key-based auth, SSH agent). What if it doesn't? The design has no mention of prompting for passwords, SSH agent forwarding configuration, or jump hosts. This will hit the first real user immediately.

5. **`requireEntryConfirmation` bypass behavior** — Needs to be specified: does `/target switch production` bypass the confirmation or not? "Could bypass" is not a spec.

6. **System prompt block size budget** — Before shipping, measure: how many tokens does the target block add per turn? What's the limit above which it becomes a cost/context problem? The design defers this to Phase 3, but it affects Phase 1 behavior.

7. **`write` and `edit` tool overrides** — The architecture diagram lists them, but the design body only deeply covers `bash` and `read`. The `edit` tool (which does diff-based patching) likely has a more complex remote implementation. What's the strategy?

8. **Session persistence across target switches** — When switching from `dev` → `local` → `dev`, does pi-tramp reuse the existing SSH connection or create a new one? The design says "keep alive," which implies reuse — but the detected platform/shell state needs to be cached and reloaded, not re-probed.
