# Error Message Format for LLM

> Spec for standardized error handling across all 4 tool overrides.
> Blocks: All tool overrides, operations-remote error handling.

## Design Principle

Errors from remote operations must be:
1. **Actionable by the LLM** — include enough context to decide what to do next
2. **Identifiable as remote** — always include the target name
3. **Consistent across tools** — same structure for read, write, edit, bash

## Error Architecture

### Internal: TransportError (discriminated union)

Used inside the transport and operations layers. Type-safe, exhaustive matching.

```typescript
type TransportError =
  | { kind: "connection_lost"; cause: Error }
  | { kind: "command_failed"; code: number; stderr: string }
  | { kind: "timeout"; after_ms: number }
  | { kind: "not_connected" };
```

### External: RemoteOperationError (Error subclass)

Thrown at the tool layer. Extends `Error` for standard catch semantics.

```typescript
class RemoteOperationError extends Error {
  public readonly target: string;
  public readonly operation: "read" | "write" | "edit" | "bash";
  public readonly transportError?: TransportError;

  constructor(
    message: string,
    target: string,
    operation: "read" | "write" | "edit" | "bash",
    transportError?: TransportError
  ) {
    super(message);
    this.name = "RemoteOperationError";
    this.target = target;
    this.operation = operation;
    this.transportError = transportError;
  }
}
```

### Tool Result: Error Output

When a tool override catches a `RemoteOperationError`, it returns a structured
error result that the LLM can parse:

```typescript
function formatToolError(err: RemoteOperationError): string {
  return [
    `Remote ${err.operation} failed on target '${err.target}':`,
    err.message,
    err.transportError ? `(${err.transportError.kind})` : "",
  ].filter(Boolean).join("\n");
}
```

The error is returned as the tool's text output (not thrown) — pi's tool framework
handles this naturally. The LLM sees it as the tool's response.

## Error Messages by Operation

### read

| Situation | Message |
|-----------|---------|
| File not found | `Remote read failed on target 'dev': File not found: /path/to/file` |
| Permission denied | `Remote read failed on target 'dev': Permission denied: /path/to/file` |
| File too large | `Remote read failed on target 'dev': File too large (15728640 bytes, limit 10MB): /path/to/file` |
| Connection lost | `Remote read failed on target 'dev': Connection lost during read operation` |
| Timeout | `Remote read failed on target 'dev': Operation timed out after 60000ms` |
| Not connected | `Remote read failed on target 'dev': Not connected to target (use target switch first)` |

### write

| Situation | Message |
|-----------|---------|
| Permission denied | `Remote write failed on target 'dev': Permission denied: /path/to/file` |
| Disk full | `Remote write failed on target 'dev': Write failed (disk full?): /path/to/file` |
| Content too large | `Remote write failed on target 'dev': Content too large (15728640 bytes, limit 10MB)` |
| Parent dir creation failed | `Remote write failed on target 'dev': Cannot create directory: /path/to/` |
| Connection lost | `Remote write failed on target 'dev': Connection lost during write operation` |
| Timeout | `Remote write failed on target 'dev': Operation timed out after 60000ms` |

### edit

| Situation | Message |
|-----------|---------|
| File not found | `Remote edit failed on target 'dev': File not found: /path/to/file` |
| old_text not found (LF file) | `Remote edit failed on target 'dev': old_text not found in /path/to/file` |
| old_text not found (CRLF file) | `Remote edit failed on target 'dev': old_text not found in /path/to/file (note: file uses CRLF line endings)` |
| old_text not found (mixed) | `Remote edit failed on target 'dev': old_text not found in /path/to/file (file has mixed line endings)` |
| File too large | `Remote edit failed on target 'dev': File too large for edit (15728640 bytes, limit 10MB): /path/to/file` |
| Write-back failed | `Remote edit failed on target 'dev': Failed to write back edited file: /path/to/file` |
| Connection lost during read | `Remote edit failed on target 'dev': Connection lost during read phase of edit` |
| Connection lost during write | `Remote edit failed on target 'dev': Connection lost during write-back phase of edit (file may be unchanged)` |

### bash

| Situation | Message |
|-----------|---------|
| Command failed (non-zero) | *(Not an error — return stdout, stderr, and exit code normally)* |
| Connection lost | `Remote bash failed on target 'dev': Connection lost during command execution` |
| Timeout | `Remote bash failed on target 'dev': Command timed out after 60000ms` |
| Not connected | `Remote bash failed on target 'dev': Not connected to target` |

**Note**: Non-zero exit codes from bash commands are NOT errors. They're returned as
normal results with `exitCode` set. Only transport-level failures are errors.

## Error Context Wrapping

All transport errors are wrapped with target and operation context before surfacing:

```typescript
// In operations-remote
async readFile(path: string): Promise<Buffer> {
  try {
    return await this.transport.readFile(path);
  } catch (err) {
    throw new RemoteOperationError(
      `File operation failed: ${path}`,
      this.targetName,
      "read",
      this.classifyError(err)
    );
  }
}

private classifyError(err: unknown): TransportError {
  if (err && typeof err === "object" && "kind" in err) {
    return err as TransportError;
  }
  // Unknown error → wrap as command_failed
  return {
    kind: "command_failed",
    code: 1,
    stderr: err instanceof Error ? err.message : String(err),
  };
}
```

## Stderr Handling

For bash commands, stderr is part of the normal output — returned to the LLM as-is.

For file operations (read, write, edit), stderr from the underlying shell command
(e.g., `cat: /path: No such file or directory`) is captured and used to construct
the error message. The raw stderr helps identify the specific failure:

```typescript
function parseShellError(stderr: string, path: string): string {
  if (stderr.includes("No such file or directory")) return `File not found: ${path}`;
  if (stderr.includes("Permission denied")) return `Permission denied: ${path}`;
  if (stderr.includes("Is a directory")) return `Path is a directory: ${path}`;
  if (stderr.includes("No space left")) return `Write failed (disk full?): ${path}`;
  // Default: include raw stderr
  return `Command failed: ${stderr.trim()}`;
}
```

## Target Tool Errors

The `target` tool has its own error messages:

| Situation | Message |
|-----------|---------|
| Target not found | `Target 'foo' not found. Available targets: dev, staging, production` |
| Already connected | `Already connected to target 'dev'` |
| Connection failed | `Failed to connect to target 'dev': Connection refused (is the SSH server running?)` |
| Confirmation denied | `Target switch to 'production' cancelled by user (requires confirmation)` |
| Reserved name | `'local' is a reserved target name` |
| Duplicate name | `Target 'dev' already exists (use target remove first)` |

## Error Recovery Guidance

For connection errors, include recovery hints:

```typescript
function connectionErrorWithHint(target: string, cause: string): string {
  return [
    `Connection to target '${target}' failed: ${cause}`,
    "",
    "Possible actions:",
    "- Check if the target is reachable (SSH server running, Docker container started)",
    "- Use `target status ${target}` to check connection health",
    "- Use `target switch ${target}` to reconnect",
  ].join("\n");
}
```

This gives the LLM actionable next steps instead of just a failure message.
