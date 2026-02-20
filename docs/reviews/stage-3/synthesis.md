# Stage 3 Final Synthesis: Vision → Decomposition → Recomposition

## Executive Summary

**The design is shippable.** The TRAMP analogy survives decomposition intact, the architecture is a clean DAG with zero cycles, and the Operations abstraction is the correct boundary. Both reviewers traced the scenarios end-to-end and found the design **85% complete** — the remaining 15% is three un-written specifications and three missing interface contracts. Without those, the first three weeks will be debugging instead of building. With them, the 7-9 week estimate is realistic and the project will ship successfully.

**Critical path**: Write the 8 specifications from Stage 2 (sentinel protocol, shell escaping, CRLF policy, Zod schema, error format, atomic write, shell detection, trampExec API) before Week 1 starts. Add 3 interface contracts (initial target selection, context injection trigger, UUID-based tmp files). Then build bottom-up following the dependency graph.

**Bottom line**: Ready to implement. Spec work required: ~2-3 days. Implementation timeline: 7-9 weeks for Phase 1A (SSH + Docker + all 4 tool overrides). First deliverable: prototype the SSH sentinel protocol (2-4 hours if the design is sound, days if it's not — this validates everything).

---

## 1. Composition Verdict

### Does the decomposition preserve the original vision when reassembled?

**Yes, with 3 additions.**

The TRAMP analogy (pi stays local, tools execute remotely, explicit boundary) survives decomposition intact:

#### What Survived ✅

1. **Explicit boundary** — Target switch visible to agent (system prompt, status bar)
2. **pi stays local** — No bind-mounting, no devcontainer complexity, pi's brain runs on host
3. **Tools execute remotely** — Transport abstraction + Operations layer delivers this
4. **TRAMP-like transparency** — `read()` syntax unchanged, routing invisible to LLM
5. **Multiple transports** — SSH, Docker, WSL, PSRemote all plug into same abstraction
6. **Shell-agnostic** — Agent adapts to target shell via system prompt, tools don't morph

#### What Changed ⚠️

1. **requireEntryConfirmation bypass** — Marc's decision ("/target bypasses confirmation") can't be implemented without `ctx.isUserInitiated` from pi. **Deferred to Phase 2** (blocked upstream).
2. **Dynamic target persistence** — API for "asking to persist" wasn't in original design. Stage 2 proposed `persist: boolean` flag. **Not a loss, it's an addition.**
3. **trampExec() for extensions** — API signature proposed but not locked. Build order pushes to Week 6. **The hook exists, just not day-one ready.**

#### What Was Lost ❌

**Nothing fundamental.** The vision survives. The 7-9 week timeline and specification gaps are engineering reality checks, not architectural drift.

### Interface Gaps Found (The Missing 15%)

Three interface contracts are missing from the Stage 2 decomposition:

#### GAP 1: Initial Target Selection
**Problem**: Who sets `TargetManager.currentTarget` on session start?

**Solution**: Add `default` field to config. TargetManager sets it on init.
```typescript
// ~/.pi/targets.json
{
  "default": "dev",  // ← Add this
  "targets": { "dev": { ... } }
}
```

#### GAP 2: Context Injection Trigger (Critical)
**Problem**: `sendMessage()` for target context is described but **not wired in the decomposition**.

**Solution**: TargetManager emits event → extension root listener calls `sendMessage()`.
```typescript
// Add to TargetManager interface:
interface TargetManager extends EventEmitter {
  on(event: "target_switched", listener: (event: { from: string | null; to: string }) => void): this;
}

// Add to extension.ts activate():
targetManager.on("target_switched", async ({ to }) => {
  const context = await buildTargetContext(to);
  pi.sendMessage({ customType: "pi_tramp-target_context", content: [...], display: "none" });
});
```

#### GAP 3: Temp File Cleanup
**Problem**: Write crash leaves `.tmp` files on remote. No cleanup strategy.

**Solution**: UUID-based tmp filenames, document as known limitation.
```typescript
const tmpPath = `${path}.${crypto.randomUUID()}.tmp`;
```

### Recomposition Verdict

**Does it compose? Yes, with 3 additions.**

All 4 end-to-end scenarios work (read file, edit file, connection drop recovery, target switch) when the 3 interface contracts above are added.

---

## 2. Scenario Trace Results

Both reviewers traced scenarios through the full stack. Results:

### ✅ Scenario 1: Read File on SSH Target (PASSES)
User configures SSH target → agent calls `read("src/index.ts")` → tool override routes to operations-remote → SshTransport connects (lazy) → shell detection → sentinel protocol → base64 decode → returns to agent.

**Assumption**: Default target set in config OR user switches first.

### ✅ Scenario 2: Edit File (Read-Apply-Write) (PASSES)
Agent calls `edit()` → read file via transport → apply diffs locally (CRLF preserved) → write back via transport. Two round trips. Atomic write on remote (temp file + mv).

**Note**: CRLF handling is documented behavior, not a gap. Agent must provide exact match.

### ⚠️ Scenario 3: SSH Drops Mid-Edit (PARTIAL)
Connection dies between read and write → `onDisconnect()` rejects all pending queue items → tool error visible to agent → agent can retry.

**Issue**: Temp file orphaning is not addressed. Not a critical bug (slow accumulation), but should use UUID-based tmp names (GAP 3 above).

### ✅ Scenario 4: Target Switch (dev → staging → dev) (PASSES with caveat)
Agent switches targets → TargetManager updates → context injection fires (via event) → next tool call uses new target → connection reuse works (pool cache).

**Caveat**: Context injection trigger is described but not wired in Stage 2 decomposition (GAP 2 above).

**Bottom line**: All scenarios work end-to-end when the 3 gaps are filled.

---

## 3. Integration Risk Map

Highest-risk seams between components, rank-ordered by likelihood × impact:

### 🔴 CRITICAL (Will Break in Week 1 Without Mitigation)

#### 1. **PowerShell ANSI Color Codes in Sentinel Protocol**
**Risk**: Interactive pwsh emits `\e[32m` color sequences that corrupt output. Sentinel never found. Every bash tool call on Windows SSH target times out after 60s.

**Seam**: SshTransport ↔ ShellDriver (pwsh session setup)

**Mitigation**: Send `$PSStyle.OutputRendering = 'PlainText'` as the **very first command** in `connect()` for any pwsh session, before shell detection is complete. If target is bash, this errors silently (ignore).

**Test**: Docker container with pwsh as default shell. Confirm `exec("echo hello")` returns clean output.

---

#### 2. **Shell Escaping Breaks on First Non-Trivial Path**
**Risk**: User has project at `/home/user/my project/` (space in path). Every file operation fails with "no such file or directory." Silent failure.

**Seam**: ShellDriver.shellEscape() ↔ all tool overrides

**Mitigation**: Test escaping on **Day 2** against real local bash and pwsh processes. Not mocked. Test cases:
- `file with spaces.txt`
- `file's.txt` (single quote)
- `file"double.txt` (double quote)
- `file$(rm -rf /).txt` (injection attempt)
- `file\nnewline.txt` (literal newline)

**Test**: Run `cat ${escaped_path} 2>/dev/null; echo "exit:$?"` and verify: exit code 1 (file not found), no shell error, no injection.

---

#### 3. **Concurrent Tool Calls Corrupt SSH Session**
**Risk**: LLM returns two tool calls in one turn. Both write to stdin simultaneously. Session corrupted. Output from one command appears as output for the other.

**Seam**: Tool overrides ↔ SshTransport (command queue)

**Mitigation**: Serial queue is **non-negotiable**. Implement on Day 1 (in Tier 1 of dependency graph). Test: `Promise.all([exec("echo a"), exec("echo b")])` with DockerTransport first (simpler), then SshTransport.

---

### 🟡 HIGH (Will Break in Week 2-3 Without Mitigation)

#### 4. **CRLF Mismatch in Edit on Windows Targets**
**Risk**: Remote Windows file has CRLF. LLM provides `oldText` with LF only. String match fails silently. Edit returns success, file unchanged, agent retries forever.

**Seam**: RemoteEditOps ↔ Transport (readFile/writeFile)

**Mitigation**: Detect line ending in read content. Normalize `oldText` before match. Preserve original line ending on write-back. Clear error message if match fails: "old_text not found (check line endings: file uses CRLF)."

---

#### 5. **SSH Reconnect Leaves Tool Calls Hanging**
**Risk**: Network blip kills SSH mid-command. ConnectionPool tries to reconnect. Tool Promise neither resolved nor rejected. Pi turn hangs indefinitely.

**Seam**: SshTransport ↔ ConnectionPool (queue error recovery)

**Mitigation**: `onDisconnect()` must reject all pending queue items immediately with `{ kind: "connection_lost" }`. Tool's execute() catches rejection and returns error to pi. Add hard timeout at tool layer (120s) as fallback.

**Test**: Kill SSH server mid-command (Docker container stop). Confirm tool returns error, queue drains, pool evicts connection, reconnect succeeds on next use.

---

### 🟢 MEDIUM (Will Break in Week 3-5, Non-Blocker)

#### 6. **Tool Override Silently Overwritten by Another Extension**
**Risk**: If user loads pi-powershell after pi-tramp, it overwrites the `bash` override. Remote targets silently run bash locally.

**Seam**: extension.ts ↔ pi.registerTool (last-writer-wins)

**Mitigation**: Conflict detection warnings at activate time. Log clearly: "pi-tramp: registered bash override — load pi-tramp LAST to ensure precedence." Runtime check if pi exposes the currently-registered execute function (likely not possible).

---

#### 7. **Token Budget Blowup with Large Remote AGENTS.md**
**Risk**: 2000-line AGENTS.md on remote. Context injection reads it and injects every switch. Context window fills. LLM drops earlier conversation.

**Seam**: context-injection ↔ pi.sendMessage

**Mitigation**: Cap injected content at 2000 tokens. Log warning if remote AGENTS.md exceeds 500 lines: "Remote AGENTS.md is large (N lines). Injecting first 100 lines only."

---

#### 8. **Connection Leak on Extension Disable**
**Risk**: pi-tramp disabled mid-session. Open SSH connections never closed. Zombie processes.

**Seam**: extension.ts ↔ ConnectionPool lifecycle

**Mitigation**: Hook `deactivate()` lifecycle: `await pool.closeAll()`.

---

## 4. Dependency Graph (Merged & Validated)

Synthesized from both reviewers (verified acyclic):

```
Tier 0 — Pure interfaces (no deps)
  Transport (interface)
  ShellDriver (interface)

Tier 1 — Pure implementations (no I/O except config reading)
  BashDriver        → ShellDriver
  PwshDriver        → ShellDriver
  TargetManager     → (config file I/O only, no other component)

Tier 2 — Transport implementations
  DockerTransport   → Transport, BashDriver | PwshDriver (created after shell detection)
  SshTransport      → Transport, BashDriver | PwshDriver (created after shell detection)
  NOTE: ShellDriver is created INSIDE Transport after connect(), not injected.
        Transport drives probe commands through its own exec(), parses output, creates driver.

Tier 3 — Lifecycle manager
  ConnectionPool    → TargetManager (reads config), DockerTransport, SshTransport

Tier 4 — Operations
  RemoteReadOps     → Transport (via pool), TargetManager (cwd resolution)
  RemoteWriteOps    → Transport (via pool), TargetManager
  RemoteEditOps     → RemoteReadOps + RemoteWriteOps (read-apply-write pattern)
  RemoteBashOps     → Transport (via pool)

Tier 5 — Tool overrides and target tool (pi runtime boundary)
  tool-overrides    → TargetManager, ConnectionPool, Remote*Ops, pi.registerTool
  target-tool       → TargetManager, ConnectionPool, pi.registerTool

Tier 6 — Hooks and UX
  system-prompt     → TargetManager, pi.on("before_agent_start")
  context-injection → TargetManager, ConnectionPool (reads remote AGENTS.md), pi.sendMessage
  status-bar        → TargetManager, pi TUI API
  trampExec         → ConnectionPool, TargetManager

Tier 7 — Entry point
  extension.ts      → everything above, pi.createExtension
```

**Is it a DAG?** Yes. No cycles. Verified by inspection. You can build strictly bottom-up (Tier 0 → 7). Any tier can be stubbed with mocks to test the tier above it.

**Hardest seam**: SshTransport ↔ ShellDriver during sentinel parsing (pwsh color codes, streaming line reader). Not the tool overrides.

---

## 5. First Week Plan (Concrete)

### Day 1: Project structure + interfaces + pure logic

**First file created**: `src/types.ts`

```typescript
// src/types.ts — the entire dependency graph's foundation
export type ShellType = "bash" | "sh" | "pwsh" | "cmd" | "unknown";
export type PlatformType = "linux" | "darwin" | "windows" | "unknown";
export type TransportState = "connecting" | "connected" | "disconnected" | "error";

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export type TransportError =
  | { kind: "connection_lost"; cause: Error }
  | { kind: "command_failed"; code: number; stderr: string }
  | { kind: "timeout"; after_ms: number }
  | { kind: "not_connected" };

export interface Transport {
  readonly type: "ssh" | "docker" | "wsl" | "psremote";
  readonly shell: ShellType;
  readonly platform: PlatformType;
  readonly arch: string;
  readonly state: TransportState;
  exec(command: string, options?: { timeout?: number; signal?: AbortSignal }): Promise<ExecResult>;
  readFile(path: string): Promise<Buffer>;
  writeFile(path: string, content: Buffer): Promise<void>;
  close(): Promise<void>;
  healthCheck(): Promise<boolean>;
  on(event: "disconnect", cb: (err: Error) => void): void;
}

export interface ShellDriver {
  readonly shell: ShellType;
  shellEscape(arg: string): string;
  readFileCommand(absolutePath: string): string;
  writeFileCommand(absolutePath: string, base64Content: string): string;
  mkdirCommand(absolutePath: string, recursive: boolean): string;
}
```

**Second file**: `src/target-manager.ts`
- Pure class, no I/O beyond config reading
- Zod validation on load
- Config merge algorithm (global + project)
- Unit-testable with zero pi dependency

**End of Day 1**:
- Interfaces defined
- TargetManager tested
- Config loading with global + project merge working
- All tests passing

---

### Day 2: Shell drivers + escaping tests

**Files created**:
- `src/shell/bash-driver.ts`
- `src/shell/pwsh-driver.ts`
- `test/shell-escaping.test.ts` ← **Write this first (TDD)**

**Critical test harness** (runs against real local shells):
```typescript
// test/shell-escaping.test.ts
import { spawn } from "child_process";
import { BashDriver, PwshDriver } from "../src/shell";

const testPaths = [
  "simple.txt",
  "file with spaces.txt",
  "file's.txt",
  'file"double.txt',
  "file$(rm -rf /).txt",
  "file\nnewline.txt",
  "C:\\Windows\\System32",  // for pwsh driver
];

describe("BashDriver.shellEscape", () => {
  for (const path of testPaths) {
    it(`escapes: ${path}`, async () => {
      const escaped = new BashDriver().shellEscape(path);
      const cmd = `cat ${escaped} 2>/dev/null; echo "exit:$?"`;
      const result = await execInBash(cmd);
      
      // Verify: exit code 1 (file not found), no shell error, no injection
      expect(result).toMatch(/exit:1$/);
      expect(result).not.toContain("syntax error");
    });
  }
});

async function execInBash(cmd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn("bash", ["-c", cmd]);
    let output = "";
    proc.stdout.on("data", (chunk) => (output += chunk));
    proc.on("close", () => resolve(output));
    proc.on("error", reject);
  });
}
```

**End of Day 2**:
- BashDriver and PwshDriver implemented
- All escaping tests passing against real shells
- No mocks for escaping tests

---

### Day 3: DockerTransport (vertical slice)

**File created**: `src/transport/docker-transport.ts`

This proves the entire architecture before touching SSH:

```typescript
class DockerTransport implements Transport {
  private queue: CommandQueue;  // serial queue from day 1
  private _shell: ShellType = "unknown";
  
  async connect(): Promise<void> {
    // 1. Detect shell
    const result = await this.rawExec('echo "$0"');
    this._shell = this.parseShell(result.stdout.trim());
    
    // 2. If pwsh, suppress color output
    if (this._shell === "pwsh") {
      await this.rawExec('$PSStyle.OutputRendering = "PlainText"');
    }
    
    // 3. Detect platform
    const plat = await this.rawExec('uname -s 2>/dev/null || echo "Windows"');
    this._platform = this.parsePlatform(plat.stdout.trim());
  }
  
  private rawExec(command: string): Promise<ExecResult> {
    // Spawns `docker exec -i <container> sh -c <command>`
    // One-shot, no sentinel needed — docker exec handles completion
    return new Promise((resolve, reject) => {
      const proc = spawn("docker", ["exec", "-i", this.container, "sh", "-c", command]);
      // collect stdout/stderr, resolve on close
    });
  }
  
  exec(command: string, options?: ExecOptions): Promise<ExecResult> {
    return this.queue.enqueue(() => this.rawExec(command));
  }
}
```

**Why Docker first**: `docker exec` handles command isolation — each exec is its own process, no sentinel needed. Simpler than SSH. Validates the pattern.

**Test infrastructure** (create on Day 3):
```dockerfile
# test/fixtures/docker-target/Dockerfile
FROM alpine:3.19
RUN apk add --no-cache bash
SHELL ["/bin/bash", "-c"]
RUN mkdir -p /workspace && echo "hello" > /workspace/test.txt
WORKDIR /workspace
CMD ["sleep", "infinity"]
```

**Integration test**:
```typescript
// Build: docker build -t pi-tramp-test-target ./test/fixtures/docker-target
// Run: docker run -d --name pi-tramp-test pi-tramp-test-target

const transport = new DockerTransport({ container: "pi-tramp-test" });
await transport.connect();
const result = await transport.exec("echo hello");
expect(result.stdout.trim()).toBe("hello");

// Test serial queue:
const results = await Promise.all([
  transport.exec("echo a"),
  transport.exec("echo b"),
  transport.exec("echo c")
]);
// Confirm: no output mixing
```

**End of Day 3**:
- DockerTransport connects to real container
- `exec("echo hello")` works
- Two concurrent calls are serialized (queue works)

---

### Days 4-5: ConnectionPool + RemoteOperations

**Files created**:
- `src/connection-pool.ts`
- `src/operations/remote-read.ts`
- `src/operations/remote-write.ts`
- `src/operations/remote-edit.ts`
- `src/operations/remote-bash.ts`

**Build ConnectionPool** with lifecycle management:
- `getConnection(targetName)` → lazy connect, cache
- `execOnTarget(targetName, fn)` → get connection, queue fn
- `closeConnection(targetName)`, `closeAll()`

**Build RemoteOps**:
- Read/Write: straightforward mapping to transport
- Edit: read-apply-write with 10MB limit, CRLF preservation
- Bash: direct passthrough to transport.exec()

**End of Day 5**:
- Full stack works: `readFile()` and `exec()` on Docker container through pool and operations
- ConnectionPool idle timeout works (configurable)
- All operations unit-tested (mocked transport) + integration-tested (real Docker)

---

## 6. The One Prototype (Validates Everything)

**Before writing any extension code**, prototype the SSH persistent connection sentinel protocol.

### Why This Must Be First

If this prototype has bugs that take more than a day to fix, it reveals the sentinel approach has a fundamental problem (likely the streaming line reader). Better to know in **Day 1** than Week 3 when it's embedded in six layers of abstraction.

### Prototype Spec

Write a standalone Node.js script (~100 lines), no TypeScript, no pi, no interfaces:

```javascript
// prototype/ssh-sentinel.mjs
// Run: node prototype/ssh-sentinel.mjs
// Requires: docker run --rm -d -p 2222:22 <ssh-server-image>

import { spawn } from "child_process";
import { randomUUID } from "crypto";

const ssh = spawn("ssh", [
  "-i", "/tmp/test_key",
  "-p", "2222",
  "-o", "StrictHostKeyChecking=no",
  "-o", "BatchMode=yes",
  "testuser@localhost",
  "/bin/bash"
]);

async function exec(command) {
  const sentinelId = randomUUID().replace(/-/g, "");
  const sentinel = `__PITRAMP_${sentinelId}__`;
  const wrapped = `${command}\nprintf '%s_%d\\n' '${sentinel}' $?\n`;
  
  ssh.stdin.write(wrapped);
  
  return new Promise((resolve, reject) => {
    let output = "";
    const sentinelRe = new RegExp(`^${sentinel}_(\\d+)$`);
    const timeout = setTimeout(() => reject(new Error("timeout")), 10000);
    
    const onData = (chunk) => {
      output += chunk.toString();
      const lines = output.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const match = lines[i].match(sentinelRe);
        if (match) {
          clearTimeout(timeout);
          ssh.stdout.off("data", onData);
          resolve({
            stdout: lines.slice(0, i).join("\n"),
            exitCode: parseInt(match[1])
          });
          // Keep remaining data for next command
          output = lines.slice(i + 1).join("\n");
          return;
        }
      }
    };
    
    ssh.stdout.on("data", onData);
    ssh.stderr.on("data", () => {}); // drain stderr
  });
}

// Test: sequential commands
const r1 = await exec("echo hello");
console.assert(r1.stdout.trim() === "hello", "basic echo failed");

const r2 = await exec("ls /etc/hosts");
console.assert(r2.exitCode === 0, "ls failed");

// Test: command with non-zero exit
const r3 = await exec("false");
console.assert(r3.exitCode === 1, "exit code not propagated");

// Test: large output (must not buffer in string naively)
const r4 = await exec("seq 1 10000");
console.assert(r4.stdout.trim().split("\n").length === 10000, "large output corrupted");

// Test: rapid sequential commands (sentinel not mixed)
const results = await Promise.all([exec("echo a"), exec("echo b"), exec("echo c")]);
// With serial queue, this should work. Without it, fails non-deterministically.

ssh.stdin.end();
console.log("All tests passed");
```

### Expected Outcome

This prototype should work in **2-4 hours**. If it takes more than a day, the sentinel design needs revisiting before any extension code is written.

**Docker exec doesn't need this prototype** — each `docker exec` is its own process with its own stdout. That's why Docker is simpler and why the prototype targets SSH specifically.

### Test Infrastructure

```dockerfile
# test/fixtures/ssh-server/Dockerfile
FROM ubuntu:22.04
RUN apt-get update -qq && apt-get install -y -qq openssh-server bash && rm -rf /var/lib/apt/lists/*
RUN mkdir -p /run/sshd
RUN useradd -m -s /bin/bash testuser
RUN mkdir -p /home/testuser/.ssh && chmod 700 /home/testuser/.ssh
RUN ssh-keygen -t ed25519 -f /test_key -N "" -q
RUN cp /test_key.pub /home/testuser/.ssh/authorized_keys
RUN chmod 600 /home/testuser/.ssh/authorized_keys && chown -R testuser: /home/testuser/.ssh
RUN ssh-keygen -A
RUN mkdir -p /workspace && echo "hello world" > /workspace/test.txt && chown -R testuser: /workspace
RUN cat /test_key
EXPOSE 22
CMD ["/usr/sbin/sshd", "-D", "-e"]
```

Run: `docker build -t pi-tramp-ssh-bash ./test/fixtures/ssh-server && docker run -d -p 2222:22 pi-tramp-ssh-bash`

Extract key: `docker exec pi-tramp-ssh-bash cat /test_key > /tmp/test_key && chmod 600 /tmp/test_key`

---

## 7. Final Go/No-Go Assessment

### Is This Ready for Implementation?

**Yes, with pre-work.**

The design is **buildable, correct, and will ship successfully** if:

1. ✅ The 3 interface contracts (GAP 1, 2, 3) are added
2. ✅ The 8 specifications from Stage 2 are written before Week 1 starts
3. ✅ The SSH sentinel prototype validates the approach (2-4 hours)

Without those: **NO — do not start coding yet.**

---

### Minimum Spec Work Remaining

Before Week 1 starts, write these verbatim into the design doc:

#### 1. **Sentinel Protocol Algorithm** (blocks SSH Transport)
Complete algorithm with:
- Exact sentinel format: `__PITRAMP_${crypto.randomUUID().replace(/-/g, "")}__`
- Stdout reader with line buffering (not string concatenation)
- Timeout behavior: kill process, drain queue, emit disconnect
- PowerShell color suppression: `$PSStyle.OutputRendering = 'PlainText'` in `connect()`

#### 2. **Shell Detection Commands** (blocks shell routing)
```bash
# Probe 1: Get shell name
echo "$0"
# Parsing: "bash", "sh", "-bash", etc.

# Probe 2: PowerShell detection
$PSVersionTable.PSVersion.Major
# Parsing: "7" or error if not pwsh
```
Include: dash vs bash distinction, fallback if probe fails.

#### 3. **Shell Escaping Algorithm** (blocks all tool overrides)
Full implementations of:
- `BashDriver.shellEscape()` (with ANSI-C quoting for newlines)
- `PwshDriver.shellEscape()` (single quote with doubling)
- Dash fallback (no `$'...'` support)

#### 4. **CRLF Handling Policy** (blocks edit on Windows targets)
"Preserve exact bytes from `readFile()` through edit and back to `writeFile()`. Do not normalize line endings. If `oldText` match fails, include line-ending hint in error message: 'old_text not found (check line endings: file uses CRLF)'."

#### 5. **Atomic Write Strategy** (per shell)
- Bash: `echo '<base64>' | base64 -d > file.tmp && mv file.tmp file` (atomic on POSIX)
- PowerShell: `echo '<base64>' | base64 -d > file.tmp; Move-Item -Force file.tmp file` (best-effort on Windows, document limitation)

#### 6. **TargetConfig Zod Schema** (blocks config validation)
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

#### 7. **trampExec() Public API Signature** (blocks extension export)
```typescript
export async function trampExec(
  command: string,
  options?: { target?: string; timeout?: number; signal?: AbortSignal }
): Promise<ExecResult>
```
If `target` omitted, uses current target.

#### 8. **Error Message Format for LLM** (standardized across tools)
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

### Timeline: 7-9 Weeks for Phase 1A

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

Marc's decision (SSH + Docker + all 4 tool overrides together) is architecturally sound. It validates the abstraction early and surfaces cross-cutting concerns. The timeline cost (7 weeks instead of 3-4 for Docker-only) is acceptable for foundational infrastructure.

---

### What Could Slip Without Killing MVP

If timeline pressure hits:
- ❌ Status bar widget (purely cosmetic)
- ❌ `trampExec()` export (no external consumers yet)
- ❌ `context` event filtering (system prompt only for Phase 1A)
- ❌ Dynamic target creation by agent (TargetManager has the logic; just disable the `create`/`remove` actions in target-tool)

**Cannot slip** (Marc's explicit decisions):
- ✅ All 4 tool overrides (read, write, edit, bash)
- ✅ Both transports (SSH + Docker)
- ✅ Serial command queue
- ✅ Shell escaping
- ✅ 10MB binary limit with clear error

---

### Shipping Criteria

Phase 1A ships when:

1. ✅ All 4 scenarios trace successfully end-to-end (with the 3 interface contracts added)
2. ✅ All 8 specifications written verbatim in design doc
3. ✅ SSH sentinel prototype validates the approach (2-4 hours to working)
4. ✅ Shell escaping tested against real shells (Day 2, non-negotiable)
5. ✅ Initial target selection works (config default or explicit switch)
6. ✅ Context injection fires on target switch (event-based)
7. ✅ Temp file naming prevents collisions (UUID-based)
8. ✅ Connection error recovery drains queue and reconnects cleanly
9. ✅ Integration tests pass on Docker + SSH (bash and pwsh targets)
10. ✅ Dog-fooded on a real project (Week 6)

---

## Bottom Line

**The vision survived.** TRAMP analogy intact, pi stays local, tools route transparently, agent is boundary-aware.

**The decomposition is 85% complete.** The Operations abstraction is correct, the seams are clean, the reviewers caught the hard problems (sentinel, escaping, queue, CRLF).

**The recomposition has 3 interface gaps** (initial target, context injection trigger, tmp cleanup). All fixable with small additions to TargetManager and extension root.

**Pre-work required**: ~2-3 days to write the 8 specifications and run the SSH sentinel prototype.

**Implementation timeline**: 7-9 weeks for Phase 1A (SSH + Docker + all 4 tool overrides).

**Risk management**: Prototype the sentinel protocol first (2-4 hours if design is sound, days if it's not — this validates everything).

**Ship with confidence** after:
1. Writing the 8 specs from Stage 2
2. Adding the 3 interface contracts
3. Running the SSH sentinel prototype
4. Accepting the 7-9 week timeline

The design is **buildable, correct, and will ship successfully** if the remaining 15% is completed before coding starts.

---

## Next Actions

1. **Day -3**: Write `specs/stage-2-complete.md` with all 8 specifications verbatim
2. **Day -2**: Add the 3 interface contracts to design doc (TargetManager events, config default, UUID tmp files)
3. **Day -1**: Build and run SSH sentinel prototype — validate core assumption (2-4 hours)
4. **Day 1**: Start implementation following First Week Plan above

**GO.**
