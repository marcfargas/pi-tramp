# Task: Triple-Probe SSH Shell Auto-Detection + CI Two-Container Setup

## Context

SSH auto-detection fails on cmd.exe because the probe only sends `printf` (bash) and
`Write-Output` (pwsh). cmd.exe understands neither → 15s timeout.

Diagnostics confirmed: the Windows CI container's default SSH shell is **cmd.exe**.
Explicit pwsh and bash both work fine when specified as remote commands.

We need:
1. A triple-probe that works in bash, pwsh, AND cmd.exe
2. A polyglot shell detector that distinguishes cmd.exe / PowerShell Desktop / PowerShell Core / bash
3. Clear error for unsupported shells (cmd.exe)
4. Two Windows containers in CI: one with cmd.exe default, one with pwsh default

## Working Root

**Your working root is C:/dev/pi-tramp-wt-autodetect/** — all edits must go there.

## Changes Required

### 1. Triple-probe in `spawnSsh()` — `src/transport/ssh-transport.ts`

Add `echo` as a third probe line (echo is built-in in all three shells):

```typescript
// Existing probes
this.ssh.stdin!.write(`printf '%s_%d\\n' '${probeSentinel}' 0 2>/dev/null\n`);
this.ssh.stdin!.write(`Write-Output "${probeSentinel}_0" 2>$null\n`);
// New: universal fallback — echo is built-in in bash, pwsh, AND cmd.exe
this.ssh.stdin!.write(`echo ${probeSentinel}_0\n`);
```

Note: in bash/pwsh, printf/Write-Output fires first and resolves the promise.
The echo line fires after but `currentResolve` is already null, so it's harmlessly ignored.
In cmd.exe, printf and Write-Output fail (errors go to stderr), but echo succeeds → sentinel matches.

cmd.exe echoes back input lines with a prompt prefix (e.g., `C:\Users\test>echo SENTINEL_0`),
but only the output line matches the sentinel regex `^${sentinel}_(\d+)$`. The prompt-prefixed
echo doesn't match because of the prompt text before the sentinel.

### 2. Triple-sentinel in `execRawDual()` — `src/transport/ssh-transport.ts`

Same change — add echo sentinel as third format so detection commands work in cmd.exe:

```typescript
const bashSentinel = `printf '%s_%d\\n' '${sentinel}' $? 2>/dev/null`;
const pwshSentinel = `Write-Output "${sentinel}_$(${ESC_LASTEXITCODE})" 2>$null`;
const echoSentinel = `echo ${sentinel}_0`;  // universal fallback for cmd.exe
this.ssh.stdin!.write(`${command}\n${bashSentinel}\n${pwshSentinel}\n${echoSentinel}\n`);
```

### 3. Polyglot shell detection in `detectShellAndSetup()` — `src/transport/ssh-transport.ts`

Replace the current pwsh-only detection with the polyglot approach.

Source: https://stackoverflow.com/a/61469226 (CC BY-SA 4.0, by not2qubit)

```typescript
private async detectShellAndSetup(): Promise<void> {
  // Phase 1: Use polyglot to detect cmd.exe vs PowerShell
  // Returns: "CMD" (cmd.exe), "Core" (pwsh 7), "Desktop" (Windows PowerShell 5.1)
  // In bash, this produces errors — no recognizable output.
  const polyglotResult = await this.execRawDual(
    `(dir 2>&1 *\`|echo CMD);&<# rem #>echo ($PSVersionTable).PSEdition`,
    5000,
  );
  const polyglotOutput = polyglotResult.stdout.trim();

  if (polyglotOutput.includes("CMD")) {
    throw new Error(
      `Default SSH shell is cmd.exe, which is not supported.\n` +
      `Fix: set "shell" in your target config:\n` +
      `  { "shell": "pwsh" }   — for PowerShell 7\n` +
      `  { "shell": "bash" }   — for Git Bash / WSL`,
    );
  }

  if (polyglotOutput.includes("Core") || polyglotOutput.includes("Desktop")) {
    this._shell = "pwsh";
  }

  // Phase 2: If not detected as PowerShell, try bash
  if (this._shell === "unknown") {
    try {
      const bashResult = await this.execRawDual("echo $BASH_VERSION", 5000);
      const version = bashResult.stdout.trim();
      if (version && !version.includes("$BASH_VERSION")) {
        // $BASH_VERSION expanded → we're in bash
        this._shell = "bash";
      }
    } catch {
      // Not bash
    }
  }

  // Phase 3: If still unknown, default to bash (existing behavior)
  if (this._shell === "unknown") {
    this._shell = "bash";
  }

  // Validate against configured shell (if any) — keep existing code
  if (this.configuredShell && this.configuredShell !== "unknown") {
    if (this.configuredShell !== this._shell) {
      throw new Error(
        `Shell mismatch: configured '${this.configuredShell}' but detected '${this._shell}'. ` +
        `Check the target's shell setting or remove it to use auto-detection.`,
      );
    }
  }

  // pwsh session setup — keep existing code
  if (this._shell === "pwsh") {
    try {
      await this.execRaw(
        'try { $PSStyle.OutputRendering = "PlainText" } catch {}; ' +
        '$ProgressPreference = "SilentlyContinue"',
        5000,
      );
    } catch {
      // Non-fatal
    }
  }

  // Validate clean output — keep existing code
  await this.validateCleanOutput();
}
```

**IMPORTANT**: After detection, `execRaw()` uses shell-specific sentinels (printf for bash,
Write-Output for pwsh). This is correct — we only needed the triple-sentinel in the probe
and detection phases. Once the shell is known, the specific sentinel is more reliable.

### 4. Add `parseShellPolyglot()` to `src/transport/shell-detect.ts`

```typescript
/**
 * Parse the output of the cmd/PowerShell polyglot command.
 * Source: https://stackoverflow.com/a/61469226 (CC BY-SA 4.0)
 * Polyglot: (dir 2>&1 *`|echo CMD);&<# rem #>echo ($PSVersionTable).PSEdition
 * Returns: "cmd" | "pwsh" | "unknown"
 */
export function parseShellPolyglot(output: string): ShellType {
  const cleaned = stripAnsi(output).trim();
  if (cleaned.includes("CMD")) return "cmd";
  if (cleaned.includes("Core") || cleaned.includes("Desktop")) return "pwsh";
  return "unknown";
}
```

Use this in `detectShellAndSetup()` instead of inline parsing.

### 5. Unit tests for `parseShellPolyglot` — `test/shell-detect.test.ts`

```typescript
describe("parseShellPolyglot", () => {
  it("detects cmd.exe", () => {
    expect(parseShellPolyglot("CMD")).toBe("cmd");
    expect(parseShellPolyglot("CMD\r\n")).toBe("cmd");
  });

  it("detects PowerShell Core (pwsh 7)", () => {
    expect(parseShellPolyglot("Core")).toBe("pwsh");
    expect(parseShellPolyglot("Core\r\n")).toBe("pwsh");
  });

  it("detects Windows PowerShell (Desktop)", () => {
    expect(parseShellPolyglot("Desktop")).toBe("pwsh");
  });

  it("returns unknown for bash/unrecognized output", () => {
    expect(parseShellPolyglot("bash: syntax error")).toBe("unknown");
    expect(parseShellPolyglot("")).toBe("unknown");
  });

  it("strips ANSI codes", () => {
    expect(parseShellPolyglot("\x1b[32mCore\x1b[0m")).toBe("pwsh");
  });
});
```

### 6. CI: Two Windows containers — `.github/workflows/ci.yml`

Use the SAME image but start two containers with different DefaultShell settings.

Replace the current single container start:
```yaml
- name: Start SSH container
  run: docker run -d --name pi-tramp-win-test -p 2222:22 pi-tramp-win-test
```

With two containers:
```yaml
- name: Start SSH containers (cmd + pwsh defaults)
  shell: pwsh
  run: |
    # Container 1: cmd.exe as DefaultShell (Windows default)
    docker run -d --name pi-tramp-win-cmd -p 2222:22 pi-tramp-win-test

    # Container 2: pwsh as DefaultShell (real-world Windows servers)
    docker run -d --name pi-tramp-win-pwsh -p 2223:22 pi-tramp-win-test `
      powershell -Command "New-ItemProperty -Path 'HKLM:\SOFTWARE\OpenSSH' -Name DefaultShell -Value 'C:\pwsh\pwsh.exe' -PropertyType String -Force; Start-Service sshd; while (`$true) { Start-Sleep 3600 }"

- name: Wait for SSH
  shell: pwsh
  run: |
    foreach ($port in @(2222, 2223)) {
      for ($i = 0; $i -lt 30; $i++) {
        try {
          $null = Test-NetConnection -ComputerName localhost -Port $port -ErrorAction Stop
          Write-Host "SSH ready on port $port"
          break
        } catch { Start-Sleep 2 }
      }
    }
```

Update cleanup to remove both:
```yaml
- name: Cleanup
  if: always()
  run: |
    docker rm -f pi-tramp-win-cmd 2>$null
    docker rm -f pi-tramp-win-pwsh 2>$null
```

### 7. Test helpers — `test/helpers/platform.ts`

Add the second SSH port for Windows. The platform config should expose:
- `sshCmdPort: 2222` — SSH to cmd.exe-default container
- `sshPwshPort: 2223` — SSH to pwsh-default container

Check how `platform.ts` currently exposes port config and add the second port.

### 8. E2E test scenarios — `test/e2e.integration.test.ts`

Update the Windows auto-detect scenarios:

**`ssh-auto-cmd`**: Connect to port 2222 (cmd default), no shell config.
Expect: connection error containing "cmd.exe" and "not supported".

```typescript
if (isWindows) {
  tm.createTarget("ssh-auto-cmd", {
    type: "ssh", host: `${SSH_USER}@${P.sshHost}`,
    port: P.sshCmdPort, identityFile: P.sshKey,
  } as TargetConfig);
}
```

**`ssh-auto-pwsh`**: Connect to port 2223 (pwsh default), no shell config.
Auto-detection should find pwsh. It may succeed (clean pwsh) or fail at
validateCleanOutput (noisy interactive pwsh). Either outcome is valid:
- If clean → great, auto-detect works end-to-end
- If noisy → test should expect an error mentioning "noisy output" and suggesting shell config

```typescript
if (isWindows) {
  tm.createTarget("ssh-auto-pwsh", {
    type: "ssh", host: `${SSH_USER}@${P.sshHost}`,
    port: P.sshPwshPort, identityFile: P.sshKey,
  } as TargetConfig);
}
```

For `ssh-auto-cmd`, add an error-expectation test:
```typescript
if (isWindows) {
  describe("SSH × auto-detect (cmd)", () => {
    it("rejects cmd.exe with clear error", async () => {
      const pool = tm.getPool();
      await expect(pool.getTransport("ssh-auto-cmd"))
        .rejects.toThrow(/cmd\.exe.*not supported/i);
    });
  });
}
```

For `ssh-auto-pwsh`, keep the existing full test suite (read/write/edit/exec).
If it fails at validateCleanOutput, update the test to expect that specific error instead.

### 9. Remove the diagnostic step

Remove the "Diagnose default SSH shell" step from `.github/workflows/ci.yml` — it was temporary.

### 10. Verify

```bash
cd /c/dev/pi-tramp-wt-autodetect
npm run lint
npm run typecheck
npm test
```

All must pass. Commit when done:
```bash
git add -A && git commit -m "feat: triple-probe SSH shell detection with cmd.exe support

- Add echo as universal third probe in spawnSsh() and execRawDual()
- Use polyglot command to detect cmd.exe vs PowerShell Core/Desktop vs bash
- cmd.exe detected → clear error with fix instructions
- PowerShell (Core or Desktop) → auto-detect as pwsh
- New parseShellPolyglot() parser with unit tests
- CI: two Windows containers (cmd default + pwsh default) on ports 2222/2223
- E2E: ssh-auto-cmd expects clear rejection, ssh-auto-pwsh tests full auto-detect

Polyglot source: https://stackoverflow.com/a/61469226 (CC BY-SA 4.0)"
```

## Key Design Decisions

- **echo for universal probe**: built-in in all three shells, no external binary needed
- **Polyglot for detection**: one command distinguishes cmd/Core/Desktop — no sequential probing
- **cmd.exe = error, not silent fallback**: users must explicitly choose pwsh or bash
- **Same Docker image, two containers**: avoid double build time, just override DefaultShell via registry
- **PowerShell Desktop treated as pwsh**: same driver works for both 5.1 and 7.x

## Files to Change

1. `src/transport/ssh-transport.ts` — triple probe + polyglot detection
2. `src/transport/shell-detect.ts` — add `parseShellPolyglot()`
3. `test/shell-detect.test.ts` — unit tests for parseShellPolyglot
4. `test/helpers/platform.ts` — add sshCmdPort / sshPwshPort
5. `test/e2e.integration.test.ts` — two auto-detect scenarios
6. `.github/workflows/ci.yml` — two containers, remove diagnostic step
