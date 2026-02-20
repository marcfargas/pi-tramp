# pi-tramp

TRAMP-like transparent remote execution for [pi](https://github.com/mariozechner/pi-coding-agent).

Pi stays local. Tools execute remotely.

## What

A pi extension that overrides the built-in tools (`read`, `write`, `edit`, `bash`) with remote-aware versions. When a target is active, all tool calls are transparently routed to the remote machine via SSH or Docker exec. The agent knows it's working remotely (via system prompt and status bar) but uses the same tool syntax.

## Why

pi-devcontainers mounts the host filesystem into containers, creating 11+ documented deviations from real container behavior. pi-tramp inverts this: containers just need a shell. Pi connects to them, not the other way around.

## Status

**Pre-implementation.** Design reviewed, specs in progress.

## Architecture

```
┌──────────────────────────┐      ┌──────────────────────┐
│  pi (local)              │      │  Remote Target       │
│  ┌─────────────────────┐ │  SSH │  ┌────────────────┐  │
│  │ read/write/edit/bash│─┼──────┼─→│ bash/pwsh      │  │
│  │ (tool overrides)    │ │  or  │  │ (real shell)   │  │
│  └────────┬────────────┘ │Docker│  └────────────────┘  │
│           │              │ exec │                       │
│  ┌────────▼────────────┐ │      │                       │
│  │ Transport + Pool    │ │      │                       │
│  │ ShellDriver         │ │      │                       │
│  └─────────────────────┘ │      │                       │
└──────────────────────────┘      └──────────────────────┘
```

## Documentation

- [Design Document](docs/DESIGN.md)
- [Design Review Takeaways](docs/TAKEAWAYS.md)
- [Design Reviews](docs/reviews/) (3-stage review artifacts)
- [Specifications](specs/) (detailed component specs)
