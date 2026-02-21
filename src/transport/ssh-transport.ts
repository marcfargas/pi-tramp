/**
 * SshTransport — Transport implementation for SSH targets.
 *
 * Persistent SSH connection. Commands multiplexed via sentinel protocol.
 * See specs/sentinel-protocol.md for the full algorithm.
 *
 * Uses Windows SSH (C:\Windows\System32\OpenSSH\ssh.exe) for agent key access.
 * See memoria: ssh-persistent-connections.md.
 */

import { spawn, type ChildProcess } from "child_process";
import { EventEmitter } from "events";
import { randomUUID } from "crypto";
import type {
  Transport,
  TransportState,
  ShellType,
  PlatformType,
  ExecResult,
  ExecOptions,
  SshTargetConfig,
  ShellDriver,
} from "../types.js";
import { BashDriver } from "../shell/bash-driver.js";
import { PwshDriver } from "../shell/pwsh-driver.js";
import { CommandQueue } from "./command-queue.js";
import { parsePlatform, parseArch, parsePwshVersion } from "./shell-detect.js";

// On Windows, use the native SSH binary for access to Windows SSH agent.
// On Linux/macOS, use system ssh from PATH.
const SSH_BINARY = process.platform === "win32"
  ? "C:\\Windows\\System32\\OpenSSH\\ssh.exe"
  : "ssh";

export class SshTransport extends EventEmitter implements Transport {
  readonly type = "ssh" as const;

  private _shell: ShellType = "unknown";
  private _platform: PlatformType = "unknown";
  private _arch: string = "unknown";
  private _state: TransportState = "disconnected";
  private _driver: ShellDriver | null = null;
  private queue = new CommandQueue();

  private ssh: ChildProcess | null = null;
  private stderrLog: string = "";

  // Sentinel reader state
  private buffer: string = "";
  private outputChunks: string[] = [];
  private sentinelRegex: RegExp | null = null;
  private currentResolve: ((result: ExecResult) => void) | null = null;
  private currentReject: ((err: Error) => void) | null = null;
  private currentTimeout: ReturnType<typeof setTimeout> | null = null;

  // Config
  private readonly host: string;
  private readonly port: number;
  private readonly identityFile: string | undefined;
  private readonly configuredShell: ShellType | undefined;
  private readonly defaultTimeout: number;

  constructor(config: SshTargetConfig) {
    super();
    this.host = config.host;
    this.port = config.port ?? 22;
    this.identityFile = config.identityFile;
    this.configuredShell = config.shell as ShellType | undefined;
    this.defaultTimeout = config.timeout ?? 60000;
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
      await this.spawnSsh();
      await this.detectShellAndSetup();
      await this.detectPlatformAndArch();

      this._driver = this._shell === "pwsh"
        ? new PwshDriver()
        : new BashDriver(this._shell);

      this._state = "connected";
    } catch (err) {
      this._state = "error";
      this.killSsh();
      throw err;
    }
  }

  async close(): Promise<void> {
    this._state = "disconnected";
    this.killSsh();
    this.queue.drain(new Error("Transport closed"));
  }

  async healthCheck(): Promise<boolean> {
    try {
      const result = await this.exec("echo ok");
      return result.stdout.trim() === "ok" && result.exitCode === 0;
    } catch {
      return false;
    }
  }

  // --- SSH process management ---

  private spawnSsh(): Promise<void> {
    return new Promise((resolve, reject) => {
      const args: string[] = [];

      // -T: no PTY (critical — PTY echoes input, breaks sentinel parsing)
      args.push("-T");

      // Identity file
      if (this.identityFile) {
        args.push("-i", this.identityFile);
      }

      // Port
      if (this.port !== 22) {
        args.push("-p", String(this.port));
      }

      // Standard options
      args.push(
        "-o", "BatchMode=yes",
        "-o", "StrictHostKeyChecking=accept-new",
        "-o", "ServerAliveInterval=15",
        "-o", "ServerAliveCountMax=3",
      );

      // Host
      args.push(this.host);

      // If shell is explicitly configured, force that shell for clean output.
      // Otherwise, connect to the login shell and auto-detect.
      if (this.configuredShell === "pwsh") {
        args.push("pwsh", "-NoProfile", "-NonInteractive", "-Command", "-");
      } else if (this.configuredShell === "bash" || this.configuredShell === "sh") {
        args.push("bash", "--norc", "--noprofile");
      }
      // No configuredShell → use login shell, detect on connect

      this.ssh = spawn(SSH_BINARY, args, {
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });

      this.ssh.stderr!.on("data", (chunk: Buffer) => {
        this.stderrLog += chunk.toString();
      });

      this.ssh.stdout!.on("data", (chunk: Buffer) => {
        this.onStdoutData(chunk);
      });

      this.ssh.on("error", (err) => {
        this.onSshDeath(err);
      });

      this.ssh.on("close", (code) => {
        if (this._state === "connecting" || this._state === "connected") {
          this.onSshDeath(new Error(`SSH process exited with code ${code}`));
        }
      });

      // Wait for SSH to be ready by sending a probe
      const probeId = randomUUID().replace(/-/g, "");
      const probeSentinel = `__PITRAMP_${probeId}__`;

      this.sentinelRegex = new RegExp(`^${probeSentinel}_(\\d+)$`);
      this.outputChunks = [];

      const timeout = setTimeout(() => {
        this.sentinelRegex = null;
        this.currentResolve = null;
        this.currentReject = null;
        reject(new Error(`SSH connection timeout. stderr: ${this.stderrLog}`));
      }, 15000);

      this.currentResolve = () => {
        clearTimeout(timeout);
        resolve();
      };
      this.currentReject = (err) => {
        clearTimeout(timeout);
        reject(err);
      };
      this.currentTimeout = timeout;

      // Send ready probe — dual format for unknown login shells.
      // One of these will succeed depending on what shell is running.
      // bash/sh: printf works, Write-Output errors to stderr
      // pwsh: Write-Output works, printf may or may not exist
      this.ssh.stdin!.write(`printf '%s_%d\\n' '${probeSentinel}' 0 2>/dev/null\n`);
      this.ssh.stdin!.write(`Write-Output "${probeSentinel}_0" 2>$null\n`);
    });
  }

  private killSsh(): void {
    if (this.ssh) {
      try {
        this.ssh.stdin?.end();
        this.ssh.kill();
      } catch {
        // Ignore kill errors
      }
      this.ssh = null;
    }
    // Clean up sentinel reader state
    if (this.currentTimeout) clearTimeout(this.currentTimeout);
    this.sentinelRegex = null;
    this.currentResolve = null;
    this.currentReject = null;
    this.buffer = "";
    this.outputChunks = [];
  }

  private onSshDeath(err: Error): void {
    if (this._state === "disconnected") return; // Expected close
    this._state = "error";

    // Reject any pending command
    if (this.currentReject) {
      const reject = this.currentReject;
      if (this.currentTimeout) clearTimeout(this.currentTimeout);
      this.currentResolve = null;
      this.currentReject = null;
      this.sentinelRegex = null;
      reject(err);
    }

    // Drain the queue
    this.queue.drain(err);

    // Emit disconnect
    this.emit("disconnect", err);
  }

  // --- Sentinel reader ---

  private onStdoutData(chunk: Buffer): void {
    this.buffer += chunk.toString("utf8");

    const lines = this.buffer.split("\n");
    this.buffer = lines.pop()!; // Keep incomplete last line

    for (const line of lines) {
      // Strip carriage returns and ANSI escape sequences (pwsh interactive mode emits
      // [?1h, [?1l, color codes, etc. even with -T and $PSStyle.OutputRendering = 'PlainText')
      // eslint-disable-next-line no-control-regex
      const cleaned = line.replace(/\r$/, "").replace(/\x1b[[(][^\x1b]*?[a-zA-Z]|\x1b\][^\x07]*\x07/g, "");

      if (this.sentinelRegex) {
        const match = cleaned.match(this.sentinelRegex);
        if (match) {
          const exitCode = parseInt(match[1], 10);
          const stdout = this.outputChunks.join("\n");

          if (this.currentTimeout) clearTimeout(this.currentTimeout);
          const resolve = this.currentResolve;
          this.currentResolve = null;
          this.currentReject = null;
          this.sentinelRegex = null;
          this.outputChunks = [];

          resolve?.({ stdout, stderr: "", exitCode });
          return;
        }
      }

      this.outputChunks.push(cleaned);
    }
  }

  // --- Shell detection + setup ---

  private async detectShellAndSetup(): Promise<void> {
    if (this.configuredShell && this.configuredShell !== "unknown") {
      this._shell = this.configuredShell;
    } else {
      // Auto-detect: try a pwsh-specific command
      try {
        const result = await this.execRawDual(
          'echo "$($PSVersionTable.PSVersion.Major)"',
          5000,
        );
        const version = parsePwshVersion(result.stdout);
        if (version !== null) {
          this._shell = "pwsh";
        }
      } catch {
        // Not pwsh or timeout
      }
      if (this._shell === "unknown") {
        this._shell = "bash";
      }
    }

    // pwsh session setup — suppress ANSI, progress bars
    if (this._shell === "pwsh") {
      try {
        await this.execRaw(
          'try { $PSStyle.OutputRendering = "PlainText" } catch {}; ' +
          '$ProgressPreference = "SilentlyContinue"',
          5000,
        );
      } catch {
        // Non-fatal
      }
    }
  }

  private async detectPlatformAndArch(): Promise<void> {
    if (this._shell === "pwsh") {
      try {
        const result = await this.execRaw(
          "if ($IsLinux) { 'linux' } elseif ($IsMacOS) { 'darwin' } else { 'windows' }",
          5000,
        );
        this._platform = result.stdout.trim() as PlatformType;
      } catch {
        this._platform = "unknown";
      }
      try {
        const result = await this.execRaw(
          "[System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture",
          5000,
        );
        const archMap: Record<string, string> = { X64: "x86_64", Arm64: "aarch64", X86: "x86", Arm: "arm" };
        this._arch = archMap[result.stdout.trim()] ?? result.stdout.trim();
      } catch {
        this._arch = "unknown";
      }
    } else {
      try {
        const result = await this.execRaw("uname -s", 5000);
        this._platform = parsePlatform(result.stdout);
      } catch {
        this._platform = "unknown";
      }
      try {
        const result = await this.execRaw("uname -m", 5000);
        this._arch = parseArch(result.stdout);
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
    return this.queue.enqueue(() =>
      this.execRaw(command, options?.timeout ?? this.defaultTimeout),
    );
  }

  async readFile(path: string): Promise<Buffer> {
    if (!this._driver) throw new Error("Not connected — no shell driver");
    const cmd = this._driver.readFileCommand(path);
    const result = await this.exec(cmd);
    if (result.exitCode !== 0) {
      throw Object.assign(
        new Error(`readFile failed: ${result.stderr.trim() || result.stdout.trim() || "unknown error"}`),
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
        new Error(`writeFile failed: ${result.stderr.trim() || result.stdout.trim() || "unknown error"}`),
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

  // --- Internal: sentinel-wrapped exec ---

  /**
   * Execute with dual-format sentinel — for shell detection when we
   * don't yet know if the login shell is bash or pwsh.
   */
  private execRawDual(command: string, timeoutMs: number): Promise<ExecResult> {
    return new Promise((resolve, reject) => {
      if (!this.ssh || !this.ssh.stdin?.writable) {
        reject(new Error("SSH process not available"));
        return;
      }

      const sentinelId = randomUUID().replace(/-/g, "");
      const sentinel = `__PITRAMP_${sentinelId}__`;

      this.sentinelRegex = new RegExp(`^${sentinel}_(\\d+)$`);
      this.outputChunks = [];
      this.currentResolve = resolve;
      this.currentReject = reject;

      this.currentTimeout = setTimeout(() => {
        this.sentinelRegex = null;
        this.currentResolve = null;
        this.currentReject = null;
        reject(Object.assign(
          new Error(`Detection timed out after ${timeoutMs}ms`),
          { kind: "timeout", after_ms: timeoutMs },
        ));
        try { this.ssh?.stdin?.write("\x03\n"); } catch { /* ignore */ }
      }, timeoutMs);

      // Send command + both sentinel formats
      const bashSentinel = `printf '%s_%d\\n' '${sentinel}' $? 2>/dev/null`;
      const pwshSentinel = `Write-Output "${sentinel}_$LASTEXITCODE" 2>$null`;
      this.ssh.stdin!.write(`${command}\n${bashSentinel}\n${pwshSentinel}\n`);
    });
  }

  private execRaw(command: string, timeoutMs?: number): Promise<ExecResult> {
    const timeout = timeoutMs ?? this.defaultTimeout;

    return new Promise((resolve, reject) => {
      if (!this.ssh || !this.ssh.stdin?.writable) {
        reject(new Error("SSH process not available"));
        return;
      }

      const sentinelId = randomUUID().replace(/-/g, "");
      const sentinel = `__PITRAMP_${sentinelId}__`;

      this.sentinelRegex = new RegExp(`^${sentinel}_(\\d+)$`);
      this.outputChunks = [];
      this.currentResolve = resolve;
      this.currentReject = reject;

      this.currentTimeout = setTimeout(() => {
        this.sentinelRegex = null;
        this.currentResolve = null;
        this.currentReject = null;
        reject(Object.assign(
          new Error(`Command timed out after ${timeout}ms`),
          { kind: "timeout", after_ms: timeout },
        ));
        // Send Ctrl-C to try to cancel the remote command
        try { this.ssh?.stdin?.write("\x03\n"); } catch { /* ignore */ }
      }, timeout);

      // Build the wrapped command + sentinel based on detected shell.
      let wrapped: string;
      if (this._shell === "pwsh") {
        // pwsh: send directly with pwsh sentinel
        wrapped =
          "$global:LASTEXITCODE = 0\n" +
          `${command}\n` +
          `Write-Output "${sentinel}_$LASTEXITCODE"\n`;
      } else {
        // bash/sh: send directly with bash sentinel
        wrapped = `${command}\nprintf '%s_%d\\n' '${sentinel}' $?\n`;
      }

      this.ssh.stdin!.write(wrapped);
    });
  }
}
