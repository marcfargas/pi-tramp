/**
 * SshTransport integration tests — Linux containers only.
 *
 * Requires: docker run -d --name pi-tramp-ssh-test -p 2222:22 pi-tramp-ssh-test
 *
 * Windows: skipped — Linux-specific paths (/workspace, rm, testuser-pwsh).
 * Windows SSH coverage is provided by e2e.integration.test.ts.
 *
 * Run: npm run test:integration
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFile } from "child_process";
import { promisify } from "util";
import { SshTransport } from "../src/transport/ssh-transport.js";
import { getTestPlatform } from "./helpers/platform.js";

const isWindows = getTestPlatform().os === "windows";
import type { SshTargetConfig } from "../src/types.js";
import { join } from "path";

const execFileAsync = promisify(execFile);

const CONTAINER = "pi-tramp-ssh-test";
const TEMP = process.env.TEMP || process.env.TMP || "/tmp";
const KEY_PATH = join(TEMP, "pi-tramp-test-key");

let transport: SshTransport;

describe.skipIf(isWindows)("SshTransport", () => {
  beforeAll(async () => {
    // Ensure SSH container is running
    try {
      await execFileAsync("docker", ["start", CONTAINER]);
    } catch {
      // Container might not exist — create it
      await execFileAsync("docker", [
        "run", "-d", "--name", CONTAINER, "-p", "2222:22", "pi-tramp-ssh-test",
      ]);
    }

    // Wait for sshd to start
    await new Promise((r) => setTimeout(r, 1000));

    // Extract the key and fix permissions (Windows docker cp creates broad ACLs)
    await execFileAsync("docker", ["cp", `${CONTAINER}:/test_key`, KEY_PATH]);
    const { fixKeyPermissions } = await import("./helpers/platform.js");
    await fixKeyPermissions(KEY_PATH);

    transport = new SshTransport({
      type: "ssh",
      host: "testuser@127.0.0.1",
      port: 2222,
      identityFile: KEY_PATH,
      cwd: "/workspace",
    } as SshTargetConfig);

    await transport.connect();
  }, 30000);

  afterAll(async () => {
    await transport.close();
  });

  describe("connection", () => {
    it("detects bash shell", () => {
      expect(["bash", "sh"]).toContain(transport.shell);
    });

    it("detects Linux platform", () => {
      expect(transport.platform).toBe("linux");
    });

    it("detects architecture", () => {
      expect(transport.arch).toBeTruthy();
      expect(transport.arch).not.toBe("unknown");
    });

    it("is connected", () => {
      expect(transport.state).toBe("connected");
    });
  });

  describe("exec (sentinel protocol)", () => {
    it("runs basic echo", async () => {
      const result = await transport.exec("echo hello");
      expect(result.stdout.trim()).toBe("hello");
      expect(result.exitCode).toBe(0);
    });

    it("captures exit code", async () => {
      const result = await transport.exec("(exit 42)");
      expect(result.exitCode).toBe(42);
    });

    it("handles multi-line output", async () => {
      const result = await transport.exec('for i in 1 2 3 4 5; do echo "line $i"; done');
      const lines = result.stdout.trim().split("\n");
      expect(lines).toHaveLength(5);
      expect(lines[0]).toBe("line 1");
      expect(lines[4]).toBe("line 5");
    });

    it("handles empty output", async () => {
      const result = await transport.exec("true");
      expect(result.stdout.trim()).toBe("");
      expect(result.exitCode).toBe(0);
    });

    it("handles large output (10,000 lines)", async () => {
      const result = await transport.exec("seq 1 10000");
      const lines = result.stdout.trim().split("\n");
      expect(lines).toHaveLength(10000);
      expect(lines[0]).toBe("1");
      expect(lines[9999]).toBe("10000");
    }, 15000);

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

    it("handles rapid fire (20 commands)", async () => {
      const results = await Promise.all(
        Array.from({ length: 20 }, (_, i) =>
          transport.exec(`echo "rapid_${i}"`),
        ),
      );
      for (let i = 0; i < 20; i++) {
        expect(results[i].stdout.trim()).toBe(`rapid_${i}`);
      }
    });

    it("preserves special characters in output", async () => {
      const result = await transport.exec("echo 'hello $world \"quotes\" `backticks`'");
      expect(result.stdout.trim()).toContain("$world");
      expect(result.stdout.trim()).toContain('"quotes"');
    });
  });

  describe("file operations", () => {
    it("reads a file", async () => {
      const data = await transport.readFile("/workspace/test.txt");
      expect(data.toString("utf8").trim()).toBe("hello world");
    });

    it("writes and reads a file", async () => {
      const content = Buffer.from("ssh write test\n");
      await transport.writeFile("/workspace/ssh-write-test.txt", content);

      const read = await transport.readFile("/workspace/ssh-write-test.txt");
      expect(read.toString("utf8")).toBe("ssh write test\n");

      await transport.exec("rm /workspace/ssh-write-test.txt");
    });

    it("handles binary content via base64", async () => {
      const binary = Buffer.alloc(256);
      for (let i = 0; i < 256; i++) binary[i] = i;

      await transport.writeFile("/workspace/ssh-binary.bin", binary);
      const read = await transport.readFile("/workspace/ssh-binary.bin");
      expect(read.equals(binary)).toBe(true);

      await transport.exec("rm /workspace/ssh-binary.bin");
    });

    it("creates parent directories on write", async () => {
      const content = Buffer.from("deep write\n");
      await transport.writeFile("/workspace/ssh-deep/nested/file.txt", content);

      const read = await transport.readFile("/workspace/ssh-deep/nested/file.txt");
      expect(read.toString("utf8")).toBe("deep write\n");

      await transport.exec("rm -rf /workspace/ssh-deep");
    });
  });

  describe("health check", () => {
    it("returns true when connected", async () => {
      expect(await transport.healthCheck()).toBe(true);
    });
  });
});
