# Roadmap

## Now

- Keep capability probes deterministic and time-bounded across new providers. *(completed for current adapters)*
- Maintain README maturity/status and the enforced loopback trust boundary. *(completed baseline)*
- Split orchestrator lifecycle, comparison, approval, and failover responsibilities behind explicit state-transition services.

## K12/K14 closure (2026-09-14)

- **K12 PARTIAL:** operator surfaces are implemented in the Control Plane and
  Cockpit #37. Only the joint K9/K12 live-provider warning-pressure evidence gate
  (§5.2.4) remains unverified: Claude is rate-limited; the real Codex unavailable
  projection passed. See the [live record](agentic-os-k12-live-acceptance.md).
  Do not rebuild the context service or gauges.
- **K14 COMPLETE:** K7/K8 supply canonical model/price/benchmark evidence;
  Cockpit #38 implements the offline catalog snapshot and shared Usage/Retro
  pricing. The existing Agents card presents evidence; it grants no eligibility
  or hard-cost authority. Do not create another catalog or pricing store.
- Evidence, pre-change matrices and validation:
  [K12/K14 operator closure](agentic-os-k12-k14-closure.md).

## Next

- Kernel services as independent slices: K1 durable dispatch contract + single-task time waits with boot recovery; K2 quota retry with explicit evidence; K3 optional probes; K7 execution identity + provider facts + price evidence (does not close the cost-cap deferral); K9/K12 context observation + gauges (implemented; live-provider pressure evidence remains — see closure above); K11 bounded checkpoint-backed continuation; K10 provider-command compaction after conformance (blocked on the installed Claude stack — `docs/agentic-os-k10-blocker.md`); K14 catalog/pricing presentation (complete — see closure above); K8 one verified benchmark source; K13 shadow selection then gated activation. Demand-driven: K4 dependency waits (before increment 11), K4b resource slots (named config pools, claim co-committed with the wake reservation — `docs/agentic-os-k4b-resource-slots.md`), K5 recurrence including `overlap: queue` (durable queued occurrences on the occurrence row, FIFO promotion, intent snapshot — `docs/agentic-os-k5-overlap-queue.md`) + K6 schedule UI. Deferred: K15 runtime enum/abstraction, K16 timer consolidation. Design: `docs/agentic-os-kernel-services.md` §6.
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
