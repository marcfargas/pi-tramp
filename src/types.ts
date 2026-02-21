/**
 * pi-tramp core types — Tier 0.
 *
 * These interfaces define the contracts between all components.
 * Every component depends on these; these depend on nothing.
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Shell & Platform types
// ---------------------------------------------------------------------------

export type ShellType = "bash" | "sh" | "pwsh" | "cmd" | "unknown";
export type PlatformType = "linux" | "darwin" | "windows" | "unknown";
export type TransportType = "ssh" | "docker" | "wsl" | "psremote";
export type TransportState = "connecting" | "connected" | "disconnected" | "error";

// ---------------------------------------------------------------------------
// Exec result
// ---------------------------------------------------------------------------

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

// ---------------------------------------------------------------------------
// Transport errors (internal, discriminated union)
// ---------------------------------------------------------------------------

export type TransportError =
  | { kind: "connection_lost"; cause: Error }
  | { kind: "command_failed"; code: number; stderr: string }
  | { kind: "timeout"; after_ms: number }
  | { kind: "not_connected" };

// ---------------------------------------------------------------------------
// RemoteOperationError (external, thrown at tool layer)
// ---------------------------------------------------------------------------

export type RemoteOperation = "read" | "write" | "edit" | "bash";

export class RemoteOperationError extends Error {
  public readonly target: string;
  public readonly operation: RemoteOperation;
  public readonly transportError?: TransportError;

  constructor(
    message: string,
    target: string,
    operation: RemoteOperation,
    transportError?: TransportError,
  ) {
    super(message);
    this.name = "RemoteOperationError";
    this.target = target;
    this.operation = operation;
    this.transportError = transportError;
  }
}

// ---------------------------------------------------------------------------
// Transport interface
// ---------------------------------------------------------------------------

export interface ExecOptions {
  /** Timeout in milliseconds. */
  timeout?: number;
  signal?: AbortSignal;
}

export interface Transport {
  // Identity
  readonly type: TransportType;
  readonly shell: ShellType;
  readonly platform: PlatformType;
  readonly arch: string;

  /** Remote home/initial working directory, detected on connect. */
  readonly homedir: string;

  // State
  readonly state: TransportState;

  // Core operations
  exec(command: string, options?: ExecOptions): Promise<ExecResult>;
  readFile(path: string): Promise<Buffer>;
  writeFile(path: string, content: Buffer): Promise<void>;

  // Lifecycle
  connect(): Promise<void>;
  close(): Promise<void>;
  healthCheck(): Promise<boolean>;

  // Events
  on(event: "disconnect", cb: (err: Error) => void): void;
  off(event: "disconnect", cb: (err: Error) => void): void;
}

// ---------------------------------------------------------------------------
// ShellDriver interface
// ---------------------------------------------------------------------------

export interface ShellDriver {
  readonly shell: ShellType;

  /** Escape an argument for safe use in a shell command. */
  shellEscape(arg: string): string;

  /** Command to read a file as base64. */
  readFileCommand(absolutePath: string): string;

  /**
   * Command to write base64 content to a file atomically
   * (temp file + move).
   */
  writeFileCommand(absolutePath: string, base64Content: string, tmpPath: string): string;

  /** Command to create a directory (with parents). */
  mkdirCommand(absolutePath: string): string;

  /** Command to check if a path exists and its type. */
  statCommand(absolutePath: string): string;
}

// ---------------------------------------------------------------------------
// Target config (Zod schemas)
// ---------------------------------------------------------------------------

export const ShellTypeSchema = z.enum(["bash", "pwsh", "sh", "cmd"]);

const SshTargetConfigSchema = z.object({
  type: z.literal("ssh"),
  host: z.string().min(1, "SSH host is required (user@hostname)"),
  port: z.number().int().min(1).max(65535).optional().default(22),
  identityFile: z.string().optional(),
  cwd: z.string().min(1).optional(), // Optional — auto-detected from remote homedir on connect
  shell: ShellTypeSchema.optional(),
  requireEntryConfirmation: z.boolean().optional().default(false),
  timeout: z.number().int().min(1000, "Timeout must be at least 1000ms").optional().default(60000),
});

const DockerTargetConfigSchema = z.object({
  type: z.literal("docker"),
  container: z.string().min(1, "Docker container name is required"),
  cwd: z.string().min(1).optional(), // Optional — auto-detected from remote homedir on connect
  shell: ShellTypeSchema.optional(),
  requireEntryConfirmation: z.boolean().optional().default(false),
  timeout: z.number().int().min(1000).optional().default(30000),
});

const WslTargetConfigSchema = z.object({
  type: z.literal("wsl"),
  distro: z.string().min(1, "WSL distro name is required"),
  cwd: z.string().min(1).optional(), // Optional — auto-detected from remote homedir on connect
  shell: ShellTypeSchema.optional(),
  requireEntryConfirmation: z.boolean().optional().default(false),
  timeout: z.number().int().min(1000).optional().default(30000),
});

const PsRemoteTargetConfigSchema = z.object({
  type: z.literal("psremote"),
  computerName: z.string().min(1, "Computer name is required"),
  credential: z.string().optional(),
  authentication: z.enum(["Default", "Kerberos", "Negotiate", "Basic"]).optional(),
  cwd: z.string().min(1).optional(), // Optional — auto-detected from remote homedir on connect
  shell: ShellTypeSchema.optional(),
  requireEntryConfirmation: z.boolean().optional().default(false),
  timeout: z.number().int().min(1000).optional().default(60000),
});

export const TargetConfigSchema = z.discriminatedUnion("type", [
  SshTargetConfigSchema,
  DockerTargetConfigSchema,
  WslTargetConfigSchema,
  PsRemoteTargetConfigSchema,
]);

export type TargetConfig = z.infer<typeof TargetConfigSchema>;
export type SshTargetConfig = z.infer<typeof SshTargetConfigSchema>;
export type DockerTargetConfig = z.infer<typeof DockerTargetConfigSchema>;

const TargetNameRegex = /^[a-zA-Z0-9_-]+$/;

export const TargetsFileSchema = z.object({
  default: z.string().optional(),
  targets: z.record(
    z.string().min(1).regex(TargetNameRegex, "Target name must be alphanumeric with dashes/underscores"),
    TargetConfigSchema,
  ),
}).refine(
  (data) => {
    // Validate that default target exists in targets
    if (data.default && data.default !== "local" && !(data.default in data.targets)) {
      return false;
    }
    return true;
  },
  { message: "Default target must exist in targets (or be 'local')" },
).refine(
  (data) => {
    // 'local' is reserved
    return !("local" in data.targets);
  },
  { message: "'local' is a reserved target name and cannot be used" },
);

export type TargetsFile = z.infer<typeof TargetsFileSchema>;

// ---------------------------------------------------------------------------
// Target (runtime representation)
// ---------------------------------------------------------------------------

export interface Target {
  name: string;
  config: TargetConfig;
  isDynamic: boolean;
}

// ---------------------------------------------------------------------------
// ConnectionPool interface
// ---------------------------------------------------------------------------

export interface ConnectionPool {
  getConnection(targetName: string): Promise<Transport>;

  execOnTarget<T>(
    targetName: string,
    fn: (transport: Transport) => Promise<T>,
  ): Promise<T>;

  closeConnection(targetName: string): Promise<void>;
  closeAll(): Promise<void>;
}
