# trampExec() Public API

> Spec for the public API exported by pi-tramp for use by other extensions.
> Must be locked before v1.0 — public APIs are hard to change after adoption.

## Purpose

Extension authors need to execute commands on the current remote target.
Pi's `pi.exec()` is hardwired to local `spawn()`. `trampExec()` provides
the same capability but routes through pi-tramp's transport layer.

Example use case: An extension that runs `git status` should run it on the
remote target, not locally. Instead of `pi.exec("git", ["status"])`, it
calls `trampExec("git status")`.

## API Signature

```typescript
export async function trampExec(
  command: string,
  options?: TrampExecOptions
): Promise<ExecResult>;

export interface TrampExecOptions {
  /** Target name. If omitted, uses current target from TargetManager. */
  target?: string;

  /** Timeout in milliseconds. Default: 60000 (60s). */
  timeout?: number;

  /** AbortSignal for cancellation. */
  signal?: AbortSignal;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}
```

## Behavior

### Normal Flow

1. Resolve target: `options.target ?? currentTarget`
2. If no target resolved → throw `Error("No active target. Use target switch first.")`
3. If target is `"local"` or null → fall back to local `spawn()` (same as pi.exec)
4. Get connection from ConnectionPool (lazy connect if needed)
5. Execute command through the serial queue
6. Return `{ stdout, stderr, exitCode }`

### Error Handling

```typescript
// Target not found
trampExec("ls", { target: "nonexistent" })
// → throws Error("Target 'nonexistent' not found")

// Connection failed
trampExec("ls", { target: "unreachable-host" })
// → throws RemoteOperationError with kind "connection_lost"

// Command timeout
trampExec("sleep 999", { timeout: 5000 })
// → throws RemoteOperationError with kind "timeout"

// Cancellation
const controller = new AbortController();
const promise = trampExec("sleep 999", { signal: controller.signal });
controller.abort();
// → throws AbortError
```

### Non-Zero Exit Codes

Non-zero exit codes are NOT errors. They're returned normally:

```typescript
const result = await trampExec("false");
// result.exitCode === 1 — no throw
```

Only transport-level failures throw.

## Usage by Extension Authors

```typescript
// In another pi extension
import { trampExec } from "pi-tramp";

// Execute on current target
const result = await trampExec("git status");
console.log(result.stdout);

// Execute on specific target
const result = await trampExec("docker ps", { target: "staging" });

// With timeout
const result = await trampExec("npm run build", { timeout: 120000 });

// With cancellation
const controller = new AbortController();
const result = await trampExec("npm test", { signal: controller.signal });
```

## Implementation Notes

### Goes Through ConnectionPool

`trampExec()` is not a raw `transport.exec()` call. It goes through the
ConnectionPool, which means:

1. Connection is lazily established if needed
2. Command is serialized through the per-target queue
3. Connection health is managed (reconnect on failure)

```typescript
export async function trampExec(
  command: string,
  options?: TrampExecOptions
): Promise<ExecResult> {
  const targetName = options?.target ?? targetManager.currentTarget?.name;

  if (!targetName) {
    throw new Error("No active target. Use target switch first, or specify options.target.");
  }

  if (targetName === "local") {
    // Fall back to local execution
    return localExec(command, options);
  }

  const target = targetManager.getTarget(targetName);
  if (!target) {
    throw new Error(`Target '${targetName}' not found.`);
  }

  return connectionPool.execOnTarget(targetName, async (transport) => {
    return transport.exec(command, {
      timeout: options?.timeout,
      signal: options?.signal,
    });
  });
}
```

### Module-Level References

`trampExec()` needs access to `targetManager` and `connectionPool`. These are
set during extension activation:

```typescript
// Internal state — set by extension.ts activate()
let targetManager: TargetManager;
let connectionPool: ConnectionPool;

export function _initialize(tm: TargetManager, pool: ConnectionPool): void {
  targetManager = tm;
  connectionPool = pool;
}

export async function trampExec(...) { ... }
```

The `_initialize` function is internal (underscore prefix convention). Only
`trampExec` is part of the public API.

### Local Fallback

When no target is active or target is `"local"`, `trampExec()` falls back to
local execution using Node.js `child_process.exec`:

```typescript
async function localExec(
  command: string,
  options?: TrampExecOptions
): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const proc = exec(command, {
      timeout: options?.timeout,
      signal: options?.signal,
    }, (error, stdout, stderr) => {
      resolve({
        stdout,
        stderr,
        exitCode: error?.code ?? 0,
      });
    });
  });
}
```

## API Stability

This API is **locked for v1.0**. Changes after v1.0 require a major version bump.

### What's Locked

- Function name: `trampExec`
- Parameters: `(command: string, options?: TrampExecOptions)`
- Return type: `Promise<ExecResult>`
- ExecResult shape: `{ stdout: string, stderr: string, exitCode: number }`
- Options fields: `target`, `timeout`, `signal`
- Error behavior: transport failures throw, non-zero exit codes don't

### What Can Be Added (Minor Version)

- New optional fields in `TrampExecOptions` (backwards compatible)
- New optional fields in `ExecResult` (backwards compatible)
- Additional exports (e.g., `trampReadFile`, `trampWriteFile`)

### What Requires Major Version

- Changing the function signature
- Changing ExecResult field names or types
- Changing error behavior (e.g., throwing on non-zero exit codes)
- Removing any existing field

## Phase 2 Candidates

These are NOT part of v1.0 but may be added later:

```typescript
// File operations on remote targets (Phase 2)
export async function trampReadFile(path: string, options?: TrampExecOptions): Promise<Buffer>;
export async function trampWriteFile(path: string, content: Buffer, options?: TrampExecOptions): Promise<void>;

// Current target info (Phase 2)
export function getCurrentTarget(): TargetInfo | null;

export interface TargetInfo {
  name: string;
  type: "ssh" | "docker" | "wsl" | "psremote";
  shell: ShellType;
  platform: PlatformType;
  arch: string;
  cwd: string;
}
```
