/**
 * BashDriver — ShellDriver implementation for bash and sh (POSIX shells).
 *
 * Escaping uses POSIX single-quote strategy (works on bash, sh, dash, zsh, ash).
 * See specs/shell-escaping.md for full rationale.
 */

import type { ShellDriver, ShellType } from "../types.js";

export class BashDriver implements ShellDriver {
  readonly shell: ShellType;

  constructor(shell: ShellType = "bash") {
    this.shell = shell;
  }

  /**
   * Escape an argument for safe use in a POSIX shell command.
   *
   * Strategy: single-quote everything, escape embedded single quotes
   * by ending the single-quoted string, adding an escaped single quote,
   * and restarting the single-quoted string.
   *
   * "it's" → 'it'"'"'s'
   *
   * This is POSIX-compatible (works on bash, sh, dash, zsh, ash).
   */
  shellEscape(arg: string): string {
    if (arg.includes("\0")) {
      throw new Error("Shell argument contains null byte — cannot be safely escaped");
    }

    // Empty string → ''
    if (arg === "") return "''";

    // If arg contains no special chars, return as-is (optimization)
    if (/^[a-zA-Z0-9._\-\/=:@]+$/.test(arg)) return arg;

    // Single-quote with embedded quote escaping
    return "'" + arg.replace(/'/g, "'\"'\"'") + "'";
  }

  /**
   * Command to read a file as base64.
   * Uses base64 -w 0 to output on a single line (no wrapping).
   */
  readFileCommand(absolutePath: string): string {
    const escaped = this.shellEscape(absolutePath);
    return `base64 -w 0 ${escaped} && echo`;
    // The `&& echo` adds a trailing newline after the base64 output
    // (base64 -w 0 doesn't add one), ensuring the sentinel is on its own line.
  }

  /**
   * Command to write base64 content to a file atomically.
   * Strategy: mkdir -p parent → decode to tmp → mv to dest (POSIX atomic rename).
   */
  writeFileCommand(absolutePath: string, base64Content: string, tmpPath: string): string {
    const escapedDst = this.shellEscape(absolutePath);
    const escapedTmp = this.shellEscape(tmpPath);
    const escapedParent = this.shellEscape(this.dirname(absolutePath));

    // For large content (>1MB base64), we can't pass it as a command argument
    // due to ARG_MAX limits. Use heredoc-style stdin instead.
    // For now, use printf which handles most cases.
    return [
      `mkdir -p ${escapedParent}`,
      `printf '%s' ${this.shellEscape(base64Content)} | base64 -d > ${escapedTmp}`,
      `mv ${escapedTmp} ${escapedDst}`,
    ].join(" && ");
  }

  /**
   * Command to create a directory (with parents).
   */
  mkdirCommand(absolutePath: string): string {
    return `mkdir -p ${this.shellEscape(absolutePath)}`;
  }

  /**
   * Command to check if a path exists and return its type.
   * Output: "file", "directory", "other", or "missing".
   */
  statCommand(absolutePath: string): string {
    const escaped = this.shellEscape(absolutePath);
    return `if [ -f ${escaped} ]; then echo file; elif [ -d ${escaped} ]; then echo directory; elif [ -e ${escaped} ]; then echo other; else echo missing; fi`;
  }

  /**
   * Extract parent directory from a path.
   */
  private dirname(path: string): string {
    const lastSlash = path.lastIndexOf("/");
    if (lastSlash <= 0) return "/";
    return path.substring(0, lastSlash);
  }
}
