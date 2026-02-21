/**
 * DockerTransport integration tests — Linux containers only.
 *
 * Requires: docker run -d --name pi-tramp-ssh-test -p 2222:22 pi-tramp-ssh-test
 * (The SSH test container also works as a Docker exec target.)
 *
 * Windows: skipped — Linux-specific commands (echo -e, true, rm).
 * Windows Docker coverage is provided by e2e.integration.test.ts.
 *
 * Run: npm run test:integration
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFile } from "child_process";
import { promisify } from "util";
import { DockerTransport } from "../src/transport/docker-transport.js";
import type { DockerTargetConfig } from "../src/types.js";
import { getTestPlatform } from "./helpers/platform.js";

const execFileAsync = promisify(execFile);
const P = getTestPlatform();
const isWindows = P.os === "windows";

const CONTAINER = "pi-tramp-test-docker";
const IMAGE = P.image; // platform-aware: pi-tramp-ssh-test (Linux) or pi-tramp-win-test (Windows)

let transport: DockerTransport;

describe.skipIf(isWindows)("DockerTransport", () => {
  beforeAll(async () => {
    // Start a fresh container for testing
    try {
      await execFileAsync("docker", ["rm", "-f", CONTAINER]);
    } catch { /* ignore */ }

    await execFileAsync("docker", [
      "run", "-d", "--name", CONTAINER, IMAGE,
      ...P.keepaliveArgs,
    ]);

    // Wait a moment for container to be ready
    await new Promise((r) => setTimeout(r, 500));

    transport = new DockerTransport({
      type: "docker",
      container: CONTAINER,
      cwd: "/workspace",
    } as DockerTargetConfig);

    await transport.connect();
  }, 30000);

  afterAll(async () => {
    await transport.close();
    try {
      await execFileAsync("docker", ["rm", "-f", CONTAINER]);
    } catch { /* ignore */ }
  });

  describe("connection", () => {
    it("detects shell", () => {
      expect(["bash", "sh"]).toContain(transport.shell);
    });

    it("detects platform", () => {
      expect(transport.platform).toBe("linux");
    });

    it("detects arch", () => {
      expect(transport.arch).toBeTruthy();
      expect(transport.arch).not.toBe("unknown");
    });

    it("is in connected state", () => {
      expect(transport.state).toBe("connected");
    });

    it("has a shell driver", () => {
      expect(transport.driver).not.toBeNull();
    });
  });

  describe("exec", () => {
    it("runs basic echo", async () => {
      const result = await transport.exec("echo hello");
      expect(result.stdout.trim()).toBe("hello");
      expect(result.exitCode).toBe(0);
    });

    it("captures exit code", async () => {
      const result = await transport.exec("(exit 42)");
      expect(result.exitCode).toBe(42);
    });

    it("captures multi-line output", async () => {
      const result = await transport.exec("echo -e 'line1\\nline2\\nline3'");
      const lines = result.stdout.trim().split("\n");
      expect(lines).toHaveLength(3);
    });

    it("handles empty output", async () => {
      const result = await transport.exec("true");
      expect(result.stdout.trim()).toBe("");
      expect(result.exitCode).toBe(0);
    });

    it("serializes concurrent commands", async () => {
      const results = await Promise.all([
        transport.exec("echo a"),
        transport.exec("echo b"),
        transport.exec("echo c"),
      ]);
      expect(results[0].stdout.trim()).toBe("a");
      expect(results[1].stdout.trim()).toBe("b");
      expect(results[2].stdout.trim()).toBe("c");
    });
  });

  describe("file operations", () => {
    it("reads a file", async () => {
      const data = await transport.readFile("/workspace/test.txt");
      expect(data.toString("utf8").trim()).toBe("hello world");
    });

    it("writes and reads a file", async () => {
      const content = Buffer.from("pi-tramp write test\n");
      await transport.writeFile("/workspace/write-test.txt", content);

      const read = await transport.readFile("/workspace/write-test.txt");
      expect(read.toString("utf8")).toBe("pi-tramp write test\n");

      // Cleanup
      await transport.exec("rm /workspace/write-test.txt");
    });

    it("writes to nested directory (creates parents)", async () => {
      const content = Buffer.from("nested content\n");
      await transport.writeFile("/workspace/deep/nested/dir/file.txt", content);

      const read = await transport.readFile("/workspace/deep/nested/dir/file.txt");
      expect(read.toString("utf8")).toBe("nested content\n");

      // Cleanup
      await transport.exec("rm -rf /workspace/deep");
    });

    it("handles binary content via base64", async () => {
      // Create a buffer with all byte values 0-255
      const binary = Buffer.alloc(256);
      for (let i = 0; i < 256; i++) binary[i] = i;

      await transport.writeFile("/workspace/binary-test.bin", binary);
      const read = await transport.readFile("/workspace/binary-test.bin");
      expect(read.equals(binary)).toBe(true);

      await transport.exec("rm /workspace/binary-test.bin");
    });

    it("rejects reading nonexistent file", async () => {
      await expect(transport.readFile("/nonexistent/file.txt")).rejects.toThrow();
    });
  });

  describe("health check", () => {
    it("returns true when connected", async () => {
      expect(await transport.healthCheck()).toBe(true);
    });
  });
});
