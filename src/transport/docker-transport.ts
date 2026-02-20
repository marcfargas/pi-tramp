/**
 * DockerTransport — Transport implementation for Docker containers.
 *
 * Each command is a separate `docker exec` invocation (one-shot).
 * No sentinel needed — docker exec handles process lifecycle.
 * Serial queue prevents concurrent exec interference.
 */

import { execFile } from "child_process";
import { promisify } from "util";
import { EventEmitter } from "events";
import { randomUUID } from "crypto";
import type {
  Transport,
  TransportState,
  ShellType,
  PlatformType,
  ExecResult,
  ExecOptions,
  DockerTargetConfig,
  ShellDriver,
} from "../types.js";
import { BashDriver } from "../shell/bash-driver.js";
import { PwshDriver } from "../shell/pwsh-driver.js";
import { CommandQueue } from "./command-queue.js";
import { parseShellName, parsePlatform, parseArch, parsePwshVersion } from "./shell-detect.js";

const execFileAsync = promisify(execFile);

export class DockerTransport extends EventEmitter implements Transport {
  readonly type = "docker" as const;

  private _shell: ShellType = "unknown";
  private _platform: PlatformType = "unknown";
  private _arch: string = "unknown";
  private _state: TransportState = "disconnected";
  private _driver: ShellDriver | null = null;
  private queue = new CommandQueue();

  private readonly container: string;
  private readonly configuredShell: ShellType | undefined;
  private readonly defaultTimeout: number;

  constructor(config: DockerTargetConfig) {
    super();
    this.container = config.container;
    this.configuredShell = config.shell as ShellType | undefined;
    this.defaultTimeout = config.timeout ?? 30000;
  }

  // --- Transport interface accessors ---

  get shell(): ShellType { return this._shell; }
  get platform(): PlatformType { return this._platform; }
  get arch(): string { return this._arch; }
  get state(): TransportState { return this._state; }
  get driver(): ShellDriver | null { return this._driver; }

  // --- Lifecycle ---

  async connect(): Promise<void> {
    this._state = "connecting";

    try {
      // Verify container is running
      const { stdout: status } = await execFileAsync("docker", [
        "inspect", "-f", "{{.State.Running}}", this.container,
      ]);
      if (status.trim() !== "true") {
        throw new Error(`Container '${this.container}' is not running`);
      }

      // Detect shell (or use configured)
      if (this.configuredShell && this.configuredShell !== "unknown") {
        this._shell = this.configuredShell;
      } else {
        await this.detectShell();
      }

      // Detect platform and arch
      await this.detectPlatformAndArch();

      // Create appropriate shell driver
      this._driver = this._shell === "pwsh"
        ? new PwshDriver()
        : new BashDriver(this._shell);

      this._state = "connected";
    } catch (err) {
      this._state = "error";
      throw err;
    }
  }

  async close(): Promise<void> {
    this._state = "disconnected";
    this.queue.drain(new Error("Transport closed"));
  }

  async healthCheck(): Promise<boolean> {
    try {
      const result = await this.rawExec("echo ok", 5000);
      return result.stdout.trim() === "ok" && result.exitCode === 0;
    } catch {
      return false;
    }
  }

  // --- Shell detection ---

  private async detectShell(): Promise<void> {
    // Probe 1: Check for PowerShell
    try {
      const pwshResult = await this.rawExec(
        '$PSVersionTable.PSVersion.Major',
        5000,
      );
      const version = parsePwshVersion(pwshResult.stdout);
      if (version !== null) {
        this._shell = "pwsh";
        return;
      }
    } catch {
      // Not pwsh — continue
    }

    // Probe 2: Get login shell from /etc/passwd
    try {
      const loginShellResult = await this.rawExec(
        'getent passwd $(whoami) 2>/dev/null | cut -d: -f7 || cat /etc/passwd | grep "^$(whoami):" | cut -d: -f7',
        5000,
      );
      const loginShell = loginShellResult.stdout.trim();
      if (loginShell) {
        const parsed = parseShellName(loginShell);
        if (parsed !== "unknown") {
          this._shell = parsed;
          return;
        }
      }
    } catch {
      // Continue with fallback
    }

    // Probe 3: Check what shell sh is
    try {
      const shResult = await this.rawExec('echo "$0"', 5000);
      const parsed = parseShellName(shResult.stdout);
      this._shell = parsed !== "unknown" ? parsed : "sh";
    } catch {
      this._shell = "sh"; // fallback
    }
  }

  private async detectPlatformAndArch(): Promise<void> {
    if (this._shell === "pwsh") {
      // PowerShell detection
      try {
        const platResult = await this.rawExec(
          "if ($IsLinux) { 'linux' } elseif ($IsMacOS) { 'darwin' } else { 'windows' }",
          5000,
        );
        this._platform = platResult.stdout.trim() as PlatformType;
      } catch {
        this._platform = "unknown";
      }
      try {
        const archResult = await this.rawExec(
          "[System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture",
          5000,
        );
        const archMap: Record<string, string> = { X64: "x86_64", Arm64: "aarch64", X86: "x86", Arm: "arm" };
        this._arch = archMap[archResult.stdout.trim()] ?? archResult.stdout.trim();
      } catch {
        this._arch = "unknown";
      }
    } else {
      // POSIX detection
      try {
        const platResult = await this.rawExec("uname -s", 5000);
        this._platform = parsePlatform(platResult.stdout);
      } catch {
        this._platform = "unknown";
      }
      try {
        const archResult = await this.rawExec("uname -m", 5000);
        this._arch = parseArch(archResult.stdout);
      } catch {
        this._arch = "unknown";
      }
    }
  }

  // --- Core operations ---

  async exec(command: string, options?: ExecOptions): Promise<ExecResult> {
    if (this._state !== "connected") {
      throw Object.assign(new Error("Not connected"), { kind: "not_connected" });
    }
    return this.queue.enqueue(() => this.rawExec(command, options?.timeout));
  }

  async readFile(path: string): Promise<Buffer> {
    if (!this._driver) throw new Error("Not connected — no shell driver");
    const cmd = this._driver.readFileCommand(path);
    const result = await this.exec(cmd);
    if (result.exitCode !== 0) {
      throw Object.assign(
        new Error(`readFile failed: ${result.stderr.trim() || "unknown error"}`),
        { kind: "command_failed", code: result.exitCode, stderr: result.stderr },
      );
    }
    return Buffer.from(result.stdout.trim(), "base64");
  }

  async writeFile(path: string, content: Buffer): Promise<void> {
    if (!this._driver) throw new Error("Not connected — no shell driver");
    const base64 = content.toString("base64");
    const tmpPath = `${path}.${randomUUID()}.pitramp.tmp`;
    const cmd = this._driver.writeFileCommand(path, base64, tmpPath);
    const result = await this.exec(cmd);
    if (result.exitCode !== 0) {
      throw Object.assign(
        new Error(`writeFile failed: ${result.stderr.trim() || "unknown error"}`),
        { kind: "command_failed", code: result.exitCode, stderr: result.stderr },
      );
    }
  }

  // --- Events ---

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  override on(event: string, cb: (...args: any[]) => void): this {
    return super.on(event, cb);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  override off(event: string, cb: (...args: any[]) => void): this {
    return super.off(event, cb);
  }

  // --- Internal ---

  /**
   * Raw docker exec — one-shot, no queue.
   * Used internally for detection probes and queued commands.
   */
  private rawExec(command: string, timeout?: number): Promise<ExecResult> {
    return new Promise((resolve, reject) => {
      // Determine the shell to invoke within the container
      const shellBin = this._shell === "pwsh" ? "pwsh" : "sh";
      const shellArgs = this._shell === "pwsh"
        ? ["-NoProfile", "-NonInteractive", "-Command", command]
        : ["-c", command];

      const args = ["exec", "-i", this.container, shellBin, ...shellArgs];

      const proc = execFile("docker", args, {
        timeout: timeout ?? this.defaultTimeout,
        maxBuffer: 20 * 1024 * 1024, // 20MB (base64 of 10MB + headroom)
        encoding: "buffer",
      }, (error, stdout, stderr) => {
        if (error && (error as NodeJS.ErrnoException).code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
          reject(Object.assign(
            new Error("Output exceeded 20MB buffer limit"),
            { kind: "command_failed", code: 1, stderr: "maxBuffer exceeded" },
          ));
          return;
        }

        // Timeout manifests as SIGTERM/error with killed flag
        if (error && "killed" in error && (error as { killed?: boolean }).killed) {
          reject(Object.assign(
            new Error(`Command timed out after ${timeout ?? this.defaultTimeout}ms`),
            { kind: "timeout", after_ms: timeout ?? this.defaultTimeout },
          ));
          return;
        }

        // execFile reports non-zero exit code as an error, but we want
        // to return it as a normal result
        const exitCode = error && "code" in error && typeof error.code === "number"
          ? error.code
          : 0;

        resolve({
          stdout: (stdout as unknown as Buffer).toString("utf8"),
          stderr: (stderr as unknown as Buffer).toString("utf8"),
          exitCode,
        });
      });
    });
  }
}
