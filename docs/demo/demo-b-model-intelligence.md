# Demo B — model intelligence, end to end, in truthful SHADOW mode

Demo B is the repeatable end-to-end demonstration of the merged **K13** model
selection slice (kernel-services §4.4.3), running the way it ships: **SHADOW**.
A model recommendation is computed, fully sourced, and shown on every routing
decision, and **nothing about execution changes**. It consumes **K7** model
identity and the **K8** Artificial Analysis benchmark priors that are already in
`main`.

Like Demo A and Demo A.5 it adds no kernel semantics of its own — it is an
integration, UI, and validation artefact.

At completion the product claim it backs is:

> Agentic OS can tell an operator which model it *would* choose for a task, show
> the whole derivation — identity, benchmark prior, own telemetry, blend weight,
> hard filters — and prove that the recommendation did not touch what actually
> ran. Automatic selection stays off until a real week of shadow evidence and
> the operator attestations exist.

## 1. The flow the screenshots make legible

```
user goal
  → routing / composition (unchanged)
  → candidate assistants/models around the Orbital
  → a hard filter removes a candidate
  → K13 SHADOW recommends another
  → actual execution remains unchanged
```

Both facts are always visible together:

| | |
|---|---|
| **ACTUAL** | the assistant/model that is executing (or `unchanged` / the operator's selector) |
| **SHADOW** | "Would choose `<assistant/model>`", with `Activation: not eligible yet` and the failing gates |

The Orbital marks the shadow "would choose" satellite with a **dashed amber
ring** — deliberately not the teal "executing" style — so the field can never
imply the shadow winner ran.

## 2. Run it

```
pnpm demo:b          # from repo root — Playwright project `demo-b`, 1440×900
```

or

```
pnpm --filter @agent-plane/web exec playwright test e2e/demo-b.spec.ts --project=demo-b
```

Deterministic: a real in-process `buildServer`, the `FakeAdapter`, an injected
clock, and **scripted in-process `CatalogSource`s** for the benchmark and price
priors — the same K8 seam Artificial Analysis plugs into. **No network.**
`models.selection.enabled` is never set.

Artefacts (git-ignored) land in `apps/web/test-results/demo-b-*/`:
`demo-b-0-overview-command-state.png`, `demo-b-1-*`, `demo-b-2-*`, `demo-b-3-*`
(each scenario has a 1440×900 viewport shot and a full-page shot), plus trace and
video.

## 3. The deterministic scenario (Demo B/1)

Three fake assistants, each advertising real catalog model ids via
`assistants.<id>.options.models`:

| Assistant | Advertises | AA coding | AA speed | Price (in/out $/Mtok) | Own coding cohort |
|---|---|---|---|---|---|
| `fake-a` | `premium-max`, `swift-mini` | `premium-max` 0.92 | 0.45 | 15 / 75 | `premium-max` at n = k = 10, all successful |
| `fake-b` | `swift-mini` | `swift-mini` 0.55 | 0.90 | 1 / 4 | — |
| `fake-c` | `nightly` (a moving alias) | — no AA row — | — | — | — |

Task: *"Implement the streaming JSON parser"*, profile `best-quality`
(coding-weighted). What the Decision tab then shows and the test asserts:

| Shown | Value |
|---|---|
| Requested vs resolved identity | requested `nightly` etc.; resolved `catalog-exact` — "the selector is a catalog model id for fake" |
| Provider-safe candidate identities | each candidate is `assistant/selector`; a prior attaches only to a proven identity |
| One AA prior | coding `external:artificial-analysis` 0.92, `intelligence-index-4.3`, published 2026-06-01, `aa-normalization-v1` |
| Own telemetry sample | coding `success × test-pass × verification-pass`, n = 10 |
| n / k / telemetry weight | coding n = 10, k = 10, w(n) = 10/(10+10) = **0.50** |
| Coding / speed / cost evidence | coding ≈ 0.96 (0.5·1.0 + 0.5·0.92); speed prior 0.45; cost prior `k7:price-evidence` (never AA pricing) |
| Hard-filtered alternative | present in Demo B/2; here every candidate is eligible |
| Recommended model | **`fake-a/premium-max`** — highest blended score on a coding-weighted task |
| `mode` | `SHADOW` |
| "Current execution: unchanged" | the run named no model; `ExecutionRequest.model` stays the only authority |

**Provider-request proof.** The task is then routed and started. The test reads
`execution_requests.model` (NULL) and `runs.model_requested` (NULL) directly from
the durable store: the shadow winner `fake-a/premium-max` did **not** become the
requested selector. The persisted recommendation still says `mode: shadow`,
`applied: undefined`, `execution.decidedBy: unchanged`.

## 4. Second scenario — a hard filter beats the benchmark (Demo B/2)

`fake-a` (which owns `premium-max`, AA coding 0.92 **plus** a full own-telemetry
cohort — the best-scoring candidate by far) is made **quota-exhausted**. Result:

- `fake-a/premium-max` and `fake-a/swift-mini` are **Excluded** with a named
  reason (`quota blocked … quota exhausted`), and carry **no score** —
  `total` is `undefined`.
- `fake-b/swift-mini` (AA coding **0.55**, no own telemetry — a materially lower
  score) is the recommendation.
- The panel states: *"A benchmark score never resurrects an excluded candidate —
  hard filters run before any score."*

This is the product point: Agentic OS is not a leaderboard follower. Eligibility
is decided by the same hard filters `route()` already ran (auth, capability,
workspace policy, quota, cooldown), and external evidence can never grant it.

## 5. Third scenario — a missing prior is honest (Demo B/3)

`fake-c` advertises the selector `nightly`. Discovery makes it a `catalog-exact`
identity, but **no Artificial Analysis row joins it** — and K13 does not
fuzzy-match `nightly` onto `premium-max` (I-M5: an alias is never resolved
against today's catalog). The Decision tab shows:

```
Eligible, but benchmark identity unproven:
  fake-c/nightly   priorMissing
    catalog-exact — … · priorMissing:coding … · priorMissing:speed … · priorMissing:cost …
  No alias or fuzzy match is made to a benchmarked model. The candidate stays
  eligible; it simply carries no prior.
```

The dimension contributes **nothing** (missing data is never normalized to a
neutral 0.5). Execution still works under current routing semantics — the test
routes and completes the task on `fake-c`.

## 6. Shadow-soak read path

```
pnpm model:shadow-report            # text
pnpm model:shadow-report --json     # machine-readable
```

A **read-only** CLI (`apps/api/src/bin/model-shadow-report.ts`) over
`routing_decisions` in the workspace DB. It answers, from durable state alone:

- number of shadow recommendations, and the first / most-recent timestamp;
- candidate coverage (every `assistant/selector` scored);
- recommendations by model;
- `priorMissing:{coding,speed,cost}` counts;
- hard-filter violation count (must be 0 to activate — reuses
  `countHardFilterViolations`);
- resolved own-telemetry `n` vs `k`, per model per dimension;
- how many activation gates currently pass / fail, from the most recent
  recorded recommendation.

It **never** sets `models.selection.enabled`, writes `shadowReviewedAt` /
`egressVerifiedAt`, or backdates anything. On a fresh workspace it prints zeros
and says so. Covered by `apps/api/test/model-shadow-report.test.ts` (no mutation,
survives no AA network, reconstructible arithmetic, no secret in output).

## 7. Current activation gates

On `main` today, every routed task's recommendation is `SHADOW` with **1 / 6
gates passing**:

| Gate | State | Why |
|---|---|---|
| `config` | ❌ | `models.selection.enabled` is `false` (the shipped default) |
| `telemetry` | ❌ | needs ≥ 2 eligible candidates with a resolved per-model cohort at or above `k` |
| `shadow-week` | ❌ | no 7-day span of recorded shadow recommendations yet |
| `shadow-reviewed` | ❌ | `models.selection.shadowReviewedAt` not set (and must postdate a full week of log) |
| `no-filter-violations` | ✅ | no recorded recommendation has named a hard-filtered candidate |
| `egress-verified` | ❌ | `models.selection.egressVerifiedAt` not set |

Activation is **fail-closed**: `active` is true only when all six pass. Demo B
does not move any of them. The one-week soak is what fills `shadow-week` and
makes the two attestations meaningful.

## 8. Artificial Analysis live check

`AA_API_KEY` is **not present** in this environment, so no live catalog refresh
was run. Demo B does not need it — the deterministic scenario uses scripted
in-process priors. When a key is available, one bounded refresh
(`built.modelCatalog.refresh()`, `AA_MAX_PAGES = 20`) reports endpoint success,
mapped vs unmatched models, and which mapped models are actually `availableVia`;
K8 §17 documents the exact capture values. No secret or raw payload is committed.

## 9. Cockpit K14 status

Cockpit PR **#38** (`feat(agentic-os): add K14 catalog and pricing snapshot`) is
**merged** on `cockpit` `main` (`833d420`). K14 renders the K7 `/api/models`
catalog and one pricing resolver (offline snapshot, `modelPricingResolver.ts`),
consumed by Usage + Retro. It is model **catalog and price evidence**, not model
scoring — Demo B adds no duplicate scoring to Cockpit. The Control Plane remains
the sole place a K13 recommendation is computed.

## 10. Reference-image visual acceptance

Reference: `/home/ubuntu/workspace/reference-images/Agentic_OS_View.png`.
Evaluation is structural / perceptual, not pixel similarity. Captured at
1440×900 (`demo-b-*-viewport-1440x900.png`) plus full-page.

| Category | Score | Note |
|---|---|---|
| Visual hierarchy | 4 | active mission prominent; Decision panel is the focus; register secondary |
| Orbital prominence | 4 | `.orbital-map` > 40% of workspace width; sphere + provider satellites + rings |
| Depth / dimensionality | 4 | existing glass/dark sphere with grid, halo, specular — unchanged |
| Command composer prominence | 4 | "What should Agentic OS do?" full-width across the top, primary "Route mission" action, in viewport without scrolling |
| Provider/model relationship clarity | 4 | satellites labelled per assistant; the shadow "would choose" satellite is distinctly dashed/amber and captioned |
| Operational density | 4 | workspace status strip + register + inspector tabs; cards do not overwhelm the Orbital |
| Readability | 4 | mono for identifiers, dimension rows carry source + freshness + sample size |
| Premium / polished feel | 4 | dark technical aesthetic, restrained glow; no card-grid look |
| Product-language similarity to the reference | 4 | same shell: compact left nav, top composer, Orbital left/centre, operational cards right |
| Semantic truthfulness | 5 | Orbital state is real kernel state; SHADOW vs ACTUAL never conflated; failed gates shown truthfully; no invented agents/approvals/health |

No category below 4. The real Orbital is dimmer than the mock when little is
executing (there is no idle animation faking activity) — backend truth wins over
the mock, per the acceptance brief.

## 11. What Demo B proves

| Claim | Evidence |
|---|---|
| A recommendation is computed and persisted on every routing decision, in SHADOW | `routing_decisions.explanation.modelRecommendation`, `mode: "shadow"`, `activation.active: false` |
| Every number is sourced (I-M1) | each dimension carries source, normalization version, benchmark release + publishedAt, observedAt, freshness, and the raw measurement |
| Own telemetry blends against the prior at the documented weight | coding n = k ⇒ w = 0.5 ⇒ score = 0.5·telemetry + 0.5·prior, reconstructible from the panel |
| A hard-filtered candidate can never be recommended, however good its prior | Demo B/2: `fake-a/premium-max` (0.92 + full cohort) excluded, `total` undefined, `fake-b/swift-mini` (0.55) recommended |
| A missing prior is shown, not guessed | Demo B/3: `fake-c/nightly` → `priorMissing:{coding,speed,cost}`, no fuzzy match, still eligible, still executes |
| The shadow winner never alters execution (CR-33) | `execution_requests.model` and `runs.model_requested` are NULL after a run whose shadow winner was `fake-a/premium-max`; `execution.decidedBy: "unchanged"` |
| The Orbital cannot imply the shadow winner ran | `.satellite.shadow` (dashed amber) is rendered; `.satellite.executing` count is 0 |
| Activation stays closed | 1/6 gates pass; `models.selection.enabled` is never set; no attestation is written or backdated |
| The soak report does not mutate activation state | `apps/api/test/model-shadow-report.test.ts` — identical output on re-run, row count unchanged, no write path to selection state |
| Demo A and Demo A.5 stay green | `pnpm demo:a`, `pnpm demo:a5` in the same validation run |

## 12. Non-goals

Demo B does **not** activate K13, set `models.selection.enabled`, write
`shadowReviewedAt` / `egressVerifiedAt`, backdate any log, or start K15/K16/K4b.
The remaining M12 dimensions (architecture, frontend, review, reasoning,
long-context, tool-use) are out of scope until both a prior and a metric exist
for them.
