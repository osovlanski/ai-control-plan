# Roadmap

## Now

- Keep capability probes deterministic and time-bounded across new providers. *(completed for current adapters)*
- Maintain README maturity/status and the enforced loopback trust boundary. *(completed baseline)*
- Split orchestrator lifecycle, comparison, approval, and failover responsibilities behind explicit state-transition services.

## Next

- Kernel services before dashboards: Scheduler (M13, `WAITING_RESOURCE`, re-compose at wake), model catalog + priors (M12 part 1, closes the pricing deferral), Context Lifecycle guard + gauge (M14), then blended model selection (M12 part 2). Design: `docs/agentic-os-kernel-services.md`; slices K1–K16.
- Publish/version a read-only task/event/approval contract for Cockpit.
- Add frontend workflow tests and end-to-end adapter contract tests.
  See `docs/agentic-os-eval-plan.md` for the staged eval program (conformance,
  E2E scenarios, recovery chaos, rollout canary) gating the `harnessSingleMode` flip.
- Add structured correlation IDs, latency/error metrics, and cost-budget alerts.

## Later

- Authenticated remote runner only when a real remote use case is proven (the Scheduler is one re-armed timer over SQLite, not a queue — I-S3).
- Policy packs and provider portability conformance tests.

## Avoid

- Replacing telemetry-fed routing with public leaderboards, or introducing Redis/Postgres/queues for the Scheduler.
- Duplicating Cockpit's tooling-management UI or building a generalized multi-tenant cloud before local reliability is proven.
- Decide whether to merge `docs/agentic-os-plan.md` into the primary repository documentation.
