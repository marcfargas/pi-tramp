/**
 * PowerShell transport integration tests.
 *
 * Tests DockerTransport and SshTransport against a target running pwsh.
 * Uses testuser-pwsh (login shell = pwsh) for SSH, and explicit shell
 * override for Docker.
 *
 * Requires:
 *   docker run -d --name pi-tramp-ssh-test -p 2222:22 pi-tramp-ssh-test
 *   (image must include pwsh + testuser-pwsh user)
 *
 * Run: npm run test:integration
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFile } from "child_process";
import { promisify } from "util";
import { join } from "path";
import { DockerTransport } from "../src/transport/docker-transport.js";
import { SshTransport } from "../src/transport/ssh-transport.js";
import type { DockerTargetConfig, SshTargetConfig } from "../src/types.js";
import { getTestPlatform } from "./helpers/platform.js";

const execFileAsync = promisify(execFile);
const TEMP = process.env.TEMP || process.env.TMP || "/tmp";
const KEY_PATH = join(TEMP, "pi-tramp-test-key");

const P = getTestPlatform();
const isWindows = P.os === "windows";

const DOCKER_CONTAINER = "pi-tramp-pwsh-docker";
const SSH_CONTAINER = P.sshContainer;
const IMAGE = P.image;

// =========================================================================
// Docker + pwsh
// =========================================================================
// Linux-only: uses /workspace paths and testuser-pwsh — e2e.integration.test.ts covers Windows.
describe.skipIf(isWindows)("DockerTransport (pwsh)", () => {
  let transport: DockerTransport;

  beforeAll(async () => {
    try { await execFileAsync("docker", ["rm", "-f", DOCKER_CONTAINER]); } catch { /* */ }
    await execFileAsync("docker", ["run", "-d", "--name", DOCKER_CONTAINER, IMAGE, ...P.keepaliveArgs]);
    await new Promise((r) => setTimeout(r, 500));

    transport = new DockerTransport({
      type: "docker",
      container: DOCKER_CONTAINER,
      shell: "pwsh", // Force pwsh
      cwd: "/workspace",
    } as DockerTargetConfig);

    await transport.connect();
  }, 30000);

  afterAll(async () => {
    await transport?.close();
    try { await execFileAsync("docker", ["rm", "-f", DOCKER_CONTAINER]); } catch { /* */ }
  });

  it("detects pwsh shell", () => {
    expect(transport.shell).toBe("pwsh");
  });

  it("detects linux platform", () => {
    expect(transport.platform).toBe("linux");
  });

  it("runs basic echo", async () => {
    const result = await transport.exec("Write-Output 'hello from pwsh'");
    expect(result.stdout.trim()).toBe("hello from pwsh");
    expect(result.exitCode).toBe(0);
  });

  it("captures exit code", async () => {
    const result = await transport.exec("exit 42");
    expect(result.exitCode).toBe(42);
  });

  it("handles multi-line output", async () => {
    const result = await transport.exec("1..5 | ForEach-Object { Write-Output \"line $_\" }");
    const lines = result.stdout.trim().split("\n").map((l) => l.trim());
    expect(lines).toHaveLength(5);
    expect(lines[0]).toBe("line 1");
    expect(lines[4]).toBe("line 5");
  });

  it("handles variables and expressions", async () => {
    const result = await transport.exec("$x = 42; Write-Output \"The answer is $x\"");
    expect(result.stdout.trim()).toBe("The answer is 42");
  });

  it("reads a file via base64", async () => {
    const data = await transport.readFile("/workspace/test.txt");
    expect(data.toString("utf8").trim()).toBe("hello world");
  });

  it("writes and reads a file", async () => {
    const content = Buffer.from("pwsh docker write test\n");
    await transport.writeFile("/workspace/pwsh-docker-write.txt", content);

    const read = await transport.readFile("/workspace/pwsh-docker-write.txt");
    expect(read.toString("utf8")).toBe("pwsh docker write test\n");

    await transport.exec("Remove-Item /workspace/pwsh-docker-write.txt");
  });

  it("handles binary content", async () => {
    const binary = Buffer.alloc(256);
    for (let i = 0; i < 256; i++) binary[i] = i;

    await transport.writeFile("/workspace/pwsh-docker-binary.bin", binary);
    const read = await transport.readFile("/workspace/pwsh-docker-binary.bin");
    expect(read.equals(binary)).toBe(true);

    await transport.exec("Remove-Item /workspace/pwsh-docker-binary.bin");
  });

  it("serializes concurrent commands", async () => {
    const results = await Promise.all([
      transport.exec("Write-Output 'a'"),
      transport.exec("Write-Output 'b'"),
      transport.exec("Write-Output 'c'"),
    ]);
    expect(results[0].stdout.trim()).toBe("a");
    expect(results[1].stdout.trim()).toBe("b");
    expect(results[2].stdout.trim()).toBe("c");
  });
});

// =========================================================================
// SSH + pwsh (testuser-pwsh has pwsh as login shell)
// =========================================================================
// Linux-only: uses /workspace paths, testuser-pwsh user — e2e.integration.test.ts covers Windows.
describe.skipIf(isWindows)("SshTransport (pwsh)", () => {
  let transport: SshTransport;

  beforeAll(async () => {
    try { await execFileAsync("docker", ["start", SSH_CONTAINER]); } catch { /* */ }
    await new Promise((r) => setTimeout(r, 1000));
    await execFileAsync("docker", ["cp", `${SSH_CONTAINER}:/test_key`, KEY_PATH]);

    transport = new SshTransport({
      type: "ssh",
      host: "testuser-pwsh@localhost",
      port: 2222,
      identityFile: KEY_PATH,
      shell: "pwsh",
      cwd: "/workspace",
    } as SshTargetConfig);

    await transport.connect();
  }, 30000);

  afterAll(async () => {
    await transport?.close();
  });

  it("detects pwsh shell", () => {
    expect(transport.shell).toBe("pwsh");
  });

  it("detects linux platform", () => {
    expect(transport.platform).toBe("linux");
  });

  it("runs basic echo", async () => {
    const result = await transport.exec("Write-Output 'hello from ssh pwsh'");
    expect(result.stdout.trim()).toBe("hello from ssh pwsh");
    expect(result.exitCode).toBe(0);
  });

  it("captures exit code", async () => {
    // Use a failing native command to set $LASTEXITCODE without killing session
    const result = await transport.exec("pwsh -NoProfile -Command 'exit 42'");
    expect(result.exitCode).toBe(42);
  });

  it("handles multi-line output", async () => {
    const result = await transport.exec("1..10 | ForEach-Object { Write-Output \"line $_\" }");
    const lines = result.stdout.trim().split("\n").map((l) => l.trim());
    expect(lines).toHaveLength(10);
    expect(lines[0]).toBe("line 1");
    expect(lines[9]).toBe("line 10");
  });

  it("handles variables", async () => {
    const result = await transport.exec("$greeting = 'Hello'; Write-Output \"$greeting World\"");
    expect(result.stdout.trim()).toBe("Hello World");
  });

  it("reads a file", async () => {
    const data = await transport.readFile("/workspace/test.txt");
    expect(data.toString("utf8").trim()).toBe("hello world");
  });

  it("writes and reads a file", async () => {
    const content = Buffer.from("pwsh ssh write test\n");
    await transport.writeFile("/workspace/pwsh-ssh-write.txt", content);

    const read = await transport.readFile("/workspace/pwsh-ssh-write.txt");
    expect(read.toString("utf8")).toBe("pwsh ssh write test\n");

    await transport.exec("Remove-Item /workspace/pwsh-ssh-write.txt");
  });

  it("handles binary content", async () => {
    const binary = Buffer.alloc(256);
    for (let i = 0; i < 256; i++) binary[i] = i;

    await transport.writeFile("/workspace/pwsh-ssh-binary.bin", binary);
    const read = await transport.readFile("/workspace/pwsh-ssh-binary.bin");
    expect(read.equals(binary)).toBe(true);

    await transport.exec("Remove-Item /workspace/pwsh-ssh-binary.bin");
  });

  it("serializes concurrent commands", async () => {
    const results = await Promise.all([
      transport.exec("Write-Output 'x'"),
      transport.exec("Write-Output 'y'"),
      transport.exec("Write-Output 'z'"),
    ]);
    expect(results[0].stdout.trim()).toBe("x");
    expect(results[1].stdout.trim()).toBe("y");
    expect(results[2].stdout.trim()).toBe("z");
  });

  it("handles rapid fire (10 commands)", async () => {
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        transport.exec(`Write-Output "rapid_${i}"`),
      ),
    );
    for (let i = 0; i < 10; i++) {
      expect(results[i].stdout.trim()).toBe(`rapid_${i}`);
    }
  });

  it("health check passes", async () => {
    expect(await transport.healthCheck()).toBe(true);
  });
});
