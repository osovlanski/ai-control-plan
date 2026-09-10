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

## 10. Reference-image visual acceptance — convergence pass

Reference: `/home/ubuntu/workspace/reference-images/Agentic_OS_View.png` (design
language only; the Control Plane is truth). Evaluation is structural /
perceptual, not pixel similarity. Captured at 1440×900
(`demo-b-*-viewport-1440x900.png`, `demo-b-hero.png`) plus full-page
(`demo-b-1-shadow-vs-actual.png`, `demo-b-2-hard-filter.png`,
`demo-b-3-missing-prior.png`). "Before" = the first Demo B pass
(`.satellite`-level shadow, field-left / inspector-right, small dark sphere).

The first pass was functionally complete but **visually too incremental**: the
Orbital represented *assistants*, not *models*, so a K13 recommendation of
`assistant/selector` could not be drawn; SHADOW was a small dashed dot on the
assistant with **no ACTUAL counterpart shown**; the sphere was a low-contrast
near-black disc pushed into a corner; the hard filter lived only in Inspector
prose. This pass is the correction.

| # | Category | Before | Exact change | After evidence | Score |
|---|---|---|---|---|---|
| 1 | Overall composition | Field left / Inspector right, 50/50; no dominant element | `.orbital-layout` order swapped — contextual Inspector + operational strip on the left, Orbital on the right; grid `1fr 1fr`, map `position: sticky` | `demo-b-1-viewport-1440x900.png`: Orbital anchored top-right, ops/inspector left; matches the reference's left-ops / right-orbital split | 4 |
| 2 | Orbital prominence | `.orbital-map` ~46% but the sphere filled little of it | Column ≈ 50% of the workspace; `SPHERE_R` 210→300, scene `max-width` 700→560 with negative top margin so the sphere fills its region | `assertReferenceComposition()` asserts `map.width > main.width*0.44` **and** `scene.width > map.width*0.8` at 1440×900 and 1280×800 | 4 |
| 3 | Sphere depth | Teal-on-black disc, flat, grid + halo + specular only | Blue→violet body gradient; contained white-hot `#sph-core` light; 3 translucent `.sph-shell` rings; gold `#sph-arc` crossing in front of / behind the core; restrained `#sph-amber` counter-light; brighter rim + orbit strokes; idle-only atmospheric breathing | `demo-b-hero.png`: layered, dimensional sphere with a luminous core and visible orbit rings; `prefers-reduced-motion` still renders it coherently (asserted) | 4 |
| 4 | Command composer prominence | Thin bar, 16px input, single action | `.command-surface`: 18px input, gradient border + glow, larger spark mark, primary `Route mission`, secondary `↵ route`, and a row of four suggestion chips that route to Intake (existing behaviour, no fake controls) | `demo-b-hero.png`: composer is the loudest element above the composer help line; `toBeInViewport()` asserted at 1440×900 and 1280×800 and under reduced motion | 4 |
| 5 | ACTUAL vs SHADOW clarity | Only SHADOW shown (dashed dot); ACTUAL absent — "nothing is executing" was the implicit proof | Both drawn together as two bowed relationship **paths** (`path.rel-actual` solid teal, `path.rel-shadow` dashed amber, opposite bows) plus a teal `.model-actual-chip` and an amber `.model-node.is-shadow`. When ACTUAL and SHADOW share a model the ONE node carries both (`is-actual is-shadow`, stacked badges); both paths still separate. Inspector repeats it as a two-panel `.truth-split` | `demo-b-1-shadow-vs-actual.png` + `demo-b-4-same-model.png`; tests assert `path.rel-actual` = 1, `path.rel-shadow` = 1, distinct `d`, computed `stroke-dasharray` (actual solid / shadow dashed) pre-exec **and** while executing, `APPLIED` absent | 5 |
| 6 | Model-level relationship clarity | Nodes were `fake-a` (assistant), not `fake-a/premium-max` | New `modelNodes()` projection of `modelRecommendation.candidates`; every node is `assistantId/<em>selector</em>` and knows eligibility, filter failures, score, priorMissing, shadow, actual | Tests assert the SHADOW node contains `premium-max` (not just `fake-a`) and that `fake-a/swift-mini` — same assistant — is present and **not** `.is-shadow`; `orbital.test.ts` proves the projection | 5 |
| 7 | Hard-filter legibility | Exclusion only in Inspector text; on the node it truncated (`EXCLUDED · QUOTA BLOC…`) and was near-invisible at 50% opacity | `.model-node.is-excluded`: **0.74** opacity, dotted ring, no glow; `EXCLUDED · <short semantic reason>` via `shortFilterReason()` (`quota exhausted → "Quota exhausted"`, `auth… → "Authentication unavailable"`, …), wraps instead of clipping; full technical string still in `title` + Inspector | `demo-b-2-hard-filter.png`: `fake-a/premium-max` reads `EXCLUDED · Quota exhausted` in the hero. Tests assert the **rendered** text contains `Quota exhausted` at 1440×900 (not tooltip-only), `title` matches `/quota/i`, `.is-excluded.is-shadow` = 0 | 4 |
| 8 | Information hierarchy | Even-weight panels; register competed with the field | COMMAND (composer) → MISSION (status strip + selected mission) → ORBITAL INTELLIGENCE (right) → CONTEXTUAL INSPECTOR (left); register stays a secondary rail below | `demo-b-1-shadow-vs-actual.png`: the Orbital and the ACTUAL/SHADOW split are the eye's first two stops; no card grid | 4 |
| 9 | Premium / polished feel | Dark + restrained but flat; sphere read as a widget | Dimensional sphere, layered glow, one-accent discipline (teal = active/selection, amber = shadow), mono identifiers, generous composer | `demo-b-hero.png` | 4 |
| 10 | Semantic truthfulness | (already strong) | ACTUAL model is only ever the persisted `execution.requestedModelSelector`; when NULL it shows **`Model: unspecified`**, never invented; the ACTUAL status line is now the mission's real lifecycle (`actualStatusLine()`), so a terminal task never says "will execute"; K13 stays SHADOW | Tests: `execution_requests.model` / `runs.model_requested` NULL after the run; `mode: "shadow"`, `decidedBy: "unchanged"`; `demo-b-5-cancelled` asserts the ACTUAL chip + Inspector panel never match `/will execute/` | 5 |

**No category below 4.** Remaining compromises, stated plainly:

- The `.map-legend` / `.map-caption` key can sit just below the 1440×900 fold on
  the hero. The orbital *story* (sphere, ACTUAL + SHADOW nodes and both
  relationship paths, one exclusion) is above the fold; the legend is fully
  visible on the full-page shots and after a short scroll.
- The amber `#sph-amber` counter-light is restrained by design so status colour
  stays legible.
- Left column below the Inspector is sparse on the hero (no fabricated
  "Recent activity" feed — the reference's is illustrative).

### 10a. Independent visual review corrections (GPT-6 Astra High → REQUEST CHANGES)

A cold independent review returned five blocking P1 findings. Each is fixed in
presentation / UI semantics only — no change to K13 scoring, hard filters,
activation, routing, CR-33, K8/K10/K11 or the task state machine.

| Finding | Original failure | Correction | Regression |
|---|---|---|---|
| **P1-1** ACTUAL disappears when ACTUAL and SHADOW target the same model | node `cls` let `is-shadow` win over `is-actual`; the two relationship `<line>`s overlapped exactly | one candidate identity may carry **both** `is-actual is-shadow` with stacked ACTUAL/SHADOW badges; relationships are bowed `<path>`s with opposite curvature so both stay legible to a shared endpoint | `orbital.test.ts` "carries BOTH relationships on one node…"; `demo-b.spec` Demo B/4 (`overrides.model` == shadow selector) asserts one node, both classes, distinct `d`, computed solid/dashed |
| **P1-2** a cancelled mission still showed `Routed · will execute` | ACTUAL line was a binary `running ? "Executing" : "Routed · will execute"` | `actualLifecycle()` maps canonical/effective state → 8 buckets; `actualStatusLine()` gives each a truthful phrase (`Cancelled · will not execute`, `Completed`, `Paused · waiting for resource`, …). Wired through the Orbital chip, the same-model node badge, and the Inspector `.truth-actual` | `orbital.test.ts` "never implies future execution for a terminal task" (routed/running/waiting/completed/failed/cancelled); `demo-b.spec` Demo B/5 asserts no `/will execute/` in the chip or the Inspector panel |
| **P1-3** ACTUAL relationship became dashed while executing (`stroke-dasharray: 10 6`) | `.is-executing .rel-actual` set a dash array | removed; `.rel-actual` base is `stroke-dasharray: none`; execution now animates a glow/opacity pulse only. SHADOW's dash is unconditional | `demo-b.spec` Demo B/1 + B/4 read `getComputedStyle(path.rel-actual).strokeDasharray` — must be `none`/all-zero **while `.is-executing` is forced**; SHADOW must be non-empty. New captures `demo-b-running-unspecified.png`, `demo-b-running-same-model.png` |
| **P1-4** hard-filter reason too dim / truncated in the hero (`EXCLUDED · QUOTA BLOC…`, 50% opacity, uppercased + clipped) | raw `filterFailures[0]` + `text-transform: uppercase` + `white-space: nowrap` + `opacity: 0.5` | `shortFilterReason()` presentation mapper (technical string → `Quota exhausted` / `Authentication unavailable` / `Disabled` / `Context window too small` / `Operator override` / …); excluded `small` wraps, `opacity: 0.74`, colour `--text-2`. Full technical string unchanged, still in `title` + Inspector | `orbital.test.ts` "maps a technical filter string to a short semantic reason"; `demo-b.spec` Demo B/2 asserts the **rendered** node text contains `Quota exhausted` at 1440×900 |
| **P1-5** sphere depth / visual identity materially trailed the reference | scene `max-width: 560`, `SPHERE_R: 300` (~336 px apparent), faint single-gradient disc, weak front/back separation, tiny satellite labels | scene `max-width: 600` pulled up under the heading; `SPHERE_R` 300→312 (core spans ~60–64% of the Orbital region); shell/grid/rim/arc opacities and widths raised; `orbit-front` bold + thick vs faint `orbit-back` for unmistakable occlusion; `sph-amber` counter-light 0.6→0.82; model nodes 14→18 px bodies, 12 px labels; top chrome trimmed (h1 40→32, tighter margins) for vertical fit | `assertReferenceComposition()` still holds (`map.width > main.width*0.44`, `scene.width > map.width*0.8`) at 1440×900 and 1280×800; `demo-b-hero.png` |

This pass is prepared for a **second independent cold visual review**; the scores
above are the implementer's and are explicitly not a self-approval.

## 11. What Demo B proves

| Claim | Evidence |
|---|---|
| A recommendation is computed and persisted on every routing decision, in SHADOW | `routing_decisions.explanation.modelRecommendation`, `mode: "shadow"`, `activation.active: false` |
| Every number is sourced (I-M1) | each dimension carries source, normalization version, benchmark release + publishedAt, observedAt, freshness, and the raw measurement |
| Own telemetry blends against the prior at the documented weight | coding n = k ⇒ w = 0.5 ⇒ score = 0.5·telemetry + 0.5·prior, reconstructible from the panel |
| A hard-filtered candidate can never be recommended, however good its prior | Demo B/2: `fake-a/premium-max` (0.92 + full cohort) excluded, `total` undefined, `fake-b/swift-mini` (0.55) recommended |
| A missing prior is shown, not guessed | Demo B/3: `fake-c/nightly` → `priorMissing:{coding,speed,cost}`, no fuzzy match, still eligible, still executes |
| The shadow winner never alters execution (CR-33) | `execution_requests.model` and `runs.model_requested` are NULL after a run whose shadow winner was `fake-a/premium-max`; `execution.decidedBy: "unchanged"` |
| The Orbital cannot imply the shadow winner ran | `.model-node.is-shadow` (dashed amber, `SHADOW · would choose`) is rendered alongside the teal `.model-actual-chip`; `line.rel-shadow` is dashed amber, `line.rel-actual` solid teal; `.model-node.is-shadow.is-actual` count is 0 |
| The Orbital represents models, not just assistants | `modelNodes()` projects `modelRecommendation.candidates`; the SHADOW node is `fake-a/premium-max` and `fake-a/swift-mini` (same assistant) does not inherit the style — `apps/web/src/orbital.test.ts` |
| Activation stays closed | 1/6 gates pass; `models.selection.enabled` is never set; no attestation is written or backdated |
| The soak report does not mutate activation state | `apps/api/test/model-shadow-report.test.ts` — identical output on re-run, row count unchanged, no write path to selection state |
| Demo A and Demo A.5 stay green | `pnpm demo:a`, `pnpm demo:a5` in the same validation run |

## 12. Non-goals

Demo B does **not** activate K13, set `models.selection.enabled`, write
`shadowReviewedAt` / `egressVerifiedAt`, backdate any log, or start K15/K16/K4b.
The remaining M12 dimensions (architecture, frontend, review, reasoning,
long-context, tool-use) are out of scope until both a prior and a metric exist
for them.
