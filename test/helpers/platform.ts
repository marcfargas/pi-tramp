/**
 * Cross-platform test helpers.
 *
 * Tests run against both Linux and Windows containers.
 * This module provides platform/shell-aware paths and commands.
 */

import { posix, win32 } from "path";

export interface TestPlatform {
  /** "linux" or "windows" */
  os: "linux" | "windows";
  /** Base workspace path on the target container */
  workspace: string;
  /** Path to SSH test key inside the container */
  testKeyPath: string;
  /** SSH test user */
  sshUser: string;
  /** SSH host — use 127.0.0.1 to avoid IPv6 issues with Windows Docker NAT */
  sshHost: string;
  /** Docker image name */
  image: string;
  /** Container names */
  dockerContainer: string;
  sshContainer: string;
  /** SSH ports for Windows two-container setup (cmd default + pwsh default) */
  sshCmdPort: number;
  sshPwshPort: number;
  /** Args to keep a docker exec container alive */
  keepaliveArgs: string[];
  /** Extra startup wait (Windows containers are slower) */
  startupDelayMs: number;

  /** Join path segments using the target's separator */
  join(...segments: string[]): string;

  /** Shell-aware commands for cleanup/checks */
  rmFile(path: string, shell: "bash" | "pwsh"): string;
  rmDir(path: string, shell: "bash" | "pwsh"): string;
  testDir(path: string, shell: "bash" | "pwsh"): string;
  echoCmd(text: string, shell: "bash" | "pwsh"): string;
  /**
   * Produce a non-zero exit code.
   * Docker (ephemeral): `exit N` is fine — each exec is a fresh process.
   * SSH (persistent): pwsh needs a child process; `exit` would kill the session.
   */
  exitCmd(code: number, shell: "bash" | "pwsh", transport: "docker" | "ssh"): string;
  pwdCmd(shell: "bash" | "pwsh"): string;
}

const linuxPlatform: TestPlatform = {
  os: "linux",
  workspace: "/workspace",
  testKeyPath: "/test_key",
  sshUser: "testuser",
  sshHost: "127.0.0.1",
  image: "pi-tramp-ssh-test",
  dockerContainer: "pi-tramp-e2e-docker",
  sshContainer: "pi-tramp-ssh-test",
  sshCmdPort: 2222,  // not used on Linux, but satisfies the interface
  sshPwshPort: 2222, // not used on Linux, but satisfies the interface
  keepaliveArgs: ["sleep", "infinity"],
  startupDelayMs: 1000,

  join: (...segments) => posix.join(...segments),

  rmFile: (path, shell) =>
    shell === "pwsh" ? `Remove-Item '${path}' -Force` : `rm '${path}'`,
  rmDir: (path, shell) =>
    shell === "pwsh" ? `Remove-Item '${path}' -Recurse -Force` : `rm -rf '${path}'`,
  testDir: (path, shell) =>
    shell === "pwsh" ? `if (Test-Path '${path}') { 'ok' }` : `test -d '${path}' && echo ok`,
  echoCmd: (text, shell) =>
    shell === "pwsh" ? `Write-Output '${text}'` : `echo '${text}'`,
  // Docker pwsh: `exit N` directly (ephemeral). SSH pwsh: child process (persistent session).
  exitCmd: (code, shell, transport) =>
    shell === "pwsh" && transport === "ssh"
      ? `pwsh -NoProfile -c 'exit ${code}'`
      : shell === "pwsh"
        ? `exit ${code}`
        : `(exit ${code})`,
  pwdCmd: (shell) =>
    shell === "pwsh" ? "(Get-Location).Path" : "pwd",
};

const windowsPlatform: TestPlatform = {
  os: "windows",
  workspace: "C:\\workspace",
  testKeyPath: "C:\\test_key",
  sshUser: "testuser",
  sshHost: "127.0.0.1",
  image: "pi-tramp-win-test",
  dockerContainer: "pi-tramp-e2e-win-docker",
  sshContainer: "pi-tramp-win-cmd",  // cmd-default container (port 2222), started first
  sshCmdPort: 2222,  // container with cmd.exe as DefaultShell
  sshPwshPort: 2223, // container with pwsh as DefaultShell
  keepaliveArgs: [], // Windows CMD loop keeps it alive
  startupDelayMs: 5000,

  join: (...segments) => win32.join(...segments),

  rmFile: (path, shell) =>
    shell === "pwsh" ? `Remove-Item '${path}' -Force` : `rm '${path}'`,
  rmDir: (path, shell) =>
    shell === "pwsh" ? `Remove-Item '${path}' -Recurse -Force` : `rm -rf '${path}'`,
  testDir: (path, shell) =>
    shell === "pwsh" ? `if (Test-Path '${path}') { 'ok' }` : `test -d '${path}' && echo ok`,
  echoCmd: (text, shell) =>
    shell === "pwsh" ? `Write-Output '${text}'` : `echo '${text}'`,
  // Docker pwsh: `exit N` directly (ephemeral). SSH pwsh: child process (persistent session).
  exitCmd: (code, shell, transport) =>
    shell === "pwsh" && transport === "ssh"
      ? `pwsh -NoProfile -c 'exit ${code}'`
      : shell === "pwsh"
        ? `exit ${code}`
        : `(exit ${code})`,
  pwdCmd: (shell) =>
    shell === "pwsh" ? "(Get-Location).Path" : "pwd",
};

/**
 * Fix SSH private key permissions after docker cp.
 * On Windows, docker cp creates files with broad ACLs — SSH refuses them.
 * On Linux, docker cp preserves container permissions (600) — no fix needed.
 */
export async function fixKeyPermissions(keyPath: string): Promise<void> {
  if (process.platform !== "win32") return; // Linux is fine
  const { execFile } = await import("child_process");
  const { promisify } = await import("util");
  const exec = promisify(execFile);
  // Remove inherited ACLs, grant only current user read access
  await exec("icacls", [keyPath, "/inheritance:r", "/grant:r", `${process.env.USERNAME}:(R)`]);
}

export function getTestPlatform(): TestPlatform {
  return process.env.PI_TRAMP_TARGET_OS === "windows"
    ? windowsPlatform
    : linuxPlatform;
}
