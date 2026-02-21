/**
 * End-to-end integration tests.
 *
 * Tests the full stack: TargetManager → ConnectionPool → Transport → Operations.
 *
 * Scenarios tested:
 *   Docker × bash, Docker × pwsh        — shell forced via Docker exec
 *   SSH × auto-detect (bash)             — no shell config, default is bash (Linux only)
 *   SSH × auto-detect (pwsh)             — no shell config, default is pwsh
 *   SSH × explicit bash                  — shell: "bash", default is bash (Linux only)
 *   SSH × explicit pwsh                  — shell: "pwsh", default is pwsh
 *   SSH × mismatch                       — shell: "X" but default is "Y" → error
 *
 * Platform-aware: set PI_TRAMP_TARGET_OS=windows for Windows containers.
 * Default: Linux containers.
 *
 * Run: npm run test:integration
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFile } from "child_process";
import { promisify } from "util";
import { join } from "path";
import { TargetManager } from "../src/target-manager.js";
import { ConnectionPool } from "../src/connection-pool.js";
import {
  createRemoteReadOps,
  createRemoteWriteOps,
  createRemoteEditOps,
  createRemoteBashOps,
} from "../src/operations/remote-ops.js";
import { createEditTool } from "@mariozechner/pi-coding-agent";
import { initTrampExec, trampExec } from "../src/tramp-exec.js";
import type { TargetConfig } from "../src/types.js";
type TestShell = "bash" | "pwsh";
import { getTestPlatform, fixKeyPermissions } from "./helpers/platform.js";

const execFileAsync = promisify(execFile);
const TEMP = process.env.TEMP || process.env.TMP || "/tmp";
const KEY_PATH = join(TEMP, "pi-tramp-test-key");
const P = getTestPlatform();
const isWindows = P.os === "windows";

// ---------------------------------------------------------------------------
// SSH user config per platform
// ---------------------------------------------------------------------------
// Linux container: testuser (bash default), testuser-pwsh (pwsh default)
// Windows container: testuser (DefaultShell=pwsh, single user)
const SSH_BASH_USER = "testuser";           // bash default shell (Linux only)
const SSH_PWSH_USER = isWindows ? "testuser" : "testuser-pwsh";  // pwsh default shell
const SSH_BASE = { port: 2222, identityFile: KEY_PATH, cwd: P.workspace };

// ---------------------------------------------------------------------------
// Operational test scenarios — each gets the full read/write/edit/exec suite
// ---------------------------------------------------------------------------
interface Scenario {
  name: string;
  targetName: string;
  transport: "docker" | "ssh";
  shell: TestShell;
}

const scenarios: Scenario[] = [
  // Docker: shell forced via docker exec — always works
  { name: "Docker × bash", targetName: "docker-bash", transport: "docker", shell: "bash" },
  { name: "Docker × pwsh", targetName: "docker-pwsh", transport: "docker", shell: "pwsh" },
  // SSH auto-detect: no shell configured, default shell is bash (clean, non-interactive)
  ...(isWindows ? [] : [
    { name: "SSH × auto-detect (bash)", targetName: "ssh-auto-bash", transport: "ssh" as const, shell: "bash" as TestShell },
  ]),
  // SSH auto-detect: no shell configured, default shell is pwsh (Windows container)
  ...(isWindows ? [
    { name: "SSH × auto-detect (pwsh)", targetName: "ssh-auto-pwsh", transport: "ssh" as const, shell: "pwsh" as TestShell },
  ] : []),
  // SSH explicit: user configures shell, forced as SSH remote command
  ...(isWindows ? [] : [
    { name: "SSH × explicit bash", targetName: "ssh-explicit-bash", transport: "ssh" as const, shell: "bash" as TestShell },
  ]),
  { name: "SSH × explicit pwsh", targetName: "ssh-explicit-pwsh", transport: "ssh" as const, shell: "pwsh" as TestShell },
];

// Shared state
let tm: TargetManager;
let pool: ConnectionPool;

describe("End-to-End", () => {
  beforeAll(async () => {
    // Start Docker containers
    try { await execFileAsync("docker", ["rm", "-f", P.dockerContainer]); } catch { /* */ }
    await execFileAsync("docker", ["run", "-d", "--name", P.dockerContainer, P.image, ...P.keepaliveArgs]);

    try { await execFileAsync("docker", ["start", P.sshContainer]); } catch {
      await execFileAsync("docker", ["run", "-d", "--name", P.sshContainer, "-p", "2222:22", P.image]);
    }

    // Extract SSH key and fix permissions (Windows docker cp creates broad ACLs)
    await execFileAsync("docker", ["cp", `${P.sshContainer}:${P.testKeyPath}`, KEY_PATH]);
    await fixKeyPermissions(KEY_PATH);
    await new Promise((r) => setTimeout(r, P.startupDelayMs));

    tm = new TargetManager();

    // Docker targets — shell forced via docker exec
    tm.createTarget("docker-bash", {
      type: "docker", container: P.dockerContainer, cwd: P.workspace, shell: "bash",
    } as TargetConfig);
    tm.createTarget("docker-pwsh", {
      type: "docker", container: P.dockerContainer, cwd: P.workspace, shell: "pwsh",
    } as TargetConfig);

    // SSH auto-detect — no shell configured, server default is bash (clean, Linux)
    if (!isWindows) {
      tm.createTarget("ssh-auto-bash", {
        type: "ssh", host: `${SSH_BASH_USER}@${P.sshHost}`, ...SSH_BASE,
      } as TargetConfig);
    }

    // SSH auto-detect — no shell configured, server default is pwsh (Windows)
    if (isWindows) {
      tm.createTarget("ssh-auto-pwsh", {
        type: "ssh", host: `${SSH_PWSH_USER}@${P.sshHost}`, ...SSH_BASE,
      } as TargetConfig);
    }

    // SSH explicit — user configures shell, forced as SSH remote command
    if (!isWindows) {
      tm.createTarget("ssh-explicit-bash", {
        type: "ssh", host: `${SSH_BASH_USER}@${P.sshHost}`, ...SSH_BASE, shell: "bash",
      } as TargetConfig);
    }
    tm.createTarget("ssh-explicit-pwsh", {
      type: "ssh", host: `${SSH_PWSH_USER}@${P.sshHost}`, ...SSH_BASE, shell: "pwsh",
    } as TargetConfig);

    // SSH mismatch targets — created per-test, not here

    pool = new ConnectionPool(tm);
    initTrampExec(pool, tm);
  }, 60000);

  afterAll(async () => {
    await pool.closeAll();
    try { await execFileAsync("docker", ["rm", "-f", P.dockerContainer]); } catch { /* */ }
  });

  // =========================================================================
  // Run the full operations suite for each scenario
  // =========================================================================
  for (const s of scenarios) {
    describe(s.name, () => {
      beforeAll(() => { tm.switchTarget(s.targetName); });

      // -----------------------------------------------------------------------
      // Read operations
      // -----------------------------------------------------------------------
      describe("read", () => {
        it("reads an existing file", async () => {
          const ops = createRemoteReadOps(pool, tm);
          const data = await ops.readFile(P.join(P.workspace, "test.txt"));
          expect(data.toString("utf8").trim()).toBe("hello world");
        });

        it("access succeeds for existing file", async () => {
          const ops = createRemoteReadOps(pool, tm);
          await ops.access(P.join(P.workspace, "test.txt"));
        });

        it("access fails for missing file", async () => {
          const ops = createRemoteReadOps(pool, tm);
          await expect(ops.access(P.join(P.workspace, "nope.txt"))).rejects.toThrow();
        });
      });

      // -----------------------------------------------------------------------
      // Write operations
      // -----------------------------------------------------------------------
      describe("write", () => {
        it("writes and reads back a file", async () => {
          const fname = `e2e-write-${s.targetName}.txt`;
          const fpath = P.join(P.workspace, fname);
          const writeOps = createRemoteWriteOps(pool, tm);
          const readOps = createRemoteReadOps(pool, tm);

          await writeOps.writeFile(fpath, `write test ${s.name}\n`);
          const data = await readOps.readFile(fpath);
          expect(data.toString("utf8")).toBe(`write test ${s.name}\n`);

          // Cleanup
          const transport = await pool.getConnection(s.targetName);
          await transport.exec(P.rmFile(fpath, s.shell));
        });

        it("creates directories", async () => {
          const dir = P.join(P.workspace, `e2e-dir-${s.targetName}`, "sub", "deep");
          const writeOps = createRemoteWriteOps(pool, tm);
          await writeOps.mkdir(dir);

          const transport = await pool.getConnection(s.targetName);
          const result = await transport.exec(P.testDir(dir, s.shell));
          expect(result.stdout.trim()).toBe("ok");

          // Cleanup parent
          await transport.exec(P.rmDir(P.join(P.workspace, `e2e-dir-${s.targetName}`), s.shell));
        });
      });

      // -----------------------------------------------------------------------
      // Edit operations (via pi's createEditTool)
      // -----------------------------------------------------------------------
      describe("edit", () => {
        it("edit cycle with LF content", async () => {
          const fname = `e2e-edit-${s.targetName}.txt`;
          const fpath = P.join(P.workspace, fname);
          const writeOps = createRemoteWriteOps(pool, tm);
          const readOps = createRemoteReadOps(pool, tm);

          await writeOps.writeFile(fpath, "line1\nline2\nline3\n");
          const content = await readOps.readFile(fpath);
          const modified = content.toString("utf8").replace("line2", "MODIFIED");
          await writeOps.writeFile(fpath, modified);

          const final = await readOps.readFile(fpath);
          expect(final.toString("utf8")).toContain("MODIFIED");

          const transport = await pool.getConnection(s.targetName);
          await transport.exec(P.rmFile(fpath, s.shell));
        });

        it("CRLF edit preserves line endings", async () => {
          const fname = `e2e-crlf-${s.targetName}.txt`;
          const fpath = P.join(P.workspace, fname);
          const transport = await pool.getConnection(s.targetName);
          const crlfContent = "alpha\r\nbeta\r\ngamma\r\n";
          await transport.writeFile(fpath, Buffer.from(crlfContent, "utf8"));

          const editOps = createRemoteEditOps(pool, tm);
          const tool = createEditTool(P.workspace, { operations: editOps });
          const result = await tool.execute("test-id", {
            path: fpath,
            oldText: "beta",    // LF-only (as LLM sends)
            newText: "CHANGED",
          });

          expect((result.content[0] as { text: string }).text).toContain("Successfully");
          const final = await transport.readFile(fpath);
          expect(final.toString("utf8")).toBe("alpha\r\nCHANGED\r\ngamma\r\n");

          await transport.exec(P.rmFile(fpath, s.shell));
        });
      });

      // -----------------------------------------------------------------------
      // Bash (exec) operations
      // -----------------------------------------------------------------------
      describe("exec", () => {
        it("runs a command and captures output", async () => {
          const ops = createRemoteBashOps(pool, tm);
          const chunks: Buffer[] = [];
          await ops.exec(P.echoCmd(`exec-test-${s.name}`, s.shell), P.workspace, {
            onData: (d) => chunks.push(d),
          });
          expect(Buffer.concat(chunks).toString("utf8")).toContain(`exec-test-${s.name}`);
        });

        it("reports cwd", async () => {
          const ops = createRemoteBashOps(pool, tm);
          const chunks: Buffer[] = [];
          await ops.exec(P.pwdCmd(s.shell), P.workspace, {
            onData: (d) => chunks.push(d),
          });
          const output = Buffer.concat(chunks).toString("utf8").trim();
          // Normalize: bash on Windows returns MSYS paths (/c/workspace),
          // pwsh returns Windows paths (C:\workspace).
          const normalize = (p: string) =>
            p.replace(/\\/g, "/").replace(/^\/([a-zA-Z])\//, (_, d: string) => `${d.toUpperCase()}:/`).toLowerCase();
          expect(normalize(output)).toBe(normalize(P.workspace));
        });

        it("captures non-zero exit code", async () => {
          const ops = createRemoteBashOps(pool, tm);
          const result = await ops.exec(P.exitCmd(42, s.shell, s.transport), P.workspace, {
            onData: () => {},
          });
          expect(result.exitCode).toBe(42);
        });
      });
    });
  }

  // =========================================================================
  // Shell error tests
  // =========================================================================
  describe("SSH shell errors", () => {
    // Noisy default shell: pwsh login shell echoes input + shows prompts.
    // Auto-detect without explicit shell config should error with helpful message.
    // Linux-only: Linux container has a noisy-pwsh-default user for this test.
    it.skipIf(isWindows)(
      "errors when default shell is noisy (pwsh login shell, no shell configured)",
      async () => {
        const noisyTm = new TargetManager();
        noisyTm.createTarget("noisy-pwsh", {
          type: "ssh", host: `${SSH_PWSH_USER}@${P.sshHost}`, ...SSH_BASE,
          // No shell configured — connects to pwsh login shell directly
        } as TargetConfig);
        const noisyPool = new ConnectionPool(noisyTm);

        await expect(noisyPool.getConnection("noisy-pwsh"))
          .rejects.toThrow(/noisy output|shell/i);

        await noisyPool.closeAll();
      });

    // Explicit shell works regardless of user's default — the configured
    // shell is forced as SSH remote command. If the shell binary exists
    // on the server, it starts correctly (e.g., pwsh on a bash-default user).
    // Linux-only: requires separate testuser (bash default) + pwsh installed.
    it.skipIf(isWindows)(
      "explicit pwsh works even when user default is bash",
      async () => {
        // testuser's default is bash, but shell: "pwsh" forces SSH to run
        // pwsh -NonInteractive -Command -, which succeeds because pwsh is installed.
        const crossTm = new TargetManager();
        crossTm.createTarget("cross-pwsh", {
          type: "ssh", host: `${SSH_BASH_USER}@${P.sshHost}`, ...SSH_BASE,
          shell: "pwsh",
        } as TargetConfig);
        const crossPool = new ConnectionPool(crossTm);

        const transport = await crossPool.getConnection("cross-pwsh");
        expect(transport.shell).toBe("pwsh");
        const result = await transport.exec("Write-Output 'cross-test'");
        expect(result.stdout.trim()).toBe("cross-test");

        await crossPool.closeAll();
      });
  });

  // =========================================================================
  // Cross-scenario tests
  // =========================================================================
  describe("target switching", () => {
    it("emits events on switch", () => {
      const events: Array<{ from?: string; to: string }> = [];
      tm.on("target_switched", (e: { from?: string; to: string }) => events.push(e));

      tm.switchTarget("docker-bash");
      tm.switchTarget("ssh-explicit-pwsh");
      tm.switchTarget("local");

      expect(events).toHaveLength(3);
      expect(events[0].to).toBe("docker-bash");
      expect(events[1].from).toBe("docker-bash");
      expect(events[1].to).toBe("ssh-explicit-pwsh");
      expect(events[2].to).toBe("local");

      tm.removeAllListeners("target_switched");
    });
  });

  describe("trampExec", () => {
    it("executes on current target", async () => {
      tm.switchTarget("docker-bash");
      const result = await trampExec("echo trampExec-test");
      expect(result.stdout.trim()).toBe("trampExec-test");
      expect(result.exitCode).toBe(0);
    });

    it("executes on a specific target", async () => {
      const sshTarget = isWindows ? "ssh-auto-pwsh" : "ssh-auto-bash";
      tm.switchTarget("local");
      const result = await trampExec(
        isWindows ? "Write-Output 'specific'" : "echo specific",
        { target: sshTarget },
      );
      expect(result.stdout.trim()).toBe("specific");
    });

    it("throws when no target active", async () => {
      tm.switchTarget("local");
      await expect(trampExec("echo nope")).rejects.toThrow("No active target");
    });
  });

  describe("connection pool", () => {
    it("reuses connections", async () => {
      const t1 = await pool.getConnection("docker-bash");
      const t2 = await pool.getConnection("docker-bash");
      expect(t1).toBe(t2);
    });

    it("reports status", async () => {
      await pool.getConnection("docker-bash");
      const status = pool.getStatus();
      const s = status.get("docker-bash");
      expect(s).toBeDefined();
      expect(s!.state).toBe("connected");
    });

    it("closes and reconnects", async () => {
      await pool.closeConnection("docker-bash");
      expect(pool.getStatus().has("docker-bash")).toBe(false);
      const t = await pool.getConnection("docker-bash");
      expect(t.state).toBe("connected");
    });
  });

  describe("binary files", () => {
    it("round-trips binary content via Docker", async () => {
      const binary = Buffer.alloc(256);
      for (let i = 0; i < 256; i++) binary[i] = i;

      const transport = await pool.getConnection("docker-bash");
      const fpath = P.join(P.workspace, "e2e-binary.bin");
      await transport.writeFile(fpath, binary);
      const read = await transport.readFile(fpath);
      expect(read.equals(binary)).toBe(true);
      await transport.exec(P.rmFile(fpath, "bash"));
    });

    it("round-trips binary content via SSH", async () => {
      const binary = Buffer.alloc(256);
      for (let i = 0; i < 256; i++) binary[i] = i;

      const sshTarget = isWindows ? "ssh-auto-pwsh" : "ssh-auto-bash";
      const shell: TestShell = isWindows ? "pwsh" : "bash";
      const transport = await pool.getConnection(sshTarget);
      const fpath = P.join(P.workspace, "e2e-ssh-binary.bin");
      await transport.writeFile(fpath, binary);
      const read = await transport.readFile(fpath);
      expect(read.equals(binary)).toBe(true);
      await transport.exec(P.rmFile(fpath, shell));
    });
  });
});
