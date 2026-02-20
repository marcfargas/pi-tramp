# Stage 2 Synthesis: Component-Level Review

## Unanimous Verdicts

Both reviewers agree on the following critical points:

### 1. **Architecture is sound but underspecified**
The decomposition is clean and the Operations abstraction is the right boundary. However, three components (ShellDriver, operations-remote, Sentinel Protocol) have hand-waved complexity that will surface as multi-day debugging sessions if not specified before implementation starts.

### 2. **The serial command queue is non-negotiable**
Must be implemented from day one. The first concurrent tool call will corrupt the SSH session without it. Both reviewers emphasize this cannot be deferred.

### 3. **Edit operation: read-apply-write is the only viable approach**
Both reviewers independently arrived at the same conclusion:
- **Option A (read → local edit → write)**: Acceptable for Phase 1 with 10MB file size limit
- **Option B (sed/awk)**: Too fragile, escaping surface too large, shell injection risk
- **Option C (temp script)**: Circular dependency, requires file upload infrastructure first

The consensus is clear: implement read-apply-write with explicit encoding preservation (no line-ending normalization).

### 4. **Shell escaping is the #1 silent failure risk**
Both reviewers flag this as the most likely source of production bugs. The driver must handle escaping internally; paths with spaces, quotes, and special characters will break if escaping is wrong. **Must be tested against real shells, not mocked.**

### 5. **Scope decision impact: 7-9 weeks, not 3-4**
Both reviewers agree that building SSH + Docker simultaneously, while validating the abstraction, doubles the timeline. The implementation reviewer provides the most detailed breakdown: 7-9 weeks for a solid Phase 1A.

---

## Key Divergences

### Transport Interface Design

**Architecture reviewer** proposes:
```typescript
interface Transport {
  readonly type: "ssh" | "docker" | "wsl" | "psremote";
  readonly isConnected: boolean;
  exec(command: string, timeout?: number): Promise<ExecResult>;
  readFile(path: string): Promise<Buffer>;
  writeFile(path: string, content: Buffer): Promise<void>;
  close(): Promise<void>;
  healthCheck(): Promise<boolean>;
}
```

**Implementation reviewer** proposes:
```typescript
interface Transport {
  exec(command: string, signal?: AbortSignal): Promise<ExecResult>;
  readFile(path: string): Promise<Buffer>;
  writeFile(path: string, content: Buffer): Promise<void>;
  close(): Promise<void>;
  readonly shell: "bash" | "pwsh" | "unknown";
  readonly platform: "linux" | "darwin" | "windows" | "unknown";
  readonly arch: string;
  readonly state: "connecting" | "connected" | "disconnected" | "error";
  on(event: "disconnect", cb: (err: Error) => void): void;
}
```

**Key differences**:
- **Timeout vs AbortSignal**: Architecture reviewer uses per-call timeout parameter; Implementation reviewer uses AbortSignal for cancellation
- **State representation**: Architecture uses `isConnected: boolean`; Implementation uses `state` enum with 4 values
- **Platform detection**: Implementation reviewer adds `shell`, `platform`, `arch` directly to Transport; Architecture reviewer doesn't specify where this lives
- **Event handling**: Implementation reviewer adds explicit disconnect event handler

**Recommendation**: **Merge both approaches**:
```typescript
interface Transport {
  // Identity
  readonly type: "ssh" | "docker" | "wsl" | "psremote";
  readonly shell: "bash" | "pwsh" | "unknown";
  readonly platform: "linux" | "darwin" | "windows" | "unknown";
  readonly arch: string;
  
  // State
  readonly state: "connecting" | "connected" | "disconnected" | "error";
  
  // Core operations
  exec(command: string, options?: { timeout?: number; signal?: AbortSignal }): Promise<ExecResult>;
  readFile(path: string): Promise<Buffer>;
  writeFile(path: string, content: Buffer): Promise<void>;
  
  // Lifecycle
  close(): Promise<void>;
  healthCheck(): Promise<boolean>;
  
  // Events
  on(event: "disconnect", cb: (err: Error) => void): void;
}
```

This combines the best of both: timeout for simple cases, AbortSignal for complex cancellation, explicit state enum, and platform detection at the Transport level.

---

### Error Handling Strategy

**Architecture reviewer**: Proposes custom error classes:
```typescript
class TransportError extends Error {}
class ConnectionDroppedError extends TransportError {}
class CommandTimeoutError extends TransportError {}
```

**Implementation reviewer**: Proposes discriminated unions:
```typescript
type TransportError =
  | { kind: "connection_lost"; cause: Error }
  | { kind: "command_failed"; code: number; stderr: string }
  | { kind: "timeout"; after_ms: number }
  | { kind: "not_connected" };
```

**Decision needed**: The discriminated union approach is more TypeScript-idiomatic and makes error handling explicit (`if (err.kind === "timeout")`), but the class-based approach integrates better with existing JavaScript error handling (`catch (e) { if (e instanceof TimeoutError) }`).

**Recommendation**: **Use discriminated unions for Transport errors, wrap in Error for tool results**:
```typescript
// Internal (Transport layer)
type TransportError =
  | { kind: "connection_lost"; cause: Error }
  | { kind: "command_failed"; code: number; stderr: string }
  | { kind: "timeout"; after_ms: number }
  | { kind: "not_connected" };

// External (tool layer throws regular Errors)
class RemoteOperationError extends Error {
  constructor(message: string, public transportError: TransportError) {
    super(message);
  }
}
```

This gives type safety internally and standard error handling externally.

---

### Shell Detection Timing

**Architecture reviewer**: "Detect shell during connection establishment (before any operations)."

**Implementation reviewer**: Doesn't explicitly specify timing but shows shell detection in the connection setup phase.

**Consensus**: Shell detection must happen during `connect()`, not on first command. The first command might be `readFile()`, which requires knowing the shell to generate the correct read command.

---

### Confirmation Bypass Implementation

**Architecture reviewer**: "The bypass rule can't be implemented without upstream pi changes. Either drop it or propose a `ctx.isUserInitiated` flag to pi."

**Implementation reviewer**: Shows concrete spec with `ctx.isUserInitiated` and notes: "The `ctx.isUserInitiated` flag needs to be set by pi's slash command dispatch — verify this is actually the case in pi's source. If it's not currently threaded through, this is a missing upstream feature."

**Consensus**: This is a **missing upstream feature**. Marc's decision ("/target switch bypasses requireEntryConfirmation") cannot be implemented without changes to pi's tool context. Flag this as a blocker or defer to Phase 2.

---

## Critical Issues (Must Address)

Ordered by severity and likelihood of blocking shipment:

### 1. **Sentinel Protocol Specification** (Blocks SSH Transport)
**What**: The exact algorithm for parsing SSH command completion is not specified in the original design.

**Consensus solution**:
```typescript
const sentinelId = crypto.randomUUID().replace(/-/g, "");
const sentinel = `__PITRAMP_${sentinelId}__`;

// Bash:
const wrapped = `${command}\necho "${sentinel}_$?"\n`;

// PowerShell:
const wrapped = `${command}\nWrite-Output "${sentinel}_$LASTEXITCODE"\n`;
```

**Critical edge cases identified**:
- **PowerShell color codes**: Interactive pwsh emits ANSI escape codes that corrupt output. **Must** run pwsh with `-NonInteractive` or `$PSStyle.OutputRendering = 'PlainText'` before any real commands.
- **Timeout behavior**: Kill the SSH process (don't try CTRL-C), mark connection dead, pool reconnects on next use.
- **Buffer streaming**: Handle 10MB+ output without buffering entire response in memory.

**Must be specified**: Write the complete sentinel parsing algorithm including the stdout reader's line-buffering logic before coding SshTransport.

---

### 2. **Shell Escaping Algorithm** (Blocks all tool overrides)
**What**: The exact escaping rules for bash and pwsh are not specified.

**Implementation reviewer provides concrete algorithm**:
```typescript
// BashDriver
function shellEscape(arg: string): string {
  if (!arg.includes("'")) return `'${arg}'`;
  return `${arg
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\0/g, '\\0')
  }'`;
}

// PwshDriver
function shellEscape(arg: string): string {
  return `'${arg.replace(/'/g, "''")}'`;
}
```

**Warning from reviewer**: The bash algorithm shown uses `$'...'` ANSI-C quoting, which is bash-specific. Dash (`/bin/sh`) doesn't support it. Shell detection must distinguish bash from dash.

**Critical test cases**:
- `file with spaces.txt`
- `file's.txt`
- `file$(rm -rf /).txt` (injection attempt)
- `a\nb` (literal newline)

**Must be tested**: Against real local bash and pwsh processes, not mocks. One escaping bug = production injection vulnerability.

---

### 3. **CRLF Handling Policy** (Blocks edit on Windows targets)
**What**: Files on Windows targets have CRLF line endings. The read-apply-write edit strategy requires exact byte preservation.

**Implementation reviewer**: "Spec this explicitly: preserve the exact bytes from `readFile()`, do the string match and replace on those bytes, write the exact result back. Do not normalize."

**Failure scenario**:
1. Remote Windows file has CRLF (`\r\n`)
2. `readFile()` returns bytes with CRLF
3. `toString("utf8")` preserves CRLF
4. Pi's edit logic searches for `oldText` (which might have LF-only from user input)
5. Match fails → edit fails

**Must be specified**: Document that `edit` requires exact byte-for-byte match including line endings. Provide clear error message if match fails: "old_text not found (check line endings)."

---

### 4. **ctx.isUserInitiated Flag** (Blocks confirmation bypass)
**What**: Marc decided `/target switch` bypasses `requireEntryConfirmation`, but agent-initiated switches don't. Pi's tool context doesn't distinguish these.

**Both reviewers flag this as a missing upstream feature.**

**Options**:
1. **Request upstream pi change**: Add `ctx.isUserInitiated: boolean` to tool context, set by slash command dispatcher.
2. **Defer to Phase 2**: Ship without bypass rule; all switches require confirmation if flag is set.
3. **Drop the bypass rule**: Accept that `/target` commands also trigger confirmation.

**Recommendation**: **Option 2 (defer)**. Document as a known limitation. Revisit when pi supports the flag.

---

### 5. **Tool Override Conflict Detection** (Blocks multi-extension use)
**What**: If pi-tramp and pi-powershell both override `bash`, last-writer-wins. Silent failure.

**Mitigation from architecture reviewer**:
```typescript
for (const toolName of tools) {
  const original = pi.tools.get(toolName);
  if (original && original.source !== "builtin") {
    pi.logger.warn(
      `pi-tramp: Tool '${toolName}' was already overridden by '${original.source}'. ` +
      `Remote routing may not work correctly.`
    );
  }
}
```

**Implementation reviewer adds**: Check at runtime in `execute()` whether we're still the registered handler. If not, throw a visible error.

**Must be implemented**: Load order enforcement is impossible without upstream pi changes. Conflict detection warnings are the best available mitigation.

---

### 6. **ConnectionPool Queue Error Recovery** (Blocks reconnect reliability)
**What**: When SSH drops mid-command, the serial queue must drain all pending commands with errors before accepting new connections.

**Implementation reviewer provides detailed error recovery sketch**:
```typescript
class SshConnection {
  private onDisconnect(err: Error) {
    // Reject all pending including current
    for (const item of this.queue) {
      item.reject({ kind: "connection_lost", cause: err });
    }
    this.queue = [];
    this.processing = false;
    this.emit("dead", err);  // Signal pool to evict
  }
}
```

**Must be tested**: Simulate by killing SSH server mid-command (Docker container with sshd). Verify queue drains, pool evicts, reconnect succeeds.

---

## Suggestions (Should Address)

### 1. **SSH Port Configuration**
Implementation reviewer: "SSH Phase 1 accepts `identityFile` in config. Does it also accept `port`? (SSH to non-standard ports is extremely common.)"

**Recommendation**: Add `port?: number` to SSH target config. Default 22. Trivial to implement, prevents first user frustration.

---

### 2. **Error Context Wrapping**
Architecture reviewer: "When `exec("cat /missing")` fails, the error is "No such file or directory." But which target? Which file?"

**Recommendation**:
```typescript
catch (err) {
  throw new Error(
    `Remote operation failed on target '${target.name}': ${err.message}\n` +
    `Command: ${command}`
  );
}
```

Wrap all transport errors with target name and command for debuggability.

---

### 3. **Base64 Encoding Overhead Instrumentation**
Both reviewers note: 10MB file = 13.3MB transfer due to base64. Acceptable for Phase 1, but needs measurement.

**Recommendation**: Log transfer sizes and latency. If it becomes a bottleneck, implement binary transfer (scp/sftp for SSH, docker cp for Docker) in Phase 2.

---

### 4. **Connection Leak on Extension Disable**
Architecture reviewer: "If pi-tramp is disabled mid-session, open SSH connections are never closed."

**Recommendation**: Hook `extension.disable()` lifecycle and call `connectionPool.closeAll()`.

---

### 5. **Keepalive Algorithm Details**
Architecture reviewer: "Send `echo "keepalive"` every 30s. If fails 3 times consecutively → close and mark unhealthy."

Implementation reviewer: "Keep alive for 30 minutes of idle, probe every 15 seconds."

**Recommendation**: **Merge**: Probe every 15 seconds with `echo keepalive`. After 3 consecutive failures (45s), mark unhealthy and close. After 30 minutes idle, close gracefully.

---

## Open Questions

These require human decisions before implementation starts:

### 1. **Timeout vs AbortSignal for exec()**
Do we support both, or pick one?
- **Timeout**: Simpler, covers 90% of cases
- **AbortSignal**: Standard Web API, composable with other async operations

**Proposed resolution**: Support both via options object (shown in merged interface above).

---

### 2. **Shell detection commands**
Stage 1 synthesis recommended `echo "$0"` → `$PSVersionTable`. Both reviewers accepted this but it's not specified verbatim.

**Must document**: Exact probe commands and parsing rules for bash vs pwsh vs dash vs cmd.

---

### 3. **Atomic write strategy per shell**
Implementation reviewer shows bash using `mv` (atomic on POSIX) and pwsh using `Move-Item -Force` (not atomic on Windows).

**Question**: Is this acceptable for Phase 1? Or do we need `WriteAllBytes` followed by atomic rename on Windows?

**Proposed resolution**: Document as known limitation. File corruption on write failure is rare. Address in Phase 2 if it becomes an issue.

---

### 4. **`trampExec()` public API signature**
Design doc mentions exporting `trampExec()` for extension authors. Implementation reviewer asks: "What is the exact API?"

**Must specify**: Before Phase 1 ships. Public APIs are hard to change after external extensions depend on them.

**Proposed signature**:
```typescript
export async function trampExec(
  command: string,
  options?: { target?: string; timeout?: number }
): Promise<ExecResult>
```

If `target` is omitted, uses current target. Returns same shape as Transport.exec().

---

### 5. **Dynamic target persistence**
Architecture reviewer: "Dynamic targets created by agent: do they persist across sessions?"

Design says "runtime-only unless user asks to persist" but the API for persisting isn't specified.

**Proposed resolution**: `target({ action: "create", persist: true, ... })` writes to `.pi/targets.json`. Default is runtime-only.

---

### 6. **Config validation error format**
Architecture reviewer: "Validate against a Zod schema. Return a clear error with file path and field name."

Implementation reviewer agrees but doesn't specify schema.

**Must specify**: The exact Zod schema for TargetConfig before TargetManager implementation. This ensures validation errors are clear from day one.

---

## Consolidated Interface Specifications

Merging both reviewers' proposals into a single coherent spec:

### Transport Interface
```typescript
type TransportError =
  | { kind: "connection_lost"; cause: Error }
  | { kind: "command_failed"; code: number; stderr: string }
  | { kind: "timeout"; after_ms: number }
  | { kind: "not_connected" };

interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

interface Transport {
  // Identity
  readonly type: "ssh" | "docker" | "wsl" | "psremote";
  readonly shell: "bash" | "pwsh" | "sh" | "cmd" | "unknown";
  readonly platform: "linux" | "darwin" | "windows" | "unknown";
  readonly arch: string;
  
  // State
  readonly state: "connecting" | "connected" | "disconnected" | "error";
  
  // Core operations
  exec(command: string, options?: {
    timeout?: number;
    signal?: AbortSignal;
  }): Promise<ExecResult>;
  
  readFile(path: string): Promise<Buffer>;
  writeFile(path: string, content: Buffer): Promise<void>;
  
  // Lifecycle
  close(): Promise<void>;
  healthCheck(): Promise<boolean>;
  
  // Events
  on(event: "disconnect", cb: (err: Error) => void): void;
}
```

---

### ShellDriver Interface
```typescript
interface ShellDriver {
  readonly shell: "bash" | "pwsh" | "sh" | "cmd";
  
  // Command generation (returns complete, escaped commands)
  readFileCommand(absolutePath: string): string;
  writeFileCommand(absolutePath: string, base64Content: string): string;
  mkdirCommand(absolutePath: string, recursive: boolean): string;
  removeCommand(absolutePath: string, recursive: boolean): string;
  
  // Path utilities
  normalizePath(windowsOrPosix: string): string;
  isAbsolute(path: string): boolean;
}
```

---

### TargetManager Interface
```typescript
interface TargetConfig {
  type: "ssh" | "docker" | "wsl" | "psremote";
  // SSH-specific
  host?: string;
  identityFile?: string;
  port?: number;
  // Docker-specific
  container?: string;
  // Common
  cwd: string;
  shell?: "bash" | "pwsh";  // override detected shell
  requireEntryConfirmation?: boolean;
  timeout?: number;  // ms, default 60000
}

interface Target {
  name: string;
  type: "ssh" | "docker" | "wsl" | "psremote";
  config: TargetConfig;
  isDynamic: boolean;
  requireEntryConfirmation: boolean;
}

interface TargetManager {
  // State
  readonly currentTarget: Target | null;
  readonly targets: Map<string, Target>;
  
  // CRUD
  getTarget(name: string): Target | undefined;
  listTargets(): Target[];
  createTarget(name: string, config: TargetConfig, persist: boolean): Target;
  removeTarget(name: string): void;
  
  // Switching
  setCurrentTarget(name: string): void;
  clearCurrentTarget(): void;
  
  // Config
  reloadConfig(): Promise<void>;
  persistTarget(name: string): Promise<void>;
}
```

---

### ConnectionPool Interface
```typescript
interface ConnectionPool {
  // Get a connection (creates if needed, reuses if exists)
  getConnection(targetName: string): Promise<Transport>;
  
  // Execute with automatic queueing
  execOnTarget<T>(
    targetName: string,
    fn: (transport: Transport) => Promise<T>
  ): Promise<T>;
  
  // Cleanup
  closeConnection(targetName: string): Promise<void>;
  closeAll(): Promise<void>;
}
```

---

### operations-remote Pseudocode
```typescript
class RemoteReadOperations implements ReadOperations {
  async readFile(path: string): Promise<Buffer> {
    const absolutePath = this.resolvePath(path);
    return this.transport.readFile(absolutePath);
  }
}

class RemoteWriteOperations implements WriteOperations {
  async writeFile(path: string, content: Buffer): Promise<void> {
    const absolutePath = this.resolvePath(path);
    await this.transport.writeFile(absolutePath, content);
  }
}

class RemoteEditOperations implements EditOperations {
  async applyEditToFile(path: string, diffs: FileDiff[]): Promise<void> {
    // 1. Read entire file
    const content = await this.transport.readFile(path);
    if (content.length > 10 * 1024 * 1024) {
      throw new Error(`File too large for remote edit: ${path}`);
    }
    
    // 2. Apply diffs locally (preserve exact bytes including CRLF)
    const contentStr = content.toString("utf8");
    const newContent = applyDiffsToString(contentStr, diffs);
    
    // 3. Write back
    await this.transport.writeFile(path, Buffer.from(newContent, "utf8"));
  }
}

class RemoteBashOperations implements BashOperations {
  async exec(command: string, options?: ExecOptions): Promise<ExecResult> {
    return this.transport.exec(command, options);
  }
}
```

---

## Cross-Component Risks

Both reviewers identified the following integration risks:

### 1. **Shell Detection Must Happen Before First Command**
If the first command is `readFile()`, you need to know the shell to generate the read command. Detection must happen in `Transport.connect()`.

---

### 2. **Path Normalization at Tool Boundary**
Agent on Windows sends `C:\project\file.txt`. Target is Linux. Tool overrides must normalize paths before passing to operations-remote:
```typescript
const normalizedPath = target.normalizePath(params.path);
```

---

### 3. **Serial Queue is Per-Target, Not Global**
If the user has two targets active and switches between them, each target needs its own queue. Implementation reviewer specifies: `Map<string, CommandQueue>` in ConnectionPool.

---

### 4. **Sentinel Mixing in Rapid Sequential Commands**
Without UUID-based sentinels, two queued commands could emit `SENTINEL_0` and the parser might match the wrong one. UUID per invocation solves this.

---

### 5. **Connection Eviction After Mid-Command Drop**
When SSH drops mid-command, the connection object is dead (holds a killed process). Pool must evict immediately and refuse to reuse it. Critical: drain the queue before evicting.

---

## Build Order

Merging both reviewers' recommendations into a single unified sequence:

### Week 1: Interfaces & Pure Logic
1. **Transport interface + error types** (TypeScript only, zero implementation)
2. **TargetManager** (pure state management, config loading, merge logic)
   - Write Zod schema for TargetConfig
   - Test merge algorithm with overlapping global/project configs
3. **ShellDriver interface + implementation**
   - Implement BashDriver and PwshDriver
   - Unit test `shellEscape()` against real bash/pwsh processes
   - Test all critical cases: spaces, quotes, injection attempts, newlines

### Week 2: Docker Transport (Simpler Path)
4. **DockerTransport** (implements Transport interface)
   - Shell detection on connect (`docker exec <container> bash -c 'echo $0'`)
   - Serial command queue from day one
   - Integration test with real Docker container
5. **ConnectionPool** (lifecycle management over DockerTransport)
   - Test: connect, disconnect, reconnect, idle timeout
   - Measure latency: 100 exec iterations

### Week 3: SSH Transport (Harder Path)
6. **SshTransport** (persistent connection, sentinel protocol)
   - UUID-based sentinel algorithm
   - Stdout streaming reader with line buffering
   - Shell detection on connect
   - Timeout handling (kill process, mark dead)
   - pwsh color code detection and suppression
7. **Integration testing** (Docker container running sshd)
   - Test: large output (10MB), timeout, mid-command disconnect
   - Test: rapid sequential commands (verify no sentinel mixing)
   - Test: pwsh session (verify color codes handled)

### Week 4: Operations & Tool Overrides
8. **operations-remote** (all 4 operation interfaces)
   - Read/Write: straightforward mapping to transport
   - Edit: read-apply-write with 10MB limit, CRLF preservation
   - Bash: direct passthrough to transport.exec()
9. **tool-overrides** (all 4 tools: read, write, edit, bash)
   - Conflict detection warnings
   - Path normalization at tool boundary
   - Route to local or remote ops based on current target
10. **target-tool** (CRUD + switch)
    - Lazy connection on switch (not on create)
    - requireEntryConfirmation (no bypass in Phase 1)

### Week 5: Integration & Polish
11. **System prompt + context injection**
    - Inject platform/shell/arch/cwd into system prompt
    - Measure token count immediately (log if >300 tokens)
12. **Status bar widget** (show current target)
13. **End-to-end testing**
    - Switch targets mid-conversation
    - All 4 tools work on both SSH and Docker
    - Error recovery: connection drop, timeout, unreachable host

### Week 6: Validation
14. **Dog-fooding** (use on a real project)
15. **Bug fixes** based on real usage
16. **Documentation** (README, examples, config schema reference)

---

## Timeline

**Consensus estimate: 7-9 weeks for Phase 1A**

Both reviewers agree that building SSH + Docker + all 4 tool overrides simultaneously:
- Validates the abstraction (correct)
- Doubles the hardest part of the work (SSH: 2 weeks instead of Docker-only's 1 week)
- Delays first integration test (week 4 instead of week 2)

**Breakdown**:
| Phase | What | Estimate |
|---|---|---|
| Interfaces + TargetManager + ShellDrivers | Foundation | 1 week |
| DockerTransport + ConnectionPool | Docker complete | 1 week |
| SshTransport + sentinel + lifecycle | SSH complete | 2 weeks |
| operations-remote (all 4 ops) | Remote ops | 1 week |
| tool-overrides + target-tool | Wiring | 0.5 weeks |
| System prompt + status bar | UX polish | 0.5 weeks |
| Integration debugging | Reality tax | 1-2 weeks |
| **Total** | | **7-9 weeks** |

**What could be cut** (if timeline pressure hits):
- `write` and `edit` overrides → Phase 1B (read-only remote targets)
- WSL and PSRemote transports → Phase 2
- System prompt injection → Phase 2 (target context only)

But Marc explicitly decided all 4 tool overrides ship together. Accept the 7-9 week timeline.

---

## Remaining Specifications Required

Before implementation starts, these must be written into the design doc:

### 1. **Sentinel Protocol Algorithm** (verbatim)
```typescript
// Exact format, exact parsing rules, exact error handling
const sentinel = `__PITRAMP_${crypto.randomUUID().replace(/-/g, "")}__`;
// ... (full algorithm as shown in Implementation reviewer section 8)
```

### 2. **Shell Detection Commands** (verbatim)
```bash
# Probe 1: Get shell name
echo "$0"
# Expected output: "bash", "sh", "-bash", etc.

# Probe 2: PowerShell detection
$PSVersionTable.PSVersion.Major
# Expected output: "7" or error if not pwsh
```
Include: parsing logic, fallback if probe fails, dash vs bash distinction.

### 3. **Shell Escaping Algorithm** (verbatim)
Full implementations of `BashDriver.escape()` and `PwshDriver.escape()` including dash fallback.

### 4. **CRLF Handling Policy** (explicit rule)
"Preserve exact bytes from `readFile()` through edit and back to `writeFile()`. Do not normalize line endings. If `oldText` match fails, include line-ending hint in error message."

### 5. **Atomic Write Strategy** (per shell, documented)
Bash: temp file + mv (atomic on POSIX)
Pwsh: temp file + Move-Item (best-effort on Windows, document limitation)

### 6. **TargetConfig Zod Schema** (executable code)
```typescript
const TargetConfigSchema = z.object({
  type: z.enum(["ssh", "docker", "wsl", "psremote"]),
  host: z.string().optional(),
  identityFile: z.string().optional(),
  port: z.number().int().min(1).max(65535).optional(),
  container: z.string().optional(),
  cwd: z.string(),
  shell: z.enum(["bash", "pwsh", "sh", "cmd"]).optional(),
  requireEntryConfirmation: z.boolean().optional(),
  timeout: z.number().int().min(1000).optional()
});
```

### 7. **trampExec() Public API Signature** (before Phase 1 ships)
```typescript
export async function trampExec(
  command: string,
  options?: { target?: string; timeout?: number; signal?: AbortSignal }
): Promise<ExecResult>
```

### 8. **Error Message Format for LLM** (standardized across all 4 tools)
```typescript
// On transport error:
return {
  error: true,
  kind: "remote_operation_failed",
  target: target.name,
  operation: "read" | "write" | "edit" | "bash",
  message: "Connection lost to target 'dev' during read operation",
  details: transportError
};
```

---

## Final Recommendation

**The architecture is shippable in 7-9 weeks if the 8 specifications above are written before coding starts.**

Without them:
- Week 3: Debugging "why does SSH hang?"
- Week 4: Discovering paths with spaces break everything
- Week 5: Edit fails silently on Windows targets
- Week 6-8: Firefighting instead of testing

**Next action**: Write a `stage-2-specs.md` document containing verbatim implementations of all 8 items. Review it. Then start Week 1.

Marc's scope decision (SSH + Docker + all 4 tools together) is architecturally sound. It validates the abstraction early and surfaces cross-cutting concerns. The timeline cost (7 weeks instead of 3-4) is acceptable for a foundational piece. The reviewers' critiques are not objections to the decision — they're requests for specification completeness before implementation.

**Ship it.**
