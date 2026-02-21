# Task: Remove SSH Auto-Detection, Require Shell in Config

## Context

SSH shell auto-detection proved too complex for v0.1.x. Decision: make `shell` a required
field for SSH targets. This simplifies the transport, removes flaky detection code, and
gives clear errors when shell is missing.

## Working Root

**Your working root is C:/dev/pi-tramp-wt-require-shell/** — all edits must go there.

## What to Change

### 1. Revert auto-detection code from `src/transport/ssh-transport.ts`

**Remove**:
- The triple-probe lines in `spawnSsh()` — revert to the original two-line probe (printf + Write-Output). These are only sent when shell IS configured, so they always target the right shell.
- Actually, since shell is now required: `spawnSsh()` should ALWAYS have `this.configuredShell` set. So the probe can be shell-specific:
  - If shell is "pwsh": only send `Write-Output "${probeSentinel}_0"`
  - If shell is "bash" or "sh": only send `printf '%s_%d\n' '${probeSentinel}' 0`
  - Remove the dual-format probe entirely — we know the shell upfront
- `execRawDual()` — remove entirely. It was only used for detection. All exec goes through `execRaw()` which already uses the known shell type.
- `detectShellAndSetup()` — remove the polyglot detection logic. Since shell is configured, this method just needs to:
  1. Set `this._shell = this.configuredShell` (already known)
  2. Run pwsh session setup if pwsh (PSStyle, ProgressPreference)
  3. Run `validateCleanOutput()` to verify the session works
  No more marker probes, no more polyglot.
- Remove `parseShellPolyglot` import

**Keep**:
- `validateCleanOutput()` — still needed to verify clean session
- `execRaw()` — the shell-specific command executor
- Shell mismatch validation can be removed (no mismatch possible if shell is required)

### 2. Make `shell` required in schema — `src/types.ts`

Find `SshTargetConfigSchema`. The `shell` field should be required (not optional):

```typescript
// Before: shell is optional
shell: ShellTypeSchema.optional(),

// After: shell is required
shell: ShellTypeSchema,
```

Also update the `SshTargetConfig` type if it's manually defined (or it auto-infers from schema).

The error when shell is missing will be a Zod validation error, which is clear enough.

### 3. Remove `parseShellPolyglot` from `src/transport/shell-detect.ts`

Delete the `parseShellPolyglot()` function entirely. It's no longer used.

### 4. Remove polyglot tests from `test/shell-detect.test.ts`

Delete the entire `describe("parseShellPolyglot", ...)` block.

### 5. Update `spawnSsh()` — shell-specific probe

Since shell is always known, simplify the probe:

```typescript
// The shell is always configured now
if (this.configuredShell === "pwsh") {
  args.push("pwsh", "-NoProfile", "-NonInteractive", "-Command", "-");
} else {
  // bash or sh
  args.push(this.configuredShell!, "--login");
}

// ... after spawn, send shell-specific probe:
if (this.configuredShell === "pwsh") {
  this.ssh.stdin!.write(`Write-Output "${probeSentinel}_0"\n`);
} else {
  this.ssh.stdin!.write(`printf '%s_%d\\n' '${probeSentinel}' 0\n`);
}
```

No more dual or triple probes. The SSH remote command is always explicit.

### 6. CI — revert to single Windows container

In `.github/workflows/ci.yml`:
- Remove the second container (`pi-tramp-win-pwsh` on port 2223)
- Keep single container: `pi-tramp-win-cmd` (or rename back to `pi-tramp-win-test`) on port 2222
- Revert the Wait for SSH to check only port 2222
- Cleanup removes only one container
- Keep the GHCR caching (that's good)

### 7. E2E tests — remove auto-detect scenarios

In `test/e2e.integration.test.ts`:
- Remove `ssh-auto-bash` target and scenario
- Remove `ssh-auto-pwsh` target and scenario
- Remove `ssh-auto-cmd` target and error test
- All SSH tests use explicit `shell:` config (ssh-explicit-bash, ssh-explicit-pwsh)
- Update header comment to reflect the new scenarios

### 8. Platform helpers — `test/helpers/platform.ts`

- Remove `sshCmdPort` and `sshPwshPort` if they were added
- Keep `sshPort` (or whatever the single port field is called)

### 9. Schema tests — `test/types.test.ts`

Add a test that SSH target without `shell` is rejected:

```typescript
it("rejects SSH target without shell", () => {
  expect(() => SshTargetConfigSchema.parse({
    type: "ssh", host: "user@host"
  })).toThrow();
});
```

### 10. Verify

```bash
cd /c/dev/pi-tramp-wt-require-shell
npm run lint
npm run typecheck
npm test
```

All must pass. Commit:
```bash
git add -A && git commit -m "feat!: require shell in SSH target config, remove auto-detection

BREAKING CHANGE: SSH targets now require a 'shell' field ('bash', 'pwsh', or 'sh').
Auto-detection removed — proved too complex for v0.1.x (polyglot breaks bash,
interactive pwsh is noisy). Explicit config is one field and always works.

- shell required in SshTargetConfigSchema
- spawnSsh() uses shell-specific probe (no more dual/triple)
- Removed: execRawDual(), parseShellPolyglot(), polyglot detection
- CI: single Windows container (explicit shell tests only)
- Tests: removed auto-detect scenarios, added shell-required validation"
```

## Files to Change

1. `src/transport/ssh-transport.ts` — simplify probe, remove execRawDual, simplify detectShellAndSetup
2. `src/transport/shell-detect.ts` — remove parseShellPolyglot
3. `src/types.ts` — make shell required in SshTargetConfigSchema
4. `test/shell-detect.test.ts` — remove polyglot tests
5. `test/types.test.ts` — add shell-required test
6. `test/e2e.integration.test.ts` — remove auto-detect scenarios
7. `test/helpers/platform.ts` — remove dual port config
8. `.github/workflows/ci.yml` — single container
