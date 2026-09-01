# Roadmap

## Now

- Keep capability probes deterministic and time-bounded across new providers. *(completed for current adapters)*
- Maintain README maturity/status and the enforced loopback trust boundary. *(completed baseline)*
- Split orchestrator lifecycle, comparison, approval, and failover responsibilities behind explicit state-transition services.

## Next

- Publish/version a read-only task/event/approval contract for Cockpit.
- Add frontend workflow tests and end-to-end adapter contract tests.
  See `docs/agentic-os-eval-plan.md` for the staged eval program (conformance,
  E2E scenarios, recovery chaos, rollout canary) gating the `harnessSingleMode` flip.
- Add structured correlation IDs, latency/error metrics, and cost-budget alerts.

## Later

- Durable queue/recovery for process crashes; authenticated remote runner only when a real remote use case is proven.
- Policy packs and provider portability conformance tests.

## Avoid

- Duplicating Cockpit's tooling-management UI or building a generalized multi-tenant cloud before local reliability is proven.
- Decide whether to merge `docs/agentic-os-plan.md` into the primary repository documentation.
