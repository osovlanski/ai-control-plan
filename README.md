# AI Agent Control Plane

An agnostic control plane that catalogs your available AI assistant environments (Claude Code, OpenAI Codex, Cursor, AWS Bedrock agents), explains and selects the best one for each task, observes execution through a normalized event timeline, and hands work off between assistants — automatically when the active one hits its usage limits.

It routes between **complete assistant environments** (runtime + models + skills + MCP + tools + account limits), not bare LLM APIs.

## Experimental Ox Alpha evaluation

Ox Alpha is an OpenRouter model, not a standalone coding-agent environment. The
control plane can evaluate it inside the Codex harness so shell, filesystem,
streaming events, checkpoints, and Compare mode remain available.

Keep the key outside configuration and source control:

```bash
export OPENROUTER_API_KEY="sk-or-..."
```

Add this opt-in assistant to the active workspace's
`~/.agent-plane/<workspace>/config.yaml`:

```yaml
assistants:
  personal-claude: { provider: anthropic }
  personal-codex: { provider: openai }
  personal-ox-alpha:
    provider: openrouter
    options:
      model: stealth/ox-alpha
      reasoningEffort: high
```

Then use Compare mode on representative tasks before allowing automatic
routing. Ox Alpha is an anonymous preview model and its provider retains prompts
and completions, so do not send sensitive or proprietary repositories unless
that data policy is acceptable. It is deliberately not enabled by default.

## Status

Implemented local-first prototype through Phases 0–5. The core loop, portable
handoff/checkpoints, quota failover, retention/redaction, workspaces, Bedrock and
Cursor adapters, parallel Compare/Race, and telemetry-fed routing are present.
The suite currently contains 84 API, 10 core, and 8 adapter tests.

The API is deliberately loopback-only. Configuration rejects non-loopback binds
until an authenticated remote mode exists. Read-only observability clients can
negotiate the integration boundary through `GET /api/meta`; the current API and
normalized-event contract version is `1.0`.

| Document | Purpose |
|---|---|
| [`docs/original-plan.md`](docs/original-plan.md) | The original proposed architecture (kept for traceability) |
| [`docs/architecture-review.md`](docs/architecture-review.md) | Review: verified provider capabilities, challenged assumptions, KEEP / CHANGE / REMOVE / DEFER |
| [`docs/revised-architecture.md`](docs/revised-architecture.md) | The accepted target architecture |
| [`plans/implementation-plan.md`](plans/implementation-plan.md) | Phased delivery plan (Phase 0–5) |
| [`plans/progress.md`](plans/progress.md) | Living progress log |

## Run and verify

```bash
pnpm install
pnpm dev
pnpm typecheck
pnpm test
pnpm build
```

## Core loop being proven first

```text
prompt → route (explainably) → execute → observe (normalized events) → checkpoint → handoff
```

## Workspaces

- **Personal** (Claude Code + Codex): automatic quota failover, cross-provider handoff.
- **Work** (Claude Code + Cursor + Codex + Bedrock): isolated by running its own control-plane instance on the work machine — credentials and data never mix by construction.
