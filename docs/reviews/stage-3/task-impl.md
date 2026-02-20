# Task: Final Implementation Integrity Review

Read these files in order:
1. `C:/dev/mypi/experiments/pi-tramp/DESIGN.md` — original vision
2. `C:/dev/mypi/experiments/pi-tramp/reviews/stage-1/synthesis.md` — Stage 1: overall review
3. `C:/dev/mypi/experiments/pi-tramp/reviews/stage-1/decisions.md` — author's decisions
4. `C:/dev/mypi/experiments/pi-tramp/reviews/stage-2/synthesis.md` — Stage 2: component review

This is the final implementation integrity check. Focus on:

## Can This Actually Be Built?

1. **Dependency graph validation** — Draw the dependency graph of all 8+ components. Is it a DAG? Are there cycles? Can you build bottom-up without circular deps?

2. **The hardest integration point** — Where does the biggest impedance mismatch happen? Is it Transport ↔ ShellDriver? Operations ↔ Transport? Tool-overrides ↔ pi runtime? Find the seam with the highest risk.

3. **What the first day of coding looks like** — You sit down to implement. What's the first file you create? What does it contain? Walk through the first 3 days of actual development.

4. **Test infrastructure** — Can you write a test for DockerTransport and SshTransport that runs in CI without special setup? What Docker images do you need? How do you test SSH? The Stage 2 synthesis says "Docker container running sshd" — specify the exact Dockerfile.

5. **pi runtime integration** — The tool overrides use `createReadTool`, `createBashTool`, etc. with custom Operations. Walk through the actual registration code. Does the `before_agent_start` hook have access to everything it needs? Timing: when does `before_agent_start` fire relative to tool registration?

6. **The 10% that will take 90% of the time** — What single component or integration point will consume the most debugging time? Why? Can it be de-risked?

## Output

- **Dependency graph** (text format)
- **First 3 days plan** (concrete files, concrete code, concrete tests)
- **Test infrastructure spec** (Dockerfiles, CI config)
- **Risk matrix**: component × likelihood × impact
- **The one thing that must be prototyped first** before committing to the full build
