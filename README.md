# pi-tramp

**TRAMP-like transparent remote execution for [pi](https://github.com/mariozechner/pi-coding-agent).**

Pi stays local (brain). Tools (`read`, `write`, `edit`, `bash`) execute on remote targets via SSH or Docker.

## Quick Start

```bash
# Install
npm install pi-tramp

# Add to pi
pi -e pi-tramp
```

## Configuration

Create `.pi/targets.json` in your project (or `~/.pi/targets.json` globally):

```json
{
  "default": "dev",
  "targets": {
    "dev": {
      "type": "ssh",
      "host": "user@dev-server.example.com",
      "port": 22,
      "cwd": "/home/user/project"
    },
    "staging": {
      "type": "ssh",
      "host": "deploy@staging.example.com",
      "port": 22,
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

Project config (`.pi/targets.json`) overrides global (`~/.pi/targets.json`) by target name. The `default` target auto-connects on session start.

## Transport Types

### SSH

```json
{
  "type": "ssh",
  "host": "user@hostname",
  "port": 22,
  "identityFile": "~/.ssh/id_ed25519",
  "cwd": "/remote/working/directory",
  "shell": "bash",
  "timeout": 60000
}
```

- **Keys only** — no password auth (SSH agent or `identityFile`)
- **Persistent connection** — single SSH process, sentinel protocol for command demarcation
- **Shell**: defaults to bash. Set `"shell": "pwsh"` for PowerShell targets — commands are wrapped in `pwsh -NonInteractive -Command '...'`
- Uses Windows SSH (`C:\Windows\System32\OpenSSH\ssh.exe`) on Windows for agent access

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

## Usage

Once configured, all tool calls automatically route to the active target:

```
You: Read src/index.ts
→ pi-tramp reads from /home/user/project/src/index.ts on dev-server

You: Run the tests
→ pi-tramp executes on dev-server via SSH

You: Edit src/config.ts, change the port to 8080
→ pi-tramp reads remote file, applies edit, writes back
```

### Target Management

The agent has a `target` tool with these actions:

| Action | Description |
|--------|-------------|
| `target list` | Show available targets and which is active |
| `target switch <name>` | Switch to a target (or `"local"` for local execution) |
| `target status` | Show connection health for all targets |
| `target add <name> --config <json>` | Add a dynamic target (not persisted) |
| `target remove <name>` | Remove a dynamic target |

### Status Bar

When a target is active, the footer shows:
- 🔗 SSH targets
- 🐳 Docker targets

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
| `port` | number | SSH only | `22` | SSH port |
| `identityFile` | string | — | — | Path to SSH private key |
| `container` | string | Docker only | — | Container name or ID |
| `cwd` | string | ✅ | — | Remote working directory |
| `shell` | `"bash"` \| `"sh"` \| `"pwsh"` | — | auto-detect | Override shell detection |
| `requireEntryConfirmation` | boolean | — | `false` | Ask before switching (Phase 2) |
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
import { trampExec } from "pi-tramp";

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
- **POSIX single-quote escaping** — works across bash/sh/dash/zsh/ash
- **Base64 for file I/O** — reliable binary transfer without encoding issues
- **10MB file limit** — clear errors for oversized files
- **Shell auto-detection** — pwsh probe → login shell → fallback to sh

## Limitations

- **SSH keys only** — no password authentication
- **No Windows CRLF normalization** — edit's `oldText` must match exactly (including line endings)
- **No port forwarding** — Phase 2
- **No WSL or PSRemote transports** — Phase 2
- **10MB max file size** — for read/write operations
- **PS 5.1 Unicode** — Windows PowerShell's console can't round-trip all Unicode via stdout

## Development

```bash
# Install dependencies
npm install

# Unit tests (no Docker required)
npm test

# Integration tests (requires Docker)
docker build -t pi-tramp-ssh-test test/fixtures/ssh-server/
docker run -d --name pi-tramp-ssh-test -p 2222:22 pi-tramp-ssh-test
npm run test:integration

# Type check
npx tsc --noEmit
```

## License

MIT
