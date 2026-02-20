# Task: Final Composition Review

Read these files in order:
1. `C:/dev/mypi/experiments/pi-tramp/DESIGN.md` — original vision
2. `C:/dev/mypi/experiments/pi-tramp/reviews/stage-1/synthesis.md` — Stage 1: overall review
3. `C:/dev/mypi/experiments/pi-tramp/reviews/stage-1/decisions.md` — author's decisions
4. `C:/dev/mypi/experiments/pi-tramp/reviews/stage-2/synthesis.md` — Stage 2: component review

This is the final review. You're checking:

## Vision → Decomposition → Recomposition Integrity

1. **Does the decomposition preserve the vision?** The original design had a specific philosophy (TRAMP-like transparent remote execution, pi stays local, tools execute remotely). Do the decomposed pieces, when reassembled, deliver that vision? Or did something get lost in translation?

2. **Interface coherence** — Do the consolidated TypeScript interfaces from Stage 2 actually compose? Walk through a concrete scenario:
   - User configures SSH target "dev-server" in targets.json
   - Agent starts, pi-tramp activates, detects target
   - Agent calls `read("src/index.ts")`
   - Trace the call through: tool-override → operations-remote → ConnectionPool → Transport → ShellDriver → SSH exec → sentinel → back up
   - Does every interface hand off cleanly? Are there gaps?

3. **Another scenario**: Agent calls `edit("src/index.ts", {oldText: "foo", newText: "bar"})`
   - This is the hard case: read-apply-write, 2 round trips, CRLF preservation
   - Trace through the same stack. Does it work?

4. **Error scenario**: SSH drops mid-edit (after read, before write-back)
   - What state is everything in? Does the file stay intact on the remote?
   - What does the agent see?
   - Can it recover?

5. **Target switch scenario**: Agent is on target "dev", switches to "staging", switches back to "dev"
   - Connection lifecycle: reuse or reconnect?
   - Context injection: does the system prompt update correctly?
   - What if "dev" session state was lost during the switch?

6. **Scope gaps** — Is there anything in the original DESIGN.md that the decomposition simply doesn't cover? Anything that fell through the cracks between Stage 1 and Stage 2?

## Output

- **Verdict**: Does the composition hold together?
- **Gaps found**: Specific issues where vision != decomposition + recomposition
- **Scenario trace results**: Did the 4 scenarios work end-to-end through the interfaces?
- **Final recommendations**: What must be addressed before implementation starts
