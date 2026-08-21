# AI Agent Control Plane

An agnostic control plane that catalogs your available AI assistant environments (Claude Code, OpenAI Codex, Cursor, AWS Bedrock agents), explains and selects the best one for each task, observes execution through a normalized event timeline, and hands work off between assistants — automatically when the active one hits its usage limits.

It routes between **complete assistant environments** (runtime + models + skills + MCP + tools + account limits), not bare LLM APIs.

## Status

Architecture review phase — no implementation yet.

| Document | Purpose |
|---|---|
| [`docs/original-plan.md`](docs/original-plan.md) | The original proposed architecture (kept for traceability) |
| [`docs/architecture-review.md`](docs/architecture-review.md) | Review: verified provider capabilities, challenged assumptions, KEEP / CHANGE / REMOVE / DEFER |
| [`docs/revised-architecture.md`](docs/revised-architecture.md) | The accepted target architecture |
| [`plans/implementation-plan.md`](plans/implementation-plan.md) | Phased delivery plan (Phase 0–5) |
| [`plans/progress.md`](plans/progress.md) | Living progress log |

## Core loop being proven first

```text
prompt → route (explainably) → execute → observe (normalized events) → checkpoint → handoff
```

## Workspaces

- **Personal** (Claude Code + Codex): automatic quota failover, cross-provider handoff.
- **Work** (Claude Code + Cursor + Codex + Bedrock): isolated by running its own control-plane instance on the work machine — credentials and data never mix by construction.
