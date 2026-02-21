/**
 * Tool Overrides — Tier 5.
 *
 * Registers overrides for pi's built-in read/write/edit/bash tools.
 * When a target is active, operations route to the remote target.
 * When no target (or target is "local"), falls through to local execution.
 *
 * Uses pi's createReadTool/createWriteTool/createEditTool/createBashTool
 * with injected remote Operations.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
  createReadTool,
  createWriteTool,
  createEditTool,
  createBashTool,
} from "@mariozechner/pi-coding-agent";
import type { TargetManager } from "./target-manager.js";
import type { ConnectionPool } from "./connection-pool.js";
import {
  createRemoteReadOps,
  createRemoteWriteOps,
  createRemoteEditOps,
  createRemoteBashOps,
} from "./operations/remote-ops.js";

/** Shared runtime state — reads at call time, so session_start updates are visible. */
export interface RuntimeState {
  targetManager: TargetManager;
  pool: ConnectionPool;
}

/**
 * Register tool overrides for read, write, edit, bash.
 *
 * Each tool checks state.targetManager.currentTarget at call time:
 * - If a target is active → create tool with remote operations → execute
 * - If no target → use local tool → execute
 */
export function registerToolOverrides(
  pi: ExtensionAPI,
  state: RuntimeState,
): void {
  const localCwd = process.cwd();

  // Create local tools — we spread their schema/label/description/renderCall/renderResult
  const localRead = createReadTool(localCwd);
  const localWrite = createWriteTool(localCwd);
  const localEdit = createEditTool(localCwd);
  const localBash = createBashTool(localCwd);

  // Helper: is a remote target active?
  const isRemoteActive = () => state.targetManager.currentTarget !== null;

  // -------------------------------------------------------------------------
  // Read override
  // -------------------------------------------------------------------------
  pi.registerTool({
    ...localRead,
    label: "read",
    async execute(id, params, signal, onUpdate, _ctx) {
      if (isRemoteActive()) {
        const tool = createReadTool(localCwd, {
          operations: createRemoteReadOps(state.pool, state.targetManager),
        });
        return tool.execute(id, params, signal, onUpdate);
      }
      return localRead.execute(id, params, signal, onUpdate);
    },
  });

  // -------------------------------------------------------------------------
  // Write override
  // -------------------------------------------------------------------------
  pi.registerTool({
    ...localWrite,
    label: "write",
    async execute(id, params, signal, onUpdate, _ctx) {
      if (isRemoteActive()) {
        const tool = createWriteTool(localCwd, {
          operations: createRemoteWriteOps(state.pool, state.targetManager),
        });
        return tool.execute(id, params, signal, onUpdate);
      }
      return localWrite.execute(id, params, signal, onUpdate);
    },
  });

  // -------------------------------------------------------------------------
  // Edit override
  // -------------------------------------------------------------------------
  pi.registerTool({
    ...localEdit,
    label: "edit",
    async execute(id, params, signal, onUpdate, _ctx) {
      if (isRemoteActive()) {
        const tool = createEditTool(localCwd, {
          operations: createRemoteEditOps(state.pool, state.targetManager),
        });
        return tool.execute(id, params, signal, onUpdate);
      }
      return localEdit.execute(id, params, signal, onUpdate);
    },
  });

  // -------------------------------------------------------------------------
  // Bash override
  // -------------------------------------------------------------------------
  pi.registerTool({
    ...localBash,
    label: "bash",
    async execute(id, params, signal, onUpdate, _ctx) {
      if (isRemoteActive()) {
        const tool = createBashTool(localCwd, {
          operations: createRemoteBashOps(state.pool, state.targetManager),
        });
        return tool.execute(id, params, signal, onUpdate);
      }
      return localBash.execute(id, params, signal, onUpdate);
    },
  });
}
