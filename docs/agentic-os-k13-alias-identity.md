# K13 alias identity evidence — PROPOSED

Status: **PROPOSED** (2026-11-05). Q1–Q4 answered by itay on 2026-11-06: all four recommended answers accepted (see section 7). Nothing here is implemented. K7, K8 and K13
records win where this note and they disagree; the code wins over all three.

## Why this note exists

OCI read-only finding (2026-11-05): on the live plane all 37 K13
recommendations have `recommended` unset and `priorMissing` 148 on every
dimension. `AA_API_KEY` is unset there, but a key alone would not help: the
runnable candidates are the alias selectors `anthropic:opus` /
`anthropic:sonnet`, K8 priors attach to dated model ids, and an alias is not
proof of the same configuration (K8 §17a). This note says what evidence exists,
how an alias could earn a prior without breaking I-M5, and what that does to the
activation gate.

## 1. Evidence that exists today (read from the diff, `1152ef3`)

| Evidence | Where | What it proves | Gap |
|---|---|---|---|
| Requested selector | `runs.model_requested` (K7), `model_requested_source` (migration 035) | what the plane asked for | since M2 S6 a composed Claude run requests `opus` unless overridden, so `sonnet` only accrues runs from overrides |
| Resolved id | `runs.model_resolved`, `model_resolved_source = 'run.started'`, from Claude `system/init` `msg.model` (`packages/adapters/src/claude.ts`) | which model the provider says it served, per run | Claude only; Codex, Cursor, Bedrock, OpenRouter record NULL. `recordResolvedModel` accepts `'result'` but nothing calls it with that source |
| CLI version | `run.started` payload `version` (`claude_code_version`) | which CLI resolved the alias | stored in the event payload only, not on `runs`; alias meaning depends on it (`model-catalog.ts` price-seed comment: `opus` → Opus 5.5 since v2.1.280) |
| `result.modelUsage` | `run.ended` payload | per-model usage keys, context window | not read for identity; may list helper models as well as the main one, so it is not a single-id proof |
| `catalog-exact` | `resolveCandidateIdentity` (`apps/api/src/modules/model-selection.ts`) | the selector is itself a catalog id | never true for `opus` / `sonnet`; the price-seed `aliases` field is explicitly not used |
| `observed-resolution` | same function | **already shipped**: every run on this assistant requesting this selector in the last 30 days reported one `model_resolved` | binds on N = 1 run; two ids anywhere in the window ⇒ `unresolved` for up to 30 days after an alias moves; no freshness on the newest run |
| Execution settings | `CandidateIdentity.executionSettings` (core) | a set value withholds every prior | always empty: the composition `reasoning_effort` field is not carried to `RunSpec`, and the plane cannot see an effort set in the operator's own Claude settings |

So the mechanism the finding asks for — bind an alias only through observed
resolutions — exists. On OCI it yields nothing for three independent reasons:

1. **No runs.** The operator DB had no routing decisions since 2026-09-26, so
   no run in the 30-day window resolves anything.
2. **No AA map entry for what `opus` serves now.** Even a bound candidate
   resolves to `anthropic:claude-opus-5-5` (or `-sonnet-5-5`); `AA_MODEL_MAP`
   (`artificial-analysis.ts`) maps only `claude-opus-4-1` and
   `claude-sonnet-4-5`. The bound catalog entry therefore has no
   `benchmarkPriors`.
3. **No AA key.** Without `AA_API_KEY` no benchmark row is ingested at all.

The cost prior is a fourth, separate gap: price rows need `appliesTo` and a
declared `accountKind` (K13 §4.1); a subscription account never matches an API
tariff. Not in scope here.

## 2. How an alias earns a prior (proposed rule)

Replace the "all runs in 30 days agree" test with **last-N agreement with a
freshness window**, still evaluated per (assistant, selector):

- Take this assistant's most recent runs that requested this selector and have
  a non-NULL `model_resolved`, newest first, up to N (proposed N = 3).
- Bind (`basis: observed-resolution`) only when there are exactly N such runs,
  they all report the same dated id, and the newest is within F days (proposed
  F = 14).
- Fewer than N, a disagreement inside the last N, or a newest run older than F ⇒
  `unresolved` with the reason named. Runs older than the last N do not block a
  binding: an alias that moved last week binds to the new id after N new runs,
  instead of being blacked out for 30 days.
- The evidence string and the persisted identity name N, the newest
  `observedAt`, and the CLI version(s) seen, so an audit can see why it bound.
- The prior then comes from the bound id's catalog entry exactly as today: an
  `AA_MODEL_MAP` row on the dated id, exact AA id plus creator id, no slug, no
  fuzzy match. The alias never appears in `AA_MODEL_MAP`.
- Effort: a prior attaches only when `executionSettings` is empty **and** the
  operator has attested that their Claude configuration sets no effort or
  thinking override (question Q3). The plane does not set one today.

Not changed: `catalog-exact` stays first; an alias table is still never a
proof; an ambiguous or stale selector still carries no prior. Cohorts stay keyed
by resolved id, so telemetry was never alias-bound and is unaffected.

## 3. What never bypasses the hard filters

- Identity binding runs after `route()`'s per-assistant verdict and K13's model
  filters; it adds evidence, never removes a `filterFailures` entry.
- An ineligible candidate keeps `total: undefined` whatever its prior (I-M2).
- An operator model or assistant override stays a filter, not a preference, and
  outranks K13 in `pickModel` (D2).
- A bound prior never grants availability: `availableVia` stays
  provider-discovery only (K8 test 9).
- Codex and every adapter without a resolved id stay `unresolved`; no prior is
  ever inferred from CLI config or defaults.

## 4. Effect on the activation gate

No gate is added, removed or loosened. Priors are **not** an activation gate;
`evaluateActivationGate` needs config, telemetry, shadow-week, shadow-reviewed,
no-filter-violations and egress-verified.

Identity binding matters to the gate in one place: `telemetry` counts eligible
candidates whose `resolvedModelKey` has a cohort at or above k (coding 10, speed
5, cost 5 on any one dimension), and a candidate only has a `resolvedModelKey`
through binding. Because only Claude resolves, the two required candidates must
be `personal-claude/opus` **and** `personal-claude/sonnet`, each bound and each
with at least 5 qualifying runs. With the shipped rule an alias move unbinds the
candidate for up to 30 days; the proposed rule rebinds after N runs, but the new
id's cohort still starts from zero, which is the honest outcome.

Priors change what a shadow recommendation says before telemetry reaches k
(`recommended` stops being unset); they do not move activation closer.
Activation stays M12 part 2, Phase 8, and stays off until every gate holds.

## 5. Slices

| # | Slice | Where / model | Owns | Tests | Drive |
|---|---|---|---|---|---|
| A0 | Identity probe, read-only | OCI, after the operator upgrade and O7 dogfood; Sonnet 5.5 / medium | `/mnt/project-files/k13-alias/` drive output, 1 PROJECT_MEMORY line | — | per (assistant, `model_requested`, `model_resolved`, CLI version) counts for 30 days, read-only (`new Database(path, { readonly: true })`, never `openDb`); whether `system/init` model ids carry a date or a `[1m]`-style suffix; whether init or result reports effort. Verdict PASS if counts are shown |
| A1 | Last-N binding | cloud, plane; Opus 5.5 / high | `resolveCandidateIdentity` in `apps/api/src/modules/model-selection.ts`, `CandidateIdentity` fields in `packages/core/src/model-selection.ts`, new `apps/api/test/model-identity-binding.test.ts` | N−1 agreeing runs ⇒ unresolved; N agreeing ⇒ bound; disagreement inside last N ⇒ unresolved naming both ids; older disagreeing runs outside the last N do not block; newest older than F ⇒ unresolved; bound candidate with a hard-filter failure still has no total; `opus` never binds through the price-seed alias | fake adapter reporting two dated ids over an injected clock; show a shadow recommendation flip from `unresolved` to `observed-resolution` in the persisted explanation |
| A2 | CLI version on runs | cloud, plane; Sonnet 5.5 / high; after A1 | migration 041 (`runs.harness_cli_version`; 040 is taken by O6 S3 `040_memory_shadow`; forward only, not backfilled), the `run.started` writer in `session-runner.ts` / `session-store.ts`, its test | written once from `run.started` `version`; NULL when absent; old rows stay NULL | fake run, read the column back |
| A3 | AA map for served ids | OCI with the key set; Opus 5.5 / high | `AA_MODEL_MAP` in `artificial-analysis.ts`, its test, K8 §17 live-refresh record | the new ids map by exact id + creator; an effort variant id stays unmatched | ONE bounded live refresh; record pages, row count, mapped / unmatched, never the key or payload |
| A4 | Base-config attestation | cloud, plane; Sonnet 5.5 / high; only if Q3 = yes | `models.selection.baseConfigAttestedAt` in config schema, `gatherEvidence`, its test | unset, future or older than 30 days ⇒ no prior; set and fresh ⇒ prior attaches; never touches any gate | config toggle on a fake workspace, read the explanation |

A1 and A2 touch disjoint files and can run in parallel; A2 does not need to
merge first. A3 needs A0's list of ids actually served. `model-shadow-report.ts`
is owned by D1 today; showing the identity basis there is a follow-up after D1
merges.

## 6. Operator note: `AA_API_KEY` on the OCI operator unit (not a slice)

The key is read once from `process.env` in `server.ts` and must never reach a
config file, the DB, a log or a repo. On the OCI host:

1. Put `AA_API_KEY=<value>` in a file outside every checkout, e.g.
   `~/.agent-plane/personal/aa.env`, mode `600`.
2. Add `EnvironmentFile=-%h/.agent-plane/personal/aa.env` to the `[Service]`
   section of `agent-plane-operator.service` (a drop-in via
   `systemctl --user edit` keeps the unit file untouched).
3. `systemctl --user daemon-reload && systemctl --user restart
   agent-plane-operator.service`.
4. Trigger one catalog refresh and confirm the AA attempt is no longer
   `not configured` (status label only; never print the key or response).
5. `egress-verified` is a separate operator attestation; setting the key does
   not set it.

## 7. Questions for itay

Answered 2026-11-06: itay accepted all four recommended answers below. A4 is in scope because Q3 = yes.

| # | Question | Answer (accepted) |
|---|---|---|
| Q1 | Values for N and F? | N = 3 agreeing runs, F = 14 days. Small enough for a personal plane, large enough that one odd run cannot bind |
| Q2 | Replace the shipped "all runs in 30 days agree" rule with last-N agreement? | Yes. Old disagreeing runs then stop blocking a rebinding after an alias moves; a disagreement inside the last N still refuses |
| Q3 | May a prior attach when the plane set no effort but cannot see the operator's own Claude settings? | Only with a 30-day operator attestation (`baseConfigAttestedAt`, slice A4) that those settings set no effort or thinking override. Without it, no prior |
| Q4 | Should a prior ever be required for activation? | No. Keep the gate as is: telemetry from resolved runs is the evidence that activates; priors only shape cold-start shadow output |
