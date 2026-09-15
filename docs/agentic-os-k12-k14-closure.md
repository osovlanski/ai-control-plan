# K12/K14 operator closure — 2026-09-14

Baseline: ai-control-plan `5257926dacc73a7367a821b732be00b455d9a546`;
Cockpit `62acc956b873ad073659f5b1a9894326047565aa`. The old H branches are
already merged and are not implementation prerequisites.

## Decision before implementation

**B — SMALL CLOSURE GAPS.** The canonical services and Cockpit integrations
already exist. Only bounded Control Plane presentation and status corrections
are needed. No new service, schema, provider behavior or routing policy.

K12's presentation is implemented, but the joint K9/K12 live-provider acceptance
in kernel-services §5.2.4 is not fully evidenced. The K9 record documents a short
Claude observation (~39k / ~967k), explicitly with no compaction boundary. It
does not prove a run beyond `warnRatio`. Scripted tests cannot close that gate.

## K12 matrix (baseline, before coding)

| Criterion | Source requirement | Current implementation | Test evidence | Status | Action |
|---|---|---|---|---|---|
| Per-session, provider-truthful observations | kernel-services §5.2.1 | core `context.ts`, SessionRunner, Claude adapter; Codex unavailable | core `context.test.ts`, adapter `context-capability.test.ts` / `claude-context.test.ts`, API `harness/context-observer.test.ts` | SATISFIED | Preserve; never derive occupancy from accounting |
| Effective window separate from advertised maximum; unknown/stale | §5.2.1–2 | API `context.ts`, web ContextReadout, Cockpit contextGauge | API `context-endpoint.test.ts`, web `context.test.tsx`, Cockpit `contextGauge.test.ts` | SATISFIED | Preserve |
| Method, freshness, observed auto-compaction | §5.2.2–3 | Both presenters and normalized events | Same gauge tests; scripted adapter boundary test | SATISFIED | Preserve; no intervention |
| Unambiguous session and canonical pressure on web | §5.2.2; closure brief | Endpoint returns latest session ID and pressure; web omits ID and recomputes percentage | Existing rendering tests lack session/no-recompute cases | PARTIAL | Label latest session and format supplied pressure only |
| Cockpit managed-session gauge with context.read | §6 K12 | Cockpit #37; current K6 refresh preserves independent context read/error path | Cockpit `contextGauge.test.ts`, `controlPlane.test.ts`, `controlPlanePublicWiring.test.ts` | SATISFIED | Record shipped status |
| K11 continuation distinguished from compaction | closure brief; §5.2.5–10 | ContinuationReadout exists, but adjacent Inspector text says K11 is planned | API `context-continuation.test.ts`, web continuation tests | PARTIAL | Correct presentation text only |
| Actual Claude warning-pressure observation and conditional auto-compaction boundary; real Codex unavailable | §5.2.4 | Short Claude smoke only; complete pressure scenario is scripted | K9 implementation record; K11 explicitly records no real-provider run | PARTIAL | Keep live-provider evidence gate open; do not claim scripted evidence is live |
| Original apps/web Usage-tab placement | §4.3 gauge prose | Equivalent Context tab in V3 | web gauge tests | OBSOLETE/REPLACED | Annotate replacement; do not duplicate the gauge |

## K14 matrix (baseline, before coding)

| Criterion | Source requirement | Current implementation | Test evidence | Status | Action |
|---|---|---|---|---|---|
| Requested vs resolved model; unknown stays unknown | kernel-services §5.3.1 | K7 persisted run identity; Inspector modelIdentityView | API `model-identity.test.ts`, web `orbital.test.ts`, adapter `model-evidence.test.ts` | SATISFIED | Preserve |
| Provider/model identity and discovery-owned availability | §5.3.2 | K7 provider-qualified catalog and Agents; Cockpit modelKey resolver | API `model-catalog.test.ts`, Cockpit `modelPricingResolver.test.ts` | SATISFIED | Never infer availability |
| Context/capability evidence and explicit missing facts | §5.3.2; closure brief | API and Cockpit preserve fields; Agents leaves absent context/price facts silent | API catalog tests; Cockpit presenter/wiring tests | PARTIAL | Present canonical fields and explicit unknowns in existing card |
| Price source/version/applicability/freshness | §5.3.3; K14 item | Cockpit complete; Agents shows tier/version but omits price's own source/date | API catalog tests; Cockpit resolver/snapshot tests | PARTIAL | Show price-level source and observedAt |
| Benchmark prior, attribution, release/publication/model/fetch dates | §5.3 K8 item | K8 ingestion and Agents presentation | API `artificial-analysis.test.ts` | SATISFIED | Add browser regression for existing metadata |
| Evidence is not routing or tariff authority | §5.3.3, K8/K14 items | Price evidence label; negative cost-cap gate; discovery-only availability; K13 SHADOW | API `model-identity.test.ts`, `artificial-analysis.test.ts`, `router-model.test.ts`; Demo B | SATISFIED | Preserve and state in card |
| Capability-gated Cockpit catalog with durable offline snapshot | §5.3 K14 item | Cockpit #38: ControlPlaneClient.models, modelCatalogSnapshot | Cockpit `controlPlaneModels.test.ts`, `modelCatalogSnapshot.test.ts`, `modelCatalogWiring.test.ts` | SATISFIED | Record shipped status |
| Usage/Retro share prices; old local table retired after offline proof | §5.3 K14 item | Cockpit modelPricingResolver used by both; modelPricing.ts deleted | Cockpit `modelPricingResolver.test.ts`, `modelCatalogWiring.test.ts`, `retroSummary.test.ts` | SATISFIED | No second pricing source |
| Loading, failure and empty are distinct | closure brief | Cockpit distinguishes them; Agents initially says no evidence while loading | No focused Agents browser regression | PARTIAL | Distinguish states and test |

## Merged implementation evidence

- Control Plane [K7 #29](https://github.com/osovlanski/ai-control-plan/pull/29),
  [K8 #33](https://github.com/osovlanski/ai-control-plan/pull/33),
  [K9 #30](https://github.com/osovlanski/ai-control-plan/pull/30),
  [K11 #31](https://github.com/osovlanski/ai-control-plan/pull/31), and
  [UI V3 #39](https://github.com/osovlanski/ai-control-plan/pull/39).
- Cockpit [K12 #37](https://github.com/osovlanski/cockpit/pull/37), merge
  `ec1569a201aa45aab0d2181ff816308e31e054fd`, CI success.
- Cockpit [K14 #38](https://github.com/osovlanski/cockpit/pull/38), merge
  `833d42016297c43918e4b7694798a790a30be15c`, CI success.
- Cockpit current-main comparison retains `public/contextGauge.js`,
  `public/modelCatalog.js`, `modelCatalogSnapshot.ts` and
  `modelPricingResolver.ts` unchanged from K14. Current `public/app.js` still
  calls `renderPlaneManagedContext` independently after schedule refresh.
- Cockpit snapshot preserves evidence observedAt separately from syncedAt,
  survives failed/malformed reads, and carries connection scope. Pricing uses
  provider-qualified identities, never current aliases for historical runs.

Historical design and implementation records retain their original claims;
dated status annotations link here rather than rewriting history.

## Result of this closure

**K12: PARTIAL.** Presentation/observation implementation is complete in both
products. The bounded web changes label the latest execution session, format
the API's supplied pressure without recomputing it, reject stale/unavailable
pressure inputs, and correct the adjacent K11 implementation status. The
remaining item is evidence for kernel-services §5.2.4, not another service or
gauge: a recorded real Claude session beyond `warnRatio` and an observed boundary
if the provider auto-compacts. The bounded follow-up hit a real Claude rate
limit; the real Codex unavailable-session API/renderer check passed. See the
[sanitized live acceptance record](agentic-os-k12-live-acceptance.md). No
transcript is committed.

**K14: COMPLETE.** The Cockpit acceptance was already delivered by #38. In the
existing Control Plane Agents card, each price now shows its own source and
observedAt rather than relying on the model entry's tier. Missing facts and
initial loading are explicit; canonical capability evidence is visible.
Benchmark release/publication/model-release/fetch metadata remains separate.
No backend, migration, catalog store, pricing resolver or routing-policy change
was needed.

The browser regressions use explicitly scripted HTTP evidence to test
presentation, plus the real in-process API for the surrounding application.
They are not provider-conformance or live-pressure evidence. Existing API/core/
adapter tests establish the producer-side honesty boundaries.

### Remaining priorities and Green-Light-A

- **P0:** none identified in this bounded closure.
- **P1 acceptance evidence:** kernel-services §5.2.4 is still unverified. Do not
  mark the combined K9/K12 acceptance complete or issue an unconditional
  Green-Light-A clearance from this record. No K12/K14 implementation package
  remains after this change; the remaining work is the live evidence run.
- **P2:** no new implementation follow-up identified by this review. Ordinary
  dogfooding and the pre-existing UI V3 limitations remain outside this slice.

K5/#37, Cockpit K6 queue extensions, K10 implementation, K13 activation,
K15/K16, provider runtime refactors and H cleanup are unchanged. Cockpit was
inspected read-only; all changes belong to the isolated Control Plane branch.

## Validation of the closure branch

- `pnpm typecheck`: passed, exit 0.
- `pnpm lint`: passed, exit 0, no diagnostics.
- `pnpm test`: passed, exit 0 — core **116**, adapters **21**, API **818**,
  web **47**; **1,002 tests / 73 files**, no failures or skips.
- `pnpm build`: passed, exit 0.
- `pnpm --filter @agent-plane/web exec playwright test e2e/operator-closure.spec.ts --project=chromium`:
  **4 passed**, including 1100px/390px catalog checks and the mobile Context
  readout. Generated screenshots were reviewed and remain ignored test artifacts.
- Web context coverage is **14 tests**, including eight added cases for session
  identity, canonical/missing pressure, unavailable sources and invalid/stale
  evidence. Browser cases cover per-price provenance, benchmark metadata,
  unknown availability/facts, loading/empty/error states and K11 status.
- Existing full-suite tests cover Codex unavailable occupancy, effective-window
  semantics, requested/resolved identity, pricing applicability, benchmark
  provenance and evidence not granting routing or bounded-cost authority.
- An initial browser-fixture type error (`task.id` vs `task.taskId`) was fixed.
  Interrupted validation attempts are not counted as passes; the completed
  reruns above passed. The later bounded live check proves only the Codex
  unavailable-session projection; it does not close Claude pressure acceptance.
- Cockpit historical K12/K14 CI checks were successful. Cockpit tests were
  inspected but not rerun or changed in this Control Plane worktree.

## PR #40 CI follow-up

[CI #108](https://github.com/osovlanski/ai-control-plan/actions/runs/34861529828)
at `9ee1faba2c776d253ef5bcec49d7cf76fc1fd396` failed once removing
`repo/.git/objects` in the failover handoff test. Attempt **2 passed on the
unchanged head**, including the normal suite, Harness-on suite, recovery-chaos
gate and build. No source/test cleanup correction was made.

The exact failing scenario passed **21/21** local runs: one initial invocation,
then ten with legacy execution and ten with Harness single mode. Local Node
was 22.18.0; CI used 22.23.2, the same supported major. Patch-version parity
was not claimed; the successful unchanged rerun used CI's own environment.

Inspection found a plausible pre-existing race: legacy `consume` removes its
active entry before detached `settleRun` finishes; `settleRun` transitions the
task terminal before awaiting the completion checkpoint. `waitForSettled` and
shutdown therefore need not imply that checkpoint Git writes have ended. The
nested real-repository teardown deletes its fixture before outer teardown. Git
helper calls themselves await `execFile`; no unawaited child spawn was found
inside those helpers. PR #40 did not change these paths.

**Root cause: unknown; suspected pre-existing cleanup flake.** The source
ordering is a hypothesis, not proof that this caused CI's single ENOTEMPTY.
There was no deterministic reproduction, so no speculative retry, sleep,
production-lifecycle change or test assertion weakening was introduced.

Code safety and milestone acceptance are separate: the unchanged CI rerun
passed, K12 implementation and K14 are complete, and the Claude live-pressure
proof remains the Green-Light-A K12 gate. Final-head validation is recorded in
the PR checks and follow-up summary.
