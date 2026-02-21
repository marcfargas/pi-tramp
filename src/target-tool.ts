/**
 * Target Tool — Tier 5.
 *
 * Registers the "target" tool that lets the agent manage remote targets:
 * - list: Show available targets and current selection
 * - switch: Switch to a different target (or "local" for no target)
 * - status: Show connection status and health
 * - add: Add a dynamic target (not persisted)
 * - remove: Remove a dynamic target
 */

import type { ExtensionAPI, AgentToolResult } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import type { TargetManager } from "./target-manager.js";
import type { ConnectionPool } from "./connection-pool.js";
import { type TargetConfig, TargetConfigSchema } from "./types.js";
import type { RuntimeState } from "./tool-overrides.js";

const targetSchema = Type.Object({
  action: Type.Union(
    [
      Type.Literal("list"),
      Type.Literal("switch"),
      Type.Literal("status"),
      Type.Literal("add"),
      Type.Literal("remove"),
    ],
    { description: "Action: list, switch, status, add, remove" },
  ),
  name: Type.Optional(
    Type.String({ description: "Target name (for switch, add, remove)" }),
  ),
  config: Type.Optional(
    Type.String({ description: "JSON config for add action (e.g., {\"type\":\"ssh\",\"host\":\"user@host\",\"port\":22,\"cwd\":\"/home/user\"})" }),
  ),
});

type TargetToolInput = { action: string; name?: string; config?: string };

function textResult(text: string): AgentToolResult<unknown> {
  return { content: [{ type: "text", text }], details: {} };
}

export function registerTargetTool(
  pi: ExtensionAPI,
  state: RuntimeState,
): void {
  pi.registerTool({
    name: "target",
    label: "target",
    description: `pi-tramp: Remote target management. When active, all tool calls (read, write, edit, bash) execute on the remote target instead of locally. Use this tool to connect to SSH servers or Docker containers.

Actions:
- list: Show configured targets and which is active
- switch <name>: Connect to a target. All subsequent read/write/edit/bash calls execute there. Use "local" to return to local execution.
- status: Show connection health for all targets
- add <name> --config <json>: Add a target. Config: {"type":"ssh","host":"user@host","port":22,"cwd":"/path"} or {"type":"docker","container":"name","cwd":"/path"}. Optional: "shell":"pwsh" for PowerShell targets.
- remove <name>: Remove a dynamic target

After switching, you do NOT need special syntax — just use read/write/edit/bash normally and they execute on the remote target transparently.`,
    parameters: targetSchema,

    async execute(_toolCallId, params: TargetToolInput) {
      const { action, name, config } = params;

      switch (action) {
        case "list":
          return handleList(state.targetManager);

        case "switch":
          return handleSwitch(state.targetManager, state.pool, name);

        case "status":
          return handleStatus(state.targetManager, state.pool);

        case "add":
          return handleAdd(state.targetManager, name, config);

        case "remove":
          return handleRemove(state.targetManager, state.pool, name);

        default:
          return textResult(`Unknown action: ${action}. Use: list, switch, status, add, remove`);
      }
    },
  });
}

// ---------------------------------------------------------------------------
// Action handlers
// ---------------------------------------------------------------------------

function handleList(tm: TargetManager): AgentToolResult<unknown> {
  const targets = tm.listTargets();
  const current = tm.currentTarget;

  if (targets.length === 0) {
    return textResult("No targets configured. Using local execution.\n\nAdd targets in .pi/targets.json or ~/.pi/targets.json");
  }

  const lines: string[] = ["Available targets:", ""];
  for (const t of targets) {
    const active = current && current.name === t.name ? " ← active" : "";
    const dynamic = t.isDynamic ? " (dynamic)" : "";
    const type = t.config.type;
    const info = type === "ssh"
      ? `ssh://${(t.config as TargetConfig & { type: "ssh" }).host}:${(t.config as TargetConfig & { type: "ssh" }).port}`
      : type === "docker"
        ? `docker://${(t.config as TargetConfig & { type: "docker" }).container}`
        : type;

    lines.push(`  ${t.name}: ${info} → ${t.config.cwd}${dynamic}${active}`);
  }

  if (!current) {
    lines.push("", "Currently: local execution (no target active)");
  }

  return textResult(lines.join("\n"));
}

async function handleSwitch(
  tm: TargetManager,
  pool: ConnectionPool,
  name?: string,
): Promise<AgentToolResult<unknown>> {
  if (!name) {
    return textResult("Usage: target switch <name> (or \"local\" for local execution)");
  }

  if (name === "local") {
    const prev = tm.currentTarget?.name ?? "local";
    tm.switchTarget("local");
    return textResult(`Switched from '${prev}' to local execution. Tools now execute locally.`);
  }

  const target = tm.getTarget(name);
  if (!target) {
    const available = tm.listTargets().map((t) => t.name).join(", ");
    return textResult(`Target '${name}' not found. Available: ${available || "none"}`);
  }

  try {
    // Eagerly connect to validate the target works
    const transport = await pool.getConnection(name);

    // Auto-fill cwd from remote homedir if not configured
    if (!target.config.cwd && transport.homedir) {
      target.config.cwd = transport.homedir;
    }

    tm.switchTarget(name);

    const effectiveCwd = target.config.cwd ?? "(unknown — will use remote default)";
    const info = [
      `Switched to target '${name}'.`,
      `  Type: ${target.config.type}`,
      `  Shell: ${transport.shell}`,
      `  Platform: ${transport.platform} (${transport.arch})`,
      `  CWD: ${effectiveCwd}`,
      "",
      "All read/write/edit/bash commands now execute on this target.",
    ];
    return textResult(info.join("\n"));
  } catch (err) {
    return textResult(`Failed to connect to '${name}': ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function handleStatus(
  tm: TargetManager,
  pool: ConnectionPool,
): Promise<AgentToolResult<unknown>> {
  const targets = tm.listTargets();
  const current = tm.currentTarget;

  if (targets.length === 0) {
    return textResult("No targets configured.");
  }

  const lines: string[] = ["Target Status:", ""];
  const poolStatus = pool.getStatus();

  for (const t of targets) {
    const active = current && current.name === t.name ? " ← active" : "";
    const connInfo = poolStatus.get(t.name);

    if (connInfo) {
      lines.push(`  ${t.name}: ${connInfo.state} (${connInfo.shell}/${connInfo.platform})${active}`);
    } else {
      lines.push(`  ${t.name}: not connected${active}`);
    }
  }

  return textResult(lines.join("\n"));
}

function handleAdd(
  tm: TargetManager,
  name?: string,
  configJson?: string,
): AgentToolResult<unknown> {
  if (!name || !configJson) {
    return textResult(
      "Usage: target add <name> --config '{\"type\":\"ssh\",\"host\":\"user@host\"}'\n" +
      "cwd is optional — auto-detected from remote home directory on connect.",
    );
  }

  try {
    const raw = JSON.parse(configJson);
    const config = TargetConfigSchema.parse(raw);
    tm.createTarget(name, config);
    return textResult(`Target '${name}' added (dynamic, not persisted).`);
  } catch (err) {
    return textResult(`Failed to add target '${name}': ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function handleRemove(
  tm: TargetManager,
  pool: ConnectionPool,
  name?: string,
): Promise<AgentToolResult<unknown>> {
  if (!name) {
    return textResult("Usage: target remove <name>");
  }

  const target = tm.getTarget(name);
  if (!target) {
    return textResult(`Target '${name}' not found.`);
  }

  if (!target.isDynamic) {
    return textResult(`Target '${name}' is from config file — cannot remove. Edit .pi/targets.json instead.`);
  }

  // Close connection if open
  await pool.closeConnection(name);
  tm.removeTarget(name);
  return textResult(`Target '${name}' removed.`);
}
