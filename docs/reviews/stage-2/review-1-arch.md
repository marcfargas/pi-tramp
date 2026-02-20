# Architecture Review: Pi-Tramp Component Analysis

## Summary Verdict

The architecture is **sound but underspecified in critical areas**. Given the author's decision to build SSH + Docker + all 4 tool overrides simultaneously, the component interfaces need hardening now — not during implementation. The decomposition is clean, the Operations abstraction is the right boundary, but three components (ShellDriver, operations-remote, Sentinel Protocol) have hand-waved complexity that will surface as multi-day debugging sessions.

**Key risk**: The decision to build both transports together amplifies interface ambiguity. When SSH and Docker both fail, you won't know if it's the Transport contract, the ShellDriver layer, or operations-remote. The serial queue for concurrent commands is essential from day one — not a "we'll add it when we hit the bug" feature.

**Shippable?** Yes, if the 6 interface gaps below are closed before implementation starts.

---

## Component Reviews

### 1. Transport Interface

**Interface**: Incomplete — missing critical methods and error contracts.

```typescript
// What the design shows:
interface Transport {
  exec(command: string): Promise<{ stdout, stderr, code }>;
  readFile(path: string): Promise<Buffer>;
  writeFile(path, content): Promise<void>;
  close(): Promise<void>;
}
```

**What's missing**:
- **Connection state query** — How does ConnectionPool check if a transport is alive? `isConnected()` or let `exec` throw?
- **Concurrent execution contract** — Is `exec()` safe to call in parallel, or must the caller serialize? The design says "serial queue from day one" but doesn't say where — Transport or ConnectionPool?
- **Error types** — What does `exec` throw when the connection drops? `TransportError`? `NetworkError`? Just `Error`? operations-remote needs to know what to catch.
- **Timeout handling** — Does `exec` have a timeout? Is it per-call or connection-level? Who owns the timeout?
- **Initialization** — How does a transport get created? Factory pattern? Constructor with config object? The design never shows `new SshTransport(...)` or `DockerTransport.create(...)`.

**Recommendation**:
```typescript
interface Transport {
  // State
  readonly type: "ssh" | "docker" | "wsl" | "psremote";
  readonly isConnected: boolean;
  
  // Core operations (ALL serialized by ConnectionPool)
  exec(command: string, timeout?: number): Promise<ExecResult>;
  readFile(path: string): Promise<Buffer>;
  writeFile(path: string, content: Buffer): Promise<void>;
  
  // Lifecycle
  close(): Promise<void>;
  healthCheck(): Promise<boolean>;  // keepalive probe
}

interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

// Transports throw these:
class TransportError extends Error {
  constructor(message: string, public cause?: Error) {}
}
class ConnectionDroppedError extends TransportError {}
class CommandTimeoutError extends TransportError {}
```

**Coupling**: Minimal — this is the right abstraction. Depends on nothing.

**Testing seam**: Perfect — mock implementations are trivial. Write a `MemoryTransport` that stores files in a Map and returns canned exec results.

**Risk**: If this interface isn't nailed down now, both SSH and Docker will implement different error semantics and timeout behaviors. Then operations-remote has to handle two different contract variants.

---

### 2. ShellDriver (BashDriver + PwshDriver)

**Interface**: The commands are easy, but escaping is underspecified and will cause the first production bug.

```typescript
// What the design implies:
interface ShellDriver {
  readFileCommand(path: string): string;
  writeFileCommand(path: string, base64Content: string): string;
  mkdirCommand(path: string): string;
  shellEscape(arg: string): string;  // mentioned but not specified
}
```

**What's missing**:
- **Escaping rules for nested quotes** — `cat "file with \"quotes\".txt"` requires different escaping in bash vs pwsh vs cmd
- **Path normalization** — Does BashDriver convert `C:\path` to `/c/path`? Or does the caller handle it?
- **Error detection in commands** — The `writeFileCommand` needs to check if write succeeded. Does each command include `|| exit 1`? Or do you trust `$?` from the sentinel?
- **Binary file handling** — `readFileCommand` with base64 encoding (`cat | base64`) vs raw binary. Does the interface specify encoding or does readFile/writeFile handle it?

**Example that will break**:
```typescript
// Agent calls: read({ path: "user input.txt" })
const cmd = driver.readFileCommand("user input.txt");  // WRONG
// Needs: driver.readFileCommand(driver.shellEscape("user input.txt"))
// Who is responsible for escaping? The driver or the caller?
```

**Recommendation**:
```typescript
interface ShellDriver {
  readonly shell: "bash" | "pwsh";
  
  // These return COMPLETE commands (already escaped)
  readFileCommand(absolutePath: string): string;
  writeFileCommand(absolutePath: string, base64Content: string): string;
  mkdirCommand(absolutePath: string, recursive: boolean): string;
  removeCommand(absolutePath: string, recursive: boolean): string;
  
  // Path utilities
  normalizePath(windowsOrPosix: string): string;  // C:\foo → /c/foo for bash
  isAbsolute(path: string): boolean;
  
  // Internal escaping (not exposed — driver handles it)
}

class BashDriver implements ShellDriver {
  readFileCommand(path: string): string {
    const escaped = this.escape(path);
    return `cat ${escaped} | base64`;
  }
  
  private escape(arg: string): string {
    // Bash escaping: wrap in single quotes, escape embedded single quotes
    return `'${arg.replace(/'/g, "'\\''")}'`;
  }
}

class PwshDriver implements ShellDriver {
  readFileCommand(path: string): string {
    const escaped = this.escape(path);
    return `[Convert]::ToBase64String([IO.File]::ReadAllBytes(${escaped}))`;
  }
  
  private escape(arg: string): string {
    // PowerShell escaping: wrap in single quotes, escape embedded quotes
    return `'${arg.replace(/'/g, "''")}'`;
  }
}
```

**Coupling**: Tight coupling to shell-specific syntax. That's correct — trying to abstract bash+pwsh into shared logic is a trap.

**Testing seam**: Easy — unit test each driver's commands by parsing output or running in a local shell.

**Risk**: Escaping bugs will cause silent failures (file not found) or injection vulnerabilities if paths come from untrusted sources. **This is the #1 place to write paranoid tests.**

---

### 3. TargetManager

**Interface**: The config schema is clear, but CRUD operations and lifecycle are underspecified.

**What's in the design**:
- Config: `~/.pi/targets.json` + `.pi/targets.json` (project overrides global)
- CRUD: create/list/remove dynamic targets
- Current target tracking

**What's missing**:
- **State persistence** — Dynamic targets created by agent: do they persist across sessions? The design says "runtime-only unless user asks to persist" but doesn't specify the API for persisting.
- **Config reload behavior** — If `.pi/targets.json` changes while pi is running, does TargetManager reload automatically or only on startup?
- **Validation** — What happens if `targets.json` has invalid JSON? Missing required fields? Duplicate target names?
- **Merge conflicts** — Global defines `dev`, project defines `dev`. Project wins. But what if project's `dev` has `type: "docker"` and global has `type: "ssh"`? Full replacement or field-level merge?

**Recommendation**:
```typescript
interface TargetManager {
  // State
  readonly currentTarget: Target | null;
  readonly targets: Map<string, Target>;  // all targets (config + dynamic)
  
  // CRUD
  getTarget(name: string): Target | undefined;
  listTargets(): Target[];
  createTarget(config: TargetConfig, persist: boolean): Target;
  removeTarget(name: string): void;  // throws if target is from config file
  
  // Switching
  setCurrentTarget(name: string): void;
  clearCurrentTarget(): void;
  
  // Config
  reloadConfig(): Promise<void>;  // re-read files
  persistTarget(name: string): Promise<void>;  // write to config
}

interface Target {
  name: string;
  type: "ssh" | "docker" | "wsl" | "psremote";
  config: TargetConfig;
  isDynamic: boolean;  // true if created at runtime
  requireEntryConfirmation: boolean;
}
```

**Coupling**: Depends on config file parsing (fs + JSON). No coupling to Transport — correct.

**Testing seam**: Perfect — pure state management. Mock filesystem for config loading.

**Risk**: Merge precedence bugs if global/project configs overlap. Needs explicit test cases for every merge scenario.

---

### 4. ConnectionPool

**Interface**: Lifecycle and reconnect logic are the hard parts. The design mentions keepalive and reconnect but provides no algorithm.

**What's in the design**:
- "Keep connections alive"
- "On connection drop → attempt reconnect"
- "On target switch away → keep connection alive (don't close)"

**What's missing**:
- **Keepalive algorithm** — How often? What command? (Common: send a no-op every 30s)
- **Reconnect policy** — Exponential backoff? Max retries? Immediate reconnect?
- **Concurrent access** — If two tool calls happen simultaneously on the same target, do they share the connection? (Yes, via serial queue — but where is the queue?)
- **Close behavior** — When does a connection actually close? Only on session shutdown? Or timeout after 5min of inactivity?
- **Health check failures** — If keepalive fails 3 times, close and mark unhealthy? Or keep retrying forever?

**Recommendation**:
```typescript
interface ConnectionPool {
  // Get a connection (creates if needed, reuses if exists)
  getConnection(target: Target): Promise<Transport>;
  
  // Close a specific target's connection
  closeConnection(targetName: string): Promise<void>;
  
  // Close all connections
  closeAll(): Promise<void>;
  
  // Execute on target with automatic queueing
  execOnTarget(targetName: string, fn: (transport: Transport) => Promise<T>): Promise<T>;
}

class ConnectionPoolImpl {
  private connections = new Map<string, Connection>();
  private queues = new Map<string, CommandQueue>();  // one queue per target
  
  async execOnTarget<T>(targetName: string, fn: (t: Transport) => Promise<T>): Promise<T> {
    const queue = this.getOrCreateQueue(targetName);
    return queue.enqueue(async () => {
      const transport = await this.getConnection(targetName);
      return fn(transport);
    });
  }
  
  private async keepalive(connection: Connection): Promise<void> {
    // Send `echo "keepalive"` every 30s
    // If fails 3 times consecutively → close and mark unhealthy
  }
}

interface Connection {
  transport: Transport;
  lastUsed: Date;
  healthCheckFailures: number;
  keepaliveTimer: NodeJS.Timer;
}

class CommandQueue {
  private queue: Array<() => Promise<any>> = [];
  private running = false;
  
  async enqueue<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      this.queue.push(async () => {
        try {
          const result = await fn();
          resolve(result);
        } catch (err) {
          reject(err);
        }
      });
      this.processQueue();
    });
  }
  
  private async processQueue() {
    if (this.running || this.queue.length === 0) return;
    this.running = true;
    while (this.queue.length > 0) {
      const fn = this.queue.shift()!;
      await fn();
    }
    this.running = false;
  }
}
```

**Coupling**: Depends on TargetManager (to get target configs) and Transport implementations.

**Testing seam**: Mockable — inject fake transports and verify queue ordering, reconnect attempts, etc.

**Risk**: If the serial queue is not implemented from day one, the first concurrent tool call will corrupt the SSH session. This is non-negotiable.

---

### 5. operations-remote

**Interface**: Maps pi's Operations interfaces to remote execution. The `edit` operation is genuinely hard.

**What's in the design**:
- Implements `ReadOperations`, `WriteOperations`, `EditOperations`, `BashOperations`
- Uses Transport + ShellDriver to translate operations to shell commands

**What's missing for `edit`**:
The design punts on this: "how do you do diff-based patching remotely?" It's not a trivial problem.

Pi's `edit` tool uses `applyEditToFile(diffs: FileDiff[])` where each diff has `startLine`, `endLine`, `newContent`. To apply this remotely:

**Option A: Ship the diff, apply with sed/awk** (fragile)
```bash
# For each diff: sed -i '${startLine},${endLine}c\${newContent}' ${file}
# Problem: newContent with newlines breaks sed syntax
# Problem: off-by-one errors if multiple diffs overlap
```

**Option B: Read file locally, apply diff, write back** (bandwidth waste)
```typescript
// 1. readFile(path) → download entire file
// 2. Apply diffs locally (pi's own logic)
// 3. writeFile(path, newContent) → upload entire file
// Problem: 100MB file with 1-line change = 200MB transfer
```

**Option C: Ship a temp script** (correct but complex)
```typescript
async function applyEditRemotely(transport: Transport, path: string, diffs: FileDiff[]) {
  // 1. Generate a shell script that applies diffs line-by-line
  const script = generateEditScript(diffs);  // uses awk or similar
  
  // 2. Upload script to temp file
  await transport.writeFile("/tmp/edit-script-${uuid}.sh", Buffer.from(script));
  
  // 3. Execute script
  await transport.exec(`bash /tmp/edit-script-${uuid}.sh ${shellEscape(path)}`);
  
  // 4. Clean up
  await transport.exec(`rm /tmp/edit-script-${uuid}.sh`);
}
```

**Recommendation**: Commit to **Option C** (temp script) or **Option B** (read-apply-write) now. Don't defer this decision — it affects whether you need script generation logic or file size limits.

For Phase 1, **Option B is simpler** and fine for source files (<1MB). Add a 10MB limit and fail fast.

```typescript
class RemoteEditOperations implements EditOperations {
  constructor(
    private transport: Transport,
    private driver: ShellDriver,
    private cwd: string
  ) {}
  
  async applyEditToFile(path: string, diffs: FileDiff[]): Promise<void> {
    const absolutePath = this.resolvePath(path);
    
    // 1. Read entire file
    const content = await this.transport.readFile(absolutePath);
    if (content.length > 10 * 1024 * 1024) {
      throw new Error(`File too large for remote edit: ${absolutePath} (${content.length} bytes)`);
    }
    
    // 2. Apply diffs locally (reuse pi's own applyEditToFile logic)
    const lines = content.toString("utf-8").split("\n");
    const newLines = applyDiffsToLines(lines, diffs);
    const newContent = newLines.join("\n");
    
    // 3. Write back
    await this.transport.writeFile(absolutePath, Buffer.from(newContent, "utf-8"));
  }
}
```

**Coupling**: Depends on Transport, ShellDriver, and pi's own Operations logic (for local diff application).

**Testing seam**: Good — mock Transport, feed it diffs, verify the writeFile call.

**Risk**: **Edit is the hardest operation.** The design handwaves this. If you commit to read-apply-write, you need file size limits. If you commit to remote script generation, you need awk/sed expertise and edge case tests.

---

### 6. tool-overrides

**Interface**: Dispatch logic is simple, but conflict detection is missing.

**What's in the design**:
- Override `read`, `write`, `edit`, `bash` using `pi.registerTool()`
- Route to local or remote operations based on current target

**What's missing**:
- **Conflict detection** — If another extension (pi-powershell, pi-sandbox) also overrides `bash`, last-writer-wins. Silent failure.
- **Initialization order** — If pi-tramp loads before pi-powershell, pi-powershell's override wins. How do you guarantee pi-tramp loads last?

**Recommendation**:
```typescript
function registerToolOverrides(pi: PiSDK) {
  const tools = ["read", "write", "edit", "bash"];
  
  for (const toolName of tools) {
    const original = pi.tools.get(toolName);
    
    // Warn if another extension already overrode this
    if (original && original.source !== "builtin") {
      pi.logger.warn(
        `pi-tramp: Tool '${toolName}' was already overridden by '${original.source}'. ` +
        `Remote routing may not work correctly.`
      );
    }
    
    pi.registerTool({
      ...createRemoteTool(toolName),
      source: "pi-tramp"  // mark for conflict detection
    });
  }
}
```

**Coupling**: Depends on TargetManager (to get current target), ConnectionPool (to get transport), and operations-remote.

**Testing seam**: Requires pi runtime or elaborate mocking of `pi.registerTool`.

**Risk**: If two extensions override the same tool and there's no visible warning, debugging "why is bash running locally when I switched targets?" will take hours.

---

### 7. target-tool

**Interface**: The tool schema is clear, but confirmation UX is underspecified.

**What's in the design**:
- `target({ action: "list" | "switch" | "create" | "remove" | "status", ... })`
- `requireEntryConfirmation` triggers `ctx.ui.confirm()` before switch

**What's missing**:
- **Confirmation text** — What does the confirm dialog say? "Switch to production (requires confirmation)?"
- **Blocking behavior** — If confirmation is denied, does the tool call throw an error? Return `{ success: false }`? How does the agent know?
- **User-initiated bypass** — The decision doc says `/target switch production` bypasses confirmation. How does the tool know if the call came from the user vs the agent? (Answer: it can't — the user command is translated to a tool call by pi.)

**This is actually a pi limitation**: There's no way for a tool to distinguish "user typed `/target switch production`" from "agent called `target({ action: 'switch' })`". Both arrive as tool calls.

**Recommendation**: **Ignore the bypass rule for Phase 1.** Always require confirmation if `requireEntryConfirmation` is true. Accept that `/target` commands also require confirmation.

```typescript
async function handleTargetSwitch(params: { name: string }, ctx: ToolContext) {
  const target = targetManager.getTarget(params.name);
  if (!target) {
    throw new Error(`Target not found: ${params.name}`);
  }
  
  if (target.requireEntryConfirmation) {
    const confirmed = await ctx.ui.confirm(
      `Switch to target '${params.name}'?\n\n` +
      `This target requires confirmation before entry.`
    );
    if (!confirmed) {
      return { success: false, message: "Switch cancelled by user" };
    }
  }
  
  targetManager.setCurrentTarget(params.name);
  await connectionPool.getConnection(target);  // establish connection
  
  return { success: true, message: `Switched to ${params.name}` };
}
```

**Coupling**: Depends on TargetManager and ConnectionPool.

**Testing seam**: Requires pi runtime for `ctx.ui.confirm()`. Mock it if possible.

**Risk**: The bypass rule can't be implemented without upstream pi changes. Either drop it or propose a `ctx.isUserInitiated` flag to pi.

---

### 8. Sentinel Protocol (SSH-specific)

**Interface**: Not defined at all. The design says "SSH needs sentinels" but provides no algorithm.

**The problem**: You send `ls /tmp` over stdin. The SSH shell executes it and waits for the next command. How do you know `ls` finished? You need a sentinel:

```bash
ls /tmp
echo "SENTINEL_$?"
```

Then read stdout until you see `SENTINEL_0` (success) or `SENTINEL_1` (failure).

**What will break**:
1. **Binary output containing the sentinel string** — If `cat image.jpg` outputs bytes that happen to match `SENTINEL_`, you parse it as completion.
2. **Concurrent commands** — If two commands are queued and both emit sentinels, you might match the wrong one.
3. **Network hiccup** — Partial sentinel (`SENTIN`) arrives, then timeout. Reconnect? Retry?

**Recommendation**: Use a **UUID-based sentinel per command**:
```typescript
class SshTransport {
  private commandCounter = 0;
  
  async exec(command: string, timeout = 60000): Promise<ExecResult> {
    const sentinel = `SENTINEL_${uuidv4()}`;
    const wrappedCommand = `${command}\necho "${sentinel}_$?"`;
    
    // Send command
    this.stdin.write(wrappedCommand + "\n");
    
    // Read until sentinel appears
    const output = await this.readUntilSentinel(sentinel, timeout);
    
    // Parse exit code from sentinel line
    const match = output.match(new RegExp(`${sentinel}_(\\d+)`));
    const exitCode = match ? parseInt(match[1]) : -1;
    
    // Remove sentinel from output
    const stdout = output.replace(new RegExp(`${sentinel}_\\d+\\n?`), "");
    
    return { stdout, stderr: "", exitCode };
  }
  
  private async readUntilSentinel(sentinel: string, timeout: number): Promise<string> {
    const chunks: string[] = [];
    const deadline = Date.now() + timeout;
    
    return new Promise((resolve, reject) => {
      const onData = (chunk: Buffer) => {
        chunks.push(chunk.toString());
        const combined = chunks.join("");
        if (combined.includes(sentinel)) {
          this.stdout.off("data", onData);
          clearTimeout(timer);
          resolve(combined);
        }
      };
      
      const timer = setTimeout(() => {
        this.stdout.off("data", onData);
        reject(new CommandTimeoutError(`Command timed out after ${timeout}ms`));
      }, timeout);
      
      this.stdout.on("data", onData);
    });
  }
}
```

**Coupling**: SSH-specific. Docker doesn't need this (docker exec returns naturally).

**Testing seam**: Run against a real SSH server or mock stdin/stdout pipes.

**Risk**: **This is the most fragile piece of the SSH transport.** If the sentinel protocol is wrong, commands will hang, output will be truncated, or exit codes will be lost. Needs extensive testing with edge cases (large output, slow output, binary output, network hiccups).

---

## Cross-Component Issues

### 1. Shell Detection Happens Too Late

The design says "detect shell on first command." But what if the first command is `readFile("/etc/passwd")`? You need to know the shell to generate the read command.

**Fix**: Detect shell during connection establishment (before any operations).

```typescript
class SshTransport {
  private shell: "bash" | "pwsh" | "unknown";
  
  async connect(): Promise<void> {
    // Send probe commands
    await this.exec(`echo "$0"`);  // get shell name
    // Parse output to determine shell
    // Set this.shell
  }
}
```

---

### 2. Path Separator Mismatch

Agent on Windows calls `read({ path: "C:\\project\\file.txt" })`. Target is Linux. Does the tool override normalize the path?

**Fix**: Tool overrides must normalize paths before passing to operations-remote:

```typescript
async function readTool(params: { path: string }) {
  const target = getCurrentTarget();
  const normalizedPath = target.normalizePath(params.path);  // C:\foo → /c/foo if needed
  const ops = target.getReadOperations();
  return ops.readFile(normalizedPath);
}
```

---

### 3. Base64 Encoding Overhead

Every file read/write goes through base64. For a 10MB file: 13.3MB transfer. Acceptable for Phase 1, but needs measurement.

**Fix**: Add instrumentation to log transfer sizes and latency. If it becomes a bottleneck, implement binary transfer (scp/sftp for SSH, docker cp for Docker) in Phase 2.

---

### 4. Error Context Lost

When `exec("cat /missing")` fails, the error is "No such file or directory." But which target? Which file?

**Fix**: Wrap all transport errors with context:

```typescript
try {
  await transport.exec(command);
} catch (err) {
  throw new Error(
    `Remote operation failed on target '${target.name}': ${err.message}\n` +
    `Command: ${command}`
  );
}
```

---

### 5. Connection Leak on Extension Disable

If pi-tramp is disabled mid-session, open SSH connections are never closed.

**Fix**: Hook `extension.disable()` and call `connectionPool.closeAll()`.

---

## Revised Build Order

Given the decision to build SSH + Docker + all 4 tool overrides together:

### Week 1: Interfaces & Pure Logic
1. **Define Transport interface** (with error types, timeout contract)
2. **Define ShellDriver interface** (with escaping spec)
3. **Implement TargetManager** (pure state, no I/O)
4. **Implement BashDriver + PwshDriver** (unit tested locally)

### Week 2: Docker Transport (Simpler Path)
5. **Implement DockerTransport** (implements Transport)
   - Shell detection on connect
   - Exec with serial queue
6. **Implement ConnectionPool** (with CommandQueue)
7. **Test**: Docker exec latency (100 iterations, measure)

### Week 3: SSH Transport (Harder Path)
8. **Implement SshTransport** (persistent connection)
   - Sentinel protocol (UUID-based)
   - Shell detection on connect
   - Timeout + reconnect
9. **Test**: Run against real SSH server (Docker container running sshd)

### Week 4: Operations & Tool Overrides
10. **Implement operations-remote** (Read/Write/Bash/Edit)
    - Edit = read-apply-write for Phase 1
    - 10MB file size limit
11. **Implement tool-overrides** (all 4 tools)
    - Conflict detection warnings
    - Path normalization
12. **Implement target-tool** (CRUD + switch)
    - requireEntryConfirmation (no bypass)

### Week 5: Integration & Polish
13. **Basic system prompt injection** (platform/shell/arch)
    - Measure token cost immediately
14. **Status bar widget** (show current target)
15. **End-to-end testing** (SSH + Docker, all 4 tools, target switching)

### Week 6: Validation
16. **Dog-fooding** (use it on a real project)
17. **Bug fixes** based on real usage
18. **Documentation** (README, examples)

---

## Final Verdict

**This architecture will work, but only if you close the interface gaps before coding.**

The 6 must-fix items:
1. **Transport interface** — add error types, timeout contract, health check
2. **ShellDriver escaping** — specify escaping algorithm for bash + pwsh
3. **Edit operation strategy** — commit to read-apply-write with 10MB limit
4. **Sentinel protocol** — specify UUID-based algorithm with timeout
5. **Serial command queue** — implement in ConnectionPool from day one
6. **Shell detection timing** — detect on connect, not on first command

With these fixed, the decomposition is clean and shippable in 6 weeks.

Without them, you'll spend week 3 debugging "why does this hang on SSH?" and week 4 discovering that file paths with spaces break everything.

**Your call.**
