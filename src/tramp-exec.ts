/**
 * trampExec() — public API for extension authors.
 * Stub — will be implemented in Tier 6.
 */

export type { ExecResult, ExecOptions } from "./types.js";

// Placeholder — implementation will come from Tier 6
export async function trampExec(
  _command: string,
  _options?: { target?: string; timeout?: number; signal?: AbortSignal },
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  throw new Error("pi-tramp not initialized. Is the extension loaded?");
}
