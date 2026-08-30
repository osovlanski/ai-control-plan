# Architecture

The domain layer in `packages/core` defines IDs, task envelopes, assistant manifests, routing explanations, events, checkpoints, and redaction. Provider-specific Claude, Codex, Cursor, Bedrock, fake, and OpenRouter behavior sits behind adapters in `packages/adapters`.

The Fastify composition root (`apps/api/src/server.ts`) constructs registry, task store, event bus, checkpoint, cooldown, telemetry, retention, and orchestrator services. SQLite is the durable system of record. API routes expose registry sync, task lifecycle, routing, approvals, handoffs, comparisons, telemetry and SSE. The React/Vite frontend consumes this local API.

The primary architectural risk is concentration of lifecycle/concurrency behavior in `orchestrator.ts`; transition invariants are partly enforced by stores and partly procedurally. Workspace isolation is deliberately process-level rather than multi-tenant. Remote runners are deferred and should preserve the adapter contract if introduced.

Graphify: `graphify-out/graph.json` (598 nodes/1,501 edges at audit time); SQL was not indexed because the optional SQL parser is absent.
The broader control, execution, observability, knowledge and UX boundaries in `docs/agentic-os-plan.md` are proposed extensions, not a second deployed architecture.
