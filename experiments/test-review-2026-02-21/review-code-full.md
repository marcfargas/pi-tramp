# Test Suite Review — pi-tramp (2026-02-21)

## 1. Unit test blind spots

### `src/types.ts`
- `WslTargetConfigSchema` and `PsRemoteTargetConfigSchema` are effectively untested (`src/types.ts:154-172`). `test/types.test.ts` only exercises SSH/Docker (`test/types.test.ts:8-117`).
- `ShellTypeSchema` allows `"cmd"` (`src/types.ts:132`) but there is no test that this is accepted/rejected where relevant.
- Boundary checks are missing: SSH port min/max (`src/types.ts:137`), timeout boundaries across all target types (`src/types.ts:142,151,160,171`).
- `TargetsFileSchema` refinements are only partially tested; no test for `default` + merged target names edge cases (`src/types.ts:193-208`).
- `RemoteOperationError.name` is set explicitly (`src/types.ts:57`) but not asserted.

### `src/transport/shell-detect.ts`
- `parseShellName()` is not tested for Windows-style paths (`C:\\...\\powershell.exe`) despite current implementation splitting only on `/` (`src/transport/shell-detect.ts:22`).
- `parseShellName()` not tested for full executable names with extensions in paths, arguments, or leading/trailing noise.
- `parsePlatform()` has no coverage for common Windows outputs like `Windows_NT` (`src/transport/shell-detect.ts:50-56`).
- `parsePwshVersion()` uses `parseInt` (`src/transport/shell-detect.ts:74`) and will accept garbage prefixes like `"7junk"`; no test catches this false positive.

### `src/transport/ssh-transport.ts`
- No unit tests for command lifecycle internals (`execRaw`, `execRawDual`, sentinel parsing, timeout/cancel branches) (`src/transport/ssh-transport.ts:493-572`).
- No tests for disconnect handling (`onSshDeath`) and queue draining (`src/transport/ssh-transport.ts:247-266`).
- No tests for `exec()` not-connected path (`src/transport/ssh-transport.ts:439-442`) or `readFile`/`writeFile` error object shape (`src/transport/ssh-transport.ts:452-471`).
- No tests for `validateCleanOutput()` failure classification (`src/transport/ssh-transport.ts:353-383`) beyond one e2e noisy-shell case.
- Massive blind spot: stderr handling. Result always resolves with `stderr: ""` (`src/transport/ssh-transport.ts:295`) and nothing asserts stderr correctness.

### `src/transport/docker-transport.ts`
- `detectShell()` fallback chain (`src/transport/docker-transport.ts:114-156`) is not unit-tested at all.
- `rawExec()` error branches (`maxBuffer`, timeout) untested (`src/transport/docker-transport.ts:280-294`).
- `exec()` not-connected branch untested (`src/transport/docker-transport.ts:213-216`).
- No test for configured shell `cmd` behavior (schema allows it, runtime routes non-pwsh to `sh`) (`src/transport/docker-transport.ts:268`).

### `src/transport/command-queue.ts`
- Existing “serialization” test does not prove non-overlap (see correctness issues below).
- No test for synchronous throw from task function (`processNext` catch path at `src/transport/command-queue.ts:56-60`).
- No test for re-entrant enqueue while a task is running.

### `src/shell/bash-driver.ts`
- Command generation tests are mostly string-contains and do not execute generated commands end-to-end (`test/shell-escaping.test.ts:172-201`).
- No tests for `dirname()` edge cases (`/`, relative paths) (`src/shell/bash-driver.ts:92-96`).
- No tests for arguments that hit ARG_MAX risk called out in code comment (`src/shell/bash-driver.ts:63-65`).

### `src/shell/pwsh-driver.ts`
- No coverage for `dirname()` edge cases (`C:\\`, `/`, mixed separators) (`src/shell/pwsh-driver.ts:101-107`).
- No test asserting forced quoting requirement for .NET file APIs (`src/shell/pwsh-driver.ts:42-49`).
- `statCommand()` behavior for `file/directory/other/missing` not integration-tested (`src/shell/pwsh-driver.ts:84-87`).

### `src/connection-pool.ts`
- Unit coverage is almost nonexistent: only 4 shallow tests (`test/connection-pool.test.ts:15-36`).
- Untested: connection reuse (`src/connection-pool.ts:35-38`), concurrent connect de-dup (`46-53`), reconnect on dead state (`40-44`), disconnect event cleanup (`123-127`), `closeConnection`/`closeAll` behavior under errors (`77-96`), and `execOnTarget` pass-through (`66-72`).

### `src/target-manager.ts`
- No tests for global+project merge precedence (`src/target-manager.ts:53-68`) because tests only use project temp config.
- No tests for stale current target after reload when target disappears from config (`src/target-manager.ts:107-129`).
- No tests for default-target behavior when current target is already set (`src/target-manager.ts:123-127`).

### `src/operations/remote-ops.ts`
- `resolveRemotePath()` is untested directly, especially Windows absolute/UNC handling (`src/operations/remote-ops.ts:24-44`).
- No tests for relative path + missing cwd error (`src/operations/remote-ops.ts:34-38`).
- 10MB limit branches are untested for read/write (`src/operations/remote-ops.ts:66-69,112-115`).
- `access()` ignores exitCode and trusts stdout string only (`src/operations/remote-ops.ts:83-88`); no tests exercise command failure or malformed output.
- `BashOperations.exec` timeout conversion and signal forwarding are untested (`src/operations/remote-ops.ts:195-201`).

### `src/tramp-exec.ts`
- No unit tests at all.
- Missing tests for uninitialized state (`src/tramp-exec.ts:51-53`), option forwarding (`timeout`/`signal`, `src/tramp-exec.ts:61-64`), and explicit target not found propagation.

---

## 2. Integration test blind spots

- **No timeout/abort integration** across SSH/Docker/remote ops. Critical branches (`timeout`, Ctrl-C, signal) are dead in tests.
- **No stderr contract testing**: integration tests rarely/never assert `stderr`, so regressions in stream handling are invisible.
- **No reconnection lifecycle testing** for SSH process death and pool recovery.
- **No shell detection adversarial scenarios**: noisy stdout/stderr, prompt contamination, echoed input, marker collisions.
- **No large-file boundary test** near/above 10MB limit in remote operations.
- **No cross-target concurrency test** (simultaneous operations on multiple targets while switching targets).
- **No Docker auto-detect validation on Windows** (all Docker scenarios in e2e force shell explicitly, `test/e2e.integration.test.ts:103-109`).
- **No SSH shell mismatch test** despite e2e header claiming it (`test/e2e.integration.test.ts:12` comment, but no actual case).
- **No cmd-shell transport integration** although `cmd` is part of accepted schema (`src/types.ts:132`).

---

## 3. Test correctness issues

1. **Fake serialization assertions**
   - `test/command-queue.test.ts:11-25` does not prove serialization. Even parallel execution would likely still push `[1,2,3]` because pushes happen at task start in call order.
   - Same issue in transport tests (`test/docker-transport.integration.test.ts:107-116`, `test/ssh-transport.integration.test.ts:118-127`, `test/pwsh-transport.integration.test.ts:120-129,219-228`): asserting each promise returns its own `echo` output does not prove queue ordering/non-overlap.

2. **afterAll hooks mask root failures with secondary TypeErrors**
   - `await transport.close()` with possibly undefined `transport` (`test/docker-transport.integration.test.ts:53-55`, `test/ssh-transport.integration.test.ts:61-63`, `test/pwsh-transport.integration.test.ts:57-59,156-158`).
   - `await pool.closeAll()` with possibly undefined `pool` (`test/remote-ops.integration.test.ts:59-61`, `test/e2e.integration.test.ts:141-143`).
   - This produced real secondary failures when Docker daemon was unavailable.

3. **Assertions too weak / wrong target**
   - Multiple `rejects.toThrow()` without checking error class/message/cause; any failure passes (example: `test/docker-transport.integration.test.ts:159-160`, `test/e2e.integration.test.ts:168-171`).
   - Command generation tests rely on `toContain` fragments, not executable correctness (`test/shell-escaping.test.ts:172-225`).

4. **Comment/spec drift in tests**
   - e2e header claims `SSH × mismatch` scenario (`test/e2e.integration.test.ts:12`) but there is no mismatch test body.

5. **Integration suite “skip noise”**
   - When setup fails early, Vitest reports all tests as skipped inside failing suites, which can hide missing execution unless you inspect suite errors.

---

## 4. Shell detection gaps (`shell-detect.ts` + SSH shell validation path)

- `parseShellName` is path-separator fragile: `split("/")` only (`src/transport/shell-detect.ts:22`). Windows path outputs can be misclassified as `unknown`.
- `parsePwshVersion` is too permissive (`parseInt` at `src/transport/shell-detect.ts:74`), allowing false positives from mixed strings.
- SSH pwsh probe uses substring match (`result.stdout.includes(marker)`, `src/transport/ssh-transport.ts:314`), not strict token matching. Echoed command text/noisy shell can spoof detection.
- `validateCleanOutput()` checks one tokenized command only (`src/transport/ssh-transport.ts:353-383`):
  - doesn’t validate stderr cleanliness,
  - doesn’t test multiline/prompt-after-command behavior,
  - doesn’t test intermittent noise (MOTD, profile hooks, first-command-only artifacts).
- Platform parse logic does not cover common Windows signatures like `Windows_NT` (`src/transport/shell-detect.ts:50-56`).

Patterns that can fool detector right now:
- shell echoes input containing marker,
- startup/profile writes one extra line on first command only,
- command writes clean stdout but noisy stderr,
- shell name/path includes backslashes/extensions not handled.

---

## 5. Platform / CI gaps

- README/CI claim Windows integration parity, but most integration suites are explicitly Linux-only (`describe.skipIf(isWindows)` in docker/ssh/remote-ops/pwsh transport tests).
- On Windows matrix, effective coverage is mostly `e2e.integration.test.ts`; fine-grained transport integration is skipped.
- Claimed matrix includes SSH×bash on Windows, but e2e scenarios omit it (`test/e2e.integration.test.ts:68-80`).
- Docker daemon preflight is missing: integration tests fail hard if Docker engine is down, then cascade into cleanup TypeErrors.
- Windows-specific bash assumptions (`rm`, `test`, `pwd`) are embedded in helper commands (`test/helpers/platform.ts:95-111`) but there is no explicit verification that GNU tools exist in the target environment.

---

## 6. Top 5 bugs most likely hiding right now

1. **SSH stderr is silently lost per command**
   - `SshTransport` resolves with `stderr: ""` (`src/transport/ssh-transport.ts:295`) and tests never assert stderr semantics.
   - High impact: tool behavior/error reporting is wrong.

2. **False pwsh auto-detection on noisy/echoing shells**
   - `includes(marker)` probe (`src/transport/ssh-transport.ts:314`) can be spoofed by echoed input/noise.
   - High impact: wrong driver/sentinel logic selected.

3. **`cmd` config accepted but not actually executed as cmd in DockerTransport**
   - Schema allows `cmd` (`src/types.ts:132`), runtime routes non-pwsh to `sh` (`src/transport/docker-transport.ts:268`).
   - High impact on Windows targets with explicit cmd expectation.

4. **`access()` can report success on command failure/malformed output**
   - Ignores exitCode and only checks `stdout.trim() !== "missing"` (`src/operations/remote-ops.ts:83-88`).
   - Medium/high impact: false positives in file existence checks.

5. **Lifecycle cleanup crashes hide real integration failures**
   - Un-guarded teardown (`transport.close()` / `pool.closeAll()`) throws TypeError after setup failures.
   - Medium impact: noisy CI failures, poor debuggability, masked root causes.

  - When setup fails early, Vitest reports many tests as skipped inside failing suites; without reading suite errors, this looks like “nothing ran”.

---

## 4. Shell detection gaps (`shell-detect.ts` + SSH shell validation path)

- `parseShellName` is path-separator fragile: `split("/")` only (`src/transport/shell-detect.ts:22`). Windows path outputs can be misclassified as `unknown`.
- `parsePwshVersion` is too permissive (`parseInt` at `src/transport/shell-detect.ts:74`), allowing false positives from mixed strings.
- SSH pwsh probe uses substring match (`result.stdout.includes(marker)`, `src/transport/ssh-transport.ts:314`), not strict token matching. Echoed command text/noisy shell can spoof detection.
- `validateCleanOutput()` checks one tokenized command only (`src/transport/ssh-transport.ts:353-383`):
  - doesn’t validate stderr cleanliness,
  - doesn’t test multiline/prompt-after-command behavior,
  - doesn’t test intermittent noise (MOTD, profile hooks, first-command-only artifacts).
- Platform parse logic does not cover common Windows signatures like `Windows_NT` (`src/transport/shell-detect.ts:50-56`).

Patterns that can fool detector right now:
- shell echoes input containing marker,
- startup/profile writes one extra line on first command only,
- command writes clean stdout but noisy stderr,
- shell name/path includes backslashes/extensions not handled.

---

## 5. Platform / CI gaps

- README/CI claim Windows integration parity, but most integration suites are explicitly Linux-only (`describe.skipIf(isWindows)` in docker/ssh/remote-ops/pwsh transport tests).
- On Windows matrix, effective coverage is mostly `e2e.integration.test.ts`; fine-grained transport integration is skipped.
- Claimed matrix includes SSH×bash on Windows, but e2e scenarios omit it (`test/e2e.integration.test.ts:68-80`).
- Docker daemon preflight is missing: integration tests fail hard if Docker engine is down, then cascade into cleanup TypeErrors.
- Windows-specific bash assumptions (`rm`, `test`, `pwd`) are embedded in helper commands (`test/helpers/platform.ts:95-111`) but there is no explicit verification that GNU tools exist in the target environment.

---

## 6. Top 5 bugs most likely hiding right now

1. **SSH stderr is silently lost per command**
   - `SshTransport` resolves with `stderr: ""` (`src/transport/ssh-transport.ts:295`) and tests never assert stderr semantics.
   - High impact: tool behavior/error reporting is wrong.

2. **False pwsh auto-detection on noisy/echoing shells**
   - `includes(marker)` probe (`src/transport/ssh-transport.ts:314`) can be spoofed by echoed input/noise.
   - High impact: wrong driver/sentinel logic selected.

3. **`cmd` config accepted but not actually executed as cmd in DockerTransport**
   - Schema allows `cmd` (`src/types.ts:132`), runtime routes non-pwsh to `sh` (`src/transport/docker-transport.ts:268`).
   - High impact on Windows targets with explicit cmd expectation.

4. **`access()` can report success on command failure/malformed output**
   - Ignores exitCode and only checks `stdout.trim() !== "missing"` (`src/operations/remote-ops.ts:83-88`).
   - Medium/high impact: false positives in file existence checks.

5. **Lifecycle cleanup crashes hide real integration failures**
   - Un-guarded teardown (`transport.close()` / `pool.closeAll()`) throws TypeError after setup failures.
   - Medium impact: noisy CI failures, poor debuggability, masked root causes.