# Pi-Tramp Design Review — Synthesis

**Reviewers**: Architecture reviewer (Codex), Implementation reviewer (Claude)  
**Date**: 2026-02-20  
**Verdict**: **Buildable with significant scope reduction and specification tightening**

---

## Overall Verdict

**Unanimous consensus**: This design is fundamentally sound and solves a real, documented problem. The TRAMP analogy is excellent, the architecture leverages existing pi abstractions correctly, and the explicit boundary approach is right for this use case.

**However**: Phase 1 is too ambitious (3-4 independent deliverables bundled as one), several critical engineering details are underspecified or hand-waved, and the design will hit integration hell if implemented as-is. The good news: both reviewers agree on what to cut, what to specify, and how to sequence the work.

**Key insight from both reviewers**: The SSH transport contains genuinely hard engineering problems (persistent stdin/stdout multiplexing, sentinel protocol, concurrent command serialization) that the design underestimates. Docker is simpler and should be the proving ground.

---

## Unanimous Verdicts

### What Both Reviewers Agree On

1. **Phase 1 must be split** — Currently 3-4 separate deliverables (SSH + Docker + dynamic targets + context injection + status widget + trampExec export). This guarantees integration hell. Split into two phases with a shippable MVP in between.

2. **Shell detection is critically underspecified** — "We detect the shell" with no algorithm. This will consume days of debugging when PowerShell Core vs Windows PowerShell behave differently, or bash on macOS vs Alpine diverge.

3. **Tool override conflict is a real problem** — `registerTool` is last-writer-wins. If any other extension (pi-powershell, pi-sandbox) also overrides `bash`, one silently loses. Needs conflict detection with visible warnings.

4. **requireEntryConfirmation UX is undefined** — What happens when confirmation is required? Does the tool call block? Error? How does the agent know? "Could bypass" for direct user commands is not a spec.

5. **System prompt token budget is deferred but affects Phase 1** — Injecting 200 tokens × 50 turns = 10,000 tokens of repeated context. Needs measurement **before** Phase 1 ships, not Phase 3.

6. **Binary file handling needs hard limits** — Base64 over stdout for a 50MB file = 66MB string = OOM/hang. Either support binary properly or fail fast with documented limits (both reviewers agree on 10MB threshold).

7. **Authentication is silent in the design** — SSH key-based auth assumed. No mention of password prompts, SSH agent forwarding, jump hosts, identity files. First real user will hit this.

8. **Testing strategy is missing** — No unit/integration test plan, no test matrix, no CI strategy. Both reviewers provide specific recommendations.

---

## Critical Issues (Must Address)

Ordered by severity (blocking → serious → important):

### 1. **SSH Concurrent Command Execution (Blocking — Impl Reviewer)**

**Problem**: Persistent SSH shell uses a single stdin/stdout pipe. If the agent calls `bash npm install` (long-running) and simultaneously `read package.json` (because the LLM made two tool calls), both commands compete for the same pipe. No native multiplexing exists.

**Impact**: Session corruption, wrong output returned to wrong tool calls, silent failures.

**Solution**: 
- Implement a **serial command queue with mutex** on the connection
- All `exec()` calls are queued and executed one at a time
- Document this limitation in the system prompt injection: "Avoid parallel tool use on remote targets"
- Phase 2: Add ControlMaster support for true multiplexing

**Action**: Add this to the Transport interface spec before writing any SSH code.

---

### 2. **Sentinel Protocol for Command Completion (Blocking — Impl Reviewer)**

**Problem**: How does `exec()` know a command finished? The shell just waits for the next command. Sentinel pattern (`echo SENTINEL_$?`) breaks when:
- Binary output contains the sentinel by coincidence
- Shell transforms output (PowerShell color codes)
- Network hiccup sends partial sentinel
- Interactive command never terminates

**Impact**: First production incident within a week of real usage.

**Solution**:
- Use a **long, unique, per-invocation UUID** as the sentinel
- Never send binary commands through `exec()` — base64 encode/decode for file I/O only
- Add a **timeout config** (default 60s) on targets — kill session and reconnect on timeout
- Implement session health checks and auto-reconnect

**Action**: Specify the sentinel protocol algorithm in the design doc before implementation.

---

### 3. **Phase 1 Scope Reduction (Critical — BOTH reviewers)**

**Problem**: Phase 1 tries to deliver SSH + Docker + dynamic targets + two context injection approaches + status widget + trampExec export. When these fail together, debugging is impossible.

**Impact**: Weeks lost in integration debugging instead of feature building.

**Two competing proposals** (see Key Tensions below), but both agree: **split Phase 1 into two shippable increments**.

**Action**: Human decision required — see "Key Divergences" section.

---

### 4. **Shell Detection Algorithm (Critical — Arch Reviewer)**

**Problem**: Design says "detect the shell" with no how. Parsing `$SHELL`? `echo $0`? Trying pwsh commands and catching errors?

**Impact**: Days debugging "why does this break on PowerShell Core vs Windows PowerShell" or "bash on macOS vs Alpine."

**Solution** (Arch reviewer's spec):
1. Send `echo "$0"`
2. Parse output: if contains "pwsh"/"powershell" → pwsh; if "bash" → bash
3. If ambiguous, send `$PSVersionTable` — success = pwsh, error = assume bash
4. Allow `"shell": "..."` config override

**Action**: Add this algorithm to the design doc verbatim.

---

### 5. **Command Quoting and Escaping (Will Break First — Impl Reviewer)**

**Problem**: Sending `cat "file with spaces.txt"` through stdin requires correct quoting at two levels: local string, remote shell interpretation. PowerShell adds a third layer (`-Command` quoting rules). Design is silent on this.

**Impact**: First production incident will be a filename with a space or quote character.

**Solution**:
- Define a `shellEscape(arg)` utility per shell type
- Specify who is responsible for escaping — the Transport or the ShellDriver?
- Implement `BashDriver` and `PwshDriver` separately from day one (don't try to share escaping logic)

**Action**: Add a "Command Construction" section to the design with escaping strategy.

---

### 6. **Tool Override Conflict Detection (Critical — Arch Reviewer)**

**Problem**: If another extension also overrides `bash`, last-writer-wins means one silently loses. No error, no warning.

**Impact**: Agent runs bash locally while thinking it's on remote target. Silent failure, hard to debug.

**Solution**:
- On extension init, check if the tool already has a non-default implementation
- Log a visible TUI warning: `"pi-tramp: WARNING — another extension has already overridden 'bash'. Remote routing may not work."`
- Document convention: other extensions check `pi.extensions.has("pi-tramp")` before overriding

**Action**: Add conflict detection code and document the convention in README.

---

### 7. **Context Injection Approach — Pick One (Critical — Arch Reviewer)**

**Problem**: Design describes two approaches (`sendMessage` with custom type AND `before_agent_start` injection) and says "design review will tell which is better."

**Impact**: Building both wastes effort. One will work, the other gets deleted.

**Solution** (Arch reviewer's recommendation):
- Pick `sendMessage` + `context` event filtering for Phase 1
- More complex but allows surgical updates (remove old context, add new)
- System prompt injection is simpler but wastes tokens on every turn
- Commit now, don't build both

**Action**: Human decision — commit to one approach in the revised design.

---

### 8. **Docker Exec Latency Unanswered (Critical — Arch Reviewer)**

**Problem**: "Is spawning `docker exec` per operation fast enough?" — this question determines the entire Docker transport design. If you spawn `docker exec` for 2000 `read` calls, latency is unusable.

**Impact**: Could invalidate the entire "one exec per call" Docker approach.

**Solution** (Arch reviewer):
- **Prototype before Phase 1**:
  ```bash
  for i in {1..100}; do
    docker exec -i <container> cat /etc/hosts > /dev/null
  done
  ```
- Time it: <1 sec total = fine, >5 sec = need persistent exec
- Make the decision with data, not guesses

**Action**: Run the latency test and commit to one-shot vs persistent exec for Docker.

---

## Key Divergences

Where reviewers disagree or emphasize different approaches. **Human decision required.**

### 1. **SSH First vs Docker First**

**Arch Reviewer**: SSH first (Phase 1A), Docker second (Phase 1B)
- Rationale: SSH is the harder problem — fail fast, learn early
- Validates the architecture against the difficult case first
- Docker is easier and can be added afterward

**Impl Reviewer**: Docker first, SSH second
- Rationale: Docker is simpler — proves the concept faster
- Get to a working end-to-end experience sooner
- SSH adds 2-3 weeks; use that time validating Docker with real users first
- Recommended MVP: Docker exec + target tool + bash/read overrides

**Synthesis recommendation**: **Docker first** (Impl reviewer is correct here)
- **Why**: The goal of Phase 1 is to prove the architecture works. Docker gets you there in 3-4 weeks. SSH adds 2-3 weeks of hard engineering (sentinel protocol, multiplexing, lifecycle). Ship Docker, validate with real usage, **then** tackle SSH with lessons learned.
- **Sequencing**: 
  - Phase 1A: Docker only (3-4 weeks) → ship, validate
  - Phase 1B: SSH (2-3 weeks) → ship, validate
  - Phase 1C: Polish (context injection, dynamic targets, widget) (1-2 weeks)

---

### 2. **Binary File Handling — Fail Fast vs Accept Limits**

**Arch Reviewer**: Fail fast with hard limits
- Set a 10MB limit for base64 transport
- Throw clear errors when exceeded
- Agent learns the limit through experience
- Suggest `scp`/`rsync` for large files

**Impl Reviewer**: Accept base64 for Phase 1, defer to Phase 2
- Binary transport is a Phase 2 problem
- Base64 is fine for source files
- Measure, then optimize

**Synthesis recommendation**: **Fail fast with limits** (Arch reviewer)
- **Why**: Silent acceptance creates a footgun. An agent tries to read a 50MB image, the extension hangs for 30s or OOMs, and the agent has no idea why. Explicit limits teach the agent the boundary.
- **How**: 
  ```typescript
  if (isRemote && isBinary && size > 10 * 1024 * 1024) {
    throw new Error(
      `Binary file ${path} is ${size} bytes (max 10MB over SSH). ` +
      `Use 'bash' tool with scp/rsync for large files.`
    );
  }
  ```

---

### 3. **System Prompt vs Message Injection — Now or Later**

**Arch Reviewer**: Decide now, commit to `sendMessage` approach
- Building both is wasted effort
- Token waste matters from day one

**Impl Reviewer**: Doesn't strongly commit, focuses on other hard problems

**Synthesis recommendation**: **Commit to `sendMessage` approach for Phase 1**
- **Why**: Arch reviewer is right — this is a one-way door decision. System prompt injection is easier to build but wastes tokens on every turn. `sendMessage` + `context` filtering is more complex but allows surgical updates and doesn't bloat the context window.
- **Action**: Remove the "both" approach from the design, commit to `sendMessage`.

---

## Decomposition Consensus

Both reviewers independently proposed decompositions. Here's the merged, final list:

### Core Abstractions (Define First)

1. **Transport Interface** (Impl reviewer's step 1)
   - Contract: `exec(command)`, `readFile(path)`, `writeFile(path, content)`, `close()`
   - Testable with mocks before any implementation
   - **Complexity**: S (interface definition only)
   - **Depends on**: Nothing
   - **Action**: Define this first — everything else implements against it

2. **ShellDriver Interface** (Arch: shell-detect, Impl: ShellDriver)
   - Contract: `readFileCommand(path)`, `writeFileCommand(path, base64)`, `mkdirCommand(path)`, `shellEscape(arg)`
   - Implementations: `BashDriver`, `PwshDriver` (separate, no shared logic)
   - **Complexity**: M (command translation, escaping rules)
   - **Depends on**: Transport (to send probe commands for detection)
   - **Action**: Implement bash + pwsh drivers separately, don't abstract

### Phase 1A — Docker MVP (3-4 weeks)

3. **TargetManager** (Arch #5, Impl step 2)
   - Pure state: loads config, tracks current target, CRUD
   - **Complexity**: S (config parsing, merge precedence)
   - **Depends on**: Nothing (pure logic)
   - **Tests**: Config parsing, merge (global + project), requireEntryConfirmation flag

4. **DockerTransport** (Arch #2, Impl step 3)
   - Wraps `docker exec` with Transport interface
   - **Serial command queue from day one** (not an afterthought)
   - **Complexity**: M (queue, error handling)
   - **Depends on**: Transport interface, ShellDriver (for shell detection)
   - **Tests**: Real Docker container in unit tests (easy in CI)
   - **This is the proof-of-concept vertical slice**

5. **ConnectionPool** (Arch #6)
   - Lifecycle: open/reuse/close connections based on TargetManager state
   - **Complexity**: M (keepalive, reconnect, timeout)
   - **Depends on**: TargetManager, Transport implementations
   - **Tests**: Mock transports, verify lifecycle

6. **operations-remote** (Arch #4)
   - Implements `ReadOperations`, `WriteOperations`, `BashOperations` over transports
   - **Complexity**: M (mapping Operations API to shell commands)
   - **Depends on**: Transport, ShellDriver
   - **Tests**: Mock transport, verify Operations contract

7. **tool-overrides** (Arch #7, Impl step 4)
   - Registers `bash` and `read` tools (defer `write`/`edit` to 1B)
   - Routes to remote operations based on current target
   - **Conflict detection on init** (log warnings if another extension already overrode)
   - **Complexity**: S (thin dispatch)
   - **Depends on**: TargetManager, ConnectionPool, operations-remote
   - **Tests**: Needs pi runtime or elaborate mocking

8. **target-tool** (Arch #8)
   - LLM-callable tool for target switch/list/status (no create/remove yet)
   - **Complexity**: S (maps params to TargetManager calls)
   - **Depends on**: TargetManager, ConnectionPool
   - **Tests**: Needs pi runtime

9. **Basic system prompt injection** (Arch #9 subset, Impl step 5)
   - Just platform/shell/arch — no message filtering yet
   - Measure token cost immediately
   - **Complexity**: S
   - **Depends on**: TargetManager
   - **Action**: Instrument and log token count in first integration test

**Ship Phase 1A** → Validate with real usage → Measure Docker exec latency at scale

---

### Phase 1B — SSH (2-3 weeks)

10. **SshTransport** (Arch #1, Impl step 7)
    - Persistent SSH connection with sentinel protocol
    - Serial command queue (same as Docker)
    - Shell detection on connect
    - **Complexity**: L (stdin/stdout multiplexing, sentinel protocol, error recovery)
    - **Depends on**: Transport interface, ShellDriver
    - **Tests**: Docker container running sshd
    - **This is the hardest piece — build after Docker is validated**

11. **SSH connection lifecycle** (Impl step 8)
    - Keepalive, reconnect on drop, health check
    - **Complexity**: M
    - **Depends on**: SshTransport
    - **Tests**: Simulate network drops in CI

**Ship Phase 1B** → Validate SSH stability

---

### Phase 1C — Polish (1-2 weeks)

12. **Full context injection** (Arch #9, Impl step 9)
    - `sendMessage` + `context` event filtering
    - Read remote AGENTS.md on target switch
    - **Complexity**: M (context filtering is subtle)
    - **Depends on**: TargetManager
    - **Tests**: Needs pi event system

13. **Dynamic targets** (Arch #11 subset)
    - Enable `create`/`remove` in target-tool (TargetManager already has the logic)
    - **Complexity**: S
    - **Depends on**: target-tool

14. **Status bar widget** (Arch #10, Impl step 10)
    - Display `@target-name` in TUI
    - **Complexity**: S
    - **Depends on**: TargetManager, pi TUI API

15. **trampExec export** (Arch #11)
    - Public API for extension authors
    - **Complexity**: S (thin wrapper)
    - **Depends on**: ConnectionPool

**Ship Phase 1C** → Feature-complete Phase 1

---

### Clean Seams (Both Reviewers Agree)

- **Transport** is the primary extension point — any transport (SSH, Docker, WSL, PSSession) can plug in
- **ShellDriver** isolates shell differences — add `fish`, `zsh`, `csh` without touching transports
- **Operations layer** is pi's own abstraction — clean boundary, already defined
- **TargetManager** is pure state — no I/O, easy to test and extend

---

### Build Order Agreement

Both reviewers agree on:
1. Define interfaces first (Transport, ShellDriver)
2. Build TargetManager (pure logic, no I/O)
3. Build transport + connection pool
4. Wire tool overrides
5. Add context injection last

**Synthesis refinement** (incorporating Impl reviewer's "Docker first" insight):
1. Interfaces (Transport, ShellDriver)
2. TargetManager
3. **DockerTransport** (not SSH) — prove the concept faster
4. ConnectionPool
5. operations-remote
6. tool-overrides (bash + read only)
7. target-tool (switch/list/status only)
8. Basic system prompt injection (measure tokens)
9. **Ship Phase 1A** → validate
10. **SshTransport** (hardest piece, after Docker works)
11. SSH lifecycle
12. **Ship Phase 1B** → validate
13. Full context injection
14. Dynamic targets, widget, trampExec
15. **Ship Phase 1C** → done

---

## Open Questions

Aggregated from both reviewers. **Human answers required before implementation.**

### Authentication & Credentials

1. **SSH authentication details** (BOTH reviewers) — SSH keys only? Password prompts? Agent forwarding? Jump hosts? What's supported in Phase 1?
   - **Arch reviewer's recommendation**: Phase 1 = key-based auth only, no password prompts
   - **Impl reviewer**: Silent assumption that `ssh user@host` works — needs explicit spec

2. **SSH agent forwarding** (Arch) — Is `"forwardAgent": true` in target config planned? Phase 1 or 2?

3. **Custom identity files** (Arch) — `"identityFile": "~/.ssh/custom_key"` in target config? Phase 2?

### Behavior & UX

4. **requireEntryConfirmation bypass behavior** (BOTH reviewers) — Does `/target switch production` bypass confirmation or not? "Could bypass" is not a spec. What's the actual behavior?

5. **Network hiccup handling** (Arch) — SSH drops mid-read. Exactly what does the agent see? Retry logic? Exponential backoff? Max retries?

6. **Unsupported shell fallback** (Arch) — If you land in `fish`, `csh`, or a restricted shell, do you error out? Try bash commands anyway? How does the user know?

7. **Session persistence across target switches** (Impl) — When switching `dev` → `local` → `dev`, does pi-tramp reuse the existing SSH connection or create a new one? If reusing, is the platform/shell state cached or re-probed?

### Implementation Details

8. **Command queuing / concurrency contract** (Impl) — Must be specified: is `exec()` serial? What happens if the agent makes two simultaneous tool calls? (Answer: serial queue, as agreed in Critical Issues.)

9. **File size limits** (Impl) — Base64 over stdout is fine for source files. What's the cutoff above which it becomes a problem? 1MB? 10MB? (Answer: 10MB, as agreed in Key Divergences.)

10. **`write` and `edit` tool overrides** (Impl) — Architecture diagram lists them, but design body only deeply covers `bash` and `read`. The `edit` tool (diff-based patching) has a more complex remote implementation. What's the strategy? Phase 1A or 1B?

### Measurement & Limits

11. **System prompt block size budget** (BOTH reviewers) — Before shipping Phase 1, measure: how many tokens does the target block add per turn? What's the limit above which it becomes a cost/context problem?

12. **Docker privileged operations** (Arch) — What if the agent needs to install packages (`apt install`) inside the container? Does `docker exec` handle that or do you need a root user configured?

### Testing & Migration

13. **Testing story** (Arch) — How do you test this? Mock SSH server? Real containers in CI? What's the test matrix for Phase 1? (Partial answer: both reviewers agree on Docker container for SSH tests, real containers in CI.)

14. **Migration from pi-devcontainers** (Arch) — What's the user experience? Delete `.devcontainer`, create a target manually, done? Any migration helper?

15. **Extension tool discovery** (Arch) — If an extension calls `trampExec()`, does it automatically know the current target? Or does it need to call `target({ action: "status" })`?

---

## Recommended Next Steps

**Immediate (Before Any Code)**:

1. **Run the Docker latency prototype** (Critical Issue #8) — 100 iterations of `docker exec cat /etc/hosts`. Measure. Commit to one-shot vs persistent exec based on data.

2. **Add shell detection algorithm to design** (Critical Issue #4) — Use Arch reviewer's spec verbatim (echo "$0", parse, try $PSVersionTable, allow override).

3. **Add command construction section to design** (Critical Issue #5) — Define `shellEscape(arg)` strategy, specify who is responsible (Transport or ShellDriver).

4. **Commit to `sendMessage` context injection** (Critical Issue #7, Key Divergence #3) — Remove the "both" approach from the design.

5. **Answer open questions** — Specifically: requireEntryConfirmation bypass behavior, authentication support for Phase 1, session persistence across switches.

6. **Revise phase breakdown**:
   - **Phase 1A**: Docker only (3-4 weeks) — bash + read overrides, target tool (switch/list/status), basic system prompt, measure tokens
   - **Phase 1B**: SSH (2-3 weeks) — sentinel protocol, connection lifecycle, same tool overrides
   - **Phase 1C**: Polish (1-2 weeks) — full context injection, dynamic targets, widget, trampExec export
   - **Phase 2**: Advanced (3-4 weeks) — port forwarding, ControlMaster, WSL, PSSession

**First Week of Implementation**:

7. **Define Transport and ShellDriver interfaces** (no implementation) — these are your contracts

8. **Implement TargetManager** (pure state, easy) — config loading, merge, CRUD

9. **Implement BashDriver and PwshDriver** (separately) — command translation, escaping

10. **Implement DockerTransport with serial queue** — this is your vertical slice proof-of-concept

**After Phase 1A Ships**:

11. **Validate with real users** — measure Docker latency at scale, measure token cost of system prompt injection

12. **Build SSH transport** — sentinel protocol, connection lifecycle (the hard piece)

13. **Ship Phase 1B**, validate, then add Phase 1C polish

---

## What Not to Do

Both reviewers implicitly agree on:

- ❌ **Don't build both context injection approaches** — commit to `sendMessage`
- ❌ **Don't start with SSH** — Docker is simpler, proves the concept faster
- ❌ **Don't build all of Phase 1 at once** — split into 1A/1B/1C with validation gates
- ❌ **Don't defer Docker latency measurement** — prototype before committing to the design
- ❌ **Don't hand-wave the sentinel protocol** — specify it now (UUID-based, timeout, reconnect)
- ❌ **Don't assume conflict-free tool overrides** — add detection and warnings
- ❌ **Don't skip token measurement** — instrument in Phase 1A, not Phase 3
- ❌ **Don't abstract BashDriver and PwshDriver** — two concrete implementations, no shared logic

---

## Final Recommendation

**This design is worth building.** Both reviewers agree it solves a real problem with the right architecture. But:

1. **Shrink Phase 1** to Docker-only MVP (3-4 weeks)
2. **Specify the 8 critical details** listed above (shell detection, sentinel protocol, command escaping, etc.)
3. **Prototype Docker latency** before writing any code
4. **Ship incrementally**: 1A (Docker) → validate → 1B (SSH) → validate → 1C (polish)

With these changes, this project goes from "will hit integration hell" to "will ship successfully in phases."

**Bottom line**: Reduce scope, tighten specs, ship Docker first, measure early, validate often. The decomposition is clean, the seams are right, and the hard problems are now visible and addressable.
