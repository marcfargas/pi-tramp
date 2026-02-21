/**
 * pi-tramp extension entry point — Tier 7.
 *
 * TRAMP-like transparent remote execution for pi.
 * Pi (brain) stays local, tools (read/write/edit/bash) execute on remote targets.
 *
 * Wires together all tiers:
 *  - TargetManager (config + state)
 *  - ConnectionPool (transport lifecycle)
 *  - Tool overrides (read/write/edit/bash → remote)
 *  - Target tool (list/switch/status/add/remove)
 *  - Context injection (system prompt, AGENTS.md, status bar)
 *  - trampExec (public API for other extensions)
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { TargetManager } from "./target-manager.js";
import { ConnectionPool } from "./connection-pool.js";
import { registerToolOverrides } from "./tool-overrides.js";
import { registerTargetTool } from "./target-tool.js";
import { registerContextInjection, registerStatusBar } from "./context-injection.js";
import { initTrampExec } from "./tramp-exec.js";

/**
 * Shared runtime state. All components reference this object,
 * so when session_start replaces the manager/pool, everyone
 * sees the new references.
 */
interface RuntimeState {
  targetManager: TargetManager;
  pool: ConnectionPool;
}

export default function (pi: ExtensionAPI) {
  // -------------------------------------------------------------------
  // Shared mutable state — all components read from this
  // -------------------------------------------------------------------
  const state: RuntimeState = {
    targetManager: new TargetManager(),
    pool: null as unknown as ConnectionPool,
  };
  state.pool = new ConnectionPool(state.targetManager);

  // -------------------------------------------------------------------
  // Initialize trampExec public API
  // -------------------------------------------------------------------
  initTrampExec(state.pool, state.targetManager);

  // -------------------------------------------------------------------
  // Load config on session start (with proper cwd)
  // -------------------------------------------------------------------
  pi.on("session_start", async (_event, ctx) => {
    try {
      // Recreate with proper project root
      state.targetManager = new TargetManager(ctx.cwd);
      state.pool = new ConnectionPool(state.targetManager);
      initTrampExec(state.pool, state.targetManager);

      await state.targetManager.loadConfig();

      // Connect to default target if one was configured
      const currentTarget = state.targetManager.currentTargetName;
      if (currentTarget && currentTarget !== "local") {
        try {
          await state.pool.getConnection(currentTarget);
          ctx.ui.notify(`pi-tramp: Connected to '${currentTarget}'`, "info");
        } catch (err) {
          ctx.ui.notify(
            `pi-tramp: Failed to connect to default target '${currentTarget}': ${err instanceof Error ? err.message : String(err)}`,
            "warning",
          );
        }
      }

      // Re-register status bar and context injection listeners on new targetManager
      registerContextInjection(pi, state.targetManager, state.pool);
      registerStatusBar(pi, state.targetManager);
    } catch (err) {
      ctx.ui.notify(
        `pi-tramp: Config error: ${err instanceof Error ? err.message : String(err)}`,
        "error",
      );
    }
  });

  // -------------------------------------------------------------------
  // Register tool overrides (read, write, edit, bash)
  // These closures read from `state` at call time.
  // -------------------------------------------------------------------
  registerToolOverrides(pi, state);

  // -------------------------------------------------------------------
  // Register target management tool
  // -------------------------------------------------------------------
  registerTargetTool(pi, state);

  // -------------------------------------------------------------------
  // Handle user ! commands via remote bash
  // -------------------------------------------------------------------
  pi.on("user_bash", (_event) => {
    const current = state.targetManager.currentTarget;
    if (!current) return; // No target — use local

    const { createRemoteBashOps } = require("./operations/remote-ops.js");
    return { operations: createRemoteBashOps(state.pool, state.targetManager) };
  });

  // -------------------------------------------------------------------
  // Cleanup on shutdown
  // -------------------------------------------------------------------
  pi.on("session_shutdown", async () => {
    await state.pool.closeAll();
  });
}
