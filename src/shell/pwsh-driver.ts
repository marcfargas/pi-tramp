/**
 * PwshDriver — ShellDriver implementation for PowerShell (pwsh 7+ and Windows PowerShell 5.1).
 *
 * Escaping uses single-quote doubling strategy.
 * See specs/shell-escaping.md for full rationale.
 */

import type { ShellDriver, ShellType } from "../types.js";

export class PwshDriver implements ShellDriver {
  readonly shell: ShellType = "pwsh";

  /**
   * Escape an argument for safe use in a PowerShell command.
   *
   * Strategy: single-quote everything, double embedded single quotes.
   * In PowerShell, single quotes are fully literal — no variable expansion,
   * no escape processing. Only the single quote itself needs escaping (by doubling).
   *
   * "it's" → 'it''s'
   */
  shellEscape(arg: string): string {
    if (arg.includes("\0")) {
      throw new Error("Shell argument contains null byte — cannot be safely escaped");
    }

    // Empty string → ''
    if (arg === "") return "''";

    // If arg contains no special chars, return as-is (optimization)
    // Note: backslash is safe in PowerShell single quotes (unlike bash)
    if (/^[a-zA-Z0-9._\-\/\\=:@]+$/.test(arg)) return arg;

    // Single-quote with doubled embedded quotes
    return "'" + arg.replace(/'/g, "''") + "'";
  }

  /**
   * Command to read a file as base64.
   * Uses .NET [Convert]::ToBase64String for reliable base64 encoding.
   */
  readFileCommand(absolutePath: string): string {
    const escaped = this.shellEscape(absolutePath);
    return `[Convert]::ToBase64String([IO.File]::ReadAllBytes(${escaped}))`;
  }

  /**
   * Command to write base64 content to a file atomically.
   * Strategy: create parent → WriteAllBytes to tmp → Move-Item to dest.
   *
   * Note: Move-Item -Force on NTFS is NOT atomic when dest exists.
   * This is a documented limitation (see specs/atomic-write.md).
   */
  writeFileCommand(absolutePath: string, base64Content: string, tmpPath: string): string {
    const escapedDst = this.shellEscape(absolutePath);
    const escapedTmp = this.shellEscape(tmpPath);
    const escapedParent = this.shellEscape(this.dirname(absolutePath));
    const escapedB64 = this.shellEscape(base64Content);

    return [
      `$d = ${escapedParent}`,
      `if (-not (Test-Path $d)) { New-Item -ItemType Directory -Force -Path $d | Out-Null }`,
      `[IO.File]::WriteAllBytes(${escapedTmp}, [Convert]::FromBase64String(${escapedB64}))`,
      `Move-Item -Force ${escapedTmp} ${escapedDst}`,
    ].join("; ");
  }

  /**
   * Command to create a directory (with parents).
   */
  mkdirCommand(absolutePath: string): string {
    const escaped = this.shellEscape(absolutePath);
    return `New-Item -ItemType Directory -Force -Path ${escaped} | Out-Null`;
  }

  /**
   * Command to check if a path exists and return its type.
   * Output: "file", "directory", "other", or "missing".
   */
  statCommand(absolutePath: string): string {
    const escaped = this.shellEscape(absolutePath);
    return `if (Test-Path -PathType Leaf ${escaped}) { 'file' } elseif (Test-Path -PathType Container ${escaped}) { 'directory' } elseif (Test-Path ${escaped}) { 'other' } else { 'missing' }`;
  }

  /**
   * Extract parent directory from a path.
   * Handles both / and \ separators.
   */
  private dirname(path: string): string {
    const lastSep = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
    if (lastSep <= 0) return path.startsWith("/") ? "/" : ".";
    // Handle C:\ root
    if (lastSep === 2 && path[1] === ":") return path.substring(0, 3);
    return path.substring(0, lastSep);
  }
}
