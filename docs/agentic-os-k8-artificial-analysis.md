# K8 — Artificial Analysis benchmark evidence: implementation and acceptance record

Implemented on `feat/agentic-os-k8-artificial-analysis`, based on
`docs/agentic-os-kernel-services.md` (§4.4.2, §5.3 K8, invariants I-M1 / I-M3).
K7 is unchanged and still wins where it and this record disagree. **K13 (task
classification, model scoring, blending, selection, activation) is not
implemented, and nothing here selects a model.**

K8 adds evidence to the **existing** K7 catalog. It does not create a second
catalog, a second scheduler, or a new API surface.

```
Artificial Analysis  →  GET /api/v2/data/llms/models  →  one CatalogSource
  →  normalized benchmark PRIOR evidence  →  existing model_catalog rows
  →  GET /api/models  (merged priors) + GET /api/models/:id (unmerged row)
```

## 1. Official API verified (2026-09-09)

Verified against `https://artificialanalysis.ai/api-reference` and
`https://artificialanalysis.ai/data-api`:

| Fact | Value |
|---|---|
| Base URL | `https://artificialanalysis.ai/api/v2` |
| Endpoint used | `GET /data/llms/models` |
| Auth | a single `x-api-key` request header. No OAuth, no signing, no body. |
| Free tier | 1 000 requests/day; `X-RateLimit-*` response headers |
| Terms (free) | "Internal use only; with attribution." Our use — an internal operator catalog, attributed — is within these terms. |
| Attribution | required across all tiers: credit Artificial Analysis and link `https://artificialanalysis.ai/`. Stored on every row as `provenance.attribution`. |
| Response shape | `{ status, prompt_options: { parallel_queries, prompt_length }, data: [ { id, name, slug, model_creator, evaluations, pricing, median_output_tokens_per_second, median_time_to_first_token_seconds, ... } ] }` |
| Release identity | `intelligence_index_version` (e.g. `4.3`) — a methodology version, major.minor. |
| Publication date | **none.** The response carries no per-row evaluation/publication timestamp. |

**Blocker check (§1 of the goal): not a blocker.** The terms permit attributed
internal storage and display. The canonical K8 requirement is release +
configuration identity on every selection-quality prior (§7); AA supplies a
release (`intelligence_index_version`) and, for speed, a measurement
configuration. It does **not** supply a per-row publication date — `publishedAt`
is therefore always absent and never fabricated (§6). `publishedAt` is
"where supplied" in §4.4.2, so its absence does not block ingestion; it is
recorded as a known gap here and surfaced in the UI as `published n/a`.

No `docs/agentic-os-k8-blocker.md` was created.

## 2. One source only

`apps/api/src/modules/artificial-analysis.ts` is the only external
`CatalogSource`. LiveBench, BenchLM, Arena and every other leaderboard are **not**
fetched — the architecture requires one source to prove value in the (future) K13
shadow log first (§5.3 K8).

## 3. Credential

`AA_API_KEY`, read once in `server.ts` from `process.env` and passed to
`createArtificialAnalysisSource({ apiKey })`. It is:

- never written to a config file, a fixture, a snapshot or the DB;
- never logged — `refresh()` records only a fixed classification label
  (`not configured` / `unauthorized` / `unavailable` / `malformed response`),
  never the transport error, response body or key;
- never returned by any API route.

With no key the source is still registered; its first `collect()` throws
`CatalogSourceError('not configured')`, `refresh` records that attempt as
`failed`, and the K7 local catalog and routing are untouched.

## 4. The CatalogSource seam (I-M3)

`collect({ fetch })` receives **only** a transport. It has no access to a task,
`TaskIntent`, prompt, repository, transcript, usage, cost history or routing
decision — structurally, so none can be transmitted. The one request is
`GET https://artificialanalysis.ai/api/v2/data/llms/models` with headers
`x-api-key` and `accept` and no body.

`CatalogSource.collect` may now return either `CatalogObservation[]` (unchanged,
K7 stubs still work) or `{ observations, detail }` where `detail` is a fixed
diagnostic string for the refresh log (mapped/unmatched counts — §13).

## 5. Egress boundary — test

`artificial-analysis.test.ts` › "egress boundary (I-M3)" registers the real
source with a **recording fetch**, creates a task carrying
`goal: "migrate the payments ledger on branch release/pci"`,
`constraints: ["never touch prod db"]`, then asserts the single AA request:

- URL is exactly `AA_ENDPOINT`, method `GET`, empty body;
- headers are exactly `{ x-api-key, accept }`;
- the wire (URL + headers + body) contains none of: the goal text, the
  constraint text, `release/pci`, the workspace home path, `AG-` (task ids),
  `inputTokens`, `outputTokens`, `costUsd`, `checkpoint`, `transcript`,
  `repoPath`.

## 6. Model-id mapping (§12)

AA `slug` is an external identity; catalog identity is `(provider, modelId)`.
There is **no fuzzy matching**. `AA_MODEL_MAP` is an explicit table; each row
carries an `evidence` comment. A row whose `slug` is not in the table is left
**unmatched** — counted in the refresh `detail`, never attached to a near-named
model, never used to invent a catalog entry (§13). `default` (Codex/Cursor) is
absent from the table and cannot be matched; aliases never participate.

Current table (best-effort; slugs need live confirmation once `AA_API_KEY` is
available — an incorrect slug simply yields an unmatched row, never a
misattribution):

| AA slug | provider | modelId |
|---|---|---|
| `claude-4-1-opus` | anthropic | `claude-opus-4-1` |
| `claude-4-5-sonnet` | anthropic | `claude-sonnet-4-5` |

## 7. Dimensions ingested (§8)

Only the dimensions AA can truthfully support:

| Dimension | Raw metric | Unit | Direction | Release identity |
|---|---|---|---|---|
| `coding` | `artificial_analysis_coding_index` (also tried: `coding_index`) | index 0–100 | higher-is-better | `intelligence-index-<intelligence_index_version>` — **required**; absent ⇒ the coding prior is skipped with a diagnostic |
| `speed` | `median_output_tokens_per_second` | tokens/second | higher-is-better | `aa-speed-measurement`, `configuration = prompt_length=<…>;parallel_queries=<…>` |

`cost` is **not** ingested from AA — provider price evidence (K7 seed) remains
the only price authority (§21). AA `price_1m_*` fields are deliberately not read.
Latency (`median_time_to_first_token_seconds`) is not ingested in v1.

## 8. Normalization — `aa-normalization-v1` (§10, §11)

`normalizeBenchmark({ value, direction, scaleMax })` in
`packages/core/src/model-catalog.ts`:

```
higher-is-better:  clamp01(value / scaleMax)
lower-is-better:   clamp01(1 - value / scaleMax)
```

- **Fixed absolute rescale, not a dataset-relative rank.** It needs no
  cross-model dataset, so ties, zero-range datasets and rank degeneracies have
  no special case; an out-of-range value simply clamps to `[0, 1]`.
- **Provider-neutral by construction** — `scaleMax` is a property of the metric.
- `scaleMax <= 0` or a non-finite input returns `undefined` (never divides), and
  the prior for that dimension is omitted.
- Scales: `AA_CODING_SCALE_MAX = 100` (the index is already 0–100);
  `AA_SPEED_SCALE_MAX = 200` tokens/second maps to `1.0`.
- Changing a scale or a direction for a dimension is a
  `AA_NORMALIZATION_VERSION` bump. K13 must never blend two versions
  (§4.4.3) — pinned by tests.

## 9. Raw vs normalized (§9)

Every `BenchmarkPrior` retains `raw: { metric, value, unit }`, `sourceModelId`
(the AA slug), `normalizationVersion` and `normalized`. The full unmerged
observation (all priors, untouched) is returned by `GET /api/models/:id` under
`evidence[].observation.benchmarks`.

## 10. External provenance (§6)

Each prior's `provenance`:

| Field | Value |
|---|---|
| `source` | `external:artificial-analysis` (new `ExternalEvidenceSource`; ranked **0** — always below every K7 source) |
| `tier` | `external-benchmark` |
| `observedAt` | when **we** fetched it — distinct from any benchmark date |
| `benchmark` | `{ release, configuration?, publishedAt?, category }` — `publishedAt` always absent for AA |
| `normalizationVersion` | `aa-normalization-v1` |
| `attribution` | `Artificial Analysis — https://artificialanalysis.ai/` |

## 11. Storage

AA rows land in the existing `model_catalog` table — no migration — as
`(provider, model_id, source='external:artificial-analysis', tier='external-benchmark')`,
`entry_json` carrying the observation with its `benchmarks[]`. No `model_prices`
row is ever written by this source.

`ModelCatalogService.list()` ranks external-benchmark rows last and **never**
lets them establish an entry or fill an identity/price/availability gap: a prior
is attached to `entry.benchmarkPriors` only when a K7 source already established
that `(provider, modelId)` entry; otherwise it is dropped. `benchmarkPriors`
carry a read-time `freshness` recomputed from `observedAt`.

## 12. Freshness / TTL (§15)

`external-benchmark` TTL is 30 days (`CATALOG_TTL_MS`, unchanged from K7).
`freshnessOf(observedAt, 'external-benchmark', now)` at read time:
`live` (<1 h) → `fresh` (<30 d) → `stale` (<60 d) → `expired`. Expired priors
stay in `benchmarkPriors` **and** in the evidence rows, labelled `expired`; K13,
when built, must exclude `expired` from selection. `observedAt` is never
rewritten on read, and a failed refresh writes nothing — old evidence keeps
ageing on its original `observedAt`.

## 13. Refresh failure (I-M3)

`ModelCatalogService.refresh()` never throws. An AA failure is recorded in
`model_catalog_refresh` with a fixed label; local rows stay readable; previously
fetched AA priors stay stored and keep ageing; routing (registry-driven) is
unaffected. Tested for: not-configured, 401/403, network throw, non-JSON,
no-`data` body.

## 14. Daily refresh (§17)

`scheduleDailyJobs` (the existing daily capability-sync + retention job) now also
calls `modelCatalog.refresh()`, contained in its own try/catch and always
rescheduled. No new scheduler, no new timer. Server startup and cold reads still
use **local evidence only** — `hydrateOnce` / `refreshLocalEvidence` never
contact a `CatalogSource`.

## 15. API (§18)

No new routes. `GET /api/models` entries gain an optional `benchmarkPriors[]`;
`GET /api/models/:id` continues to return every unmerged `evidence[]` row,
including the AA row. K7 clients that ignore the new field are unaffected.

## 16. UI (§19)

`apps/web` Model catalog card renders, per prior:
`"<dimension> prior <0.NN> · external:artificial-analysis · external-benchmark ·
release <…> (<config>) · raw <value> <unit> · published n/a · fetched <date> ·
<freshness> · Artificial Analysis — https://artificialanalysis.ai/"`.
No redesign. K14 Cockpit, which renders `GET /api/models` generically, needs no
change for these rows; no ai-control-plan change here depends on Cockpit.

## 17. Live smoke (§24)

**Not run.** `AA_API_KEY` is not set in this environment. Verification is by the
deterministic fixture `apps/api/test/fixtures/artificial-analysis-models.json`
(synthetic, secret-free, 4 rows: 2 mapped, 1 unmapped vendor, 1 `default`). No
live-source verification of the current AA slugs or response nesting occurred;
`AA_MODEL_MAP` and the `evaluations` key candidates should be confirmed with one
bounded live refresh when a key is available.

## 18. Acceptance criteria → tests

All in `apps/api/test/artificial-analysis.test.ts` unless noted.

| # (goal §23) | Criterion | Test |
|---|---|---|
| 1 | missing key ⇒ local catalog works | "missing AA_API_KEY > leaves the local catalog fully usable…" |
| 2 | valid response ⇒ evidence stored | "valid source response > stores a normalized coding + speed prior…" |
| 3 | 401/403 ⇒ classified, no secret leak | "source 401/403 > classifies as unauthorized and never leaks…" |
| 4 | timeout/network ⇒ local-first | "timeout / network failure > records the failure, keeps the local catalog readable…" |
| 5 | malformed ⇒ no corrupt rows | "malformed and partial responses > rejects a body with no data array" / "…rejects non-JSON…" |
| 6 | partial ⇒ only valid rows | "…stores only the valid rows from a partial payload" |
| 7 | egress recorder | "egress boundary (I-M3) > sends only the benchmark request…" |
| 8 | model mapping exact match | "model identity mapping > attaches a prior only on an exact AA-slug → (provider, modelId) match" |
| 9 | ambiguous mapping rejected | "…maps an AA slug to the reviewed (provider, modelId), never to a bare id" + no `default` match in "…never fuzzy-matches" |
| 10 | unmatched not misattributed | "…never fuzzy-matches: an unmapped AA model is counted, not attached anywhere" |
| 11 | release/config/publishedAt retained | "external provenance… > carries source, external tier, benchmark release/category, attribution and both dates" |
| 12 | raw + normalized retained | "…retains the raw metric, unit and source model id behind every normalized value" |
| 13 | normalization version retained | "…stamps the normalization version on every prior" |
| 14 | deterministic normalization | "deterministic normalization > is a fixed absolute rescale…" + "…byte-identical across two runs" |
| 15 | lower-is-better normalization | "deterministic normalization > handles lower-is-better metrics" |
| 16 | tie / zero-range behavior | "deterministic normalization > ties map to equal outputs; a zero/negative scale is rejected" |
| 17 | external TTL / freshness | "freshness and TTL > ages from live through fresh, stale and expired…" |
| 18 | expired prior stays inspectable | "…an expired prior stays inspectable in the entry and in the evidence rows" |
| 19 | failed refresh doesn't refresh observedAt | "…a later failed refresh does not restamp observedAt or refresh freshness" |
| 20 | provider availability registry-owned | "provider availability remains registry-owned > a benchmark prior never adds availability…" |
| 21 | K8 evidence doesn't alter routing | "K8 evidence cannot alter routing > routes a task to the same assistant before and after…" |
| 22 | bounded cost-cap still rejected | "no pricing authority expansion > ingests no AA price data…" + K7 `model-identity.test.ts` "bounded cost caps (standing deferral #3)" (unchanged) |
| — | missing coding value | "missing values > emits only the dimensions the row actually supports" |
| — | no release ⇒ coding prior skipped | "…coding priors are skipped, with a diagnostic, when the response carries no benchmark release" |
| — | capability gate unchanged | "API capability gate (unchanged from K7) > serves priors under models.read and refuses without it" |

## 19. What remains for K13

- `classifyTask` (coding / speed / cost) and `selectModel` in **shadow**.
- The blending rule `score_d = w(n_d)·telemetry_d + (1−w(n_d))·prior_d` — K8
  supplies `prior_d` for `coding` and `speed` only.
- Excluding `expired` priors from selection; source-tie and
  normalization-version handling per §4.4.3.
- Gated activation (`models.selection.enabled`). Until then, running the same
  task before and after K8 chooses the same assistant/model — pinned by test 21.
