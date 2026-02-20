# Implementation Integrity Review (Stage 3)

Now I have all four documents. Let me produce the implementation integrity review.

---

## Summary Verdict

pi-tramp is buildable. The architecture is a clean DAG, the seams are well-chosen, and the prior review rounds have de-risked the major design decisions. What remains before coding starts is not design ambiguity — it's three un-written specifications (sentinel protocol, shell escaping algorithm, CRLF policy) and one un-run prototype (SSH persistent connection). Without those, the first three weeks will be debugging instead of building. With them, the 7-9 week estimate is realistic. The dependency graph has no cycles; you can build strictly bottom-up. The hardest integration seam is **SshTransport ↔ ShellDriver** during sentinel parsing, not the tool overrides.

---

## Dependency Graph

```
Tier 0 — Pure interfaces (no deps)
  Transport (interface)
  ShellDriver (interface)

Tier 1 — Pure implementations (no I/O)
  BashDriver        → ShellDriver
  PwshDriver        → ShellDriver
  TargetManager     → (config file I/O only, no other component)

Tier 2 — Transport implementations
  DockerTransport   → Transport, BashDriver | PwshDriver (created after shell detection)
  SshTransport      → Transport, BashDriver | PwshDriver (created after shell detection)
  NOTE: ShellDriver is created INSIDE the Transport after connect(), not injected.
        Transport drives probe commands through its own exec, parses output, creates driver.

Tier 3 — Lifecycle manager
  ConnectionPool    → TargetManager (reads config), DockerTransport, SshTransport

Tier 4 — Operations
  RemoteReadOps     → Transport (via pool), TargetManager (cwd resolution), ShellDriver
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

**Is it a DAG?** Yes. No cycles. Verified by inspection: no lower tier imports from a higher tier. The only potential cycle is `ConnectionPool → Transport` and `Transport → ShellDriver`, but ShellDriver creates command *strings* — it never calls back into ConnectionPool or Transport. Clean.

**Build order confirmation**: Tier 0 → 1 → 2 → 3 → 4 → 5 → 6 → 7. You can stub any tier with a mock interface and test the tier above it. This is the correct structure for parallel development.

---

## Hard Problems

### 1. The Sentinel Protocol (Hardest)

**What's hard**: You have one stdin/stdout pipe to a persistent shell. You write a command, then read output until you see a completion marker. Three failure modes the design has not fully addressed:

- **PowerShell ANSI color codes**: Interactive pwsh emits `\e[32m` color sequences interleaved with output, even if stdout is a pipe. The sentinel `__PITRAMP_abc123___0` becomes `\e[32m__PITRAMP_abc\e[0m123__\e[32m_0\e[0m`. The sentinel parser will never match.
- **Large output streaming**: A `bash find /` returning 500K lines cannot be buffered in memory as a string. You need a streaming line reader that accumulates chunks until the sentinel line appears, then returns everything before it.
- **Sentinel in legitimate output**: `echo "__PITRAMP_abc__"` in a script the agent runs will falsely terminate the command early. UUID-based sentinels reduce (but don't eliminate) this.

**How to approach it**:

```typescript
// Exact sentinel construction — must be per-invocation, long enough to be impractical to collide
const sentinelId = crypto.randomUUID().replace(/-/g, "");
const sentinel = `__PITRAMP_${sentinelId}__`;

// Bash invocation:
const wrapped = `${command}\nprintf '%s_%d\\n' '${sentinel}' $?\n`;
// printf is more reliable than echo for this — no interpretation of escape sequences

// PowerShell invocation — MUST disable color output first at session start:
//   $PSStyle.OutputRendering = 'PlainText'   (pwsh 7.2+)
//   [Console]::OutputEncoding = [Text.Encoding]::UTF8
// Per-command:
const wrapped = `${command}\nWrite-Host "${sentinel}_$LASTEXITCODE"\n`;

// Stdout reader:
// Line-buffer the stream. When a line matches /^__PITRAMP_<id>___(\d+)$/, stop.
// Extract exit code. Return everything before that line as stdout.
// Use a 64KB chunk buffer, not string concatenation.
```

The pwsh color suppression must happen in the `connect()` handshake, not per command. If it's not sent before the first real command, the first command's output is corrupted and the sentinel is never found.

**Prototype this first** — see "The One Thing to Prototype First" below.

---

### 2. Shell Escaping Across Both Shells

**What's hard**: Stage 2 provides the algorithm. But there's a subtle bash issue: the `...'` ANSI-C quoting that handles embedded newlines is a **bashism**. If the target's shell is `/bin/sh` (Alpine, minimal Debian), it doesn't work. Shell detection must distinguish bash from sh/dash.

The real danger: escaping bugs are silent. `cat 'file.txt'` works. `cat 'file with $HOME in name.txt'` works. `cat 'file with a'\''quote.txt'` — this is where the implementation breaks. And the tests that would catch it are integration tests against real shells, not unit tests with mocks.

**How to approach it**: Day 2 of implementation is writing `shellEscape()` and running it against a real local bash process and a real local pwsh process, automated. Not mocked. The test input list must include: path with spaces, path with single quote, path with double quote, path with `$(cmd)`, path with literal newline, path with null byte.

```typescript
// The test harness (day 2, not day 10):
const testPaths = [
  "simple.txt",
  "file with spaces.txt",
  "file's.txt",
  'file"double.txt',
  "file$(rm -rf /).txt",
  "file\nnewline.txt",
  "C:\\Windows\\System32",  // for pwsh driver
];

for (const p of testPaths) {
  const cmd = `cat ${bashDriver.shellEscape(p)} 2>/dev/null; echo "exit:$?"`;
  const result = await child_process.exec(cmd, { shell: "bash" });
  // Verify: exit code 1 (file not found), no shell error, no injection
}
```

If any of these produce shell errors (not file-not-found errors), the escaping is wrong.

---

### 3. CRLF Round-Trip in Edit Operations

**What's hard**: The edit tool uses `oldText`/`newText` diff pairs. The agent writes `oldText` in its JSON response. JSON normalizes nothing — the LLM probably emits `\n` only. But the remote Windows file has `\r\n`. The string match `content.indexOf(oldText)` fails silently. The edit returns success (or an unintelligible error), the file is unchanged, and the agent retries forever.

**How to approach it**: The `RemoteEditOps.applyEditToFile()` implementation must, before matching, detect whether the file uses CRLF. If it does, and the `oldText` uses LF only, normalize `oldText` before matching. Write back the full content preserving the original line ending convention.

```typescript
const content = (await this.transport.readFile(path)).toString("utf8");
const lineEnding = content.includes("\r\n") ? "\r\n" : "\n";
// Normalize oldText to match file's line endings
const normalizedOldText = oldText.replace(/\r\n/g, "\n").replace(/\n/g, lineEnding);
if (!content.includes(normalizedOldText)) {
  throw new Error(
    `old_text not found in ${path}. ` +
    `File uses ${lineEnding === "\r\n" ? "CRLF" : "LF"} line endings. ` +
    `Check your old_text matches exactly (including whitespace).`
  );
}
```

This is NOT a Phase 2 problem. The first Windows SSH target will hit this in the first real edit.

---

### 4. The ConnectionPool Queue is Not Per-Connection — It Must Be

**What's hard**: Stage 2 specifies a serial queue. What it doesn't fully specify is what happens when the queue has a pending item and the connection drops. The correct behavior:

1. Connection drops → `onDisconnect()` called
2. All pending queue items are rejected with `{ kind: "connection_lost" }`
3. Queue is drained and cleared
4. Connection is marked dead and evicted from the pool
5. **Next call to `pool.getConnection(targetName)` starts a new connection**
6. New connection re-detects shell, re-sends pwsh setup commands
7. Pending tool calls (from the LLM's tool use turn) receive the `connection_lost` error
8. Tool returns error to pi, pi reports to LLM, LLM decides what to do

Step 6 is easy to forget. A freshly reconnected SSH session is a new shell with no state. Any `cd` commands the agent ran earlier are gone. The system prompt injection should note this: "SSH targets are stateless — do not rely on shell state (cwd, variables) persisting across tool calls."

---

### 5. pi Runtime Integration: Tool Override Registration Timing

**What's hard**: pi's `registerTool` with the same name is last-writer-wins. When does pi-tramp's `activate()` run relative to other extensions? If pi-powershell (which the user also loads) runs after pi-tramp, it overwrites the `bash` override, and remote targets silently run bash locally.

The design proposes conflict detection warnings. What's not addressed: **there's no defined extension load order** in pi's extension system. The user might load `pi-tramp` before `pi-powershell` in config, but that doesn't guarantee activation order.

**How to approach it**: In `tool-overrides.ts`, do the conflict check at activate time, but also do a **runtime check** in the tool's `execute()` function:

```typescript
const trampBashExecute = async (id, params, signal, onUpdate, ctx) => {
  // ...routing logic
};

pi.registerTool({ name: "bash", execute: trampBashExecute, /* ... */ });

// Runtime sanity check — can only detect if pi exposes current handler
// If pi.tools.get("bash").execute !== trampBashExecute, we were overwritten
// This requires pi to expose the registered execute fn, which it may not
```

If pi doesn't expose the currently-registered execute function, runtime detection is impossible. This is an upstream gap. For now: document the load order requirement, and make pi-tramp's `activate()` log clearly at startup: `"pi-tramp: registered bash override — load pi-tramp LAST to ensure it takes precedence"`.

---

### 6. `before_agent_start` Timing and What It Has Access To

**Timing**: `before_agent_start` fires before each LLM turn, after the user sends a message. By the time it fires, `activate()` has completed and `TargetManager`, `ConnectionPool`, etc. are all live. The hook closure captures them. No timing issue.

**What it can access**: Everything initialized in `activate()`. Connection status, platform info, shell — all available via `TargetManager.currentTarget` and the Transport stored in the pool.

**What it cannot access**: Whether the current connection is healthy (checking requires a round-trip, which would add latency before every LLM turn). Don't call `healthCheck()` from `before_agent_start`. Just use cached state.

**Registration code** (concrete):

```typescript
// extension.ts
export default createExtension({
  name: "pi-tramp",
  
  async activate(pi) {
    await targetManager.loadConfig();  // must be async — reads files
    
    // Tool override registration (synchronous after config load)
    const tools = ["bash", "read", "write", "edit"] as const;
    for (const name of tools) {
      const existing = pi.tools.get(name);
      if (existing?.source !== "builtin") {
        pi.logger.warn(`[pi-tramp] WARNING: '${name}' already overridden by '${existing?.source}'. Remote routing may silently fail.`);
      }
    }
    
    pi.registerTool(createBashOverride(targetManager, pool));
    pi.registerTool(createReadOverride(targetManager, pool));
    pi.registerTool(createWriteOverride(targetManager, pool));
    pi.registerTool(createEditOverride(targetManager, pool));
    pi.registerTool(createTargetTool(targetManager, pool));
    
    // System prompt injection — fires every turn
    pi.on("before_agent_start", (event) => {
      const target = targetManager.currentTarget;
      if (!target || target.type === "local") return event;
      
      const block = buildTargetPromptBlock(target);
      const tokenEstimate = block.split(/\s+/).length * 1.3; // rough estimate
      if (tokenEstimate > 300) {
        pi.logger.warn(`[pi-tramp] System prompt block is ~${Math.round(tokenEstimate)} tokens`);
      }
      
      return { ...event, systemPrompt: event.systemPrompt + "\n\n" + block };
    });
    
    // Context filtering — remove stale target context messages
    pi.on("context", (event) => {
      let seen = false;
      const filtered = event.messages.filter(m => {
        if (m.type === "custom" && m.customType === "pi_tramp-target_context") {
          if (seen) return false;
          seen = true;
        }
        return true;
      });
      return { messages: filtered };
    });
  },
  
  async deactivate() {
    await pool.closeAll();  // Don't leak SSH processes
  }
});
```

**Note**: `activate()` must be `async` because `targetManager.loadConfig()` reads files. Verify pi's `createExtension` accepts an async activate callback. If it doesn't, wrap in an immediately-invoked async block and handle the promise — fire-and-forget with error logging.

---

## What Will Break First

**Rank-ordered by production probability:**

### 1. pwsh color codes in SshTransport sentinel parsing (First week of real use)
User points pi-tramp at a Windows SSH target. pwsh is interactive. Color codes corrupt stdout. Sentinel never found. Timeout fires after 60 seconds. Every bash tool call on a Windows SSH target times out. Complete blocker.

**Mitigation**: Send `$PSStyle.OutputRendering = 'PlainText'` as the very first command in `connect()` for any pwsh session, before shell detection is even complete. If the target is bash, this command errors silently.

### 2. Shell escaping breaks on the first non-trivial path (First hour of use)
User has a project at `/home/user/my project/` (space in path). Every file operation fails with "no such file or directory." The agent retries. The user blames the tool.

**Mitigation**: Test escaping on day 2 as described. Do not ship without this.

### 3. SSH reconnect leaves tool calls hanging (Week 2 of use)
Network blip kills the SSH connection mid-bash-command. The ConnectionPool tries to reconnect. The tool call's Promise is neither resolved nor rejected. The pi turn hangs indefinitely.

**Mitigation**: The `onDisconnect()` handler must reject all pending queue items immediately. The tool's execute() catches the rejection and returns an error result to pi. Add a hard timeout at the tool layer (not just Transport) — 120 seconds, then force-reject.

### 4. Multiple simultaneous LLM tool calls corrupt SSH session (Week 1 of use)
LLM returns two tool calls in one turn: `read(file1)` and `bash(cat file2)`. Both execute concurrently. Without a serial queue, both write to stdin simultaneously. The session is corrupted. Output from one command appears as output for the other.

**Mitigation**: Serial queue is non-negotiable. Both reviewers agree. Implement it in DockerTransport first to validate the pattern, then copy to SshTransport.

### 5. Token budget blows up with large AGENTS.md on remote target (Week 3 of use)
User has a 2000-line AGENTS.md on the remote. Context injection reads it and injects it every switch. Combined with system prompt + conversation history, the context window fills up. LLM starts dropping earlier conversation.

**Mitigation**: Cap injected content at 2000 tokens. Log a warning if the remote AGENTS.md exceeds 500 lines: "Remote AGENTS.md is large (N lines). Injecting first 100 lines only." Full content available via `read` tool if needed.

---

## Scope Reality Check

**Marc's decisions** add 2-3 weeks over the Stage 2 consensus recommendation:
- SSH + Docker together (not Docker-first): +1.5 weeks  
- All 4 tool overrides in Phase 1A (not just bash + read): +0.5 weeks
- Total: 7-9 weeks, as Stage 2 estimated

**Is 7-9 weeks realistic?** Yes, with one prerequisite: the 8 specifications from Stage 2 must be written before Week 1 starts. They are not optional pre-work — they are blocking. Without the sentinel algorithm written down, Week 3 (SshTransport) becomes 3 weeks of guessing.

**What could slip without killing the MVP:**
- Status bar widget (purely cosmetic, defer to week 10)
- `trampExec()` export (no external consumers yet, defer)
- `context` event filtering (inject system prompt only for Phase 1A, add full context injection in 1B)
- Dynamic target creation by agent (TargetManager has the logic; just disable the `create`/`remove` actions in target-tool)

**What cannot slip:**
- All 4 tool overrides (Marc's explicit decision)
- Both transports (Marc's explicit decision)
- Serial command queue
- Shell escaping
- 10MB binary limit with clear error

---

## Implementation Sequence

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

Second file: `src/target-manager.ts` — pure class, no I/O beyond config reading. Full Zod validation on load. Unit-testable with zero pi dependency.

End of Day 1: interfaces defined, TargetManager tested. Config loading with global + project merge. All tests passing.

### Day 2: Shell drivers (BashDriver, PwshDriver)

Write `src/shell/bash-driver.ts` and `src/shell/pwsh-driver.ts`. 

**Critical**: Write the test harness first (test file before implementation). The test spawns a real local bash and a real local pwsh and round-trips through every escape case. If pwsh isn't available on the dev machine, skip pwsh tests with `it.skipIf(!pwshAvailable)` — but don't mock.

End of Day 2: both drivers implemented and tested against real shells. No mocks for escaping tests.

### Day 3: DockerTransport (the vertical slice)

`src/transport/docker-transport.ts`. This proves the entire architecture before touching SSH.

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

Docker transport is simpler than SSH because `docker exec` handles command isolation — each exec is its own process, no sentinel needed. This is exactly why Docker should be implemented first.

**End of Day 3**: DockerTransport connects to a real container. Run `exec("echo hello")` through the queue. Confirm output comes back. Confirm two concurrent calls are serialized.

### Days 4-5: ConnectionPool + RemoteOperations

Build ConnectionPool with lifecycle management. Build RemoteRead/Write/Edit/BashOps. Wire them up. At the end of Day 5 you should be able to `readFile()` and `exec()` on a Docker container through the full stack.

### Week 2: Tool overrides + target tool + pi runtime integration

This is where you first touch pi's extension system. The first test requires a pi test harness or an actual pi instance. Use `@marcfargas/pi-test-harness` for this (per AGENTS.md — it's the mandated test tool).

### Week 3-4: SshTransport

This is where the sentinel protocol specification (which must be written before Week 3 starts) is implemented. Do not start this week without a written spec for:
1. Exact sentinel format and UUID generation
2. Stdout reader algorithm (streaming, not buffering)
3. Timeout behavior (kill process, drain queue, emit disconnect)
4. pwsh color suppression commands

### Week 5: Integration testing, edge cases, polish

---

## Test Infrastructure Spec

### Dockerfile for Docker target tests

```dockerfile
# test/fixtures/docker-target/Dockerfile
FROM alpine:3.19
RUN apk add --no-cache bash
SHELL ["/bin/bash", "-c"]
# Create test workspace
RUN mkdir -p /workspace && echo "hello" > /workspace/test.txt
WORKDIR /workspace
CMD ["sleep", "infinity"]
```

Build and run in CI: `docker build -t pi-tramp-test-target ./test/fixtures/docker-target && docker run -d --name pi-tramp-test pi-tramp-test-target`

### Dockerfile for SSH tests

```dockerfile
# test/fixtures/ssh-server/Dockerfile
FROM ubuntu:22.04
RUN apt-get update -qq && apt-get install -y -qq openssh-server bash && rm -rf /var/lib/apt/lists/*
RUN mkdir -p /run/sshd
# Create test user with key auth only
RUN useradd -m -s /bin/bash testuser
RUN mkdir -p /home/testuser/.ssh && chmod 700 /home/testuser/.ssh
# Test key is generated at build time — NOT a real key, test-only
RUN ssh-keygen -t ed25519 -f /test_key -N "" -q
RUN cp /test_key.pub /home/testuser/.ssh/authorized_keys
RUN chmod 600 /home/testuser/.ssh/authorized_keys && chown -R testuser: /home/testuser/.ssh
# Generate host keys
RUN ssh-keygen -A
# Create test workspace
RUN mkdir -p /workspace && echo "hello world" > /workspace/test.txt && chown -R testuser: /workspace
# Expose private key for tests (test key only, not prod)
RUN cat /test_key
EXPOSE 22
CMD ["/usr/sbin/sshd", "-D", "-e"]
```

```dockerfile
# test/fixtures/ssh-server-pwsh/Dockerfile
FROM ubuntu:22.04
RUN apt-get update -qq && apt-get install -y -qq openssh-server wget apt-transport-https && rm -rf /var/lib/apt/lists/*
# Install PowerShell 7
RUN wget -q https://packages.microsoft.com/config/ubuntu/22.04/packages-microsoft-prod.deb \
    && dpkg -i packages-microsoft-prod.deb && rm packages-microsoft-prod.deb \
    && apt-get update -qq && apt-get install -y -qq powershell && rm -rf /var/lib/apt/lists/*
RUN mkdir -p /run/sshd
RUN useradd -m -s /usr/bin/pwsh testuser
# Same key setup as bash server
RUN mkdir -p /home/testuser/.ssh && chmod 700 /home/testuser/.ssh
RUN ssh-keygen -t ed25519 -f /test_key -N "" -q
RUN cp /test_key.pub /home/testuser/.ssh/authorized_keys
RUN chmod 600 /home/testuser/.ssh/authorized_keys && chown -R testuser: /home/testuser/.ssh
RUN ssh-keygen -A
EXPOSE 22
CMD ["/usr/sbin/sshd", "-D", "-e"]
```

### CI Configuration (GitHub Actions)

```yaml
# .github/workflows/test.yml
name: Test

on: [push, pull_request]

jobs:
  test:
    runs-on: ubuntu-latest
    
    services:
      docker-target:
        image: pi-tramp-test-target  # built in setup step
        options: --name pi-tramp-test
      
    steps:
      - uses: actions/checkout@v4
      
      - name: Build test Docker images
        run: |
          docker build -t pi-tramp-docker-target ./test/fixtures/docker-target
          docker build -t pi-tramp-ssh-bash ./test/fixtures/ssh-server
          docker build -t pi-tramp-ssh-pwsh ./test/fixtures/ssh-server-pwsh
      
      - name: Start test containers
        run: |
          docker run -d --name test-docker pi-tramp-docker-target
          docker run -d --name test-ssh-bash -p 2222:22 pi-tramp-ssh-bash
          docker run -d --name test-ssh-pwsh -p 2223:22 pi-tramp-ssh-pwsh
          # Extract test SSH key from container
          docker exec test-ssh-bash cat /test_key > /tmp/test_key
          chmod 600 /tmp/test_key
      
      - name: Wait for SSH servers
        run: |
          for port in 2222 2223; do
            timeout 30 bash -c "until ssh -o StrictHostKeyChecking=no -o ConnectTimeout=1 -i /tmp/test_key -p $port testuser@localhost echo ok; do sleep 1; done"
          done
      
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
      
      - run: npm ci
      
      - name: Run tests
        run: npm test
        env:
          TEST_DOCKER_CONTAINER: test-docker
          TEST_SSH_HOST: localhost
          TEST_SSH_PORT: 2222
          TEST_SSH_PWSH_PORT: 2223
          TEST_SSH_KEY: /tmp/test_key
          TEST_SSH_USER: testuser
```

**CI requirement**: Docker is available in all GitHub Actions `ubuntu-latest` runners. No special setup needed beyond building the images. This runs without any external infrastructure.

---

## Risk Matrix

| Component | Failure Likelihood | Impact | Mitigation |
|---|---|---|---|
| SSH sentinel + pwsh ANSI codes | **Certain** without mitigation | **Blocker** | Send `$PSStyle.OutputRendering = 'PlainText'` in connect() |
| Shell escaping on non-trivial paths | **High** (first real project) | **High** (silent failures) | Real-shell tests on Day 2 |
| Concurrent tool calls corrupting SSH session | **High** (LLM makes parallel calls) | **Blocker** | Serial queue, implement Day 1 |
| CRLF mismatch in edit on Windows targets | **High** (every Windows target) | **Medium** (edit silently fails) | Normalize before match, clear error |
| SSH reconnect leaves tool Promise hanging | **Medium** (network hiccups) | **High** (session stuck) | Reject queue on disconnect |
| Tool override silently overwritten | **Medium** (if user loads pi-powershell after) | **High** (silent local execution) | Conflict detection + load order docs |
| `ctx.isUserInitiated` missing upstream | **Certain** | **Low** (deferred feature works) | Document, defer |
| Docker exec latency unacceptable | **Low** (likely fine) | **Medium** (usability) | Prototype before committing |
| Token budget blowup with large AGENTS.md | **Low** (most AGENTS.md are small) | **Medium** (context exhaustion) | Cap injection at 2000 tokens |
| Binary file OOM over SSH | **Low** (agents rarely edit binaries) | **Medium** (OOM or hang) | 10MB limit, fail fast |
| Connection leak on extension disable | **Low** (extensions rarely disabled mid-session) | **Low** (zombie processes) | Hook deactivate() lifecycle |

---

## The One Thing to Prototype First

**Prototype the SSH persistent connection sentinel protocol before writing a single line of extension code.**

Write a standalone Node.js script (~100 lines), no TypeScript, no pi, no interfaces:

```javascript
// prototype/ssh-sentinel.mjs
// Run: node prototype/ssh-sentinel.mjs
// Requires: a local SSH server OR docker run --rm -d -p 2222:22 pi-tramp-ssh-bash

import { spawn } from "child_process";
import { randomUUID } from "crypto";
import { Readable } from "stream";

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
// With serial queue, this should work. Without it, this test will fail non-deterministically.

ssh.stdin.end();
console.log("All tests passed");
```

**Why this must be the first thing**: If this prototype has bugs that take more than a day to fix, it reveals that the sentinel approach itself has a fundamental problem (likely the streaming line reader). Better to know in day 1 than in week 3 when it's embedded in six layers of abstraction.

**Expected outcome**: This prototype should work in 2-4 hours. If it takes more than a day, the sentinel design needs revisiting before any extension code is written.

**Docker exec doesn't need this prototype** — each `docker exec` is its own process with its own stdout. That's why Docker is simpler and why the prototype targets SSH specifically.
