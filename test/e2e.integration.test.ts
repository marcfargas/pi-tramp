/**
 * End-to-end integration tests.
 *
 * Tests the full stack: TargetManager → ConnectionPool → Transport → Operations.
 * Covers all 4 tool operations × both transports (Docker + SSH).
 *
 * Requires:
 *   docker run -d --name pi-tramp-ssh-test -p 2222:22 pi-tramp-ssh-test
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
import { initTrampExec, trampExec } from "../src/tramp-exec.js";
import type { TargetConfig } from "../src/types.js";

const execFileAsync = promisify(execFile);
const TEMP = process.env.TEMP || process.env.TMP || "/tmp";
const KEY_PATH = join(TEMP, "pi-tramp-test-key");

const DOCKER_CONTAINER = "pi-tramp-e2e-docker";
const SSH_CONTAINER = "pi-tramp-ssh-test";
const IMAGE = "pi-tramp-ssh-test";

// Shared state
let tm: TargetManager;
let pool: ConnectionPool;

describe("End-to-End", () => {
  beforeAll(async () => {
    // Start Docker container for docker transport tests
    try { await execFileAsync("docker", ["rm", "-f", DOCKER_CONTAINER]); } catch { /* */ }
    await execFileAsync("docker", ["run", "-d", "--name", DOCKER_CONTAINER, IMAGE, "sleep", "infinity"]);

    // Ensure SSH container is running
    try { await execFileAsync("docker", ["start", SSH_CONTAINER]); } catch {
      await execFileAsync("docker", ["run", "-d", "--name", SSH_CONTAINER, "-p", "2222:22", IMAGE]);
    }

    // Extract SSH key
    await execFileAsync("docker", ["cp", `${SSH_CONTAINER}:/test_key`, KEY_PATH]);
    await new Promise((r) => setTimeout(r, 1000));

    // Setup TargetManager with both targets
    tm = new TargetManager();
    tm.createTarget("docker-test", {
      type: "docker",
      container: DOCKER_CONTAINER,
      cwd: "/workspace",
    } as TargetConfig);
    tm.createTarget("ssh-test", {
      type: "ssh",
      host: "testuser@localhost",
      port: 2222,
      identityFile: KEY_PATH,
      cwd: "/workspace",
    } as TargetConfig);

    pool = new ConnectionPool(tm);
    initTrampExec(pool, tm);
  }, 30000);

  afterAll(async () => {
    await pool.closeAll();
    try { await execFileAsync("docker", ["rm", "-f", DOCKER_CONTAINER]); } catch { /* */ }
  });

  // =========================================================================
  // Docker Transport E2E
  // =========================================================================
  describe("Docker target", () => {
    beforeAll(() => { tm.switchTarget("docker-test"); });

    describe("read operations", () => {
      it("reads an existing file", async () => {
        const ops = createRemoteReadOps(pool, tm);
        const data = await ops.readFile("/workspace/test.txt");
        expect(data.toString("utf8").trim()).toBe("hello world");
      });

      it("access checks succeed for existing files", async () => {
        const ops = createRemoteReadOps(pool, tm);
        await ops.access("/workspace/test.txt"); // should not throw
      });

      it("access checks fail for missing files", async () => {
        const ops = createRemoteReadOps(pool, tm);
        await expect(ops.access("/workspace/nope.txt")).rejects.toThrow();
      });
    });

    describe("write operations", () => {
      it("writes a new file", async () => {
        const ops = createRemoteWriteOps(pool, tm);
        await ops.writeFile("/workspace/e2e-docker-write.txt", "e2e docker write\n");

        const readOps = createRemoteReadOps(pool, tm);
        const data = await readOps.readFile("/workspace/e2e-docker-write.txt");
        expect(data.toString("utf8")).toBe("e2e docker write\n");

        // Cleanup
        const transport = await pool.getConnection("docker-test");
        await transport.exec("rm /workspace/e2e-docker-write.txt");
      });

      it("creates parent directories", async () => {
        const ops = createRemoteWriteOps(pool, tm);
        await ops.mkdir("/workspace/e2e-docker-deep/sub/dir");

        const transport = await pool.getConnection("docker-test");
        const result = await transport.exec("test -d /workspace/e2e-docker-deep/sub/dir && echo ok");
        expect(result.stdout.trim()).toBe("ok");

        await transport.exec("rm -rf /workspace/e2e-docker-deep");
      });
    });

    describe("edit operations (read-apply-write)", () => {
      it("simulates a full edit cycle", async () => {
        const ops = createRemoteEditOps(pool, tm);

        // Write initial file
        await ops.writeFile("/workspace/e2e-docker-edit.txt", "line1\nline2\nline3\n");

        // Verify access
        await ops.access("/workspace/e2e-docker-edit.txt");

        // Read
        const content = await ops.readFile("/workspace/e2e-docker-edit.txt");
        expect(content.toString("utf8")).toBe("line1\nline2\nline3\n");

        // Apply edit (in reality pi does this)
        const modified = content.toString("utf8").replace("line2", "EDITED");
        await ops.writeFile("/workspace/e2e-docker-edit.txt", modified);

        // Verify
        const final = await ops.readFile("/workspace/e2e-docker-edit.txt");
        expect(final.toString("utf8")).toBe("line1\nEDITED\nline3\n");

        // Cleanup
        const transport = await pool.getConnection("docker-test");
        await transport.exec("rm /workspace/e2e-docker-edit.txt");
      });
    });

    describe("bash operations", () => {
      it("executes a command and streams output", async () => {
        const ops = createRemoteBashOps(pool, tm);
        const chunks: Buffer[] = [];
        const result = await ops.exec("echo 'docker e2e bash'", "/workspace", {
          onData: (data) => chunks.push(data),
        });
        expect(result.exitCode).toBe(0);
        expect(Buffer.concat(chunks).toString("utf8")).toContain("docker e2e bash");
      });

      it("runs in target cwd", async () => {
        const ops = createRemoteBashOps(pool, tm);
        const chunks: Buffer[] = [];
        await ops.exec("pwd", "/workspace", {
          onData: (data) => chunks.push(data),
        });
        expect(Buffer.concat(chunks).toString("utf8").trim()).toBe("/workspace");
      });

      it("captures non-zero exit codes", async () => {
        const ops = createRemoteBashOps(pool, tm);
        const result = await ops.exec("exit 42", "/workspace", {
          onData: () => {},
        });
        expect(result.exitCode).toBe(42);
      });
    });
  });

  // =========================================================================
  // SSH Transport E2E
  // =========================================================================
  describe("SSH target", () => {
    beforeAll(() => { tm.switchTarget("ssh-test"); });

    describe("read operations", () => {
      it("reads an existing file", async () => {
        const ops = createRemoteReadOps(pool, tm);
        const data = await ops.readFile("/workspace/test.txt");
        expect(data.toString("utf8").trim()).toBe("hello world");
      });

      it("access checks succeed for existing files", async () => {
        const ops = createRemoteReadOps(pool, tm);
        await ops.access("/workspace/test.txt");
      });

      it("access checks fail for missing files", async () => {
        const ops = createRemoteReadOps(pool, tm);
        await expect(ops.access("/workspace/nope.txt")).rejects.toThrow();
      });
    });

    describe("write operations", () => {
      it("writes a new file", async () => {
        const ops = createRemoteWriteOps(pool, tm);
        await ops.writeFile("/workspace/e2e-ssh-write.txt", "e2e ssh write\n");

        const readOps = createRemoteReadOps(pool, tm);
        const data = await readOps.readFile("/workspace/e2e-ssh-write.txt");
        expect(data.toString("utf8")).toBe("e2e ssh write\n");

        const transport = await pool.getConnection("ssh-test");
        await transport.exec("rm /workspace/e2e-ssh-write.txt");
      });

      it("creates parent directories", async () => {
        const ops = createRemoteWriteOps(pool, tm);
        await ops.mkdir("/workspace/e2e-ssh-deep/sub/dir");

        const transport = await pool.getConnection("ssh-test");
        const result = await transport.exec("test -d /workspace/e2e-ssh-deep/sub/dir && echo ok");
        expect(result.stdout.trim()).toBe("ok");

        await transport.exec("rm -rf /workspace/e2e-ssh-deep");
      });
    });

    describe("edit operations (read-apply-write)", () => {
      it("simulates a full edit cycle", async () => {
        const ops = createRemoteEditOps(pool, tm);

        await ops.writeFile("/workspace/e2e-ssh-edit.txt", "alpha\nbeta\ngamma\n");
        await ops.access("/workspace/e2e-ssh-edit.txt");

        const content = await ops.readFile("/workspace/e2e-ssh-edit.txt");
        expect(content.toString("utf8")).toBe("alpha\nbeta\ngamma\n");

        const modified = content.toString("utf8").replace("beta", "REPLACED");
        await ops.writeFile("/workspace/e2e-ssh-edit.txt", modified);

        const final = await ops.readFile("/workspace/e2e-ssh-edit.txt");
        expect(final.toString("utf8")).toBe("alpha\nREPLACED\ngamma\n");

        const transport = await pool.getConnection("ssh-test");
        await transport.exec("rm /workspace/e2e-ssh-edit.txt");
      });
    });

    describe("bash operations", () => {
      it("executes a command and streams output", async () => {
        const ops = createRemoteBashOps(pool, tm);
        const chunks: Buffer[] = [];
        const result = await ops.exec("echo 'ssh e2e bash'", "/workspace", {
          onData: (data) => chunks.push(data),
        });
        expect(result.exitCode).toBe(0);
        expect(Buffer.concat(chunks).toString("utf8")).toContain("ssh e2e bash");
      });

      it("runs in target cwd", async () => {
        const ops = createRemoteBashOps(pool, tm);
        const chunks: Buffer[] = [];
        await ops.exec("pwd", "/workspace", {
          onData: (data) => chunks.push(data),
        });
        expect(Buffer.concat(chunks).toString("utf8").trim()).toBe("/workspace");
      });

      it("captures non-zero exit codes", async () => {
        const ops = createRemoteBashOps(pool, tm);
        // Use subshell to avoid killing the persistent SSH session
        const result = await ops.exec("(exit 7)", "/workspace", {
          onData: () => {},
        });
        expect(result.exitCode).toBe(7);
      });

      it("handles commands with special characters", async () => {
        const ops = createRemoteBashOps(pool, tm);
        const chunks: Buffer[] = [];
        await ops.exec("echo 'hello $USER \"quotes\" `backticks`'", "/workspace", {
          onData: (data) => chunks.push(data),
        });
        const out = Buffer.concat(chunks).toString("utf8");
        expect(out).toContain("$USER");
        expect(out).toContain('"quotes"');
      });
    });
  });

  // =========================================================================
  // Target Switching
  // =========================================================================
  describe("target switching", () => {
    it("switches between docker and ssh targets", async () => {
      // Start on docker
      tm.switchTarget("docker-test");
      let ops = createRemoteBashOps(pool, tm);
      let chunks: Buffer[] = [];
      await ops.exec("hostname", "/workspace", {
        onData: (data) => chunks.push(data),
      });
      const dockerHostname = Buffer.concat(chunks).toString("utf8").trim();

      // Switch to ssh
      tm.switchTarget("ssh-test");
      ops = createRemoteBashOps(pool, tm);
      chunks = [];
      await ops.exec("hostname", "/workspace", {
        onData: (data) => chunks.push(data),
      });
      const sshHostname = Buffer.concat(chunks).toString("utf8").trim();

      // Both should return hostnames (might be the same since same image, but test works)
      expect(dockerHostname).toBeTruthy();
      expect(sshHostname).toBeTruthy();
    });

    it("switching to local means no active target", () => {
      tm.switchTarget("docker-test");
      expect(tm.currentTarget).not.toBeNull();

      tm.switchTarget("local");
      expect(tm.currentTarget).toBeNull();
    });

    it("emits target_switched event", async () => {
      const events: Array<{ from: string | null; to: string }> = [];
      tm.on("target_switched", (ev) => events.push(ev));

      tm.switchTarget("docker-test");
      tm.switchTarget("ssh-test");
      tm.switchTarget("local");

      expect(events).toHaveLength(3);
      expect(events[0].to).toBe("docker-test");
      expect(events[1].from).toBe("docker-test");
      expect(events[1].to).toBe("ssh-test");
      expect(events[2].to).toBe("local");

      tm.removeAllListeners("target_switched");
    });
  });

  // =========================================================================
  // trampExec Public API
  // =========================================================================
  describe("trampExec", () => {
    it("executes on current target", async () => {
      tm.switchTarget("docker-test");
      const result = await trampExec("echo trampExec-test");
      expect(result.stdout.trim()).toBe("trampExec-test");
      expect(result.exitCode).toBe(0);
    });

    it("executes on a specific target", async () => {
      tm.switchTarget("local"); // No active target
      const result = await trampExec("echo specific", { target: "ssh-test" });
      expect(result.stdout.trim()).toBe("specific");
    });

    it("throws when no target is active or specified", async () => {
      tm.switchTarget("local");
      await expect(trampExec("echo nope")).rejects.toThrow("No active target");
    });
  });

  // =========================================================================
  // Connection Pool behavior
  // =========================================================================
  describe("connection pool", () => {
    it("reuses connections across operations", async () => {
      tm.switchTarget("docker-test");

      // Multiple operations should reuse the same transport
      const t1 = await pool.getConnection("docker-test");
      const t2 = await pool.getConnection("docker-test");
      expect(t1).toBe(t2); // Same object reference
    });

    it("reports status for connected targets", async () => {
      await pool.getConnection("docker-test");
      const status = pool.getStatus();
      const dockerStatus = status.get("docker-test");
      expect(dockerStatus).toBeDefined();
      expect(dockerStatus!.state).toBe("connected");
      expect(dockerStatus!.shell).toBeTruthy();
      expect(dockerStatus!.platform).toBe("linux");
    });

    it("closes and reconnects", async () => {
      await pool.closeConnection("docker-test");
      const status = pool.getStatus();
      expect(status.has("docker-test")).toBe(false);

      // Should reconnect on next use
      const transport = await pool.getConnection("docker-test");
      expect(transport.state).toBe("connected");
    });
  });

  // =========================================================================
  // Binary file handling
  // =========================================================================
  describe("binary files", () => {
    it("Docker: round-trips binary content", async () => {
      tm.switchTarget("docker-test");
      const writeOps = createRemoteWriteOps(pool, tm);
      const readOps = createRemoteReadOps(pool, tm);

      // Write binary content (all byte values 0-255)
      const binary = Buffer.alloc(256);
      for (let i = 0; i < 256; i++) binary[i] = i;

      // WriteOperations takes string, but we need Buffer for binary
      // Use transport directly for binary
      const transport = await pool.getConnection("docker-test");
      await transport.writeFile("/workspace/e2e-binary.bin", binary);
      const read = await transport.readFile("/workspace/e2e-binary.bin");
      expect(read.equals(binary)).toBe(true);

      await transport.exec("rm /workspace/e2e-binary.bin");
    });

    it("SSH: round-trips binary content", async () => {
      tm.switchTarget("ssh-test");
      const transport = await pool.getConnection("ssh-test");

      const binary = Buffer.alloc(256);
      for (let i = 0; i < 256; i++) binary[i] = i;

      await transport.writeFile("/workspace/e2e-ssh-binary.bin", binary);
      const read = await transport.readFile("/workspace/e2e-ssh-binary.bin");
      expect(read.equals(binary)).toBe(true);

      await transport.exec("rm /workspace/e2e-ssh-binary.bin");
    });
  });
});
