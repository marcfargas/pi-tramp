# Sentinel Protocol Algorithm

> Spec for SSH persistent connection command completion detection.
> Blocks: SshTransport implementation, SSH sentinel prototype.

## Overview

SSH persistent connections multiplex commands over a single stdin/stdout stream.
The sentinel protocol detects when a command's output ends and captures its exit code.

## Sentinel Format

```
__PITRAMP_<uuid>__
```

Where `<uuid>` is `crypto.randomUUID().replace(/-/g, "")` — 32 hex characters, no dashes.

Example: `__PITRAMP_a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6__`

The UUID is per-invocation. Every `exec()` call generates a fresh sentinel. This prevents
sentinel mixing when rapid sequential commands are queued.

## Command Wrapping

### Bash / sh

```bash
<command>
printf '%s_%d\n' '__PITRAMP_<uuid>__' "$?"
```

Using `printf` instead of `echo` avoids issues with `echo -n` portability.
The `\n` ensures the sentinel is on its own line.

### PowerShell (pwsh / Windows PowerShell)

```powershell
$global:LASTEXITCODE = 0
<command>
Write-Output "__PITRAMP_<uuid>___$LASTEXITCODE"
```

**Critical: Reset `$LASTEXITCODE` before each command.** `$LASTEXITCODE` is sticky in
PowerShell — it retains the value from the last native command indefinitely. Without the
reset, a prior `cmd /c "exit 42"` would pollute subsequent cmdlet-only commands with
exit code 42. Resetting to 0 means pure cmdlets report 0 (correct), and native commands
overwrite it with their actual exit code.

`Write-Output` writes to the pipeline (stdout). `$LASTEXITCODE` captures the exit code
of the last native command in the current command block.

## Stdout Reader Algorithm

### Line-Buffered Streaming

The reader processes stdout as a stream of lines, not by accumulating the entire output.

```typescript
class SentinelReader {
  private buffer: string = "";       // Incomplete line buffer
  private outputChunks: string[] = []; // Completed output lines
  private resolve: ((result: ExecResult) => void) | null = null;
  private reject: ((err: Error) => void) | null = null;
  private sentinelRegex: RegExp | null = null;
  private timeoutId: ReturnType<typeof setTimeout> | null = null;

  /**
   * Begin watching for a sentinel. Returns a Promise that resolves
   * when the sentinel line is found or rejects on timeout.
   */
  waitForSentinel(sentinelId: string, timeoutMs: number): Promise<ExecResult> {
    const sentinel = `__PITRAMP_${sentinelId}__`;
    this.sentinelRegex = new RegExp(`^${sentinel}_(\\d+)$`);
    this.outputChunks = [];

    return new Promise((resolve, reject) => {
      this.resolve = resolve;
      this.reject = reject;

      this.timeoutId = setTimeout(() => {
        this.sentinelRegex = null;
        this.resolve = null;
        this.reject = null;
        reject(new Error(`Sentinel timeout after ${timeoutMs}ms`));
      }, timeoutMs);
    });
  }

  /**
   * Called for every chunk received from SSH stdout.
   * Processes complete lines, looking for the sentinel.
   */
  onData(chunk: Buffer): void {
    this.buffer += chunk.toString("utf8");

    // Split into lines, keeping the last (possibly incomplete) segment in buffer
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop()!; // last segment is either "" or incomplete line

    for (const line of lines) {
      // Strip trailing \r (SSH may send \r\n depending on terminal settings)
      const cleaned = line.replace(/\r$/, "");

      if (this.sentinelRegex) {
        const match = cleaned.match(this.sentinelRegex);
        if (match) {
          const exitCode = parseInt(match[1], 10);
          const stdout = this.outputChunks.join("\n");

          if (this.timeoutId) clearTimeout(this.timeoutId);
          const resolve = this.resolve;
          this.resolve = null;
          this.reject = null;
          this.sentinelRegex = null;

          resolve?.({ stdout, stderr: "", exitCode });
          return;
        }
      }

      this.outputChunks.push(cleaned);
    }
  }

  /**
   * Called when the SSH process exits or the connection drops.
   */
  onClose(err?: Error): void {
    if (this.reject) {
      if (this.timeoutId) clearTimeout(this.timeoutId);
      const reject = this.reject;
      this.resolve = null;
      this.reject = null;
      this.sentinelRegex = null;
      reject(err ?? new Error("SSH connection closed"));
    }
  }
}
```

### Key Design Points

1. **Line splitting**: Split on `\n`, keep incomplete last segment in `buffer`.
2. **\r stripping**: SSH can emit `\r\n` due to terminal settings. Strip `\r` before matching.
3. **Single match per invocation**: Once sentinel is found, stop matching. Next `exec()` sets a new regex.
4. **Output is lines joined with \n**: The `outputChunks` array holds clean lines; joined on resolution.

## Stderr Handling

SSH stderr is a separate stream (fd 2). The persistent SSH connection can capture it
separately if launched with the right options. For Phase 1:

- **Collect stderr separately** if the SSH process provides a separate stderr pipe.
- **If not separable** (some SSH configurations merge stdout/stderr), document as limitation.
  The sentinel still works because it's only matched against stdout lines.

For Docker Transport, stderr is always separate (`docker exec` provides both streams).

## Timeout Behavior

When a command exceeds `timeoutMs`:

1. **Cancel the sentinel wait**: Reject the Promise with `{ kind: "timeout", after_ms: timeoutMs }`.
2. **Do NOT kill the SSH process** for per-command timeouts — the command may still be running
   on the remote, and we might want to reuse the connection.
3. **Send Ctrl-C** (`\x03`) to stdin to attempt canceling the remote command.
4. **Mark the reader as dirty**: Until the next sentinel is successfully parsed, the reader
   is in an uncertain state. The serial queue ensures no new commands are sent until the
   reader is clean.
5. **If the reader doesn't recover within 5 seconds** (no sentinel parsed for a recovery probe),
   kill the SSH process, mark the connection dead, drain the queue with `connection_lost` errors.

Recovery probe after timeout:
```bash
echo "__PITRAMP_recovery_probe__"
```
If this appears in stdout within 5s, the connection is still usable.

## PowerShell Color Code Suppression

Interactive PowerShell sessions emit ANSI escape codes (e.g., `\e[32m`) that corrupt output.
The sentinel parser would see `\e[32m__PITRAMP_...` instead of a clean match.

**Mandatory setup on pwsh connections** (run immediately after shell detection in `connect()`):

```powershell
try { $PSStyle.OutputRendering = 'PlainText' } catch {}
$ProgressPreference = 'SilentlyContinue'
$global:LASTEXITCODE = 0
```

- `$PSStyle.OutputRendering`: Only exists in pwsh 7.2+. Windows PowerShell 5.1 doesn't
  have it — use `try/catch` to handle both versions gracefully.
- `$ProgressPreference`: Prevents progress bars from emitting escape codes.
- `$LASTEXITCODE = 0`: Initialize so it's never null in sentinel output.

This must be sent as the first real command, before any sentinel-wrapped commands. It's a
setup command that doesn't need sentinel parsing itself — use a simpler echo-based confirmation
or just fire-and-forget (the subsequent shell detection probe will confirm the session works).

### SSH Connection: Use `-T` (No PTY)

The SSH connection MUST use `-T` (disable pseudo-terminal allocation), NOT `-tt`.
With a PTY, the shell echoes input back to stdout, which would double every command
in the output stream and break sentinel parsing. `-T` gives us a clean stdin/stdout pipe.

## Edge Cases

### Binary Output Containing Sentinel Pattern

The sentinel format `__PITRAMP_<32-hex-chars>__` appearing in random binary output is
astronomically unlikely (probability ~2^-128). This is a non-concern. If it somehow happens,
the command will complete prematurely with truncated output — an acceptable tradeoff for the
simplicity of line-based parsing.

### Partial Sentinel on Network Hiccup

If the network delivers `__PITRAMP_abc` in one chunk and `def...` in the next, the
line-buffer approach handles this correctly: the sentinel line is only matched after `\n`
arrives, so partial delivery is naturally buffered.

### Empty Command Output

If the command produces no output, the sentinel line is the only line. `outputChunks`
will be empty, and `stdout` will be `""`. This is correct.

### Command That Outputs Lines Matching Sentinel Format

If a command outputs `__PITRAMP_<something>___0`, the UUID uniqueness ensures it won't
match the current sentinel regex. Only the exact UUID for this invocation matches.

### Very Large Output (>10MB)

The `outputChunks` array accumulates lines in memory. For 10MB of output (~200K lines),
this is ~10MB of string data. Acceptable for Phase 1. If memory becomes an issue in
Phase 2, switch to a temp file accumulator.

## Serial Queue Integration

The sentinel reader works hand-in-hand with the serial command queue:

1. Queue has command → dequeue, generate sentinel, wrap command, write to stdin.
2. Reader watches for sentinel.
3. Sentinel found → resolve Promise → queue dequeues next command.
4. Timeout → recovery attempt → success continues queue, failure kills connection.

**Critical invariant**: Only one sentinel is active at a time. The serial queue guarantees this.

## Complete exec() Flow

```
1. exec("ls -la") called
2. Queue enqueues the command
3. Queue dequeues (only if no other command in flight)
4. Generate sentinelId = randomUUID().replace(/-/g, "")
5. sentinel = "__PITRAMP_" + sentinelId + "__"
6. For bash: wrapped = command + "\nprintf '%s_%d\\n' '" + sentinel + "' \"$?\"\n"
7. Write wrapped to ssh.stdin
8. reader.waitForSentinel(sentinelId, timeoutMs) → Promise
9. Reader receives stdout chunks, splits lines, matches sentinel
10. Sentinel found → resolve({ stdout, stderr, exitCode })
11. Queue marks command complete, dequeues next
```
