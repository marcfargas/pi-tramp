/**
 * Shell detection — probes a target to determine shell, platform, and arch.
 *
 * See specs/shell-detection.md for the full algorithm.
 */

import type { ShellType, PlatformType } from "../types.js";

/** Strip ANSI escape sequences from shell output. */
function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b[[(][^\x1b]*?[a-zA-Z]|\x1b\][^\x07]*\x07/g, "");
}

export interface DetectionResult {
  shell: ShellType;
  platform: PlatformType;
  arch: string;
}

/**
 * Parse shell type from `echo "$0"` output.
 */
export function parseShellName(output: string): ShellType {
  const cleaned = stripAnsi(output).trim().toLowerCase();

  // Strip leading dash (login shell) and path (handles both / and \ separators)
  const basename = cleaned.replace(/^-/, "").split(/[/\\]/).pop()?.replace(/\.exe$/, "") ?? cleaned;

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
  const cleaned = stripAnsi(output).trim();

  if (cleaned === "Linux") return "linux";
  if (cleaned === "Darwin") return "darwin";
  if (cleaned.startsWith("MINGW") || cleaned.startsWith("MSYS") || cleaned.startsWith("CYGWIN")) {
    return "windows";
  }
  if (cleaned.toLowerCase() === "windows") return "windows";
  if (cleaned.startsWith("Windows_NT") || cleaned.startsWith("Windows")) return "windows";
  return "unknown";
}

/**
 * Parse architecture from `uname -m` output.
 */
export function parseArch(output: string): string {
  const cleaned = stripAnsi(output).trim().toLowerCase();
  if (cleaned.length > 64) return "unknown"; // Reject absurdly long values
  if (cleaned === "arm64") return "aarch64"; // normalize macOS arm64
  return cleaned || "unknown";
}

/**
 * Check if `$PSVersionTable` output indicates PowerShell.
 * Returns the major version number if pwsh, null otherwise.
 */
export function parsePwshVersion(output: string): number | null {
  const cleaned = stripAnsi(output).trim();
  // Strict: must be digits only (parseInt accepts garbage suffixes like "7junk")
  if (!/^\d+$/.test(cleaned)) return null;
  const version = parseInt(cleaned, 10);
  if (!isNaN(version) && version > 0) return version;
  return null;
}
