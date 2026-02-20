/**
 * Shell detection — probes a target to determine shell, platform, and arch.
 *
 * See specs/shell-detection.md for the full algorithm.
 */

import type { ShellType, PlatformType } from "../types.js";

export interface DetectionResult {
  shell: ShellType;
  platform: PlatformType;
  arch: string;
}

/**
 * Parse shell type from `echo "$0"` output.
 */
export function parseShellName(output: string): ShellType {
  const cleaned = output.trim().toLowerCase();

  // Strip leading dash (login shell) and path
  const basename = cleaned.replace(/^-/, "").split("/").pop() ?? cleaned;

  switch (basename) {
    case "bash":
      return "bash";
    case "sh":
    case "dash":
    case "ash":
      return "sh";
    case "zsh":
      return "bash"; // zsh is POSIX-compatible enough for our commands
    case "pwsh":
    case "powershell":
      return "pwsh";
    case "cmd":
    case "cmd.exe":
      return "cmd";
    default:
      return "unknown";
  }
}

/**
 * Parse platform from `uname -s` output.
 */
export function parsePlatform(output: string): PlatformType {
  const cleaned = output.trim();

  if (cleaned === "Linux") return "linux";
  if (cleaned === "Darwin") return "darwin";
  if (cleaned.startsWith("MINGW") || cleaned.startsWith("MSYS") || cleaned.startsWith("CYGWIN")) {
    return "windows";
  }
  if (cleaned.toLowerCase() === "windows") return "windows";
  return "unknown";
}

/**
 * Parse architecture from `uname -m` output.
 */
export function parseArch(output: string): string {
  const cleaned = output.trim().toLowerCase();
  if (cleaned === "arm64") return "aarch64"; // normalize macOS arm64
  return cleaned || "unknown";
}

/**
 * Check if `$PSVersionTable` output indicates PowerShell.
 * Returns the major version number if pwsh, null otherwise.
 */
export function parsePwshVersion(output: string): number | null {
  const cleaned = output.trim();
  const version = parseInt(cleaned, 10);
  if (!isNaN(version) && version > 0) return version;
  return null;
}
