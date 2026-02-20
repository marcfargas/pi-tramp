/**
 * Remote Operations integration tests.
 *
 * Tests ReadOperations, WriteOperations, EditOperations, BashOperations
 * via ConnectionPool against a real Docker container.
 *
 * Run: npm run test:integration
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFile } from "child_process";
import { promisify } from "util";
import { TargetManager } from "../src/target-manager.js";
import { ConnectionPool } from "../src/connection-pool.js";
import {
  createRemoteReadOps,
  createRemoteWriteOps,
  createRemoteEditOps,
  createRemoteBashOps,
} from "../src/operations/remote-ops.js";
import type { TargetConfig } from "../src/types.js";

const execFileAsync = promisify(execFile);

const CONTAINER = "pi-tramp-test-ops";
const IMAGE = "pi-tramp-ssh-test";

let tm: TargetManager;
let pool: ConnectionPool;

describe("Remote Operations", () => {
  beforeAll(async () => {
    // Start container
    try { await execFileAsync("docker", ["rm", "-f", CONTAINER]); } catch { /* */ }
    await execFileAsync("docker", ["run", "-d", "--name", CONTAINER, IMAGE, "sleep", "infinity"]);
    await new Promise((r) => setTimeout(r, 500));

    // Setup target manager and pool
    tm = new TargetManager();
    tm.createTarget("test", {
      type: "docker",
      container: CONTAINER,
      cwd: "/workspace",
    } as TargetConfig);
    tm.switchTarget("test");

    pool = new ConnectionPool(tm);

    // Warm up connection
    await pool.getConnection("test");
  }, 30000);

  afterAll(async () => {
    await pool.closeAll();
    try { await execFileAsync("docker", ["rm", "-f", CONTAINER]); } catch { /* */ }
  });

  describe("ReadOperations", () => {
    const readOps = () => createRemoteReadOps(pool, tm);

    it("reads an existing file", async () => {
      const data = await readOps().readFile("/workspace/test.txt");
      expect(data.toString("utf8").trim()).toBe("hello world");
    });

    it("access succeeds for existing file", async () => {
      await readOps().access("/workspace/test.txt"); // should not throw
    });

    it("access fails for missing file", async () => {
      await expect(readOps().access("/workspace/nonexistent.txt")).rejects.toThrow("not found");
    });
  });

  describe("WriteOperations", () => {
    const writeOps = () => createRemoteWriteOps(pool, tm);

    it("writes a file", async () => {
      await writeOps().writeFile("/workspace/ops-write.txt", "ops write test\n");

      // Verify via transport
      const transport = await pool.getConnection("test");
      const result = await transport.exec("cat /workspace/ops-write.txt");
      expect(result.stdout).toBe("ops write test\n");

      await transport.exec("rm /workspace/ops-write.txt");
    });

    it("creates directories with mkdir", async () => {
      await writeOps().mkdir("/workspace/ops-test-dir/sub/deep");

      const transport = await pool.getConnection("test");
      const result = await transport.exec("test -d /workspace/ops-test-dir/sub/deep && echo ok");
      expect(result.stdout.trim()).toBe("ok");

      await transport.exec("rm -rf /workspace/ops-test-dir");
    });
  });

  describe("EditOperations", () => {
    const editOps = () => createRemoteEditOps(pool, tm);

    it("provides readFile + writeFile + access", async () => {
      const ops = editOps();
      expect(ops.readFile).toBeDefined();
      expect(ops.writeFile).toBeDefined();
      expect(ops.access).toBeDefined();
    });

    it("reads and writes for edit cycle", async () => {
      const ops = editOps();

      // Write initial content
      await ops.writeFile("/workspace/edit-test.txt", "line1\nline2\nline3\n");

      // Read it back
      const content = await ops.readFile("/workspace/edit-test.txt");
      expect(content.toString("utf8")).toBe("line1\nline2\nline3\n");

      // Write modified content
      const modified = content.toString("utf8").replace("line2", "MODIFIED");
      await ops.writeFile("/workspace/edit-test.txt", modified);

      // Verify
      const final = await ops.readFile("/workspace/edit-test.txt");
      expect(final.toString("utf8")).toContain("MODIFIED");

      // Cleanup
      const transport = await pool.getConnection("test");
      await transport.exec("rm /workspace/edit-test.txt");
    });
  });

  describe("BashOperations", () => {
    const bashOps = () => createRemoteBashOps(pool, tm);

    it("executes a command", async () => {
      const chunks: Buffer[] = [];
      const result = await bashOps().exec("echo hello from bash ops", "/workspace", {
        onData: (data) => chunks.push(data),
      });
      expect(result.exitCode).toBe(0);
      const output = Buffer.concat(chunks).toString("utf8");
      expect(output).toContain("hello from bash ops");
    });

    it("captures exit code", async () => {
      const result = await bashOps().exec("(exit 7)", "/workspace", {
        onData: () => {},
      });
      expect(result.exitCode).toBe(7);
    });

    it("runs in target cwd", async () => {
      const chunks: Buffer[] = [];
      await bashOps().exec("pwd", "/workspace", {
        onData: (data) => chunks.push(data),
      });
      const output = Buffer.concat(chunks).toString("utf8");
      expect(output.trim()).toBe("/workspace");
    });
  });
});
