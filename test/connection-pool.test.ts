import { describe, it, expect, beforeEach } from "vitest";
import { ConnectionPool } from "../src/connection-pool.js";
import { TargetManager } from "../src/target-manager.js";
import type { TargetConfig } from "../src/types.js";

describe("ConnectionPool", () => {
  let tm: TargetManager;
  let pool: ConnectionPool;

  beforeEach(() => {
    tm = new TargetManager();
    pool = new ConnectionPool(tm);
  });

  it("throws when target not found", async () => {
    await expect(pool.getConnection("ghost")).rejects.toThrow("not found");
  });

  it("throws for unimplemented transports", async () => {
    tm.createTarget("wsl-target", {
      type: "wsl",
      distro: "Ubuntu",
      cwd: "/home",
    } as TargetConfig);

    await expect(pool.getConnection("wsl-target")).rejects.toThrow("not yet implemented");
  });

  it("closeAll works on empty pool", async () => {
    await pool.closeAll(); // Should not throw
  });

  it("getStatus returns empty map initially", () => {
    const status = pool.getStatus();
    expect(status.size).toBe(0);
  });
});
