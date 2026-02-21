# pi-tramp

**TRAMP-like transparent remote execution for [pi](https://github.com/mariozechner/pi-coding-agent).**

Pi stays local (brain). Tools (`read`, `write`, `edit`, `bash`) execute on remote targets via SSH or Docker.

## Quick Start

```bash
# Install
npm install @marcfargas/pi-tramp

# Add to pi
pi -e pi-tramp
```

Then use the `target` tool in a pi session:

```
> target add myserver --config {"type":"ssh","host":"user@myserver.example.com"}
> target switch myserver
# All tool calls now execute on myserver
```

## Configuration

### Interactive (target tool)

The fastest way — add targets on the fly:

```
> target add dev --config {"type":"ssh","host":"user@dev.example.com","cwd":"/home/user/project"}
> target switch dev
```

### File-based (targets.json)

Create `.pi/targets.json` in your project (or `~/.pi/targets.json` globally):

```json
{
  "default": "dev",
  "targets": {
    "dev": {
      "type": "ssh",
      "host": "user@dev-server.example.com",
      "cwd": "/home/user/project"
    },
    "staging": {
      "type": "ssh",
      "host": "deploy@staging.example.com",
      "identityFile": "~/.ssh/staging_key",
      "cwd": "/opt/app"
    },
    "docker-dev": {
      "type": "docker",
      "container": "my-dev-container",
      "cwd": "/workspace"
    }
  }
}
```

Project config overrides global by target name. The `default` target auto-connects on session start.

## Transport Types

### SSH

```json
{
  "type": "ssh",
  "host": "user@hostname",
  "port": 22,
  "identityFile": "~/.ssh/id_ed25519",
  "cwd": "/remote/working/directory",
  "shell": "pwsh",
  "timeout": 60000
}
```

- **Keys only** — no password auth (SSH agent or `identityFile`)
- **Persistent connection** — single SSH process, sentinel protocol for command demarcation
- **Shell auto-detection** — on connect, probes for pwsh then bash. Override with `"shell": "bash"` or `"shell": "pwsh"`
- **`cwd` is optional** — if omitted, auto-detected from remote home directory
- Uses Windows SSH (`C:\Windows\System32\OpenSSH\ssh.exe`) on Windows for agent access

#### pwsh targets (Windows servers, PowerShell hosts)

When connecting to a host with PowerShell as the default shell (common on Windows), pi-tramp:

1. Auto-detects pwsh via a marker-based probe during connect
2. Reconnects with a clean `-NoProfile -NonInteractive` session
3. Wraps all commands in pwsh-compatible syntax
4. Uses .NET APIs for file I/O (`[IO.File]::ReadAllBytes`, `[Convert]::ToBase64String`)

Set `"shell": "pwsh"` explicitly if auto-detection fails or to skip the probe.

### Docker

```json
{
  "type": "docker",
  "container": "container-name-or-id",
  "cwd": "/workspace",
  "shell": "bash",
  "timeout": 30000
}
```

- **One-shot** — each command is a separate `docker exec`
- **Shell detection** — probes for pwsh → login shell → echo $0 → falls back to sh
- **`cwd` is optional** — defaults to container's home directory

## Usage

Once a target is active, all tool calls automatically route there:

```
You: Read src/index.ts
→ reads /home/user/project/src/index.ts on dev-server

You: Run the tests
→ executes on dev-server via SSH

You: Edit src/config.ts, change the port to 8080
→ reads remote file, applies edit, writes back (CRLF-safe)
```

### Target Management

The `target` tool supports:

| Action | Description |
|--------|-------------|
| `target list` | Show available targets and which is active |
| `target switch <name>` | Switch to a target (or `"local"` for local) |
| `target status` | Show connection health for all targets |
| `target add <name> --config <json>` | Add a dynamic target (not persisted) |
| `target remove <name>` | Remove a dynamic target |

### Status Bar

When a target is active, the footer shows:
- 🔗 SSH targets with host, shell, and platform
- 🐳 Docker targets with container name and shell

### Context Injection

On target switch, pi-tramp:
1. Modifies the system prompt with target info (type, shell, platform, CWD)
2. Reads remote `.pi/AGENTS.md` (if present, max 100 lines) and injects it
3. Updates the status bar

## Config Reference

### Target Config Fields

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `type` | `"ssh"` \| `"docker"` | ✅ | — | Transport type |
| `host` | string | SSH only | — | `user@hostname` |
| `port` | number | — | `22` | SSH port |
| `identityFile` | string | — | — | Path to SSH private key |
| `container` | string | Docker only | — | Container name or ID |
| `cwd` | string | — | home dir | Remote working directory |
| `shell` | `"bash"` \| `"sh"` \| `"pwsh"` | — | auto-detect | Override shell detection |
| `timeout` | number (ms) | — | SSH: 60000, Docker: 30000 | Command timeout |

### Targets File

```json
{
  "default": "target-name",
  "targets": {
    "name": { /* target config */ }
  }
}
```

- `default` — auto-connect on session start (`"local"` or omit for no default)
- `"local"` is a reserved name — means "no remote target"
- Target names: alphanumeric, dashes, underscores

## Public API (`trampExec`)

Other pi extensions can execute commands on remote targets:

```typescript
import { trampExec } from "@marcfargas/pi-tramp";

// Execute on current target
const result = await trampExec("ls -la");
console.log(result.stdout);

// Execute on a specific target
const result = await trampExec("hostname", { target: "staging" });

// With timeout and abort
const controller = new AbortController();
const result = await trampExec("make build", {
  timeout: 120000,
  signal: controller.signal,
});
```

## Architecture

```
┌─────────────────────────────────────────────────┐
│ pi (local)                                       │
│                                                   │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐       │
│  │ read     │  │ write    │  │ edit     │  bash  │
│  │ override │  │ override │  │ override │  ...   │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘       │
│       │              │              │              │
│  ┌────▼──────────────▼──────────────▼────┐       │
│  │         operations-remote              │       │
│  │   (ReadOps, WriteOps, EditOps, Bash)   │       │
│  └────────────────┬──────────────────────┘       │
│                    │                               │
│  ┌────────────────▼──────────────────────┐       │
│  │          ConnectionPool                │       │
│  │    (lazy connect, cache, reconnect)    │       │
│  └────┬───────────────────────┬──────────┘       │
│       │                       │                   │
│  ┌────▼─────┐           ┌────▼─────┐            │
│  │ SSH      │           │ Docker   │            │
│  │Transport │           │Transport │            │
│  │(sentinel)│           │(one-shot)│            │
│  └──────────┘           └──────────┘            │
└─────────────────────────────────────────────────┘
```

**Key design decisions:**
- **Serial command queue** — prevents concurrent SSH session corruption
- **Sentinel protocol** — UUID markers delimit command output in persistent SSH
- **Shell auto-detection** — probes for pwsh, then bash, with reconnect for clean sessions
- **Base64 for file I/O** — reliable binary transfer (bash: `base64`, pwsh: .NET APIs)
- **CRLF handling** — pi's edit tool transparently normalizes line endings for matching, then restores original endings on write
- **10MB file limit** — clear errors for oversized files
- **POSIX single-quote escaping** — works across bash/sh/dash/zsh/ash

## Limitations

- **SSH keys only** — no password authentication
- **No port forwarding** — Phase 2
- **No WSL or PSRemote transports** — Phase 2
- **10MB max file size** — for read/write operations
- **BashDriver requires `base64`** — available in full Git for Windows and Linux coreutils, not in MinGit
- **PS 5.1 Unicode** — Windows PowerShell 5.1's console can't round-trip all Unicode via stdout (pwsh 7.2+ works fine)

## Development

```bash
# Install dependencies
npm install

# Unit tests (no Docker required)
npm test

# Integration tests — Linux containers (requires Docker)
docker build -t pi-tramp-ssh-test test/fixtures/ssh-server/
docker run -d --name pi-tramp-ssh-test -p 2222:22 pi-tramp-ssh-test
npm run test:integration

# Integration tests — Windows containers (CI only, requires windows-latest runner)
# Set PI_TRAMP_TARGET_OS=windows for Windows container tests

# Lint + type check
npm run lint
npm run typecheck
```

### CI Matrix

| Runner | Tests |
|--------|-------|
| ubuntu-latest × Node 20/22/24 | Unit tests |
| windows-latest × Node 20/22/24 | Unit tests |
| ubuntu-latest | Integration: Docker×bash, Docker×pwsh, SSH×bash, SSH×pwsh (Linux container) |
| windows-latest | Integration: Docker×bash, Docker×pwsh, SSH×bash, SSH×pwsh (Windows container) |

## License

MIT
