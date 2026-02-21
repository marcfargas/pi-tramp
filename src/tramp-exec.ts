/**
 * trampExec() — public API for extension authors.
 *
 * Allows other pi extensions to execute commands on the current
 * (or a specific) remote target.
 */

import type { ExecResult, ExecOptions } from "./types.js";
import type { ConnectionPool } from "./connection-pool.js";
import type { TargetManager } from "./target-manager.js";

export type { ExecResult, ExecOptions } from "./types.js";

// Module-level references, set during extension activation
let _pool: ConnectionPool | null = null;
let _targetManager: TargetManager | null = null;

/**
 * Initialize trampExec with runtime references.
 * Called once during extension activate().
 */
export function initTrampExec(pool: ConnectionPool, targetManager: TargetManager): void {
  _pool = pool;
  _targetManager = targetManager;
}

/**
 * Execute a command on the current remote target (or a specific target).
 *
 * @param command - The shell command to execute
 * @param options - Optional: target name, timeout, abort signal
 * @returns ExecResult with stdout, stderr, exitCode
 * @throws Error if pi-tramp is not loaded or no target is active
 *
 * @example
 * ```typescript
 * import { trampExec } from "pi-tramp";
 *
 * // Execute on current target
 * const result = await trampExec("ls -la /etc");
 * console.log(result.stdout);
 *
 * // Execute on a specific target
 * const result = await trampExec("hostname", { target: "staging" });
 * ```
 */
export async function trampExec(
  command: string,
  options?: { target?: string; timeout?: number; signal?: AbortSignal },
): Promise<ExecResult> {
  if (!_pool || !_targetManager) {
    throw new Error("pi-tramp not initialized. Is the extension loaded?");
  }

  const targetName = options?.target ?? _targetManager.currentTarget?.name;
  if (!targetName) {
    throw new Error("No active target. Switch to a target first or specify one explicitly.");
  }

  const transport = await _pool.getConnection(targetName);
  return transport.exec(command, {
    timeout: options?.timeout,
    signal: options?.signal,
  });
}
