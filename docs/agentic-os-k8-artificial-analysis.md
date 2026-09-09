# K8 — Artificial Analysis benchmark evidence: implementation and acceptance record

Implemented on `feat/agentic-os-k8-artificial-analysis`, based on
`docs/agentic-os-kernel-services.md` (§4.4.2, §5.3 K8, invariants I-M1 / I-M3).
K7 is unchanged and still wins where it and this record disagree. **K13 (task
classification, model scoring, blending, selection, activation) is not
implemented, and nothing here selects a model.**

K8 adds evidence to the **existing** K7 catalog. It does not create a second
catalog, a second scheduler, or a new API surface.

```
Artificial Analysis  →  GET /api/v2/language/models/free  (paginated)  →  one CatalogSource
  →  normalized benchmark PRIOR evidence  →  existing model_catalog rows
  →  GET /api/models  (merged priors) + GET /api/models/:id (unmerged row)
```

## 1. Current official API re-verified (2026-09-09)

Re-checked against `https://artificialanalysis.ai/data-api/docs` (the current
Data API reference). The first PR used the older `/data/llms/models` path and
depended on `intelligence_index_version` appearing per row; that field is a
**root** field of the versioned endpoint, which is what the docs now document
and what promises the shape below. This PR moves to it.

| Fact | Value |
|---|---|
| Base URL | `https://artificialanalysis.ai/api/v2` |
| Endpoint used | `GET /language/models/free` — the versioned, free-tier language-model list |
| Auth | a single `x-api-key` request header. No OAuth, no signing, no body. |
| Query params | `page` (1-indexed). No `prompt_type` on the free endpoint. |
| Rate limit | the free tier is rate-limited; the effective limit is returned in `X-RateLimit-*` response headers and its **published value has changed between AA announcements**, so no fixed number is asserted in code. This client issues at most `AA_MAX_PAGES` (20) GET requests per daily refresh and treats a `429` as a classified, non-fatal `rate limited` outcome (`Retry-After` ignored; the next daily refresh retries). |
| Attribution | required across all tiers: credit Artificial Analysis and link `https://artificialanalysis.ai/`. Stored on every row as `provenance.attribution`. |
| Response root | `{ tier, intelligence_index_version, pagination: { page, page_size, total_pages, has_more }, data: [ … ] }` |
| Per row | stable `id`, `name`, `slug`, `release_date` (ISO date or `null`), `model_creator { id, name }`, `evaluations { artificial_analysis_coding_index, … }`, `performance { median_output_tokens_per_second, median_time_to_first_token_seconds, … }`, `pricing { … }` |
| Release identity | root `intelligence_index_version` — a **number**, major.minor (e.g. `4.1`); the methodology release every `evaluations.*` index belongs to. |
| Benchmark publication date | **none.** No per-row evaluation/publication timestamp. `benchmark.publishedAt` stays absent, never faked (§6). |
| Model release date | `release_date` — the MODEL's own ship date. Distinct fact from a benchmark publication date; carried on `benchmark.modelReleaseDate`, never mapped onto `publishedAt`. |

Pagination: `collect()` fetches `?page=1`, follows `pagination.has_more` up to
`AA_MAX_PAGES`, concatenates every page's `data`, and takes
`intelligence_index_version` from page 1. It runs **only** inside
`modelCatalog.refresh()` (daily job / explicit refresh route) — never at startup
or on a cold read (§14). One `observedAt` is stamped for the whole logical
refresh regardless of page count.

**Blocker check (§1 of the goal): not a blocker.** The terms permit attributed
internal storage and display. The canonical K8 requirement is release +
configuration identity on every selection-quality prior (§7); AA supplies a
release (`intelligence_index_version`) and, for speed, a fixed measurement
configuration. `publishedAt` is "where supplied" in §4.4.2, so its absence does
not block ingestion; it is recorded as a known gap and surfaced as `n/a`.

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
decision — structurally, so none can be transmitted. Each request is
`GET https://artificialanalysis.ai/api/v2/language/models/free?page=<n>` with
headers `x-api-key` and `accept` and no body.

`CatalogSource.collect` may now return either `CatalogObservation[]` (unchanged,
K7 stubs still work) or `{ observations, detail }` where `detail` is a fixed
diagnostic string for the refresh log (mapped/unmatched counts — §13).

## 5. Egress boundary — test

`artificial-analysis.test.ts` › "egress boundary (I-M3)" registers the real
source with a **recording fetch**, creates a task carrying
`goal: "migrate the payments ledger on branch release/pci"`,
`constraints: ["never touch prod db"]`, then asserts the single AA request:

- URL is exactly `${AA_ENDPOINT}?page=1`, method `GET`, empty body;
- headers are exactly `{ x-api-key, accept }`;
- the wire (URL + headers + body) contains none of: the goal text, the
  constraint text, `release/pci`, the workspace home path, `AG-` (task ids),
  `inputTokens`, `outputTokens`, `costUsd`, `checkpoint`, `transcript`,
  `repoPath`.

## 6. Model identity mapping (§12, P1-B)

AA's **stable `id`** plus its **`model_creator.id`** is the join authority — AA
itself recommends the stable id because slugs drift. A `slug` is kept only for
display (`aaSlugHint` in the table, `benchmark.sourceSlug` on the stored prior)
and is **never read to join**. There is **no fuzzy matching**:

- a row whose `id` is not in `AA_MODEL_MAP` → **unmatched** (counted in `detail`);
- a row whose `id` matches but whose `model_creator.id` does not → **creator-mismatch**,
  never mapped (an id collision alone can never map);
- a row with no `id` → **no-id**, cannot be joined (never falls back to the slug).

**Reasoning / effort variants.** AA benchmarks those as **separate model `id`s**
(e.g. a distinct id for a "…max" configuration). The exact-id join therefore
cannot pull a variant's score onto the base model — the variant id is simply
absent from the table and its row is unmatched. K7 exposes no execution-config
/ effort dimension (`ExecutionIdentity` has requested selector, resolved id,
serving provider, harness — no effort), and provider discovery lists only
`{ id, displayName }`, so the Control Plane **cannot** prove a runtime candidate
runs the same configuration AA benchmarked. A wrong attribution is worse than a
missing prior, so anything not an exact base-id match stays unmatched.

Current table. **No `AA_API_KEY` in this environment**, so the `aaId` values are
AA's documented identifiers for these two models and must be confirmed against
one bounded live refresh. A wrong `aaId` yields an unmatched row — never a
misattribution (id-exact join + creator gate make a false positive impossible).

| `aaId` (stable) | `aaCreatorId` | `aaSlugHint` (display only) | → catalog `(provider, modelId)` |
|---|---|---|---|
| `claude-4-1-opus` | `anthropic` | `claude-4-1-opus` | `anthropic` / `claude-opus-4-1` |
| `claude-4-5-sonnet` | `anthropic` | `claude-4-5-sonnet` | `anthropic` / `claude-sonnet-4-5` |

Both catalog targets are the K7 **price-seed** identities. Neither is currently
advertised by provider discovery (which lists the CLI alias selectors `opus` /
`sonnet`), so both have `availableVia = []` — see §K13 readiness.

## 7. Dimensions ingested (§8)

Only the dimensions AA can truthfully support:

| Dimension | Raw metric (documented location) | Unit | Direction | Release identity |
|---|---|---|---|---|
| `coding` | `evaluations.artificial_analysis_coding_index` (flat `coding_index` / flat key tried as resilience fallback) | index 0–100 | higher-is-better | `intelligence-index-<root intelligence_index_version>` — **required**; absent ⇒ the coding prior is skipped with a diagnostic |
| `speed` | `performance.median_output_tokens_per_second` (flat key tried as fallback) | tokens/second | higher-is-better | `aa-speed-measurement`, `configuration = prompt_length=medium (AA free-tier default)` — the `/free` endpoint takes no `prompt_type`, so the configuration is fixed and recorded verbatim |

`benchmark.modelReleaseDate` carries the row's `release_date` when present, on
both priors — diagnostic context only, never conflated with `publishedAt`.

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
(the AA **stable id**), `normalizationVersion` and `normalized`. The full unmerged
observation (all priors, untouched) is returned by `GET /api/models/:id` under
`evidence[].observation.benchmarks`.

## 10. External provenance (§6)

Each prior's `provenance`:

| Field | Value |
|---|---|
| `source` | `external:artificial-analysis` (new `ExternalEvidenceSource`; ranked **0** — always below every K7 source) |
| `tier` | `external-benchmark` |
| `observedAt` | when **we** fetched it — distinct from any benchmark date |
| `benchmark` | `{ release, configuration?, publishedAt?, modelReleaseDate?, sourceSlug?, category }` — `publishedAt` always absent for AA; `modelReleaseDate` = AA `release_date` when present; `sourceSlug` = AA slug, display only |
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
unaffected. Tested for: not-configured, 401/403, `429` (`rate limited`), network
throw, non-JSON, no-`data` body. A page cap (`AA_MAX_PAGES = 20`) bounds a
response whose `pagination.has_more` never clears.

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
release <…> (<config>) · aa-slug <…> · raw <value> <unit> ·
benchmark published n/a · model released <date|n/a> · fetched <date> ·
<freshness> · Artificial Analysis — https://artificialanalysis.ai/"`.
No redesign. K14 Cockpit, which renders `GET /api/models` generically, needs no
change for these rows; no ai-control-plan change here depends on Cockpit.

## 17. Live smoke (§24)

**Not run — `AA_API_KEY` is not set in this environment.** Verification is by the
deterministic fixture `apps/api/test/fixtures/artificial-analysis-models.json`,
now shaped to the documented `/language/models/free` response (root
`intelligence_index_version`, `pagination`, per-row `id` / `model_creator` /
`release_date` / `evaluations` / `performance`; 4 rows: 2 mapped, 1 other-creator,
1 effort variant). A regression fixture is **derived from the documented field
structure**, not copied from a large live payload.

When a key becomes available, run ONE bounded live refresh and record here:
endpoint, pages fetched, `intelligence_index_version`, row count, mapped/unmatched
count. Never record the key or the full source payload. The two `aaId` values in
`AA_MODEL_MAP` must be confirmed against that refresh; a wrong `aaId` produces an
unmatched row, never a misattribution.

## 17a. K13 readiness check (goal §"K13 READINESS CHECK")

Table derived from the **current local catalog** (K7 price-seed + the
Claude-adapter discovery manifest advertising CLI aliases `opus` / `sonnet`):

| AA evidence | mapped catalog `modelKey` | `availableVia` | safely usable by K13? | reason |
|---|---|---|---|---|
| `claude-4-1-opus` coding + speed priors | `anthropic:claude-opus-4-1` | `[]` | **no** | the runnable Anthropic identities in discovery are the alias selectors `anthropic:opus` / `anthropic:sonnet`; the dated price-seed identity is not advertised, so nothing runs it |
| `claude-4-5-sonnet` coding + speed priors | `anthropic:claude-sonnet-4-5` | `[]` | **no** | same — no discovery join to a runnable assistant |
| any AA effort/reasoning variant (e.g. `…-max`) | — (unmatched) | — | **no** | left unmatched by design; K7 cannot prove a runtime candidate uses that configuration |
| `anthropic:opus` / `anthropic:sonnet` (runnable) | — (no AA prior) | non-empty | **no** | no AA prior: mapping a specific benchmarked model onto a generic runtime alias selector is forbidden without proven configuration equivalence, which K7 does not provide |

**Result: K8 currently supplies NO usable prior for active model selection.**
This is an honesty result, not a defect. K8 stores truthful, attributed,
versioned evidence on concrete `(provider, modelId)` identities; it is ready the
moment the missing joins exist.

**`priorMissing` expectations for K13.** Until the gaps below close, K13 must
treat `coding` and `speed` priors as **absent** for every runnable candidate and
fall back to telemetry-only scoring (`w(n_d)` at `n_d = 0`), not error.

**What identity / config evidence is missing:**

1. **Availability join.** Provider discovery advertises the CLI alias selectors
   (`opus`, `sonnet`), not the dated model ids (`claude-opus-4-1`,
   `claude-sonnet-4-5`) the price seed and AA use. Nothing maps one to the other.
   Closing it needs either the Claude adapter to advertise resolved dated ids, or
   a reviewed alias→id equivalence in the catalog — **not** an AA-driven change.
2. **Execution configuration / effort.** `ExecutionIdentity` records requested
   selector, resolved id, serving provider and harness — no reasoning/effort
   setting. AA benchmarks effort variants under distinct ids; without a Control
   Plane effort dimension, an AA "…max" prior can never be proven equal to a
   runtime candidate, so it stays unmatched.

Provider discovery was **not** altered to make benchmark evidence look usable.
External evidence never grants `availableVia`.

## 18. Acceptance criteria → tests

All in `apps/api/test/artificial-analysis.test.ts` unless noted.

### P1 goal §TESTS 1–14

| # | Criterion | Test |
|---|---|---|
| 1 | fixture matches the current documented endpoint structure | fixture file (root `intelligence_index_version` + `pagination` + per-row `id`/`model_creator`/`release_date`/`evaluations`/`performance`); "valid source response > …" / "…byte-identical across two runs" |
| 2 | benchmark version comes from a documented field | "external provenance … > carries source, external tier, benchmark release/category, attribution and dates (test #2)" — `release` = `intelligence-index-4.1` from the root field |
| 3 | pagination is handled | "pagination > follows pagination.has_more across pages and stamps ONE observedAt" + "> does not loop forever … stops at AA_MAX_PAGES" |
| 4 | speed parsed from the documented `performance.*` location | "external provenance … > parses speed from the documented performance.* location (test #4)" |
| 5 | stable AA id is the mapping authority | "model identity mapping > the stable id is the authority: a changed slug on a mapped id still maps (test #5)" |
| 6 | a slug change alone cannot misattribute | "model identity mapping > a slug collision alone never misattributes: unknown id, mapped slug -> unmatched (test #6)" |
| 7 | a creator mismatch cannot map | "model identity mapping > a creator mismatch on a mapped id never maps (test #7)" |
| 8 | reasoning/effort mismatch remains unmatched | "model identity mapping > a reasoning/effort variant id is left unmatched; the base id keeps its own score (test #8)" |
| 9 | external evidence never grants availability | "provider availability remains registry-owned > …" + "K13 readiness > a prior rides an entry whether or not discovery makes it runnable" |
| 10 | candidate readiness derived from real availability | "K13 readiness — candidate availability is derived, not granted > a prior rides an entry whether or not discovery makes it runnable" |
| 11 | no fuzzy matching | "model identity mapping > never fuzzy-matches …" (+ tests #5–#8) |
| 12 | routing byte/semantically unchanged by K8 | "K8 evidence cannot alter routing > routes a task to the same assistant before and after …" |
| 13 | no AA price becomes bounded-cost authority | "no pricing authority expansion > ingests no AA price data …" + K7 `model-identity.test.ts` "bounded cost caps (standing deferral #3)" (unchanged) |
| 14 | egress contains no user/task/repository/usage content | "egress boundary (I-M3) > sends only the benchmark request …" |

### Retained coverage (first PR)

| Criterion | Test |
|---|---|
| missing key ⇒ local catalog works | "missing AA_API_KEY > leaves the local catalog fully usable…" |
| 401/403 ⇒ classified, no secret leak | "source 401/403 > classifies as unauthorized and never leaks…" |
| timeout/network ⇒ local-first | "timeout / network failure > records the failure, keeps the local catalog readable…" |
| malformed / partial ⇒ no corrupt rows | "malformed and partial responses > …" |
| raw + normalized + normalization version retained | "…retains the raw metric, unit and source model id…" / "…stamps the normalization version…" |
| deterministic / lower-is-better / tie / zero-range normalization | "deterministic normalization > …" |
| external TTL / freshness / expired stays inspectable / failed refresh keeps observedAt | "freshness and TTL > …" |
| missing coding value ⇒ speed-only; no release ⇒ coding skipped | "missing values > …" / "…coding priors are skipped…" |
| capability gate unchanged | "API capability gate (unchanged from K7) > …" |

## 19. What remains for K13

- `classifyTask` (coding / speed / cost) and `selectModel` in **shadow**.
- The blending rule `score_d = w(n_d)·telemetry_d + (1−w(n_d))·prior_d` — K8
  supplies `prior_d` for `coding` and `speed` only.
- Excluding `expired` priors from selection; source-tie and
  normalization-version handling per §4.4.3.
- Gated activation (`models.selection.enabled`). Until then, running the same
  task before and after K8 chooses the same assistant/model — pinned by test 21.
