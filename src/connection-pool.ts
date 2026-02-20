/**
 * ConnectionPool — Tier 3.
 *
 * Manages Transport lifecycle: lazy connect, caching, reconnect, cleanup.
 * Each target gets its own Transport instance, created on first use.
 */

import type {
  ConnectionPool as IConnectionPool,
  Transport,
  TargetConfig,
  SshTargetConfig,
  DockerTargetConfig,
} from "./types.js";
import { TargetManager } from "./target-manager.js";
import { DockerTransport } from "./transport/docker-transport.js";
import { SshTransport } from "./transport/ssh-transport.js";

export class ConnectionPool implements IConnectionPool {
  private connections: Map<string, Transport> = new Map();
  private connecting: Map<string, Promise<Transport>> = new Map();
  private targetManager: TargetManager;

  constructor(targetManager: TargetManager) {
    this.targetManager = targetManager;
  }

  /**
   * Get or create a connection for a target.
   * Lazy: connects on first call, reuses on subsequent calls.
   * If a connection is dead, removes it and creates a new one.
   */
  async getConnection(targetName: string): Promise<Transport> {
    // Check for existing healthy connection
    const existing = this.connections.get(targetName);
    if (existing && existing.state === "connected") {
      return existing;
    }

    // Remove dead connection
    if (existing) {
      this.connections.delete(targetName);
      try { await existing.close(); } catch { /* ignore */ }
    }

    // Check if already connecting (prevent duplicate connects)
    const pendingConnect = this.connecting.get(targetName);
    if (pendingConnect) return pendingConnect;

    // Create new connection
    const connectPromise = this.createConnection(targetName);
    this.connecting.set(targetName, connectPromise);

    try {
      const transport = await connectPromise;
      this.connections.set(targetName, transport);
      return transport;
    } finally {
      this.connecting.delete(targetName);
    }
  }

  /**
   * Execute a function with a transport, handling connection lifecycle.
   */
  async execOnTarget<T>(
    targetName: string,
    fn: (transport: Transport) => Promise<T>,
  ): Promise<T> {
    const transport = await this.getConnection(targetName);
    return fn(transport);
  }

  /**
   * Close a specific target's connection.
   */
  async closeConnection(targetName: string): Promise<void> {
    const conn = this.connections.get(targetName);
    if (conn) {
      this.connections.delete(targetName);
      await conn.close();
    }
  }

  /**
   * Close all connections. Called on extension deactivate.
   */
  async closeAll(): Promise<void> {
    const closePromises = Array.from(this.connections.entries()).map(
      async ([name, conn]) => {
        this.connections.delete(name);
        try { await conn.close(); } catch { /* ignore close errors */ }
      },
    );
    await Promise.all(closePromises);
  }

  /**
   * Get connection status for all targets (for status display).
   */
  getStatus(): Map<string, { state: string; shell?: string; platform?: string }> {
    const status = new Map<string, { state: string; shell?: string; platform?: string }>();
    for (const [name, conn] of this.connections) {
      status.set(name, {
        state: conn.state,
        shell: conn.shell,
        platform: conn.platform,
      });
    }
    return status;
  }

  // --- Internal ---

  private async createConnection(targetName: string): Promise<Transport> {
    const target = this.targetManager.getTarget(targetName);
    if (!target) {
      throw new Error(`Target '${targetName}' not found`);
    }

    const transport = this.createTransport(target.config);

    // Listen for disconnect events
    transport.on("disconnect", (err: Error) => {
      console.error(`[pi-tramp] Connection to '${targetName}' lost:`, err.message);
      this.connections.delete(targetName);
    });

    await transport.connect();
    return transport;
  }

  private createTransport(config: TargetConfig): Transport {
    switch (config.type) {
      case "ssh":
        return new SshTransport(config as SshTargetConfig);
      case "docker":
        return new DockerTransport(config as DockerTargetConfig);
      case "wsl":
        throw new Error("WSL transport not yet implemented (Phase 2)");
      case "psremote":
        throw new Error("PSRemote transport not yet implemented (Phase 2)");
      default:
        throw new Error(`Unknown transport type: ${(config as TargetConfig).type}`);
    }
  }
}
