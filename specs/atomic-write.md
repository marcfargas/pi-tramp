# Atomic Write Strategy

> Spec for per-shell write strategy with atomicity and temp file management.
> Blocks: RemoteWriteOps, RemoteEditOps write-back.

## Overview

Writing files on remote targets must be as safe as possible. The strategy is:
1. Write content to a temporary file
2. Move the temp file to the destination (atomic on POSIX, best-effort on Windows)

This prevents partial writes from corrupting the destination file if the connection
drops or the process crashes mid-write.

## Temp File Naming

```
<destination_path>.<uuid>.pitramp.tmp
```

- `<destination_path>`: The full path of the target file.
- `<uuid>`: `crypto.randomUUID()` — unique per write operation.
- `.pitramp.tmp`: Suffix identifies orphaned temp files as pi-tramp artifacts.

Example: `/home/user/project/src/index.ts.a1b2c3d4-e5f6-7890-abcd-ef1234567890.pitramp.tmp`

The UUID prevents collisions when multiple write operations target the same file
(shouldn't happen with serial queue, but defensive).

## Bash Strategy (POSIX)

### Write Command

```bash
mkdir -p '<parent_dir>' && printf '%s' '<base64_content>' | base64 -d > '<tmp_path>' && mv '<tmp_path>' '<dest_path>'
```

All paths are escaped using `BashDriver.shellEscape()`.

### Breakdown

1. **`mkdir -p '<parent_dir>'`**: Ensure parent directory exists. `-p` creates
   intermediate directories and doesn't error if they already exist.

2. **`printf '%s' '<base64>' | base64 -d > '<tmp_path>'`**: Decode base64 content
   and write to temp file. Using `printf '%s'` instead of `echo` avoids issues
   with `-n` interpretation and trailing newlines.

3. **`mv '<tmp_path>' '<dest_path>'`**: Atomic rename on POSIX. If source and destination
   are on the same filesystem (they are — same directory), `mv` is a single `rename(2)`
   syscall which is atomic.

### Chaining with `&&`

The `&&` chaining ensures:
- If `mkdir -p` fails → stop, don't write
- If base64 decode/write fails → stop, don't move (orphan temp file)
- If `mv` fails → destination unchanged (orphan temp file)

### Large Files

For files approaching the 10MB limit, the base64 content is ~13.3MB. This goes through
stdin as a single command. If this causes issues with argument length limits in the shell:

**Fallback for large files** (>1MB base64): Split into chunks and append:
```bash
mkdir -p '<parent_dir>' && \
printf '%s' '<chunk1>' | base64 -d > '<tmp_path>' && \
printf '%s' '<chunk2>' | base64 -d >> '<tmp_path>' && \
mv '<tmp_path>' '<dest_path>'
```

For Phase 1, start with single-command approach. Switch to chunked if hitting limits.

## PowerShell Strategy (Windows)

### Write Command

```powershell
$d = '<parent_dir>'; if (-not (Test-Path $d)) { New-Item -ItemType Directory -Force -Path $d | Out-Null }; [IO.File]::WriteAllBytes('<tmp_path>', [Convert]::FromBase64String('<base64_content>')); Move-Item -Force '<tmp_path>' '<dest_path>'
```

All paths are escaped using `PwshDriver.shellEscape()`.

### Breakdown

1. **Directory creation**: `New-Item -ItemType Directory -Force` creates parent dirs.
   `-Force` doesn't error if they exist. `Out-Null` suppresses output.

2. **`[IO.File]::WriteAllBytes()`**: Writes raw bytes from base64 decode. This is a
   .NET call — no encoding conversion, no BOM insertion, exact bytes.

3. **`Move-Item -Force`**: Moves temp to destination. On Windows, this is **NOT atomic**.
   `Move-Item` on NTFS is implemented as copy + delete, not as a rename, when the
   destination exists. There's a window where the file is missing or incomplete.

### Windows Atomicity Limitation

**Known limitation**: On NTFS, `Move-Item -Force` to an existing file is not atomic.
There's a brief window where the destination file doesn't exist. For Phase 1, this is
acceptable — the probability of reading during the exact move window is extremely low.

**Future improvement** (Phase 2): Use `[System.IO.File]::Replace(source, dest, backup)`
which is closer to atomic on NTFS, or PowerShell's `Rename-Item` if the destination
doesn't already exist.

## Docker Transport Considerations

Docker exec is one-shot: each `docker exec` invocation is a separate process. This means:

- PowerShell session variables (`$PSStyle`) don't persist between exec calls.
- Each write command must be self-contained.

For Docker + pwsh targets, the write command must include `$PSStyle.OutputRendering = 'PlainText'`
at the start if any output parsing is needed. For pure write operations (no output expected
except errors), this may be unnecessary.

For Docker + bash targets, the write command works as specified — each `docker exec` gets
its own `sh -c` invocation.

## Failure Modes

### Connection Drop During Write

```
State: base64 decoded to tmp, connection drops before mv
Result: Orphan temp file on remote
Recovery: None automatic — documented limitation
```

### Connection Drop During Move

```
State: mv started, connection drops
Result (POSIX): mv is atomic — either complete or not started
Result (Windows): Possible partial state — destination may be missing
Recovery: Re-run the write operation
```

### Disk Full

```
State: base64 decode fails writing to tmp
Result: Partial or zero-length tmp file
Recovery: Command returns non-zero exit code, write operation fails with clear error
         Orphan partial tmp file remains
```

## Orphan Temp File Cleanup

**Phase 1**: No automatic cleanup. Orphan temp files accumulate on connection drops.

They're identifiable by the `.pitramp.tmp` suffix. Users can clean them manually:

```bash
find /workspace -name '*.pitramp.tmp' -mmin +60 -delete
```

**Phase 2**: Consider sending a cleanup command on reconnect:
```bash
find <cwd> -name '*.pitramp.tmp' -mmin +60 -delete 2>/dev/null
```

## Complete Write Flow

```
1. writeFile(path, content) called
2. Resolve absolute path: target.cwd + path (if relative)
3. Check content size: content.length > 10MB → error
4. Encode content as base64
5. Generate UUID for temp file
6. tmpPath = path + "." + uuid + ".pitramp.tmp"
7. Build write command using ShellDriver (mkdir + decode + move)
8. Execute via transport.exec()
9. Check exit code: 0 = success, non-zero = throw RemoteOperationError
```

## Size Limits

| Item | Limit | Rationale |
|------|-------|-----------|
| File content | 10 MB | Design decision — fail fast |
| Base64 encoded | ~13.3 MB | 33% overhead |
| Shell command length | ~2 MB (Linux default) | ARG_MAX on most Linux systems |

If the base64 content exceeds shell command length limits, the chunked write
approach (see Bash Strategy) must be used. This should be detected by checking
the base64 length before building the command.

**Threshold for chunked writes**: base64 length > 1 MB → use chunked approach.
This gives comfortable headroom below typical ARG_MAX limits.
