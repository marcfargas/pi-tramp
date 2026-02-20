# Architecture Review: pi-tramp

## Summary Verdict

This design is fundamentally sound and solves a real problem. The diagnosis of pi-devcontainers' fragility is correct, and the TRAMP-inspired "local brain, remote tools" model is the right architecture. The Operations interface reuse is clean, and the explicit boundary approach fits agent needs better than implicit sandboxing.

However, **Phase 1 is too ambitious** — it's trying to deliver 3-4 independent features as a single unit, which creates integration risk. Several critical details are underspecified (shell detection, conflict resolution, authentication), and the design presents competing approaches for the same problem (context injection) without committing to one. This needs decomposition and specification tightening before implementation.

## Strengths

- **Problem statement is crisp** — concrete pain points (11 documented deviations, network boundary issues) with evidence
- **Excellent analogy** — the TRAMP comparison makes the mental model immediately graspable to anyone who knows Emacs
- **Leverages existing abstractions** — reusing Operations interfaces instead of inventing new ones is exactly right
- **Explicit vs implicit boundary** — the user/agent being aware of the network hop is the correct choice for this use case
- **Pragmatic Windows handling** — acknowledging ControlMaster unavailability and using persistent connections is realistic
- **Safety by default** — `requireEntryConfirmation` built in from the start prevents accidental production operations
- **Phasing shows restraint** — deferring port forwarding and pidc sunset to later phases is good judgment

## Critical Issues

### 1. Phase 1 is too big — will hit integration hell

Phase 1 claims to deliver:
- SSH backend with persistent connections
- Docker exec backend
- Dynamic target creation by agent
- System prompt augmentation
- Context injection with message filtering
- Status bar widget
- `trampExec()` export for extensions

**That's 3-4 separate deliverables.** When all of these fail at once (and they will), you won't know which layer is broken. You'll spend days debugging the integration instead of building features.

**What to do**: Split into Phase 1A (SSH + basic tool routing only) and Phase 1B (Docker + context refinement + dynamic targets). Ship 1A, validate it works, then add 1B.

### 2. Shell detection is underspecified and will break

The design says "we detect the shell we land in" but doesn't specify **how**. Is it parsing `$SHELL`? Running `echo $0`? Trying a pwsh-specific command and catching errors?

**Why it matters**: You'll waste days debugging "why does this break on PowerShell Core vs Windows PowerShell" or "why does bash on macOS work but bash in Alpine fail."

**What to do**: Specify the detection algorithm now:
1. Send `echo "$0"`
2. Parse output: if contains "pwsh"/"powershell" → pwsh; if "bash" → bash
3. If ambiguous, send `$PSVersionTable` — success = pwsh, error = assume bash
4. Allow `"shell": "..."` config override

### 3. Tool override conflict resolution is wishful thinking

The design acknowledges "pi-tramp must be the ONLY extension overriding these tools" and that registerTool is last-writer-wins, then proceeds anyway.

**Why it matters**: If pi-powershell or any other extension also overrides `bash`, one silently loses. The agent gets inconsistent behavior and neither extension knows about the conflict.

**What to do**: Add conflict detection. On startup, check if another extension already registered the same tool. Either error out with a clear message ("pi-tramp conflicts with pi-powershell on tool 'bash'") or provide an opt-in mechanism (`pi.tramp.takeOver = true` in config).

### 4. Two competing context injection approaches — pick one

The design describes both `sendMessage` with `customType: "pi_tramp-target_context"` AND `before_agent_start` system prompt injection, then says "design review will tell which is better."

**Why it matters**: Building both is wasted effort. One will work better and you'll delete the other. But you won't know which until you've built both.

**What to do**: Pick `sendMessage` + `context` event filtering for Phase 1. It's more complex but allows surgical updates (remove old target context, add new). System prompt injection is simpler but wastes tokens on every turn. Commit to the message approach now.

### 5. Binary file handling via base64 is a trap

"Base64 works but is 33% larger. Acceptable for Phase 1?" — **No.**

**Why it matters**: Reading a 50MB image = 66MB base64 string = OOM or massive latency. Silently accepting this creates a footgun. An agent tries to `read` a large binary, your extension hangs for 30 seconds or crashes, and the agent has no idea why.

**What to do**: Either support binary properly (stdin/stdout in binary mode, not base64) or document hard limits and fail fast:
- `if (fileSize > 10MB) throw new Error("Binary file too large for SSH base64 transport. Use scp/rsync for files >10MB")`
- Communicate the limit in the tool's error message so the agent learns

### 6. Docker exec latency is unanswered and critical

"Is spawning `docker exec` per operation fast enough, or do we need a persistent exec session?" — this question determines your entire Docker transport design.

**Why it matters**: If you're spawning `docker exec` for every `read` call on a repo with 2000 files, you've built a DOS attack on yourself. Latency will be unusable.

**What to do**: Prototype this **before** Phase 1. Write a script:
```bash
for i in {1..100}; do
  docker exec -i <container> cat /etc/hosts > /dev/null
done
```
Time it. If <1 second total, you're fine. If >5 seconds, you need persistent exec. Make the decision with data, not guesses.

## Suggestions

### 1. Split Phase 1 into 1A and 1B

**Phase 1A (MVP — 3-4 weeks):**
- SSH backend only (no Docker)
- Local/SSH target switching
- Tool overrides for read/write/bash (edit can wait)
- Basic system prompt injection (just platform/shell/arch — no message filtering)
- `target` tool (switch/list only, no create/remove)
- No dynamic targets
- No trampExec export
- No status widget

**Phase 1B (Polish — 1-2 weeks):**
- Docker backend
- Context injection with message filtering
- Dynamic target create/remove
- Status bar widget
- trampExec export

This way you get a working MVP (SSH) to validate against before adding complexity.

### 2. Add `pi.extensions.has("pi-tramp")` convention for other extensions

If pi-powershell wants to coexist, it checks:
```typescript
if (!pi.extensions.has("pi-tramp")) {
  // Only override bash if pi-tramp isn't present
  pi.registerTool({ name: "bash", ... });
}
```

Document this convention in the README and in the pi-tramp docs. It's not perfect (load order dependent) but it's pragmatic.

### 3. Document file size limits explicitly

In Phase 1, add to tool schemas:
```typescript
// read tool description
"Reads file contents. For binary files >10MB over SSH, this will fail. Use scp or rsync for large binaries."
```

And in the error:
```typescript
if (isRemote && isBinary && size > 10 * 1024 * 1024) {
  throw new Error(
    `Binary file ${path} is ${size} bytes (max 10MB over SSH). ` +
    `Use 'bash' tool with scp/rsync for large files.`
  );
}
```

The agent will learn the limit through experience.

### 4. Specify authentication strategy

The design is silent on SSH authentication. Add a section:

**Phase 1**: SSH key-based auth only. User must have `~/.ssh/id_rsa` or `ssh-agent` configured. No password prompts (they hang non-interactive SSH).

**Phase 2**: Support `"identityFile": "~/.ssh/custom_key"` in target config. Support SSH agent forwarding with `"forwardAgent": true`.

### 5. Define reconnection behavior

"On connection drop → notify agent, attempt reconnect" is too vague.

**Specify**:
- On command failure with network error (ECONNRESET, EPIPE), mark connection as dead
- Return tool error to agent: `"SSH connection to 'dev' lost. Reconnecting..."`
- Attempt one reconnect immediately
- If reconnect succeeds, retry the failed command once
- If reconnect fails, return error: `"Cannot reconnect to 'dev'. Use target({ action: 'switch', name: 'local' }) to continue locally."`
- Agent decides whether to switch back to local or abort

### 6. Add testing strategy

The design has zero testing story. Add:

**Unit tests**: TargetManager, ShellDetect (pure logic)

**Integration tests**: 
- Docker container running sshd for SSH transport tests
- Local Docker container for Docker transport tests
- Automated via GitHub Actions (containers available in CI)

**Manual testing**:
- Test matrix: Windows host → Linux SSH, Windows host → Windows SSH (Git Bash), Windows host → Docker (Alpine, Ubuntu, Windows containers)

### 7. Clarify connection lifecycle

"On target switch away → keep connection alive (might switch back)" — are you optimizing for rapid switching or long sessions?

**Recommendation**: Close connections after 5 minutes of inactivity. If the agent switches back, reconnect. Otherwise you're leaking SSH processes for sessions that last hours.

Add a `"keepalive": 300` (seconds) option in target config.

## Questions for the Author

1. **Authentication details** — SSH keys only? Password prompts? Agent forwarding? What's supported in Phase 1?

2. **requireEntryConfirmation UX** — When this is true, what happens? Does the `target` tool call block? Return an error? How does the agent know it was rejected?

3. **Network hiccup handling** — SSH drops mid-read. Exactly what does the agent see? Retry logic? Exponential backoff? Max retries?

4. **Unsupported shell fallback** — If you land in `fish`, `csh`, or a restricted shell, do you error out? Try bash commands anyway? How does the user know their shell isn't supported?

5. **Extension tool discovery** — If an extension calls `trampExec()`, does it automatically know the current target? Or does it need to call `target({ action: "status" })`?

6. **Migration from pi-devcontainers** — What's the user experience? Delete `.devcontainer`, create a target manually, done? Any migration helper?

7. **Testing story** — How do you test this? Mock SSH server? Real containers in CI? What's the test matrix for Phase 1?

8. **Context budget measurement** — "Need to measure after Phase 1" — how? What's the metric? Tokens per turn? Total conversation size? When do you declare it a problem?

9. **Binary file transport** — Why not just use `scp` under the hood for files >1MB? Operations interface supports streaming — you could detect binary, call `scp`, return success/failure.

10. **Docker privileged operations** — What if the agent needs to install packages (`apt install`) inside the container? Does `docker exec` handle that or do you need a root user configured?

## Decomposition Proposal

Break this into 11 independent, composable pieces:

### 1. **transport-ssh** — SSH persistent connection manager
- **What**: Manages a single persistent SSH connection with command execution
- **Depends on**: Node `child_process`, SSH client binary
- **Produces**: `SshConnection` interface with `exec()`, `readFile()`, `writeFile()`
- **Testable in isolation**: ✅ Test against Docker container running sshd
- **Complexity**: M (persistent stdin/stdout handling, keepalive, error recovery)

### 2. **transport-docker** — Docker exec wrapper
- **What**: Wraps `docker exec` with the same interface as SSH transport
- **Depends on**: Docker CLI
- **Produces**: `DockerConnection` interface (same signature as `SshConnection`)
- **Testable in isolation**: ✅ Test against local Docker container
- **Complexity**: S (just wrapping `docker exec`, no persistence needed if latency is acceptable)

### 3. **shell-detect** — Shell detection and command translation
- **What**: Probes remote shell, provides shell-specific command builders for file ops
- **Depends on**: Transport interface (to send probe commands)
- **Produces**: `ShellAdapter` with methods like `readFile(path) → string command`, `writeFile(path, useBase64) → string command`
- **Testable in isolation**: ✅ Unit tests with mocked transport, integration tests with real containers (bash, pwsh, sh)
- **Complexity**: M (bash vs pwsh command differences, edge cases like Alpine's minimal `sh`)

### 4. **operations-remote** — Remote Operations implementations
- **What**: Implements `ReadOperations`, `WriteOperations`, `BashOperations` using transport + shell adapter
- **Depends on**: Transport interface, ShellAdapter
- **Produces**: Operations instances compatible with pi's `createReadTool()`, etc.
- **Testable in isolation**: ✅ Mock transport, verify correct Operations contract
- **Complexity**: M (mapping pi's Operations API to shell commands, error handling)

### 5. **target-manager** — Target registry and current target state
- **What**: Loads `targets.json`, tracks current target, CRUD for dynamic targets
- **Depends on**: Nothing (pure state management)
- **Produces**: `TargetManager` with `list()`, `getCurrent()`, `switch()`, `create()`, `remove()`
- **Testable in isolation**: ✅ Pure logic, easy unit tests
- **Complexity**: S (just config parsing and state)

### 6. **connection-pool** — Connection lifecycle and reuse
- **What**: Opens/closes/reuses transport connections based on target manager state
- **Depends on**: TargetManager, transport implementations (ssh, docker)
- **Produces**: `getConnection(targetName) → Promise<Connection>` — returns active or creates new
- **Testable in isolation**: ✅ Mock transports, verify lifecycle (open once, reuse, close on timeout)
- **Complexity**: M (keepalive, reconnect logic, error states)

### 7. **tool-overrides** — Pi tool registration for read/write/bash/edit
- **What**: Registers pi tools that dispatch to remote operations based on current target
- **Depends on**: TargetManager, ConnectionPool, operations-remote
- **Produces**: N/A (side effect: registers tools via `pi.registerTool`)
- **Testable in isolation**: ⚠️ Needs pi runtime or elaborate mocking
- **Complexity**: S (thin dispatch layer)

### 8. **target-tool** — The `target()` LLM-callable tool
- **What**: Exposes target CRUD/switch as a tool for the agent
- **Depends on**: TargetManager, ConnectionPool (for switch + connection test)
- **Produces**: Pi tool registration
- **Testable in isolation**: ⚠️ Needs pi runtime
- **Complexity**: S (maps tool params to TargetManager calls, adds confirmation UI for `requireEntryConfirmation`)

### 9. **context-injection** — System prompt and message injection on target switch
- **What**: Listens to target switch events, injects target-specific context
- **Depends on**: TargetManager, pi event system (`context`, `before_agent_start`)
- **Produces**: N/A (side effect: modifies system prompt or adds custom messages)
- **Testable in isolation**: ⚠️ Needs pi event system
- **Complexity**: M (context event filtering is subtle, token budget implications)

### 10. **status-widget** — TUI status bar widget for current target
- **What**: Displays current target name in pi's status bar
- **Depends on**: TargetManager, pi TUI API
- **Produces**: N/A (side effect: renders widget)
- **Testable in isolation**: ⚠️ Needs pi TUI runtime
- **Complexity**: S (just display logic)

### 11. **trampExec-export** — Public API for extension authors
- **What**: Exports `trampExec(command, args)` that routes to current target
- **Depends on**: TargetManager, ConnectionPool
- **Produces**: Public function in extension's exports
- **Testable in isolation**: ✅ Mock connection pool, verify routing
- **Complexity**: S (thin wrapper)

---

## Build Order (Dependency Graph)

**Phase 1A (MVP — SSH only, ~3-4 weeks):**

1. `transport-ssh` (M) — foundational, blocks everything
2. `shell-detect` (M) — needed for operations
3. `target-manager` (S) — pure logic, can build in parallel with transport
4. `connection-pool` (M) — depends on 1 + 3
5. `operations-remote` (M) — depends on 1 + 2
6. `tool-overrides` (S) — depends on 4 + 5
7. `target-tool` (S) — depends on 3 + 4
8. Basic system prompt injection (subset of `context-injection`) (S) — depends on 3

**Ship Phase 1A, validate with real usage**

**Phase 1B (Docker + polish, ~1-2 weeks):**

9. `transport-docker` (S)
10. Full `context-injection` with message filtering (M)
11. Dynamic targets (enable in `target-manager`) (already built, just expose) (S)
12. `status-widget` (S)
13. `trampExec-export` (S)

**Phase 2 (advanced features, ~3-4 weeks):**

14. Port forwarding tool (M)
15. ControlMaster support in `transport-ssh` (M)
16. WSL transport (M)
17. PSSession transport (L — WinRM is complex)

---

## Clean Seams (Where to Cut)

**Transport interface** is the primary seam:
```typescript
interface Transport {
  exec(command: string): Promise<ExecResult>;
  readFile(path: string): Promise<Buffer>;
  writeFile(path: string, content: Buffer): Promise<void>;
  close(): Promise<void>;
}
```

Any transport (SSH, Docker, WSL, custom) can plug in. This is your extension point.

**ShellAdapter** isolates shell differences:
```typescript
interface ShellAdapter {
  readFileCommand(path: string): string;
  writeFileCommand(path: string, base64Content: string): string;
  mkdirCommand(path: string): string;
}
```

Add `fish`, `zsh`, `csh` without touching transports or operations.

**Operations layer** is pi's own abstraction — you're implementing it over transports. This is already a clean boundary.

**TargetManager** is pure state — no I/O, no side effects. Easy to reason about, test, and extend.

---

## What's Independently Useful

- **transport-ssh** could be a standalone npm package — useful for any Node project needing persistent SSH with file ops
- **shell-detect** could be extracted — anyone building multi-shell CLIs would benefit
- **operations-remote** demonstrates pi's Operations interfaces in practice — good reference implementation for other extension authors

---

## Big-Bang Integration Risks

The main risk is wiring **tool-overrides** + **context-injection** + **connection-pool** together for the first time and having everything fail at once.

**Mitigation**:

1. Build `transport-ssh` + `target-manager` + `connection-pool` **first**
2. Write a **test CLI** (outside pi) that calls:
   ```typescript
   const conn = await connectionPool.getConnection("dev");
   const result = await conn.exec("ls -la");
   console.log(result.stdout);
   ```
   Prove the stack works independently.
3. **Then** wire up `tool-overrides` in pi
4. Test with **manual tool calls** in pi (`/bash ls`, `/read README.md`) before enabling agent mode
5. Add `context-injection` **last**, after tool routing is proven stable

This way you're never debugging three layers at once. Each layer is validated before the next is added.

---

**Bottom line**: This design is worth building. But shrink Phase 1, specify shell detection, and prototype Docker latency before committing. The decomposition above gives you a path to ship incrementally without big-bang integration hell.
