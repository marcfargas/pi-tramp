## Summary Verdict

Pi-tramp is buildable, but the scope decision (SSH + Docker simultaneously, all four tool overrides in Phase 1A) makes the first working integration test harder to reach and integration failures harder to diagnose. The decomposition from Stage 1 synthesis is correct — the seams are clean and the build order is sound. What's still underspecified is the dangerous middle layer: the sentinel protocol, the `edit` implementation strategy, and how the serial command queue surfaces errors to the Operations layer. These gaps won't stop the build from starting, but they'll stop it from shipping. The missing details are specific enough to address in a focused spec session before touching the code.

---

## Hard Problems

### 1. Transport Interface

**Proposed interface:**

```typescript
type TransportError =
  | { kind: "connection_lost"; cause: Error }
  | { kind: "command_failed"; code: number; stderr: string }
  | { kind: "timeout"; after_ms: number }
  | { kind: "not_connected" };

interface ExecResult {
  stdout: string;
  stderr: string;
  code: number;
}

interface Transport {
  exec(command: string, signal?: AbortSignal): Promise<ExecResult>;
  readFile(path: string): Promise<Buffer>;     // base64 internally
  writeFile(path: string, content: Buffer): Promise<void>;  // atomic
  close(): Promise<void>;
  readonly shell: "bash" | "pwsh" | "unknown";
  readonly platform: "linux" | "darwin" | "windows" | "unknown";
  readonly arch: string;
  readonly state: "connecting" | "connected" | "disconnected" | "error";
  on(event: "disconnect", cb: (err: Error) => void): void;
}
```

**Hard problem**: SSH and Docker have fundamentally different execution semantics but the interface above hides this correctly. The problem is `state` management — Docker's state is just "container running or not" (binary), SSH's state is a continuous connection that can degrade without dropping. Don't try to express this difference in the interface; surface it only in error types from `exec()`.

**Do not use generics here.** The interface is narrow enough. Generics just add noise and make mock implementations harder to write.

**What's hard**: Who owns the AbortSignal contract? If a signal fires mid-command on SSH, you can send `\x03` (CTRL-C) to the shell, but you can't guarantee it's received before the sentinel arrives. Docker is cleaner — just kill the subprocess. Specify: on abort, SSH sends `\x03` and waits up to 2s for the shell to settle; Docker kills the exec process immediately. Return `{ kind: "connection_lost" }` on unclean abort.

---

### 2. ShellDriver (BashDriver + PwshDriver)

**The escaping problem is harder than it looks. Concrete cases:**

| Input | Bash target | Pwsh target |
|---|---|---|
| `file with spaces.txt` | `'file with spaces.txt'` | `'file with spaces.txt'` |
| `file's.txt` | `file\'s.txt'` or `"file's.txt"` | `"file's.txt"` |
| `$HOME/file.txt` | `'$HOME/file.txt'` (literal!) | `'$HOME/file.txt'` |
| `file \`test\`.txt` | `'file `test`.txt'` | `'file ``test``.txt'` |
| `file$(rm -rf /).txt` | `'file$(rm -rf /).txt'` | `'file$(rm -rf /).txt'` |
| `a\nb` (literal newline) | `a\nb'` | `"a`nb"` |

**Proposed algorithm for `shellEscape`:**

```typescript
// BashDriver
function shellEscape(arg: string): string {
  // Single-quote everything, escape embedded single quotes via ANSI-C ...'
  if (!arg.includes("'")) return `'${arg}'`;
  // Use ...' for anything with single quotes or control chars
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
  // Single-quote everything, escape embedded single quotes by doubling
  return `'${arg.replace(/'/g, "''")}'`;
}
```

**Warning**: `...'` is bash-specific. Dash (`/bin/sh` on Debian/Alpine) doesn't support it. If the detected shell is `sh`, fall back to `"..."` with careful escaping. This is why the synthesis says "don't share escaping logic" between bash and pwsh — but also don't assume bash is bash.

**The `edit` implementation:**

Option A (read → local edit → write) is the correct answer, but it has one subtle failure mode: **encoding round-trips**. If the remote file has Windows CRLF line endings and the read command (`cat` over base64) returns them faithfully, pi's local edit algorithm (which does an exact substring match) must also match against CRLF. If pi normalizes to LF internally, the match fails on Windows targets. Spec this explicitly: preserve the exact bytes from `readFile()`, do the string match and replace on those bytes, write the exact result back. Do not normalize.

**Atomic write per shell:**

```bash
# BashDriver: write to temp, atomic rename
base64 -d <<'CONTENT_EOF' > /tmp/.pitramp_tmp_${UUID}
<base64 content>
CONTENT_EOF
mv /tmp/.pitramp_tmp_${UUID} /target/path/file.txt
```

```powershell
# PwshDriver: write via temp file (mv is not atomic on Windows but close enough)
[System.IO.File]::WriteAllBytes("$env:TEMP\.pitramp_tmp_${UUID}", [Convert]::FromBase64String("<b64>"))
Move-Item "$env:TEMP\.pitramp_tmp_${UUID}" "C:\target\path\file.txt" -Force
```

**Test strategy**: Unit test `shellEscape()` in isolation with a table of tricky inputs. Integration test against a real bash process (spawn locally) and a real pwsh process — don't mock this.

---

### 3. TargetManager

**Proposed `targets.json` (concrete, full schema):**

```jsonc
{
  "targets": {
    "dev": {
      "type": "ssh",                           // shell required
      "host": "marc@dev.server.internal",
      "identityFile": "~/.ssh/dev_ed25519",   // Phase 1 only field
      "cwd": "/home/marc/project",
      "shell": "bash",
      "requireEntryConfirmation": false,
      "timeout": 30000                          // ms, default 60000
    },
    "odoo-container": {
      "type": "docker",
      "container": "odoo-toolbox-dev",
      "cwd": "/workspace"
      // No requireEntryConfirmation → defaults to false
    },
    "production": {
      "type": "ssh",                           // shell required
      "host": "deploy@prod.example.com",
      "cwd": "/srv/app",
      "shell": "bash",
      "requireEntryConfirmation": true
      // No identityFile → uses ssh-agent / default key
    }
  },
  "default": "local"
}
```

**Merge algorithm (global + project):**

```
merged = { ...global.targets }
for (name, config) of project.targets:
  merged[name] = { ...global.targets[name], ...config }
  // Project wins field-by-field on name collision
default = project.default ?? global.default ?? "local"
```

Field-by-field merge (not whole-target replacement) is important: user might define `host` globally and `cwd` per-project for the same named target.

**Hard problem**: Validation. If the config has a typo in `type` (`"sshh"` instead of `"ssh"`), fail loud at load time. Validate against a Zod schema. Return a clear error with file path and field name — not a runtime crash when the user tries to switch.

**Test strategy**: Pure function tests — serialize JSON, call `loadConfig()`, assert merged result. No mocking needed.

---

### 4. ConnectionPool

**Proposed interface:**

```typescript
interface ConnectionPool {
  getConnection(targetName: string): Promise<Transport>;
  releaseAll(): Promise<void>;  // on session shutdown
  // Internal: keepalive timer, reconnect logic
}
```

**Connection reuse policy**: Keep alive for 30 minutes of idle, probe with a no-op (`echo keepalive`) every 15 seconds. If keepalive fails, mark as `disconnected` and reconnect on next `getConnection()`.

**Max connections**: No hard limit for Phase 1. If a user has 20 targets configured and switches between 10 of them, all 10 stay alive. This is memory-cheap (SSH: one process per connection). Add a soft warning log at 5 connections.

**Error recovery — the hard case**: SSH drops mid-command execution. The scenario:

1. Serial queue is processing command `cat /etc/hosts`
2. SSH connection drops (network timeout, server restart)
3. No more stdout data arrives
4. The `exec()` promise is pending

**Resolution**: The disconnect event fires → `exec()` rejects with `{ kind: "connection_lost" }` → the pending Operations promise rejects → the tool override returns an error message to the LLM → the LLM sees "connection lost to target dev" → TargetManager marks connection as `disconnected`.

**What state is the pool in after this?** The connection object must not be reused — it holds a dead process. Pool must evict the connection and create a fresh one on next `getConnection()`. Critical: the serial queue must be drained (all pending calls rejected) before the pool accepts new connections.

**Implementation sketch for error recovery:**

```typescript
class SshConnection {
  private queue: Array<{ resolve, reject, command }> = [];
  private processing = false;

  private onDisconnect(err: Error) {
    // Reject all pending including current
    for (const item of this.queue) {
      item.reject({ kind: "connection_lost", cause: err });
    }
    this.queue = [];
    this.processing = false;
    // Signal pool to evict this connection
    this.emit("dead", err);
  }
}
```

**Test strategy**: Simulate network drops by killing the SSH server process mid-command. Use a Docker container running sshd — kill the sshd process while a command is in flight. Verify the pool evicts and reconnects cleanly.

---

### 5. operations-remote — The Edit Problem

**Answer: Option A (read → local edit → write). No contest.**

The reasoning:
- Option B (sed): multiline old/new text, arbitrary character content, bash vs pwsh differences → escaping surface is enormous. One shell injection risk.
- Option C (helper script): requires file upload infrastructure before the edit infrastructure exists. Circular dependency.
- Option A: 2 round trips, but `write` already costs 1 round trip. The extra round trip is one `readFile()`. Acceptable.

**Failure modes of Option A:**

1. **TOCTOU**: Another process modifies the file between read and write. Acceptable — same risk as local edit. Document it.
2. **Encoding**: Covered above — preserve exact bytes, don't normalize line endings.
3. **Old text not found**: Edit fails locally before touching the remote. Safe failure — nothing is written.
4. **Write failure after edit succeeds locally**: Remote disk full, permissions. The write fails and throws. The local file was never modified (we're editing a buffer). Safe.
5. **Partial write**: Mitigated by atomic write (temp + rename). If rename fails, original is intact.

**Implementation sketch:**

```typescript
async function remoteEdit(transport: Transport, driver: ShellDriver, params: EditParams) {
  // 1. Read file remotely
  const raw = await transport.readFile(params.path);
  const content = raw.toString("utf8");  // but keep original encoding for write

  // 2. Find and replace locally (pi's algorithm)
  const idx = content.indexOf(params.oldText);
  if (idx === -1) throw new Error(`Edit failed: old_text not found in ${params.path}`);
  const newContent = content.slice(0, idx) + params.newText + content.slice(idx + params.oldText.length);

  // 3. Write back atomically
  await transport.writeFile(params.path, Buffer.from(newContent, "utf8"));
}
```

**What about encoding?** If the file is not UTF-8 (rare but happens with legacy code), the `toString("utf8")` roundtrip may corrupt it. For Phase 1: document that `edit` assumes UTF-8. Fail with a clear error for binary files.

**Test strategy**: Unit tests for the local edit logic (fast). Integration tests against a real Docker container: write a file, edit it, read back, assert content. Include: paths with spaces, files with non-ASCII content, newlines at EOF.

---

### 6. tool-overrides

**Conditional registration (always register, check at call time):**

```typescript
// At extension init:
pi.registerTool({
  name: "bash",
  // ...schema from local bash tool...
  async execute(id, params, signal, onUpdate, ctx) {
    const target = targetManager.getCurrent();
    if (target.type === "local") {
      return localBashTool.execute(id, params, signal, onUpdate, ctx);
    }
    const conn = await pool.getConnection(target.name);
    const ops = new RemoteBashOperations(conn, target.cwd);
    return createBashTool(target.cwd, { operations: ops })
      .execute(id, params, signal, onUpdate, ctx);
  }
});
```

**Never conditionally unregister** — pi's tool registry doesn't support it cleanly and the state machine is a bug waiting to happen.

**Registration order — the real problem:**

Pi's `registerTool` is last-writer-wins. Pi-tramp must be loaded LAST. There's no API to enforce this. Realistic mitigations:

1. **Detect at runtime**: At the start of each `execute()`, check if `pi.getTool("bash").execute === ourHandler`. If not, we've been overridden — log a loud warning and fall through to local. (This requires pi to expose `getTool` — confirm it does.)

2. **Register late**: Hook into a `ready` or `after_extensions_loaded` event (if pi has one) and register tools there, not in the top-level extension init.

3. **Document the conflict clearly**: In README, the extension load order must put pi-tramp last. Provide a CI lint check (`check-extension-order.ts`).

The most dangerous scenario: pi-powershell also overrides `bash`. Both are loaded. Load order determines which one wins. The losing one silently does nothing — the agent runs commands locally while the system prompt says it's on a remote target. **This is the silent failure mode that will cause the most confusion.**

**Mitigation**: In pi-tramp's `execute()`, check `targetManager.getCurrent().type !== "local"` and also check that `this` is being called (i.e., we weren't overridden). If there's any doubt, throw a visible error rather than silently falling through.

**Test strategy**: Hard to test in isolation because it requires the pi runtime. Write playbook tests using `pi-test-harness`. Test: (1) local target → calls flow to local ops, (2) docker target → calls flow to docker transport, (3) switch target → subsequent calls go to new target. The mock `streamFn` in the test harness should verify which tool is invoked.

---

### 7. target-tool

**Unreachable SSH host on `target create`**: Do **not** connect at create time. Create is just config registration. Connect lazily at `target switch`. Rationale: creating a target for a server that's currently booting shouldn't fail. The error will surface at switch time when it matters.

**Unreachable SSH host on `target switch`**: Fail immediately with `{ kind: "connection_lost" }`. Don't leave the current target in an ambiguous state. The switch should be atomic — either fully succeed (new target active, connection established) or fully fail (old target remains active).

**Confirmation gate — concrete spec** (implementing Marc's decision: `/target switch` bypasses, agent-called `target switch` does not):

```typescript
async function handleSwitch(name: string, ctx: ToolContext) {
  const target = targetManager.get(name);
  if (!target) throw new Error(`Target '${name}' not found`);

  if (target.requireEntryConfirmation && !ctx.isUserInitiated) {
    // ctx.isUserInitiated = true when called via /target slash command
    const confirmed = await ctx.ui.confirm(
      `Switch to target '${name}' (${target.host ?? target.container})?`,
      { timeout: 30_000 }
    );
    if (!confirmed) return { success: false, reason: "User declined confirmation" };
  }

  await pool.getConnection(name);  // establish connection, may throw
  targetManager.setCurrent(name);
  injectTargetContext(name);  // sendMessage with pi_tramp-target_context
  return { success: true, target: name, platform: ..., shell: ... };
}
```

**What the agent sees on required-confirmation rejection**: The tool returns `{ success: false, reason: "User declined confirmation" }`. The agent should treat this like a permission error and stop trying to switch to that target without explicit user instruction. Make this explicit in the system prompt: "If `target switch` returns `success: false`, do not retry — wait for user instruction."

**What the agent sees on timeout** (user didn't respond in 30s): Same as declined. Return `{ success: false, reason: "Confirmation timed out" }`.

**Test strategy**: The `ctx.isUserInitiated` flag needs to be set by pi's slash command dispatch — verify this is actually the case in pi's source. If it's not currently threaded through, this is a missing upstream feature, not just a detail.

---

### 8. Sentinel Protocol (SSH)

**Exact format and algorithm:**

```typescript
// Generating a sentinel (per-invocation, UUID v4)
const sentinelId = crypto.randomUUID().replace(/-/g, "");
const sentinel = `__PITRAMP_${sentinelId}__`;

// What we send to the shell (bash):
const wrapped = `${command}\necho "${sentinel}_$?"\n`;

// What we send (pwsh):
const wrapped = `${command}\nWrite-Output "${sentinel}_$LASTEXITCODE"\n`;

// Parsing the output stream:
// Read lines. When we see a line matching:
// /^__PITRAMP_[0-9a-f]{32}___(\d+)$/ where the UUID matches sentinelId
// → extract exit code from capture group
// → everything before this line = stdout
// → done
```

**How to handle binary output containing the sentinel**: The sentinel is 48+ characters of uppercase hex with a specific prefix. The probability of this appearing in legitimate command output is astronomically low. For further safety, use a 64-character hex ID (two UUIDs concatenated). If you're paranoid, use a different sentinel per session AND per invocation — double protection.

**Never** route binary commands through `exec()`. All binary data (file reads/writes) goes through `readFile()`/`writeFile()` which use a separate encoding strategy (base64 piped in one shot) with known-length output, not sentinel-based parsing.

**Timeout — concrete spec:**

```typescript
// In target config:
{ timeout: 60_000 }  // ms, default

// In exec():
const timer = setTimeout(() => {
  reject({ kind: "timeout", after_ms: target.timeout });
  connection.kill();  // kill the SSH process, trigger reconnect
}, target.timeout);
```

On timeout: kill the SSH process (don't try to send CTRL-C — the shell is unresponsive). Mark the connection as dead. The pool reconnects on next use. The pending tool call receives a timeout error. The LLM sees "bash timed out after 60 seconds on target dev."

**PowerShell color codes**: PowerShell in interactive mode emits ANSI escape codes for color. A persistent SSH session that drops into an interactive pwsh will emit garbage around the sentinel. **Solution**: Run pwsh in non-interactive mode: `pwsh -NonInteractive -Command -`. Or launch pwsh with `$PSStyle.OutputRendering = 'PlainText'`. Detect: if initial sentinel probe (used for shell detection) contains ANSI codes, send the disable command before any real work. This is a production incident waiting to happen if not addressed before the first pwsh-over-SSH test.

**Implementation sketch (streaming stdout reader):**

```typescript
class SshSession {
  private buffer = "";

  private onData(chunk: Buffer) {
    this.buffer += chunk.toString("utf8");
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() ?? "";  // keep incomplete last line

    for (const line of lines) {
      if (this.currentSentinelRegex?.test(line)) {
        const code = parseInt(line.split("_").at(-1)!);
        this.resolveCurrentExec({ stdout: this.stdout, stderr: this.stderr, code });
        this.stdout = ""; this.stderr = "";
        this.currentSentinelRegex = null;
        this.processQueue();
        return;
      }
      this.stdout += line + "\n";
    }
  }
}
```

**Test strategy**: Docker container with sshd running is the right test environment. Test cases:
- Normal command completes
- Command produces 10MB of output (buffer pressure)
- Command produces output containing `__PITRAMP` but not the exact sentinel
- Timeout scenario: run `sleep 120` with 5s timeout — verify connection is killed and pool reconnects
- Rapid sequential commands — verify serial queue works, no sentinel mixing
- pwsh session: verify color code stripping

---

## What Will Break First

**1. PowerShell color codes in SSH session** (first pwsh-over-SSH test). ANSI escape codes will corrupt the sentinel parser. Fix requires detecting interactive mode and disabling it before any real commands.

**2. The edit tool on CRLF files** (first Windows target). A file with CRLF line endings, read over SSH with `cat`, sent through base64, decoded — then pi does a string match for `oldText` that was typed with LF in the design doc. The match fails. Silent failure is worse than a noisy error.

**3. Tool override conflict with pi-powershell** (first user who loads both extensions). Load order matters and there's no enforcement. The losing extension silently does nothing. The agent is confused.

**4. requireEntryConfirmation timeout** (first production target user who goes to make coffee). `ctx.ui.confirm()` hangs indefinitely or uses a very long default timeout. The agent's turn blocks. The user returns to find the session hung.

**5. SSH connection mid-command drop** (first unstable network). The serial queue drain logic is easy to get wrong — if any pending items leak, the next connection to the same target will see stale state.

---

## Scope Reality Check

**SSH + Docker + all 4 overrides simultaneously**: This adds 2-3 weeks of SSH work to the initial build. The integration point comes later, so you don't get the "fail fast on integration" benefit that usually justifies doing hard things first. The real timeline:

| Phase | What | Realistic Estimate |
|---|---|---|
| Interfaces + TargetManager + ShellDrivers | Foundation | 1 week |
| DockerTransport + ConnectionPool | Docker complete | 1 week |
| SshTransport + sentinel + lifecycle | SSH complete | 2 weeks |
| operations-remote (all 4 ops) | Remote ops | 1 week |
| tool-overrides (all 4 tools) | Wiring | 0.5 weeks |
| target-tool + system prompt injection | UX | 0.5 weeks |
| Integration debugging | Reality | 1-2 weeks |

**Total: 7-9 weeks** for a solid Phase 1A. The synthesis estimated 3-4 weeks for Docker-only; the decision to include SSH doubles the hardest part of the work. That's fine — just accurate.

**What could be cut for faster MVP without compromising the decision**: The `edit` override is the hardest of the four tool overrides (2 round trips, encoding edge cases). `write` is second hardest (atomic write, encoding). `bash` and `read` are the core. If timeline pressure hits, `write` and `edit` could ship as Phase 1B with a clear documented limitation ("read-only remote targets in first release"). But Marc explicitly decided all four ship together — just flag the estimate impact.

---

## Implementation Sequence

If I were building this, in this exact order:

1. **Transport interface + error types** — TypeScript only, zero implementation. Write the mock too (a fake transport that queues commands and returns preconfigured responses). Everything else tests against this mock.

2. **TargetManager** — pure logic, no I/O. Config load + merge + CRUD + `requireEntryConfirmation` flag. Full unit tests.

3. **BashDriver and PwshDriver** — `shellEscape()`, `readFileCommand()`, `writeFileCommand()`, `mkdirCommand()`. Unit tests against real local bash and pwsh processes (not mocks — the escaping logic MUST be tested against real shells).

4. **DockerTransport** — implements Transport interface via `docker exec`. Serial command queue from day one. Shell detection on connect. Full integration test with a real Docker container.

5. **ConnectionPool** — lifecycle management over DockerTransport. Test: connect, disconnect, reconnect, idle timeout.

6. **SshTransport** — sentinel protocol, stdout reader, connection lifecycle, keepalive. Use a Docker container with sshd for tests. This is the longest step. Don't move on until the sentinel parser handles: large output, timeout, mid-command disconnect.

7. **operations-remote** — implement `ReadOperations`, `WriteOperations`, `EditOperations`, `BashOperations` over Transport + ShellDriver. Test with mock transport.

8. **tool-overrides** — register all four tools. Use pi-test-harness playbooks for integration. Measure: does switching targets mid-conversation work?

9. **target-tool** — target switch/list/create/remove/status. Test confirmation gate with both user-initiated and agent-initiated paths.

10. **System prompt injection + context injection** — measure token count immediately. Log it. If it's >300 tokens per turn, it's a problem.

11. **Status bar widget** — last, because it's cosmetic and depends on everything being wired correctly.

---

## Missing from the Design

**Must be specified before implementation starts:**

1. **Sentinel timeout behavior**: What does the pool's state look like after a timeout? Is the SSH process killed immediately or gracefully? What's the reconnect delay? Exponential backoff? Max retries? Specify this as a state machine, not prose.

2. **Shell detection algorithm**: The synthesis recommended the `echo "$0"` → `$PSVersionTable` algorithm. Mark accepted it ("Shell detection algorithm needs specification"). Write the algorithm into the design doc verbatim with the exact commands and parsing rules before the SshTransport is coded.

3. **`ctx.isUserInitiated` flag**: Does pi's tool context actually carry this flag? If a slash command calls `target switch`, is there a way to distinguish it from an LLM-initiated tool call in the `execute()` context? If not, this is a missing upstream feature that blocks the requireEntryConfirmation bypass spec.

4. **CRLF handling policy**: `read` and `edit` on Windows targets. Preserve bytes or normalize? Must be explicit — this is a correctness question, not a performance one.

5. **pwsh non-interactive mode command**: What exact flag/invocation is used to start a non-interactive pwsh session over SSH? (`pwsh -NonInteractive`? `pwsh -Command -`?) Test this manually against a Windows SSH target before coding it.

6. **Port for identityFile**: SSH Phase 1 accepts `identityFile` in config. Does it also accept `port`? (SSH to non-standard ports is extremely common.) Omitting this means the first user with a non-standard port can't use the extension.

7. **Error message format returned to LLM**: When `exec()` throws `{ kind: "connection_lost" }`, what does the tool return to the LLM? A string? A structured JSON? This must be consistent across all four tool overrides. Define the error format once.

8. **`trampExec()` API signature**: The design says "exported function for extension authors." What is the exact API? `trampExec(command: string, args: string[]): Promise<ExecResult>`? Does it inherit the current target or accept a target name? This is a public API — once extensions depend on it, you can't change it.
