import { describe, it, expect, beforeEach, vi } from "vitest";
import { TargetManager } from "../src/target-manager.js";
import type { TargetConfig } from "../src/types.js";
import { writeFile, mkdir, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { randomUUID } from "crypto";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sshConfig(overrides?: Partial<TargetConfig>): TargetConfig {
  return {
    type: "ssh",
    host: "user@host",
    cwd: "/home/user",
    shell: "bash",
    ...overrides,
  } as TargetConfig;
}

function dockerConfig(overrides?: Partial<TargetConfig>): TargetConfig {
  return {
    type: "docker",
    container: "my-container",
    cwd: "/workspace",
    ...overrides,
  } as TargetConfig;
}

async function createTempDir(): Promise<string> {
  const dir = join(tmpdir(), `pi-tramp-test-${randomUUID()}`);
  await mkdir(dir, { recursive: true });
  return dir;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("TargetManager", () => {
  let tm: TargetManager;

  beforeEach(() => {
    tm = new TargetManager();
  });

  describe("CRUD", () => {
    it("starts with no targets", () => {
      expect(tm.listTargets()).toEqual([]);
      expect(tm.currentTarget).toBeNull();
      expect(tm.currentTargetName).toBeNull();
    });

    it("creates a dynamic target", () => {
      const target = tm.createTarget("dev", sshConfig());
      expect(target.name).toBe("dev");
      expect(target.isDynamic).toBe(true);
      expect(target.config.type).toBe("ssh");
      expect(tm.getTarget("dev")).toBe(target);
    });

    it("creates a persistent target", () => {
      const target = tm.createTarget("dev", sshConfig(), true);
      expect(target.isDynamic).toBe(false);
    });

    it("lists all targets", () => {
      tm.createTarget("dev", sshConfig());
      tm.createTarget("staging", dockerConfig());
      expect(tm.listTargets()).toHaveLength(2);
    });

    it("removes a target", () => {
      tm.createTarget("dev", sshConfig());
      tm.removeTarget("dev");
      expect(tm.getTarget("dev")).toBeUndefined();
    });

    it("throws on duplicate name", () => {
      tm.createTarget("dev", sshConfig());
      expect(() => tm.createTarget("dev", sshConfig())).toThrow("already exists");
    });

    it("throws on reserved name 'local'", () => {
      expect(() => tm.createTarget("local", sshConfig())).toThrow("reserved");
    });

    it("throws on invalid name characters", () => {
      expect(() => tm.createTarget("my target", sshConfig())).toThrow("alphanumeric");
    });

    it("throws when removing nonexistent target", () => {
      expect(() => tm.removeTarget("ghost")).toThrow("not found");
    });
  });

  describe("switching", () => {
    it("switches to a target", () => {
      tm.createTarget("dev", sshConfig());
      tm.switchTarget("dev");
      expect(tm.currentTargetName).toBe("dev");
      expect(tm.currentTarget?.name).toBe("dev");
    });

    it("switches between targets", () => {
      tm.createTarget("dev", sshConfig());
      tm.createTarget("staging", dockerConfig());
      tm.switchTarget("dev");
      tm.switchTarget("staging");
      expect(tm.currentTargetName).toBe("staging");
    });

    it("switches to local (clears current)", () => {
      tm.createTarget("dev", sshConfig());
      tm.switchTarget("dev");
      tm.switchTarget("local");
      expect(tm.currentTargetName).toBeNull();
      expect(tm.currentTarget).toBeNull();
    });

    it("clearTarget clears current", () => {
      tm.createTarget("dev", sshConfig());
      tm.switchTarget("dev");
      tm.clearTarget();
      expect(tm.currentTargetName).toBeNull();
    });

    it("throws on nonexistent target", () => {
      expect(() => tm.switchTarget("ghost")).toThrow("not found");
    });

    it("removing current target clears it", () => {
      tm.createTarget("dev", sshConfig());
      tm.switchTarget("dev");
      tm.removeTarget("dev");
      expect(tm.currentTargetName).toBeNull();
    });
  });

  describe("events", () => {
    it("emits target_switched on switch", () => {
      const listener = vi.fn();
      tm.on("target_switched", listener);
      tm.createTarget("dev", sshConfig());
      tm.switchTarget("dev");

      expect(listener).toHaveBeenCalledOnce();
      expect(listener).toHaveBeenCalledWith({ from: null, to: "dev" });
    });

    it("emits target_switched with previous target", () => {
      const listener = vi.fn();
      tm.createTarget("dev", sshConfig());
      tm.createTarget("staging", dockerConfig());
      tm.switchTarget("dev");

      tm.on("target_switched", listener);
      tm.switchTarget("staging");

      expect(listener).toHaveBeenCalledWith({ from: "dev", to: "staging" });
    });

    it("emits target_switched on switch to local", () => {
      const listener = vi.fn();
      tm.createTarget("dev", sshConfig());
      tm.switchTarget("dev");

      tm.on("target_switched", listener);
      tm.switchTarget("local");

      expect(listener).toHaveBeenCalledWith({ from: "dev", to: "local" });
    });

    it("does not emit when switching to same target", () => {
      const listener = vi.fn();
      tm.createTarget("dev", sshConfig());
      tm.switchTarget("dev");

      tm.on("target_switched", listener);
      tm.switchTarget("dev");

      expect(listener).not.toHaveBeenCalled();
    });

    it("does not emit clearTarget when already null", () => {
      const listener = vi.fn();
      tm.on("target_switched", listener);
      tm.clearTarget();
      expect(listener).not.toHaveBeenCalled();
    });
  });

  describe("config loading", () => {
    it("loads from project config file", async () => {
      const dir = await createTempDir();
      const piDir = join(dir, ".pi");
      await mkdir(piDir, { recursive: true });
      await writeFile(
        join(piDir, "targets.json"),
        JSON.stringify({
          default: "dev",
          targets: {
            dev: { type: "ssh", host: "user@host", cwd: "/home", shell: "bash" },
          },
        }),
      );

      const manager = new TargetManager(dir);
      await manager.loadConfig();

      expect(manager.listTargets()).toHaveLength(1);
      expect(manager.getTarget("dev")).toBeDefined();
      expect(manager.currentTargetName).toBe("dev");

      await rm(dir, { recursive: true, force: true });
    });

    it("handles missing config files gracefully", async () => {
      const dir = await createTempDir();
      const manager = new TargetManager(dir);
      await manager.loadConfig();

      expect(manager.listTargets()).toHaveLength(0);
      expect(manager.currentTargetName).toBeNull();

      await rm(dir, { recursive: true, force: true });
    });

    it("throws on invalid JSON", async () => {
      const dir = await createTempDir();
      const piDir = join(dir, ".pi");
      await mkdir(piDir, { recursive: true });
      await writeFile(join(piDir, "targets.json"), "not json");

      const manager = new TargetManager(dir);
      await expect(manager.loadConfig()).rejects.toThrow("Invalid JSON");

      await rm(dir, { recursive: true, force: true });
    });

    it("throws on invalid schema", async () => {
      const dir = await createTempDir();
      const piDir = join(dir, ".pi");
      await mkdir(piDir, { recursive: true });
      await writeFile(
        join(piDir, "targets.json"),
        JSON.stringify({
          targets: {
            dev: { type: "ssh" }, // missing host and cwd
          },
        }),
      );

      const manager = new TargetManager(dir);
      await expect(manager.loadConfig()).rejects.toThrow("Invalid targets config");

      await rm(dir, { recursive: true, force: true });
    });

    it("preserves dynamic targets on reload", async () => {
      const dir = await createTempDir();
      const piDir = join(dir, ".pi");
      await mkdir(piDir, { recursive: true });
      await writeFile(
        join(piDir, "targets.json"),
        JSON.stringify({
          targets: {
            dev: { type: "ssh", host: "user@host", cwd: "/home", shell: "bash" },
          },
        }),
      );

      const manager = new TargetManager(dir);
      await manager.loadConfig();
      manager.createTarget("dynamic-one", dockerConfig());

      // Reload config
      await manager.loadConfig();

      expect(manager.getTarget("dev")).toBeDefined();
      expect(manager.getTarget("dynamic-one")).toBeDefined();

      await rm(dir, { recursive: true, force: true });
    });
  });
});
