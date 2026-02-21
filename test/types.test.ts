import { describe, it, expect } from "vitest";
import {
  TargetConfigSchema,
  TargetsFileSchema,
  RemoteOperationError,
} from "../src/types.js";

describe("TargetConfigSchema", () => {
  it("validates SSH target", () => {
    const result = TargetConfigSchema.safeParse({
      type: "ssh",
      host: "marc@dev.server",
      cwd: "/home/marc",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.type).toBe("ssh");
      if (result.data.type === "ssh") {
        expect(result.data.port).toBe(22); // default
      }
      expect(result.data.timeout).toBe(60000); // default
      expect(result.data.requireEntryConfirmation).toBe(false); // default
    }
  });

  it("validates Docker target", () => {
    const result = TargetConfigSchema.safeParse({
      type: "docker",
      container: "my-container",
      cwd: "/workspace",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.type).toBe("docker");
      expect(result.data.timeout).toBe(30000); // docker default
    }
  });

  it("rejects SSH target without host", () => {
    const result = TargetConfigSchema.safeParse({
      type: "ssh",
      cwd: "/home/marc",
    });
    expect(result.success).toBe(false);
  });

  it("rejects Docker target without container", () => {
    const result = TargetConfigSchema.safeParse({
      type: "docker",
      cwd: "/workspace",
    });
    expect(result.success).toBe(false);
  });

  it("accepts missing cwd (auto-detected on connect)", () => {
    const result = TargetConfigSchema.safeParse({
      type: "ssh",
      host: "user@host",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.cwd).toBeUndefined();
    }
  });

  it("rejects empty cwd string", () => {
    const result = TargetConfigSchema.safeParse({
      type: "ssh",
      host: "user@host",
      cwd: "",
    });
    expect(result.success).toBe(false);
  });

  it("validates optional shell override", () => {
    const result = TargetConfigSchema.safeParse({
      type: "ssh",
      host: "user@host",
      cwd: "/home",
      shell: "pwsh",
    });
    expect(result.success).toBe(true);
  });

  it("rejects invalid shell", () => {
    const result = TargetConfigSchema.safeParse({
      type: "ssh",
      host: "user@host",
      cwd: "/home",
      shell: "fish",
    });
    expect(result.success).toBe(false);
  });

  it("rejects timeout < 1000ms", () => {
    const result = TargetConfigSchema.safeParse({
      type: "ssh",
      host: "user@host",
      cwd: "/home",
      timeout: 500,
    });
    expect(result.success).toBe(false);
  });

  it("validates SSH with custom port", () => {
    const result = TargetConfigSchema.safeParse({
      type: "ssh",
      host: "user@host",
      cwd: "/home",
      port: 2222,
    });
    expect(result.success).toBe(true);
    if (result.success && result.data.type === "ssh") {
      expect(result.data.port).toBe(2222);
    }
  });
});

describe("TargetsFileSchema", () => {
  it("validates complete config", () => {
    const result = TargetsFileSchema.safeParse({
      default: "dev",
      targets: {
        dev: { type: "ssh", host: "marc@dev", cwd: "/home/marc" },
        odoo: { type: "docker", container: "odoo-dev", cwd: "/workspace" },
      },
    });
    expect(result.success).toBe(true);
  });

  it("validates empty targets", () => {
    const result = TargetsFileSchema.safeParse({
      targets: {},
    });
    expect(result.success).toBe(true);
  });

  it("rejects 'local' as target name", () => {
    const result = TargetsFileSchema.safeParse({
      targets: {
        local: { type: "ssh", host: "user@host", cwd: "/home" },
      },
    });
    expect(result.success).toBe(false);
  });

  it("rejects default that doesn't exist in targets", () => {
    const result = TargetsFileSchema.safeParse({
      default: "nonexistent",
      targets: {
        dev: { type: "ssh", host: "user@host", cwd: "/home" },
      },
    });
    expect(result.success).toBe(false);
  });

  it("allows default: 'local' even without target", () => {
    const result = TargetsFileSchema.safeParse({
      default: "local",
      targets: {},
    });
    expect(result.success).toBe(true);
  });

  it("rejects invalid target name characters", () => {
    const result = TargetsFileSchema.safeParse({
      targets: {
        "my target": { type: "ssh", host: "user@host", cwd: "/home" },
      },
    });
    expect(result.success).toBe(false);
  });
});

describe("RemoteOperationError", () => {
  it("creates error with target and operation", () => {
    const err = new RemoteOperationError(
      "File not found",
      "dev",
      "read",
      { kind: "command_failed", code: 1, stderr: "No such file" },
    );
    expect(err.message).toBe("File not found");
    expect(err.target).toBe("dev");
    expect(err.operation).toBe("read");
    expect(err.transportError?.kind).toBe("command_failed");
    expect(err).toBeInstanceOf(Error);
  });
});
