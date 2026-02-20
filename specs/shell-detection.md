# Shell Detection Commands

> Spec for detecting the target shell during Transport.connect().
> Blocks: DockerTransport.connect(), SshTransport.connect().

## Overview

When connecting to a target, we need to identify what shell we've landed in. This determines
which ShellDriver to instantiate and how to generate commands. Detection happens **once**
during `connect()`, before any operations.

## Detection Algorithm

### Step 1: PowerShell Probe

Send first, because PowerShell can be detected unambiguously:

```
echo $PSVersionTable.PSVersion.Major 2>$null || echo __NOT_PWSH__
```

**Parsing**:
- Output is a number (e.g., `7`, `5`) → **Shell is pwsh**. Version is the number.
- Output is `__NOT_PWSH__` → Not PowerShell, continue to Step 2.
- Output contains error text or is empty → Not PowerShell, continue to Step 2.

**Why this works**: `$PSVersionTable` is a built-in PowerShell automatic variable.
In bash/sh, `$PSVersionTable` is empty (unset variable), so `echo $PSVersionTable.PSVersion.Major`
emits `.PSVersion.Major` and the whole expression evaluates differently. The `2>$null`
suppresses errors in pwsh; in bash, `$null` is empty so `2>` redirects to an empty
filename (which errors, but we catch that).

**Simpler alternative probe**:
```
$PSVersionTable.PSVersion.Major
```
- In pwsh: outputs `7` (or the major version number)
- In bash/sh: outputs error or empty — parse as "not pwsh"

Use the simpler form. If the output is a single integer, it's pwsh. Otherwise, not pwsh.

### Step 2: POSIX Shell Identification

If Step 1 indicates not-pwsh, detect which POSIX shell:

```bash
echo "$0"
```

**Parsing**:

| Output | Detected Shell | Notes |
|--------|---------------|-------|
| `bash` | bash | Standard |
| `-bash` | bash | Login shell (leading dash) |
| `/bin/bash` | bash | Full path |
| `/usr/bin/bash` | bash | Full path |
| `sh` | sh | Could be dash, busybox sh, etc. |
| `-sh` | sh | Login shell |
| `/bin/sh` | sh | Full path |
| `zsh` | bash (treat as) | zsh is POSIX-compatible enough for our commands |
| `-zsh` | bash (treat as) | Login zsh |
| `/bin/zsh` | bash (treat as) | Full path |
| `dash` | sh | Explicit dash |
| `/bin/dash` | sh | Full path |
| `ash` | sh | BusyBox/Alpine shell |
| `/bin/ash` | sh | Full path |
| Anything else | sh (fallback) | Log warning: "Unknown shell: {output}, treating as sh" |

**Key distinction: bash vs sh**

- **bash**: Supports `$'...'` ANSI-C quoting (though we don't use it — see shell-escaping.md).
  More features. Our BashDriver targets bash.
- **sh**: Strict POSIX. May be dash (Debian/Ubuntu), busybox sh (Alpine), or actual sh.
  Our BashDriver's escaping strategy (single-quote with `'"'"'`) works on both.

**For Phase 1**: We use the same BashDriver for both `bash` and `sh`, since our escaping
strategy is POSIX-compatible. The `shell` field on Transport is set to `"bash"` for bash/zsh
and `"sh"` for sh/dash/ash/unknown. This distinction matters for:
- System prompt: tell the agent which shell the target has
- Future: if we ever need bash-specific features

### Step 3: Platform Detection

After shell is known, detect platform:

**For bash/sh targets:**
```bash
uname -s
```

| Output | Platform |
|--------|----------|
| `Linux` | linux |
| `Darwin` | darwin |
| `MINGW*`, `MSYS*`, `CYGWIN*` | windows |
| Anything else | unknown (log warning) |

**For pwsh targets:**
```powershell
if ($IsLinux) { 'linux' } elseif ($IsMacOS) { 'darwin' } else { 'windows' }
```

### Step 4: Architecture Detection

**For bash/sh targets:**
```bash
uname -m
```

| Output | Arch |
|--------|------|
| `x86_64` | x86_64 |
| `aarch64` | aarch64 |
| `arm64` | aarch64 |
| `armv7l` | armv7l |
| Anything else | stored as-is |

**For pwsh targets:**
```powershell
[System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture
```

| Output | Arch |
|--------|------|
| `X64` | x86_64 |
| `Arm64` | aarch64 |
| `X86` | x86 |
| `Arm` | arm |

## Config Override

If the target config specifies `"shell": "bash"` or `"shell": "pwsh"`, **skip detection
entirely**. Use the configured shell. Still run platform and architecture detection.

```jsonc
{
  "targets": {
    "my-target": {
      "type": "ssh",
      "host": "user@host",
      "shell": "bash",  // ← Skip shell detection, use BashDriver directly
      "cwd": "/workspace"
    }
  }
}
```

## PowerShell Session Setup

If the detected (or configured) shell is pwsh, immediately after detection send:

```powershell
$PSStyle.OutputRendering = 'PlainText'
```

This suppresses ANSI color codes that would corrupt sentinel parsing. This command
is fire-and-forget during `connect()` setup — it doesn't need sentinel wrapping.

For pwsh via SSH, also consider:

```powershell
$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'
```

These prevent:
- `ErrorActionPreference = 'Stop'` from killing the session on non-fatal errors
- Progress bars from emitting escape codes to stdout

## Timing

Detection happens in `Transport.connect()`:

```
1. Open connection (SSH process, docker exec)
2. Probe for pwsh (Step 1)
3. If not pwsh, probe for shell name (Step 2)
4. Detect platform (Step 3)
5. Detect architecture (Step 4)
6. If pwsh, run session setup commands
7. Create appropriate ShellDriver (BashDriver or PwshDriver)
8. Connection is now ready for operations
```

**For Docker transport**: Each probe is a separate `docker exec` call (stateless).
The setup commands (pwsh color suppression) must be sent at the start of every
command session, or handled differently. Since Docker exec is one-shot, the
`$PSStyle` setting must be prefixed to every command. See atomic-write.md for
how Docker handles multi-statement commands.

**For SSH transport**: Probes go through the persistent connection. Setup commands
are sent once and persist for the session lifetime.

## Fallback

If all probes fail (e.g., restricted shell, unexpected output):

1. Set shell to `"sh"` (most conservative)
2. Set platform to `"unknown"`
3. Set arch to `"unknown"`
4. Log warning: `"Shell detection failed on target '{name}'. Falling back to sh. Consider setting 'shell' in target config."`
5. Proceed — most POSIX commands still work on restricted shells

## Docker Transport: Shell for Probes

Docker exec needs a shell to run probe commands. The initial probe uses `sh` since
it's available on virtually all containers:

```
docker exec -i <container> sh -c 'echo "$0"'
```

If the target's actual shell is bash or pwsh, this probe will report `sh` (since we
launched `sh`). To detect the **default** shell:

```
docker exec -i <container> sh -c 'getent passwd $(whoami) | cut -d: -f7'
```

This returns the user's login shell (e.g., `/bin/bash`, `/usr/bin/pwsh`).
If `getent` isn't available (Alpine), fall back to:

```
docker exec -i <container> sh -c 'cat /etc/passwd | grep "^$(whoami):" | cut -d: -f7'
```

If both fail, default to `sh`.
