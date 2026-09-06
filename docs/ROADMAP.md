# Roadmap

## Now

- Keep capability probes deterministic and time-bounded across new providers. *(completed for current adapters)*
- Maintain README maturity/status and the enforced loopback trust boundary. *(completed baseline)*
- Split orchestrator lifecycle, comparison, approval, and failover responsibilities behind explicit state-transition services.

## Next

- Kernel services as independent slices: K1 durable dispatch contract + single-task time waits with boot recovery; K2 quota retry with explicit evidence; K3 optional probes; K7 execution identity + provider facts + price evidence (does not close the cost-cap deferral); K9/K12 context observation + gauges; K11 bounded checkpoint-backed continuation; K10 provider-command compaction after conformance; K14 catalog/pricing presentation; K8 one verified benchmark source; K13 shadow selection then gated activation. Demand-driven: K4 dependency waits (before increment 11), K5/K6 recurrence + schedule UI. Deferred: K4b resource slots, K15 runtime enum/abstraction, K16 timer consolidation. Design: `docs/agentic-os-kernel-services.md` §6.
- Publish/version a read-only task/event/approval contract for Cockpit.
- Add frontend workflow tests and end-to-end adapter contract tests.
  See `docs/agentic-os-eval-plan.md` for the staged eval program (conformance,
  E2E scenarios, recovery chaos, rollout canary) gating the `harnessSingleMode` flip.
- Add structured correlation IDs, latency/error metrics, and cost-budget alerts.

## Later

- Authenticated remote runner only when a real remote use case is proven (the Scheduler is one re-armed timer over SQLite, not a queue — I-S3).
- Policy packs and provider portability conformance tests.

## Avoid

- Replacing telemetry-fed routing with public leaderboards (external evidence never grants eligibility), or introducing Redis/Postgres/queues for the Scheduler.
- Promising exactly-once provider execution, lossless clean-session continuation, or "never starts into an exhausted quota window" — the kernel-services document states the truthful bounds.
- Duplicating Cockpit's tooling-management UI or building a generalized multi-tenant cloud before local reliability is proven.
- Decide whether to merge `docs/agentic-os-plan.md` into the primary repository documentation.
