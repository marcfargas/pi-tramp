/**
 * Remote Operations — Tier 4.
 *
 * Implements pi's ReadOperations, WriteOperations, EditOperations, and
 * BashOperations interfaces by delegating to a Transport via ConnectionPool.
 */

import type {
  ReadOperations,
  WriteOperations,
  EditOperations,
  BashOperations,
} from "@mariozechner/pi-coding-agent";
import type { ConnectionPool } from "../types.js";
import { TargetManager } from "../target-manager.js";
import { posix } from "path";

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB

// ---------------------------------------------------------------------------
// Path resolution helper
// ---------------------------------------------------------------------------

function resolveRemotePath(path: string, cwd: string | undefined, platform: string): string {
  // If already absolute, use as-is
  if (platform === "windows") {
    // Windows: C:\ or \\ paths are absolute
    if (/^[A-Za-z]:[\\/]/.test(path) || path.startsWith("\\\\")) return path;
  } else {
    // POSIX: starts with /
    if (path.startsWith("/")) return path;
  }
  // Relative — need cwd
  if (!cwd) {
    throw new Error(
      `Cannot resolve relative path '${path}' — no working directory configured for this target. ` +
      `Use an absolute path or set 'cwd' in the target config.`,
    );
  }
  if (platform === "windows") {
    return `${cwd}\\${path}`;
  }
  return posix.join(cwd, path);
}

// ---------------------------------------------------------------------------
// Remote Read Operations
// ---------------------------------------------------------------------------

export function createRemoteReadOps(
  pool: ConnectionPool,
  targetManager: TargetManager,
): ReadOperations {
  function getTargetInfo() {
    const target = targetManager.currentTarget;
    if (!target) throw new Error("No active target");
    return target;
  }

  return {
    async readFile(absolutePath: string): Promise<Buffer> {
      const target = getTargetInfo();
      return pool.execOnTarget(target.name, async (transport) => {
        const remotePath = resolveRemotePath(absolutePath, target.config.cwd, transport.platform);
        const data = await transport.readFile(remotePath);
        if (data.length > MAX_FILE_SIZE) {
          throw new Error(
            `Remote read failed on target '${target.name}': File too large (${data.length} bytes, limit 10MB): ${remotePath}`,
          );
        }
        return data;
      });
    },

    async access(absolutePath: string): Promise<void> {
      const target = getTargetInfo();
      await pool.execOnTarget(target.name, async (transport) => {
        const remotePath = resolveRemotePath(absolutePath, target.config.cwd, transport.platform);
        const driver = (transport as unknown as { driver: { statCommand: (p: string) => string } }).driver;
        if (!driver) throw new Error("Not connected — no shell driver");

        const cmd = driver.statCommand(remotePath);
        const result = await transport.exec(cmd);
        const stat = result.stdout.trim();

        if (stat === "missing") {
          throw new Error(`File not found: ${remotePath}`);
        }
      });
    },
  };
}

// ---------------------------------------------------------------------------
// Remote Write Operations
// ---------------------------------------------------------------------------

export function createRemoteWriteOps(
  pool: ConnectionPool,
  targetManager: TargetManager,
): WriteOperations {
  function getTargetInfo() {
    const target = targetManager.currentTarget;
    if (!target) throw new Error("No active target");
    return target;
  }

  return {
    async writeFile(absolutePath: string, content: string): Promise<void> {
      const target = getTargetInfo();
      const buf = Buffer.from(content, "utf8");
      if (buf.length > MAX_FILE_SIZE) {
        throw new Error(
          `Remote write failed on target '${target.name}': Content too large (${buf.length} bytes, limit 10MB)`,
        );
      }
      await pool.execOnTarget(target.name, async (transport) => {
        const remotePath = resolveRemotePath(absolutePath, target.config.cwd, transport.platform);
        await transport.writeFile(remotePath, buf);
      });
    },

    async mkdir(dir: string): Promise<void> {
      const target = getTargetInfo();
      await pool.execOnTarget(target.name, async (transport) => {
        const remotePath = resolveRemotePath(dir, target.config.cwd, transport.platform);
        const driver = (transport as unknown as { driver: { mkdirCommand: (p: string) => string } }).driver;
        if (!driver) throw new Error("Not connected — no shell driver");

        const cmd = driver.mkdirCommand(remotePath);
        const result = await transport.exec(cmd);
        if (result.exitCode !== 0) {
          throw new Error(`Failed to create directory: ${remotePath} — ${result.stderr.trim()}`);
        }
      });
    },
  };
}

// ---------------------------------------------------------------------------
// Remote Edit Operations
// ---------------------------------------------------------------------------

export function createRemoteEditOps(
  pool: ConnectionPool,
  targetManager: TargetManager,
): EditOperations {
  const readOps = createRemoteReadOps(pool, targetManager);
  const writeOps = createRemoteWriteOps(pool, targetManager);

  return {
    readFile: readOps.readFile,
    writeFile: writeOps.writeFile,
    access: readOps.access,
  };
}

// ---------------------------------------------------------------------------
// Remote Bash Operations
// ---------------------------------------------------------------------------

export function createRemoteBashOps(
  pool: ConnectionPool,
  targetManager: TargetManager,
): BashOperations {
  return {
    async exec(
      command: string,
      _cwd: string, // Ignored — we use target cwd
      options: {
        onData: (data: Buffer) => void;
        signal?: AbortSignal;
        timeout?: number;
      },
    ): Promise<{ exitCode: number | null }> {
      const target = targetManager.currentTarget;
      if (!target) throw new Error("No active target");

      return pool.execOnTarget(target.name, async (transport) => {
        // Wrap command with cd to target cwd (if configured)
        const cwd = target.config.cwd;
        let wrappedCmd: string;

        if (cwd) {
          if (transport.shell === "pwsh") {
            wrappedCmd = `Set-Location ${escapePwshSimple(cwd)}; ${command}`;
          } else {
            wrappedCmd = `cd ${escapeBashSimple(cwd)} && ${command}`;
          }
        } else {
          // No cwd — run in whatever directory the transport lands in (homedir)
          wrappedCmd = command;
        }

        // pi's Bash tool passes timeout in seconds; transport uses milliseconds.
        const timeoutMs = options.timeout ? options.timeout * 1000 : undefined;

        const result = await transport.exec(wrappedCmd, {
          timeout: timeoutMs,
          signal: options.signal,
        });

        // Stream combined output to onData callback
        const combined = result.stdout + (result.stderr ? "\n" + result.stderr : "");
        if (combined) {
          options.onData(Buffer.from(combined, "utf8"));
        }

        return { exitCode: result.exitCode };
      });
    },
  };
}

// Simple escape helpers for cwd (which shouldn't contain malicious content)
function escapeBashSimple(s: string): string {
  return "'" + s.replace(/'/g, "'\"'\"'") + "'";
}

function escapePwshSimple(s: string): string {
  return "'" + s.replace(/'/g, "''") + "'";
}
