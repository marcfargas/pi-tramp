# pi-tramp — Transparent Remote Execution for Pi

> **Status**: Design — not yet implemented
> **Date**: 2026-02-20
> **Tracking**: TODO to be created after design review

## Problem

Pi runs where the work happens. On Windows, this means fighting native module builds,
path separators, and tool assumptions. pi-devcontainers tried to fix this by running
pi **inside** containers — bind-mounting `~/.pi`, extensions, skills, and settings.
This is fundamentally fragile: 11 documented deviations, can't cross network boundaries,
and breaks regularly.

The correct model: **pi (brain) stays local; tools execute remotely.** Like Emacs TRAMP —
the user IS aware of the network boundary, but operations are transparent.

## Analogy

| Emacs TRAMP | Pi TRAMP |
|-------------|----------|
| `/ssh:host:/path` path prefix | `target({ action: "switch", name: "dev" })` |
| `find-file` works transparently | `read` works transparently |
| `shell-command` runs remotely | `bash` runs remotely |
| Mode line shows `@host` | Status bar shows current target |
| TRAMP methods (ssh, docker, sudo) | Transport backends (ssh, docker, wsl, psremote) |
| User aware of boundary | LLM aware of boundary (system prompt) |

## Core Concepts

### Target

A named execution environment. Defined in config or created dynamically at runtime.

```jsonc
// ~/.pi/targets.json (global) and/or .pi/targets.json (project, takes precedence)
{
  "targets": {
    "dev": {
      "type": "ssh", // shell: bash
      "host": "marc@dev.server",
      "cwd": "/home/marc/project",
      "shell": "bash"
    },
    "odoo-container": {
      "type": "docker",
      "container": "odoo-toolbox-dev",
      "cwd": "/workspace"
    },
    "win-server": {
      "type": "ssh", // shell: pwsh
      "host": "admin@win.internal",
      "cwd": "C:\\Projects\\app",
      "shell": "pwsh"
    },
    "production": {
      "type": "ssh", // shell: bash
      "host": "deploy@prod.example.com",
      "shell": "bash",
      "requireEntryConfirmation": true
    }
  },
  "default": "local"
}
```

Minimal SSH config: `type` + connection details + `shell` (plus optional `cwd`).
Docker/WSL/PSRemote may still resolve shell defaults at connect time.

### What Gets Discovered on Connection

On first connect to a target, pi-tramp resolves runtime metadata:

- **Platform**: `uname -s` (Linux, Darwin) or platform-specific equivalent
- **Architecture**: `uname -m` or equivalent
- **Available tools**: selective checks (`git --version`, `node --version`, etc.) — optional

For SSH targets, shell is explicit in config and required (`"bash"` or `"pwsh"`).
No shell probe/reconnect flow is used.

### Transport Backends

| Transport | How | Notes |
|-----------|-----|-------|
| `local` | Direct execution | Default, no transport needed |
| `ssh` | Persistent SSH connection | Works on any OS with SSH client |
| `docker` | `docker exec -i <container>` | Container must be running |
| `wsl` | `wsl -d <distro>` | Windows only |
| `psremote` | PowerShell Remoting (WinRM) | `Invoke-Command -Session` |

The transport handles getting commands and data to/from the target. The shell
on the other side can be anything — bash, pwsh, zsh, fish, cmd. The transport
doesn't care.

Note: PSSession/WinRM works on Linux too if configured — the transport matrix
is not OS-dependent.

### Shell Handling

**Critical principle: we do NOT change tool behavior based on the target shell.**

The `bash` tool stays the `bash` tool. It sends commands. If the target's shell
is pwsh, the commands are sent to pwsh. The tool itself doesn't morph.

What changes is the **prompt injection**: when a target's shell is pwsh, the
system prompt tells the agent:
- "This target's shell is PowerShell (pwsh). Use PowerShell syntax."
- If pi-powershell is loaded, load its skill for PowerShell idioms
- The agent adapts its commands, not the tool

The user chooses the SSH shell explicitly in config (`"shell": "bash"` for Linux/macOS,
`"shell": "pwsh"` for Windows/PowerShell hosts). pi-tramp does not attempt shell
probing or fallback for SSH sessions.

## Architecture

```
┌──────────────────────────────────────────────────────┐
│                     Pi (local)                        │
│  LLM ← → Extensions, Skills, TUI, Config             │
│                       │                               │
│               ┌───────┴────────┐                      │
│               │   pi-tramp     │                      │
│               │   extension    │                      │
│               └───┬────┬───┬──┘                       │
│                   │    │   │                           │
│         ┌─────────┤    │   ├─────────────┐            │
│   ┌─────┴────┐ ┌──┴────┴──┐ ┌───────────┴──┐         │
│   │ local    │ │ ssh      │ │ docker exec  │  ...     │
│   │ (direct) │ │ (persis- │ │              │          │
│   │          │ │  tent)   │ │              │          │
│   └──────────┘ └──────────┘ └──────────────┘          │
│                                                       │
│   Tool overrides: read, write, edit, bash             │
│   → route to current target's Operations              │
│                                                       │
│   target tool: create/switch/list/remove/status       │
│   forward tool: manage port forwards                  │
└──────────────────────────────────────────────────────┘
```

### Tool Override Strategy

pi-tramp registers overrides for `read`, `write`, `edit`, and `bash` using
pi's Operations interfaces (`ReadOperations`, `WriteOperations`, `EditOperations`,
`BashOperations`).

**pi-tramp must be the ONLY extension overriding these tools.** Pi's `registerTool`
has a last-writer-wins semantic (see TODO-f1379fc7 for the associated rendering bug).

Each tool's `execute` function checks the current target and dispatches:

```typescript
pi.registerTool({
  ...localRead,  // keep schema, description, rendering from built-in
  async execute(id, params, signal, onUpdate, ctx) {
    const target = getCurrentTarget();
    if (target.type === "local") {
      return localRead.execute(id, params, signal, onUpdate);
    }
    const ops = target.getReadOperations();
    const tool = createReadTool(target.cwd, { operations: ops });
    return tool.execute(id, params, signal, onUpdate);
  }
});
```

### Extension Tool Routing (pi.exec)

Most extension tools call `pi.exec(command, args)` which is hardwired to local
`spawn()`. To route extension tool execution to targets, we provide:

**Phase 1**: `trampExec()` — a function exported by pi-tramp that extension
authors can use instead of `pi.exec`. Convention-based, no upstream changes.

**Phase 2**: Propose `exec` event hook upstream (see TODO-89b9ec88).

### The `target` Tool

A tool the LLM can call for target CRUD and switching:

```typescript
target({ action: "list" })
// Returns all configured and dynamic targets with connection status

target({ action: "switch", name: "dev" })
// Switches. If requireEntryConfirmation=true, triggers ctx.ui.confirm() first

target({ action: "create", name: "new-vm", type: "ssh",
         host: "ubuntu@52.123.45.67", cwd: "/home/ubuntu" })
// Dynamic target — lives for the session, not persisted to config

target({ action: "remove", name: "new-vm" })
// Remove a dynamic target

target({ action: "status", name: "dev" })
// Connection health, platform info, uptime
```

The `/target` command (user-initiated) could bypass `requireEntryConfirmation`
since the user is explicitly asking.

Dynamic targets are runtime-only unless the user asks to persist them.

### Port Forwarding

Agents need to forward ports — preview a web app, access a database, test an API.

```typescript
forward({ action: "create", localPort: 8080, remotePort: 80, target: "dev" })
forward({ action: "list" })
forward({ action: "remove", localPort: 8080 })
```

Implementation per transport:
- **SSH**: managed via the persistent connection (send port forward command)
- **Docker**: `docker exec` + `socat`, or use Docker's port mapping if available
- **WSL**: localhost is shared, often no forwarding needed
- **PSSession**: `New-NetFirewallRule` + SSH tunnel or netsh

### Context Injection on Target Switch

When switching targets, the agent needs target-specific context (AGENTS.md,
project conventions, environment details). This is injected via `sendMessage`
with a namespaced custom type:

```typescript
pi.sendMessage({
  customType: "pi_tramp-target_context",
  content: [{
    type: "text",
    text: [
      "==== system injected information relevant for work on current target environment — don't talk about it ===",
      targetSpecificMarkdown,
      "==== end of system injected information on target environment — don't talk about it ==="
    ].join("\n")
  }],
  display: "none"
}, { triggerTurn: false });
```

The `context` event handler removes previous target context messages, keeping
only the latest:

```typescript
pi.on("context", (event) => {
  // Keep only the most recent pi_tramp-target_context
  let foundLatest = false;
  const filtered = event.messages.filter(m => {
    if (m.type === "custom" && m.customType === "pi_tramp-target_context") {
      if (foundLatest) return false;  // remove older ones
      foundLatest = true;
      return true;
    }
    return true;
  });
  return { messages: filtered };
});
```

### System Prompt Injection

On every `before_agent_start`, pi-tramp injects current target info:

```typescript
pi.on("before_agent_start", (event) => {
  const target = getCurrentTarget();
  const info = buildTargetPromptBlock(target, allTargets);
  // Inject or replace the target block in the system prompt
  return { systemPrompt: event.systemPrompt + "\n\n" + info };
});
```

The target block includes:
- Current target name, platform, arch, shell
- Available targets (just names + types)
- What `target()` and `forward()` tools do
- Shell-specific guidance (e.g., "use pwsh syntax" if shell is pwsh)

**Open question**: the system prompt is rebuilt every turn, but does the full
history (with old system prompts) stay in context? This needs design review
to understand context budget impact.

## SSH Transport — Phase 1 Design

### No ControlMaster on Windows

`ControlMaster` (SSH multiplexing) is Unix-only. Since the primary host is
Windows + Git Bash, we can't use it in Phase 1.

**Phase 1**: Persistent SSH connections. One SSH process per target, kept alive
for the session duration. Commands are piped through stdin/stdout.

**Phase 2**: ControlMaster where available (macOS/Linux hosts). Enables
`ssh -O forward -L 8080:localhost:80` for port forwarding and
`ssh -O cancel` for teardown. On Windows, fall back to persistent connections.

A `ssh-via-wsl` option could be explored but adds dependencies (WSL required,
SSH agent configuration on the Windows-WSL boundary) — not Phase 1.

### Connection Model

```typescript
interface SshConnection {
  process: ChildProcess;      // persistent ssh process
  host: string;
  shell: string;              // required in config
  platform: string;           // resolved on connect
  arch: string;               // resolved on connect

  exec(command: string): Promise<{ stdout: string; stderr: string; code: number }>;
  readFile(path: string): Promise<Buffer>;
  writeFile(path: string, content: Buffer): Promise<void>;
}
```

File operations use the configured shell:
- bash: `cat`, `base64`, `mkdir -p`
- pwsh: `Get-Content`, `Set-Content`, `New-Item`

### Connection Lifecycle

1. `target switch "dev"` → open SSH connection
2. Use configured shell and resolve platform/arch/homedir
3. Keep alive with periodic no-op commands
4. On connection drop → notify agent, attempt reconnect
5. On `target switch` away → keep connection alive (don't close, might switch back)
6. On session shutdown → close all connections

## What Happens to pi-devcontainers

**pidc is killed.** Projects that need containers (like odoo-toolbox) already have
their own scripts for bringing up/down containers. What's needed is:

- **Skills** for container orchestrators (devcontainers, docker, vagrant, devpod) —
  teach the agent how to use their CLIs
- The agent uses bash to run container commands
- When a container is up, the agent creates a dynamic target:
  ```
  target({ action: "create", name: "odoo-dev", type: "docker",
           container: "odoo-toolbox-dev", cwd: "/workspace" })
  ```
- Then switches to it

The container doesn't need pi inside it. Just a shell.

## Configuration

### targets.json

Both `~/.pi/targets.json` (global) and `.pi/targets.json` (project) are supported.
Project config takes precedence on name collisions.

```jsonc
{
  "targets": {
    "<name>": {
      "type": "ssh" | "docker" | "wsl" | "psremote", // shell required when type="ssh"
      // Connection (type-specific):
      "host": "user@hostname",           // ssh
      "container": "container-name",     // docker
      "distro": "Ubuntu",               // wsl
      "computerName": "server.local",    // psremote
      "credential": "domain\\user",      // psremote
      "authentication": "Kerberos",      // psremote

      // Common:
      "cwd": "/path/to/workspace",
      "shell": "pwsh",                   // required for SSH targets; optional for other transports
      "requireEntryConfirmation": true,   // require user confirm before switch (optional)
    }
  },
  "default": "local"  // which target to activate on session start
}
```

Platform and arch are resolved on connection. For SSH, shell is configured
explicitly and required.

## Phasing

### Phase 1 — Single-Target SSH + Docker

- Persistent SSH connections (no ControlMaster)
- Docker exec backend
- `target` tool (CRUD + switch)
- System prompt augmentation with platform/shell info
- Context injection on target switch (pi_tramp-target_context)
- Status bar widget showing current target
- Explicit SSH shell configuration (`shell` required)
- `requireEntryConfirmation` safety gate
- `targets.json` config (global + project)
- Dynamic target creation by agent
- `trampExec()` export for extension authors

### Phase 2 — Port Forwarding + ControlMaster

- `forward` tool for port forwarding
- ControlMaster on macOS/Linux hosts (SSH multiplexing)
- Extra SSH/PSSession args in config for credential forwarding
- WSL transport backend
- PSSession transport backend

### Phase 3 — pidc Sunset + Polish

- Skills for container orchestrators (devcontainers, docker, vagrant, devpod)
- pidc deprecated — agent uses container skills + dynamic targets
- Design review of context injection / system prompt budget
- `trampExec()` adoption → propose pi.exec hook upstream if traction warrants

## Upstream Dependencies

| Item | Status | Tracking |
|------|--------|----------|
| registerTool multi-override bug | Known, not filed | TODO-f1379fc7 |
| pi.exec hook event | Deferred to Phase 3 | TODO-89b9ec88 |
| Operations interfaces (Read/Write/Edit/Bash) | ✅ Exported by pi | — |
| createReadTool/createWriteTool/etc. | ✅ Exported by pi | — |
| before_agent_start event | ✅ In pi | — |
| user_bash event | ✅ In pi | — |
| context event (message filtering) | ✅ In pi | — |
| registerTool (same name override) | ✅ Works (last wins) | — |
| sendMessage with customType | ✅ In pi | — |

## Open Questions

1. **System prompt context budget** — injecting target info every turn. How much
   does this cost? Need to measure after Phase 1.
2. **Context injection approach** — `sendMessage` + `context` filter vs pure system
   prompt injection. Design review will tell which is better.
3. **Shell-specific Operations** — how much divergence between bash-ops and pwsh-ops?
   Can we abstract enough to share code, or do we need separate implementations?
4. **Docker exec latency** — is spawning `docker exec` per operation fast enough,
   or do we need a persistent exec session?
5. **Binary file handling** — `read`/`write` for images over SSH. Base64 works but
   is 33% larger. Acceptable for Phase 1?

## References

- `ssh.ts` — pi example extension, proof of concept for SSH tool override
- `sandbox/` — pi example extension, same Operations pattern for sandboxing
- `tool-override.ts` — pi example for registerTool same-name override
- pi-devcontainers — what we're replacing (bind-mount approach)
- pi-server — complementary (detachable TUI), not competing
- mom — Docker sandbox reference (implicit boundary, different from our explicit approach)
- Emacs TRAMP — the inspiration (user-aware, transparent operations)
