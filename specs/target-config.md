# TargetConfig Zod Schema

> Spec for configuration validation and merge algorithm.
> Blocks: TargetManager implementation.

## Config File Locations

| Location | Scope | Priority |
|----------|-------|----------|
| `~/.pi/targets.json` | Global | Lower |
| `.pi/targets.json` | Project | Higher (overrides global by name) |

Both files are optional. If neither exists, pi-tramp starts with no targets
(local-only mode, no tool overrides active).

## Zod Schema

```typescript
import { z } from "zod";

// --- Shell and Transport types ---

const ShellTypeSchema = z.enum(["bash", "pwsh", "sh", "cmd"]);
const TransportTypeSchema = z.enum(["ssh", "docker", "wsl", "psremote"]);

// --- SSH-specific config ---

const SshTargetConfigSchema = z.object({
  type: z.literal("ssh"),
  host: z.string().min(1, "SSH host is required (user@hostname)"),
  port: z.number().int().min(1).max(65535).optional().default(22),
  identityFile: z.string().optional(),
  cwd: z.string().min(1, "Working directory (cwd) is required"),
  shell: ShellTypeSchema.optional(),
  requireEntryConfirmation: z.boolean().optional().default(false),
  timeout: z.number().int().min(1000, "Timeout must be at least 1000ms").optional().default(60000),
});

// --- Docker-specific config ---

const DockerTargetConfigSchema = z.object({
  type: z.literal("docker"),
  container: z.string().min(1, "Docker container name is required"),
  cwd: z.string().min(1, "Working directory (cwd) is required"),
  shell: ShellTypeSchema.optional(),
  requireEntryConfirmation: z.boolean().optional().default(false),
  timeout: z.number().int().min(1000).optional().default(30000),
});

// --- WSL-specific config (Phase 2) ---

const WslTargetConfigSchema = z.object({
  type: z.literal("wsl"),
  distro: z.string().min(1, "WSL distro name is required"),
  cwd: z.string().min(1, "Working directory (cwd) is required"),
  shell: ShellTypeSchema.optional(),
  requireEntryConfirmation: z.boolean().optional().default(false),
  timeout: z.number().int().min(1000).optional().default(30000),
});

// --- PSRemote-specific config (Phase 2) ---

const PsRemoteTargetConfigSchema = z.object({
  type: z.literal("psremote"),
  computerName: z.string().min(1, "Computer name is required"),
  credential: z.string().optional(),
  authentication: z.enum(["Default", "Kerberos", "Negotiate", "Basic"]).optional(),
  cwd: z.string().min(1, "Working directory (cwd) is required"),
  shell: ShellTypeSchema.optional(),
  requireEntryConfirmation: z.boolean().optional().default(false),
  timeout: z.number().int().min(1000).optional().default(60000),
});

// --- Discriminated union ---

const TargetConfigSchema = z.discriminatedUnion("type", [
  SshTargetConfigSchema,
  DockerTargetConfigSchema,
  WslTargetConfigSchema,
  PsRemoteTargetConfigSchema,
]);

// --- Root config ---

const TargetsFileSchema = z.object({
  default: z.string().optional(),
  targets: z.record(
    z.string().min(1).regex(/^[a-zA-Z0-9_-]+$/, "Target name must be alphanumeric with dashes/underscores"),
    TargetConfigSchema
  ),
});

// --- Exports ---

export type TargetConfig = z.infer<typeof TargetConfigSchema>;
export type SshTargetConfig = z.infer<typeof SshTargetConfigSchema>;
export type DockerTargetConfig = z.infer<typeof DockerTargetConfigSchema>;
export type TargetsFile = z.infer<typeof TargetsFileSchema>;

export { TargetConfigSchema, TargetsFileSchema };
```

## Validation Error Format

Zod provides detailed error paths. Format them for user consumption:

```typescript
function formatValidationError(filePath: string, error: z.ZodError): string {
  const issues = error.issues.map(issue => {
    const path = issue.path.join(".");
    return `  - ${path}: ${issue.message}`;
  });

  return [
    `Invalid targets config in ${filePath}:`,
    ...issues,
  ].join("\n");
}
```

Example output:
```
Invalid targets config in C:\Users\marc\.pi\targets.json:
  - targets.dev.host: SSH host is required (user@hostname)
  - targets.staging.timeout: Timeout must be at least 1000ms
```

## Merge Algorithm

```typescript
function mergeConfigs(global: TargetsFile | null, project: TargetsFile | null): TargetsFile {
  if (!global && !project) return { targets: {} };
  if (!global) return project!;
  if (!project) return global;

  return {
    // Project default wins
    default: project.default ?? global.default,

    // Project targets override global targets by name
    targets: {
      ...global.targets,
      ...project.targets,
    },
  };
}
```

### Merge Rules

1. **Target name collision**: Project target completely replaces global target with same name.
   No deep merge of individual fields.
2. **`default` field**: Project wins if set. Otherwise falls back to global.
3. **No target from global if project defines same name**: The project version is authoritative.
4. **Targets unique to each file**: Both appear in the merged result.

### Merge Example

**Global** (`~/.pi/targets.json`):
```json
{
  "default": "dev",
  "targets": {
    "dev": { "type": "ssh", "host": "marc@dev.server", "cwd": "/home/marc" },
    "staging": { "type": "ssh", "host": "deploy@staging", "cwd": "/app" }
  }
}
```

**Project** (`.pi/targets.json`):
```json
{
  "default": "project-dev",
  "targets": {
    "dev": { "type": "docker", "container": "myapp-dev", "cwd": "/workspace" },
    "project-dev": { "type": "docker", "container": "myapp-local", "cwd": "/workspace" }
  }
}
```

**Merged result**:
```json
{
  "default": "project-dev",
  "targets": {
    "dev": { "type": "docker", "container": "myapp-dev", "cwd": "/workspace" },
    "staging": { "type": "ssh", "host": "deploy@staging", "cwd": "/app" },
    "project-dev": { "type": "docker", "container": "myapp-local", "cwd": "/workspace" }
  }
}
```

Note: `dev` from project (Docker) completely replaced `dev` from global (SSH).

## Example Config Files

### SSH Target

```json
{
  "default": "dev",
  "targets": {
    "dev": {
      "type": "ssh",
      "host": "marc@dev.example.com",
      "port": 22,
      "identityFile": "~/.ssh/id_ed25519",
      "cwd": "/home/marc/project",
      "timeout": 60000
    }
  }
}
```

### Docker Target

```json
{
  "targets": {
    "odoo-dev": {
      "type": "docker",
      "container": "odoo-toolbox-dev",
      "cwd": "/workspace",
      "timeout": 30000
    }
  }
}
```

### Production with Confirmation Gate

```json
{
  "targets": {
    "production": {
      "type": "ssh",
      "host": "deploy@prod.example.com",
      "cwd": "/app",
      "requireEntryConfirmation": true,
      "timeout": 120000
    }
  }
}
```

### Mixed Config

```json
{
  "default": "dev",
  "targets": {
    "dev": {
      "type": "ssh",
      "host": "marc@dev.server",
      "cwd": "/home/marc/project"
    },
    "odoo": {
      "type": "docker",
      "container": "odoo-dev",
      "cwd": "/workspace"
    },
    "win-server": {
      "type": "ssh",
      "host": "admin@win.internal",
      "cwd": "C:\\Projects\\app",
      "shell": "pwsh"
    },
    "production": {
      "type": "ssh",
      "host": "deploy@prod.example.com",
      "cwd": "/app",
      "requireEntryConfirmation": true
    }
  }
}
```

## Dynamic Targets

Dynamic targets created at runtime via the `target` tool follow the same schema
but are not loaded from disk. They have `isDynamic: true` in the Target object.

To persist a dynamic target:

```typescript
target({ action: "create", name: "new-vm", type: "ssh",
         host: "ubuntu@52.123.45.67", cwd: "/home/ubuntu",
         persist: true })
```

When `persist: true`, the target is written to `.pi/targets.json` (project config).
If the project has no `.pi/targets.json`, one is created.

## Reserved Names

- `local` — reserved for the implicit local target. Cannot be used as a target name.
  If a config file defines a target named `local`, validation fails with:
  `"'local' is a reserved target name and cannot be used."`
