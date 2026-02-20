# Stage 1 Decisions (Marc)

## Overrides to Reviewer Recommendations

1. **SSH + Docker together, NOT Docker-first** — Both transports in Phase 1. Building both simultaneously surfaces edge cases faster and validates common factors/architecture. Reviewers were wrong to suggest Docker-only first.

2. **`/target switch` bypasses requireEntryConfirmation** — User-issued `/target` commands skip the gate. Only agent-initiated target switches require confirmation.

3. **SSH keys only** — No password auth. No SSH agent forwarding in Phase 1. Someone not using SSH keys doesn't deserve to use agents.

4. **write/edit overrides are Phase 1A core** — ALL four tool overrides (read, write, edit, bash) ship together. This is the core of the project, not a deferral.

## Accepted Recommendations

- Serial command queue from day one
- Shell detection algorithm needs specification  
- Sentinel protocol needs specification before SSH code
- Commit to `sendMessage` for context injection (not both)
- 10MB binary limit, fail fast
- Tool override conflict detection with warnings
- Token budget measurement in Phase 1
