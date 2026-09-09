# K13 — shadow model selection: implementation and acceptance record

Implemented on `feat/agentic-os-k13-model-selection`, based on
`docs/agentic-os-kernel-services.md` (§4.4.1–§4.4.5, §5.3 K13, CR-33, invariants
I-M1 – I-M5). K7 and K8 are unchanged and still win where they and this record
disagree.

**Automatic model selection is NOT enabled by this PR and is not ready to be.**
K13 ships in **shadow**: a recommendation is computed, fully sourced and
persisted on every routing decision, and nothing about execution changes. The
activation mechanism is implemented and fail-closed; the gates it requires
cannot hold at merge time (see §9).

```
TaskIntent
  → classifyTask (coding / speed / cost, deterministic)
  → assistant hard filters      (route(), reused verbatim — never recomputed)
  → model hard filters          (compatibility, override, declared min window)
  → candidate identity          (proof, or priorMissing)
  → evidence                    (K8 priors + K7 price evidence + own cohorts)
  → blend                       score_d = w(n)·telemetry + (1−w(n))·prior
  → routing_decisions.explanation.modelRecommendation      ← SHADOW, terminal
      ✗ ExecutionRequest.model   ✗ RunSpec.model   ✗ chosen assistant
```

## 1. Candidate identity — the hard precondition

A K13 candidate is **assistant + runtime model selector**, e.g.
`personal-claude/opus`. A benchmark prior may attach to it only when that pair is
bound to a catalog identity `provider:modelId` by **proof**. Two proofs are
accepted (`resolveCandidateIdentity`, `apps/api/src/modules/model-selection.ts`):

| Basis | Proof | Prior? |
|---|---|---|
| `catalog-exact` | the selector **is** a catalog model id for that provider, established by provider-official or own evidence | yes |
| `observed-resolution` | this workspace's own runs on **this assistant** requesting **this selector** were all served as one provider-reported `model_resolved`, inside the window | yes |
| `unresolved` | anything else — including an alias that only a catalog alias row would resolve, and a selector that resolved to two different models | **no** |

**An alias table is deliberately not a proof.** The Claude adapter advertises
`opus` and `sonnet`; the K7 price seed carries `opus` as an alias of
`claude-opus-4-1`. Binding those with today's catalog is exactly the
historical-alias resolution I-M5 forbids, and it is the mechanism by which an AA
point-release or reasoning-effort score would end up attributed to a model it
never described. On a workspace that has never recorded a resolved model for
`opus`, the candidate is `unresolved` and carries `priorMissing:coding` /
`priorMissing:speed`. That is the intended, shipped behaviour — a missing prior
is valid; a wrong attribution is not.

**Execution configuration.** A candidate carrying any non-empty
`identity.executionSettings` receives **no** prior: K8 maps only base
configurations (`AA_MODEL_MAP` joins on AA's stable id, and an effort variant has
its own AA id that is simply absent from the table), so a differently-configured
candidate is not the thing the benchmark measured. No such settings exist on
today's `RunSpec`, so the guard is currently inert by construction — which is the
point: it cannot silently become wrong when they arrive.

**No blocker was written.** The contradiction §1 of the brief asks about does not
exist: K7/K8 identity is sufficient to *refuse* a join safely, and refusing is a
supported outcome. `docs/agentic-os-k13-blocker.md` was not created.

## 2. Classification — three dimensions, deterministic

`classifyTask` (`packages/core/src/model-selection.ts`) is a pure function of the
durable intent. No LLM call, no I/O, no clock.

- **Base weights** come from the routing profile (`best-quality` → coding-heavy,
  `fastest` → speed-heavy, `lowest-tokens`/`preserve-quota` → cost-heavy,
  `auto` → 0.5/0.25/0.25).
- **Signals** are fixed regexes over goal + constraints with fixed increments:
  coding verbs, review verbs, urgency, cost sensitivity, quota sensitivity.
- Weights are normalized to sum to 1; the matched signals are persisted in
  `modelRecommendation.classification.signals`.

Only `coding`, `speed` and `cost` exist. `taskKind` (the cohort key) reuses the
same vocabulary `TelemetryService.scores` already uses, so a model cohort and an
assistant score can never disagree about what kind of work a task was.

## 3. Hard filters — first, named, unbypassable

Assistant-level filters are **not reimplemented**. `recommendModel` receives
`route()`'s own per-assistant verdict (`explanation.candidates[].filterFailures`)
and inherits it verbatim, so auth, capability, workspace allowlist, cooldown and
quota projection cannot drift between the two layers. K13 adds only what is about
a model:

| Filter | Source | Behaviour |
|---|---|---|
| assistant/provider auth | `route()` | inherited, named |
| assistant capability (filesystem/shell/manifest) | `route()` | inherited, named |
| workspace policy (repo allowlist) | `route()` | inherited, named |
| quota projection | `route()` (`QuotaProjection`) | inherited, named |
| cooldown | `route()` | inherited, named |
| security policy | K13 | a `read-only` workspace may not dispatch a repository task — excludes every candidate, named |
| model compatibility | K13 | only selectors the assistant's manifest advertises become candidates; an override naming an unadvertised selector appears as its own excluded candidate |
| explicit model / assistant override | K13 | applied as a filter, not a preference |
| declared minimum context window | K13 | excludes when capacity is unknown **or** below the declared minimum |

`selectModel` scores **only** candidates with zero filter failures.
`CandidateScore.total` is `undefined` for an ineligible candidate, so a benchmark
value of 1.0 cannot resurrect it (I-M2). Unknown capacity with no declared
minimum is an **advisory** (`candidate.advisories`), never an exclusion.

## 4. Priors

| Dimension | Prior | Pinned source |
|---|---|---|
| coding | K8 AA coding index, normalized `aa-normalization-v1` | `external:artificial-analysis` |
| speed | K8 AA `median_output_tokens_per_second`, normalized `aa-normalization-v1` | `external:artificial-analysis` |
| cost | K7 price evidence, normalized `price-normalization-v1` | `k7:price-evidence` |

**AA pricing is not read and is not price authority** (§4.4.5, K8 §21). The cost
prior is a fixed absolute rescale of a K7 priced row at a fixed reference mix
(`COST_REFERENCE_MIX` 0.9 input / 0.1 output — agentic runs are input-heavy),
against `COST_SCALE_USD_PER_MTOK`. The underlying row's own provenance rides
along; only the `source` label and `normalizationVersion` are K13's.

- **Expired** evidence stays readable and visible in the explanation
  (`excludedPriors`), and is never selected.
- **Missing** prior is explicit: `priorMissing:<dimension>`. No neutral 0.5 is
  ever manufactured.

## 5. Own telemetry — cohorts by resolved model

`modelCohorts` (`apps/api/src/modules/telemetry.ts`) builds cohorts keyed by
**resolved model + task kind + harness major + 30-day window**.

- `model_resolved IS NULL` never joins a cohort.
- `harness_major` is a new column (migration `022_model_selection.sql`), written
  forward only by both run writers and **deliberately not backfilled** — we
  cannot prove which harness major served a historical run, and NULL never joins
  a cohort. The honest consequence is that K13 cohorts start empty.
- Reliability uses the shared `reliabilityClass` (I-M4): a healthy K11 context
  yield and a cancellation are **neutral** — out of numerator *and* denominator.

| Dimension | Own metric | `n` |
|---|---|---|
| coding | `success × test-pass × verification-pass`, over the factors that **exist** (a missing factor is not multiplied in as 1.0; the metric string names what the number contains) | reliability sample count |
| speed | median own output tokens/s over run wall-clock, normalized on the **same** absolute scale as the AA speed prior | runs reporting output tokens and a duration |
| cost | median cost per completed task = cohort median usage × applicable K7 price | runs with known usage |

**Known limitation, recorded rather than hidden:** our speed number is a
whole-run wall-clock rate (it includes tool use), which is not the provider-side
generation rate AA measures. Both metric names are persisted in the explanation
so the difference is auditable. No metric without support is invented — with no
usable usage, the speed and cost dimensions simply have no telemetry.

## 6. Blending

`score_d = w(n_d)·telemetry_d + (1 − w(n_d))·prior_d`, `w(n) = n/(n+k)`,
`k = 10` (coding) / `5` (speed, cost). Table-tested at `w(0)=0`, `w(k)=0.5`,
`w(4k)=0.8` for every `k`.

- Missing prior → `telemetry_d · w(n_d)`, flagged `priorMissing:d`.
- `n = 0` and no prior → the dimension contributes **nothing** and is excluded
  from both sides of the cross-dimension average.
- The final score is the classification-weighted mean over **contributing**
  dimensions only, with `evidenceCoverage` recording how much of the weight was
  actually covered.
- `w` is monotone in `n`, **not** in time: a rolling window that drops runs takes
  `w` down with it (tested).
- Greater telemetry weight does **not** by itself reverse a ranking. Both cases
  are tested: one constructed case where a sufficient telemetry gap at `n > k`
  reverses a prior-best ranking, and one where an insufficient gap at the same
  weight does not.

## 7. Normalization versions and source ties

`selectPrior` is deterministic and never mixes normalizations:

1. expired rows are dropped (kept visible with a reason);
2. the **pinned primary source** for the dimension wins over any other source;
3. within the surviving pool the newest row pins the `normalizationVersion`, and
   any row on a different version is **excluded**, never rescaled;
4. ties break on `benchmark.publishedAt`, then `observedAt`, then source — a
   total order, so the same evidence always yields the same choice.

K8 still has exactly one benchmark source. **No second source was added.**

## 8. Shadow mode and CR-33

The recommendation is persisted at
`routing_decisions.explanation.modelRecommendation` and carries: mode,
classification (weights + signals), every candidate with its identity proof,
filter failures, advisories, and per dimension the prior (value, source, tier,
`normalizationVersion`, benchmark release, `publishedAt`, `observedAt`,
freshness, raw metric), the telemetry (value, metric, cohort key), `n`, `k`,
`weight`, blended score, excluded priors and missing-evidence flags, plus the
final recommendation, tie-break reason and the full activation gate.

It also carries `executionUnchanged: { requestedModelSelector, authority:
"ExecutionRequest.model" }` so an audit can see, from the record alone, that
execution was untouched.

**CR-33 is preserved.** `ExecutionRequest.model` remains the sole requested
selector; `Orchestrator.requestedModel` still reads `intent.overrides.model` and
`buildExecutionRequest` remains the only place it becomes `RunSpec.model`. K13
creates no second writer. When activation is eventually allowed, the path is
recommendation → accepted routing decision → immutable `ExecutionRequest.model`
→ existing bridge → `RunSpec.model`; no layer writes `RunSpec.model` on its own.

Regressions: the routing decision (`chosen`, `ruleFired`, everything but the new
field) is asserted identical with and without the recommendation, in both
`apps/api/test/router-model.test.ts` and the `model-shadow` eval scenario. The
K8 routing-invariance test was updated to assert the same property in K13 terms.

Model intelligence can never break routing: `shadowRecommendation` catches, and
routing degrades to no recommendation (I-M3).

## 9. Activation gate — implemented, fail-closed, and OFF

`models.selection.enabled` defaults to **false** and there is deliberately **no
environment-variable override**. `evaluateActivationGate` requires **all** of:

| Gate | Requirement |
|---|---|
| `config` | `models.selection.enabled` is explicitly `true` |
| `telemetry` | ≥ 2 eligible candidates with a resolved per-model cohort at or above `k` on some dimension |
| `shadow-week` | the persisted shadow log spans ≥ 7 days |
| `shadow-reviewed` | `models.selection.shadowReviewedAt` is set, under 30 days old, and was signed **after** the log already spanned a week |
| `no-filter-violations` | no persisted recommendation ever named a hard-filtered candidate (audited from the record, not assumed from the code) |
| `egress-verified` | `models.selection.egressVerifiedAt` is set and under 30 days old |

Absent, unparseable or future timestamps **fail**; they never pass. The two
timestamps are operator/CI **attestations**, which is exactly why they expire.

**Why activation is off, and must be.** No week of K13 shadow evidence exists —
the feature did not exist a week ago — and `harness_major` was only introduced by
this PR's migration, so no run in any existing workspace joins a cohort and the
`telemetry` gate cannot pass either. The production default after merge is
SHADOW. The gate is proved instead by deterministic fake-clock tests
(`packages/core/test/model-intelligence.test.ts`), including each gate failing
alone and the seven-day boundary at ±1 ms.

## 10. Rollback

Setting `models.selection.enabled: false` returns execution to assistant-only
semantics on the next routing decision — it is a read of resolved config, not a
migration. The catalog, benchmark evidence, telemetry and every previously
recorded shadow explanation stay readable. No migration rollback is required;
migration 022 only adds a nullable column and an index.

## 11. UI

The existing Routing/Inspector Decision tab, no redesign. `ModelRecommendationReadout`
(`apps/web/src/board/readouts.tsx`) renders, using existing classes only:

- a heading labelled **SHADOW** or **APPLIED** — never ambiguous;
- "Would choose `assistant/selector`" (or why nothing is recommended);
- an explicit "Current execution: **unchanged**" line naming what the run
  actually requested and that `ExecutionRequest.model` is the only authority —
  shown only in shadow;
- per dimension: own runs `n` / weight / `k` / metric, and the external prior
  with source, value, freshness, benchmark release, `observedAt` vs
  `publishedAt`, plus any excluded prior and its reason;
- the winner's identity basis and evidence, and its advisories;
- hard-filtered alternatives with their named reasons, and a line stating that a
  benchmark score never resurrects an excluded candidate;
- a collapsible "why this is shadow" listing every activation gate and its
  detail.

## 12. Tests

`packages/core/test/model-intelligence.test.ts` (36) — classification
determinism and signal attribution; the `w` table for every `k`; the score
formula; missing prior; nothing-contributed; expired exclusion; all-expired;
within-source publishedAt/observedAt tie; pinned primary source; normalization
mismatch; external evidence cannot bypass a filter; no-evidence case; shadow vs
applied mode; `executionUnchanged`; telemetry reversing a prior-best ranking and
failing to when the gap is insufficient; a falling rolling window; user override
satisfied and unsatisfied; every activation gate failing alone; the fake-clock
seven-day boundary; the review-signed-too-early case; attestation expiry;
unparseable and future attestations.

`apps/api/test/router-model.test.ts` (25) — shadow recommendation persisted and
round-tripped through `routing_decisions`; disabled assistant; quota exhaustion;
read-only security policy; unknown capacity advisory; declared minimum window
excluding unknown capacity; override filtering and truthful failure; the four
identity bases including ambiguity; cross-provider evidence isolation;
`model_resolved` NULL and foreign-harness-major runs excluded from cohorts;
healthy context yield neutral; task-kind narrowing; rolling-window `n` falling;
end-to-end blend at `w = 0.5`; execution untouched (routing decision, request and
`RunSpec.model`); catalog failure degrading to no recommendation; the activation
gate closed on a fresh workspace and on the config flag alone; and the
`enabled: false` rollback.

`eval/scenarios/model-shadow.ts` — deterministic, offline, over the real
composition root.

## 13. Deliberately not done

- No second benchmark source.
- No dimension beyond coding/speed/cost.
- No automatic selection enabled anywhere, including the demo and the eval.
- No `RunSpec.model` writer.
- No backfill of `harness_major`.
- No AA pricing ingestion.
