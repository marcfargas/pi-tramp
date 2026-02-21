/**
 * Context Injection — Tier 6.
 *
 * When target switches, injects context about the remote target:
 * - System prompt modification (before_agent_start)
 * - Remote AGENTS.md content (sendMessage)
 * - Status bar update
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { TargetManager } from "./target-manager.js";
import type { ConnectionPool } from "./connection-pool.js";

const MAX_AGENTS_MD_LINES = 100;

/**
 * Build context string for a target (for system prompt injection).
 */
function buildTargetContextPrompt(
  targetName: string,
  targetManager: TargetManager,
  pool: ConnectionPool,
): string {
  const target = targetManager.getTarget(targetName);
  if (!target) return "";

  const status = pool.getStatus();
  const connInfo = status.get(targetName);

  const lines: string[] = [
    "",
    `## Remote Target: ${targetName}`,
    "",
    `You are currently connected to a remote target. All read/write/edit/bash commands execute on this target.`,
    "",
    `- **Type**: ${target.config.type}`,
    `- **CWD**: ${target.config.cwd}`,
  ];

  if (connInfo) {
    lines.push(`- **Shell**: ${connInfo.shell}`);
    lines.push(`- **Platform**: ${connInfo.platform}`);
  }

  if (target.config.type === "ssh") {
    const cfg = target.config as { host: string; port?: number };
    lines.push(`- **Host**: ${cfg.host}:${cfg.port ?? 22}`);
  } else if (target.config.type === "docker") {
    const cfg = target.config as { container: string };
    lines.push(`- **Container**: ${cfg.container}`);
  }

  lines.push("");
  lines.push("**Important**: File paths are resolved relative to the remote CWD. The remote system may have a different OS, shell, and filesystem layout than local.");

  return lines.join("\n");
}

/**
 * Register system prompt and context injection hooks.
 */
export function registerContextInjection(
  pi: ExtensionAPI,
  targetManager: TargetManager,
  pool: ConnectionPool,
): void {
  // -------------------------------------------------------------------
  // System prompt: Inject target info on every agent turn
  // -------------------------------------------------------------------
  pi.on("before_agent_start", async (event) => {
    const current = targetManager.currentTarget;
    if (!current) return; // No target — don't modify prompt

    const contextBlock = buildTargetContextPrompt(current.name, targetManager, pool);
    const modified = event.systemPrompt + contextBlock;

    return { systemPrompt: modified };
  });

  // -------------------------------------------------------------------
  // Context injection on target switch: read remote AGENTS.md
  // -------------------------------------------------------------------
  targetManager.on("target_switched", async ({ from: _from, to }) => {
    if (to === "local") {
      // Switching to local — inject a note
      pi.sendMessage({
        customType: "pi-tramp-target-context",
        content: [{ type: "text", text: `Switched to local execution. All tools now run locally.` }],
        display: false,
      });
      return;
    }

    // Try to read remote .pi/AGENTS.md
    try {
      const transport = await pool.getConnection(to);
      const target = targetManager.getTarget(to);
      if (!target) return;

      let agentsMd = "";
      try {
        const cwd = target.config.cwd;
        const agentsPath = transport.platform === "windows"
          ? `${cwd}\\.pi\\AGENTS.md`
          : `${cwd}/.pi/AGENTS.md`;

        const data = await transport.readFile(agentsPath);
        const fullContent = data.toString("utf8");
        const lines = fullContent.split("\n");

        if (lines.length > MAX_AGENTS_MD_LINES) {
          agentsMd = lines.slice(0, MAX_AGENTS_MD_LINES).join("\n");
          agentsMd += `\n\n[Truncated: remote AGENTS.md has ${lines.length} lines, showing first ${MAX_AGENTS_MD_LINES}]`;
          console.warn(`[pi-tramp] Remote AGENTS.md is large (${lines.length} lines). Injecting first ${MAX_AGENTS_MD_LINES} lines only.`);
        } else {
          agentsMd = fullContent;
        }
      } catch {
        // No AGENTS.md — that's fine
      }

      const contextParts: string[] = [
        `Target switched to '${to}'.`,
        `Type: ${target.config.type}, Shell: ${transport.shell}, Platform: ${transport.platform} (${transport.arch})`,
        `CWD: ${target.config.cwd}`,
      ];

      if (agentsMd) {
        contextParts.push("", "--- Remote .pi/AGENTS.md ---", agentsMd);
      }

      pi.sendMessage({
        customType: "pi-tramp-target-context",
        content: [{ type: "text", text: contextParts.join("\n") }],
        display: false,
      });
    } catch (err) {
      // Connection failed — the switch still happened, context injection is best-effort
      console.error(`[pi-tramp] Context injection failed for '${to}':`, err);
    }
  });
}

/**
 * Register status bar widget showing current target.
 * Uses session_start to get the ExtensionContext (which has ui.setStatus).
 */
export function registerStatusBar(
  pi: ExtensionAPI,
  targetManager: TargetManager,
): void {
  // We need the ExtensionContext for ui.setStatus, captured on session_start
  let uiSetStatus: ((key: string, text: string | undefined) => void) | null = null;

  pi.on("session_start", async (_event, ctx) => {
    uiSetStatus = (key, text) => ctx.ui.setStatus(key, text);
    updateStatus();
  });

  const updateStatus = () => {
    if (!uiSetStatus) return;
    const current = targetManager.currentTarget;
    if (current) {
      const target = targetManager.getTarget(current.name);
      if (target) {
        const emoji = target.config.type === "ssh" ? "🔗" : target.config.type === "docker" ? "🐳" : "📡";
        uiSetStatus("pi-tramp", `${emoji} ${current.name}`);
      }
    } else {
      uiSetStatus("pi-tramp", undefined);
    }
  };

  // Update on target switch
  targetManager.on("target_switched", () => updateStatus());
}
