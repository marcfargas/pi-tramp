# Task: Remaining Review Fixes for pi-tramp Test Suite

## What to build

Fix the remaining issues from the test suite review. These are specific, scoped changes.
All changes should be on the `develop` branch (already checked out).

## Context

- Project: `C:/dev/pi-tramp` — TypeScript library, SSH+Docker remote target manager
- Review reports: `experiments/test-review-2026-02-21/review-arch.md` and `review-code-full.md`
- Previous commit `11d940e` already fixed: parseShellName, parsePlatform, parsePwshVersion, parseArch, access() exit code, cmd schema removal, afterAll guards, and added 10 new unit tests
- Current unit tests: 138 passing, 4 skipped

## Changes Required

### 1. Fix serialization tests (command-queue + transports)

**Problem**: `test/command-queue.test.ts` "serializes concurrent tasks" test doesn't prove serialization. The test pushes task index at start, but even with parallel execution the array would be `[1,2,3]` because `Promise.all` preserves call order.

**File**: `test/command-queue.test.ts` around line 11-25

**Fix**: Add timing-based assertion that proves non-overlap. Record `[start, end]` timestamps for each task, then verify no task started before the previous one finished:

```typescript
it("serializes concurrent tasks (no overlap)", async () => {
  const timeline: Array<{ id: number; start: number; end: number }> = [];
  const results = await Promise.all([1, 2, 3].map((id) =>
    queue.enqueue(async () => {
      const start = Date.now();
      await new Promise((r) => setTimeout(r, 50)); // 50ms work
      const end = Date.now();
      timeline.push({ id, start, end });
      return id;
    })
  ));
  expect(results).toEqual([1, 2, 3]);
  // Verify non-overlap: each task starts after previous ends
  for (let i = 1; i < timeline.length; i++) {
    expect(timeline[i].start).toBeGreaterThanOrEqual(timeline[i - 1].end);
  }
});
```

**Important**: Keep the existing test as-is (it tests result ordering). Add this as a new test alongside it.

### 2. Update types.test.ts for cmd removal

**Problem**: `cmd` was removed from `ShellTypeSchema` (commit 11d940e). The types tests should verify that `cmd` is now rejected.

**File**: `test/types.test.ts`

**Fix**: Find where shell types are tested. Add an assertion that `shell: "cmd"` is rejected by the schema. Example:

```typescript
it("rejects cmd shell (no driver implemented)", () => {
  expect(() => SshTargetConfigSchema.parse({
    type: "ssh", host: "user@host", shell: "cmd"
  })).toThrow();
});
```

### 3. Fix SSH stderr: document the limitation

**Problem**: `src/transport/ssh-transport.ts` line ~295 always resolves with `stderr: ""`. The SSH transport uses a single PTY stream where stdout and stderr are multiplexed — there's no separate stderr channel in the current architecture.

**This is NOT a simple fix** — it would require changing the SSH command wrapping to redirect stderr separately (e.g., `command 2>/tmp/stderr_capture; cat /tmp/stderr_capture >&2`). That's a bigger change.

**Fix for now**: Add a code comment at line 295 explaining why stderr is empty, and add a test that documents this known limitation:

In `test/shell-detect.test.ts` or a new `test/ssh-transport.test.ts` — actually, this is better as a comment + a known-limitation note in the existing integration test.

Add to `test/ssh-transport.integration.test.ts` (inside the describe, after existing tests):

```typescript
it("known limitation: stderr is not captured separately", async () => {
  // SSH transport uses a single PTY — stdout and stderr are multiplexed.
  // stderr is always empty string. This is a known limitation.
  const result = await transport.exec("echo out && echo err >&2");
  expect(result.stderr).toBe(""); // Known limitation
  // stderr content appears in stdout instead
  expect(result.stdout).toContain("out");
});
```

### 4. Remove stale e2e test header comment about SSH mismatch

**Problem**: `test/e2e.integration.test.ts` header comment (line 12) claims `SSH × mismatch — shell: "X" but default is "Y" → error` but no such test exists.

**Fix**: Remove the mismatch line from the header comment. It was planned but not implemented.

### 5. Run tests and verify

After all changes:
```bash
npm run typecheck
npm test
```

All tests must pass. Report the final count.

## Out of Scope

- SSH stderr redesign (just document the limitation)
- Four untested modules (tool-overrides, extension, context-injection, target-tool) — next sprint
- Failure mode tests — next sprint
- Integration test workspace isolation — next sprint

## Success Criteria

- `npm run typecheck` passes
- `npm test` passes with no regressions
- New serialization test actually proves non-overlap with timing
- cmd rejection test added
- SSH stderr limitation documented in code + test
- Stale comment removed
- Clean git diff, ready to commit
