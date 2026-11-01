# M6 composition telemetry: plan (APPROVED 2026-10-31; not built)

> **Status, 2026-11-01.** itay approved M6 on 2026-10-31 with the **bold default answer to every question Q1–Q11** in §6. Nothing in this plan is built yet. Corrections against main `9f66b47`, which win over the text below:
> - **Migration numbers.** `035` and `036` are taken (`035_run_model_requested_source`, `036_usage_run_link`). S1's ledger migration is **`037_asset_usage.sql`** and S4's shadow log is **`038_asset_shadow_log.sql`**. Wherever this file says 035 or 036 for M6, read 037 and 038.
> - **Waits.** "#102" and "today's slice 4" have both merged, so S1 waits on nothing.
> - **Since this was written:** the revision's model binds the launch (#120, `runs.model_requested_source`); imported usage records bind runs by session ref (#121); Harness runs store a session ref the provider reports after start (#126); `POST /api/tasks/:id/restart` exists (#119), and a session it releases ends CANCELLED, which is a neutral outcome; #128 changed the handoff refusals and the blocked-verification notice in `orchestrator.ts`. Read those from main, not from §0.
> - **Model and effort** per slice are in the §5 table. PR rules: stacked PRs merge with merge commits only, agents never merge.

Source: `docs/agentic-os-plan.md` §3.5 (reverse edge), §3.7 (`AssetUsage`), §4 M6 and M10, phase 8, risk 11, and `docs/specs/E-agentic-os-role.md` M10 in cockpit. Read against ai-control-plan `main` at `6d9058d` (M3 S5a, #104) and cockpit `main` at `41760e0` (M11, #46). Written 2026-10-21 by the M6 thread. Same shape as `m2-composer.md` and `m3-provisioning.md`. No code until itay says go.

## 0. What the code says today

- **`asset_usage` exists and nothing writes it.** Migration 033 created it append-only (UPDATE and DELETE triggers) with `event_id` PK, `asset_id`, `asset_digest`, `run_id`, `attached`, `invocation_count INTEGER NOT NULL`, `outcome`, `attribution_method`, `at`. It has no revision, no session distinct from the run, no validation column, and `invocation_count NOT NULL` cannot say "this adapter cannot see invocations". PROJECT_MEMORY M1 says "M6/M10 write it".
- **A run id is a session id.** `execution_results.session_id` references `runs(id)`. `runs.composition_revision_id` is write-once and NULL for route-only runs. A revision can own several sessions (K11 continuation reuses it), and a task can own several revisions (dispatch, failover).
- **What a session attached is already recoverable from stored rows.** `agent_specs` holds the spec (`assets.skills`, `assets.mcp_servers`, `context.memory_bundles`, `context.fragments`) and the BundleResponse, whose `manifest.included[]` maps each bundle file (`relPath`) to `{kind, ref, digest}`. `provisioning.verified` carries fidelity, the profile digest, file digests and the checks; `provisioning.ambient` says why there is no profile. The verified MCP launch shape is the revision's, pinned by digest (S4), and the profile names each server `mcpServerName(assetId)`.
- **Validation evidence exists for Claude only.** S5a makes a `full` profile's first event a `run.started` carrying `payload.profileEvidence`. A session that reaches RUNNING passed it. A session that failed it ended `policy_unenforceable` before `provider_start_acked`, and the judged event is kept. MCP status `pending` passes the judge. Codex `partial` has file verification only; the `debug prompt-input` probe is slice 3 of today's batch (S5b) and is opt-in.
- **Invocation evidence is tool events, and only some adapters emit what we need:**

| Adapter (fidelity) | Skills | MCP servers | CLAUDE.md / AGENTS.md (fragments, memory bundles) |
|---|---|---|---|
| Claude Agent SDK (`full`) | `tool.started` with `tool: "Skill"` naming `agent-plane-profile:<skill>`, or a `Read` of the profile's `plugin/skills/<skill>/SKILL.md`. **The Skill tool's input shape is not typed in SDK 0.3.238** (`sdk-tools.d.ts` has no `SkillInput`), so the key must be probed once on a live run | `tool.started` / `tool.completed` / `tool.failed` with `tool: "mcp__<server>__<tool>"`, joined by `toolUseId` | always in the prompt: not applicable |
| Codex SDK (`partial`) | none: bundle v1 gives Codex `AGENTS.md` only | `mcp_tool_call` is mapped **only at `item.completed`** (`codex.ts`), as `tool.completed`/`tool.failed` with `tool: "mcp:<server>.<tool>"`; there is no `tool.started` | in `developer_instructions`: not applicable |
| Codex app-server (`none`) | no profile | emits MCP events, but nothing was attached | no profile |
| Cursor, Bedrock, OpenRouter (`none`) | no profile | no profile | no profile |
| Fake | none today | `[FAKE:MCP:<tool>]` markers | — |

- **Outcome inputs exist.** `reliabilityClass(result)` in core (`success | error | neutral`; a cancel and a context yield are neutral, I-M4), `verification.result` events, and `provider_start_acked` to tell a session that never reached the provider.
- **Patterns to reuse.** `TelemetryService` derives routing scores at read time over a 30-day window and keeps no score table. K13 blends own telemetry with priors by `w(n) = n / (n + k)` (`packages/core/src/model-selection.ts`) and stays shadow behind a fail-closed activation gate. `bin/model-shadow-report.ts` is the inspection CLI. The usage v1 boundary is the idempotency pattern: deterministic key, body digest, 200 on replay, 409 on a different body.
- **Stage 3 ranks by matched tag count, ties by id**, and "lineage is evidence only, never a score" (`packages/core/src/composer/assets.ts`, invariant 6). Nothing in a decision may change between preview and start except `confirm` and `workspace`, or `composition_drift` fires.
- `graphify-out/graph.json` is not in either checkout, so this plan was read from source.

## 1. Vocabulary: five facts, none implies the next

For one asset in one session:

1. **selected**: the revision lists it. Always true for a row.
2. **attached**: it is in the session's verified profile. False for every `none` (ambient) session, even though the revision selected it.
3. **validated**: provider-side evidence that it loaded. `runtime_confirmed` (Claude `full`, S5a judge passed; MCP reported `connected`), `runtime_pending` (MCP reported `pending`), `rendered` (Codex probe passed, when enabled), `files_verified` (profile verified, no runtime evidence), `failed` (judge or probe failed), `none` (not attached).
4. **invoked**: the count of distinct `toolUseId`s that used it, plus how many failed. **NULL means not observable**, which is different from 0. Method `tool_event`, `not_applicable` (instructions) or `not_observable`.
5. **outcome**: the session's `reliabilityClass`, `not_run` when the provider never acked a start, and the last `verification.result` (`passed` true/false, or NULL when none ran).

The ledger records these facts and an `attribution_method` (`co-occurrence/v1`). It never records that an asset caused an outcome (risk 11).

## 2. Shapes and idempotency

### 2.1 Tables (migration 035)

`asset_usage_m1` is the old table renamed, kept with its triggers in case any row exists (none should). The new `asset_usage`:

```text
asset_usage
  event_id                 TEXT PRIMARY KEY      -- "au1_" + hex sha256(JCS(key))
  ingest_seq               INTEGER UNIQUE NOT NULL  -- feed cursor, assigned at insert
  composition_revision_id  TEXT NOT NULL REFERENCES agent_specs
  session_id               TEXT NOT NULL REFERENCES runs(id)
  task_id                  TEXT NOT NULL REFERENCES tasks(id)
  asset_kind               TEXT NOT NULL  -- skill | mcp_server | memory_bundle | fragment
  asset_id, asset_digest   TEXT NOT NULL
  harness, fidelity        TEXT NOT NULL  -- fidelity full | partial | none
  attached                 INTEGER NOT NULL CHECK (0,1)
  validation               TEXT NOT NULL
  invocation_method        TEXT NOT NULL
  invocation_count         INTEGER NULL CHECK (>= 0)   -- NULL = not observable
  invocation_failed        INTEGER NULL CHECK (>= 0)
  session_outcome          TEXT NOT NULL  -- success | error | neutral | not_run
  verification_passed      INTEGER NULL
  attribution_method       TEXT NOT NULL  -- co-occurrence/v1
  deriver_version          INTEGER NOT NULL
  body_digest              TEXT NOT NULL  -- sha256 JCS of every column but event_id, ingest_seq
  at                       TEXT NOT NULL  -- the session's execution_results.at, never the clock
  UNIQUE (composition_revision_id, session_id, asset_kind, asset_id, asset_digest)
  + UPDATE/DELETE refusal triggers, indexes on (asset_id, asset_digest) and (task_id)

asset_usage_sessions      -- projection ledger, so a zero-asset session is "done" too
  session_id PK, composition_revision_id, rows, deriver_version, body_digest, at
```

Fragments carry the fragment digest from the bundle manifest (cockpit M9: sha256 of the source file), so every row has a digest.

### 2.2 Key, replay, conflict

- **Key** = `{v: 1, revision, session, kind, id, digest}`. Same session and asset give the same `event_id` on every derivation, every restart and every machine.
- **Write** = `INSERT … ON CONFLICT(event_id) DO NOTHING`, then compare `body_digest`. Equal is a replay (no-op). Different is a **conflict**: counted, logged with event id and deriver version only, never overwritten. Never `INSERT OR REPLACE`: REPLACE deletes, and SQLite fires delete triggers on it only with `recursive_triggers`, so the append-only guarantee would rest on a pragma (the same trap M2 found on 033/034).
- **The deriver is a pure core function**: `deriveAssetUsage({ spec, bundleManifest, events, result, startAcked }) → rows`. No clock, no env, no fs, under the same lint rule as the composer. Its inputs are final once the session is terminal and settled, so a re-derivation is byte-equal.

### 2.3 When it runs

- **At settle**: one call next to `this.dispatchComposer?.settled(sessionId)` in `orchestrator.ts` (around line 1141), `assetTelemetry.project(sessionId)`. Only for sessions with a revision. It never throws into the settle path.
- **Backfill at boot**: sessions with a revision and a result but no `asset_usage_sessions` row are projected after `reconcileOnBoot`. That covers a crash between settle and projection, and every composed session that ended before M6 shipped.
- No secret can reach a row: the deriver reads asset ids, digests, tool names and counts, never tool input text beyond the Skill name and a Read path matched against the profile's own relPaths.

## 3. The M10 contract and how Cockpit consumes it

The contract lands here first: `contracts/asset-usage/v1/asset-usage-event.schema.json` (camelCase, closed objects, `schemaVersion` required), fixtures valid/invalid, `docs/contracts/asset-usage-v1.md`, and a reference validator `apps/api/src/asset-usage-contract.ts` loading that file, as usage v1 does.

**Recommended direction: Cockpit pulls** (Q2). `GET /api/composition/asset-usage?after=<ingest_seq>&limit=<≤500>` returns `{ schemaVersion, events: [...], next }` in `ingest_seq` order, behind a new `telemetry.read` capability (API 2.7). Plan §3.5 and spec E describe the plane POSTing to Cockpit. Pull is proposed because Cockpit already holds the plane's credential and calls it (M11), the plane then needs no write token for Cockpit and no second outbox, and a Cockpit that is down loses nothing. The cursor is stable because rows are append-only.

**Cockpit M10** vendors `contracts/asset-usage/v1` SHA-pinned (`contracts/asset-usage/VENDORED.json`), polls when `assetUsage.enabled`, `CONTROL_PLANE_URL` and `CONTROL_PLANE_CREDENTIAL_PATH` are set and not under `READ_ONLY`, and appends to its own `asset-usage-ledger.jsonl`, never `lineage.json`. It dedupes by `eventId`; a second body under an id it already has is kept aside as a conflict and the first one stays. Installed shows each asset's counts (selected, attached, validated, invoked or "not observable", last outcome), joined by id and digest. A digest no longer installed shows "revision no longer installed". **Cockpit computes counts only.** Shadow scores are plane state, so Cockpit shows `GET /api/composition/asset-scores` as served and never recomputes it (cockpit AGENTS.md, Control Plane contracts).

## 4. Shadow score

### 4.1 Formula (`asset-shadow/v1`, pure core)

Per asset `(id, digest)` and cohort `c = (task_kind, harness)`, over the same 30-day window as `TelemetryService`:

- Sample: sessions with `session_outcome` success or error. `neutral` and `not_run` are excluded (I-M4; a session that never ran tells us nothing about an asset).
- Baseline `p_c = (s + 1) / (n + 2)` over sessions in `c` where the asset was **not attached**.
- Invoked group `I`: attached and `invocation_count ≥ 1`. Smoothed rate `r_I = (s_I + k·p_c) / (n_I + k)`, which is `w·(s_I/n_I) + (1 − w)·p_c` with K13's `w(n) = n/(n+k)`, `k = 10`.
- **Lift** `= r_I − p_c`. With no evidence the score is exactly 0, and it moves only as invoked sessions accumulate.
- Control: the same lift for "attached, invoked 0". If idle attachment does as well as invocation, the invoked lift is noise, and the report says so.
- Where invocation is not observable, only the attached lift exists. It is labelled `attached_only` and never ranks (§4.2).
- The same formula runs a second time on `verification_passed`, among sessions that ran a verification.
- Pooled across cohorts weighted by `n_I`. Every number ships with `n`, `s`, raw rate, baseline, `w` and method. No interval is shown as a probability.

### 4.2 Where it is computed and what it may touch

- **Shadow rank** = stage 3's order with one change: within equal matched-tag counts, ties break by lift (only `tool_event`-method lifts; others count as 0) before id. That is the smallest change that could later be activated, and it can only reorder candidates that already passed every filter. So the shadow can never choose a filtered asset (the analogue of K13's `no-filter-violations`, true by construction and audited anyway).
- **It never enters the decision, the spec, `compositionDigest` or `inputs_digest`.** If it did, a score that moved between preview and start would cause `composition_drift`.
- **Shadow log** (migration 036): one row per composition attempt that reached stage 3: `attempt_id`, actual chosen ids, shadow chosen ids, `would_differ`, per-candidate scores JSON, scorer version, telemetry window end. It is written after the attempt row and outside its transaction (the "one attempt row, one routing row" invariant of S4 stays true), best-effort; a scorer error writes a row with the error and never fails a compose.

### 4.3 Inspection

- `GET /api/composition/asset-scores?taskKind=&harness=` (`telemetry.read`): the §4.1 table per asset.
- `GET /api/composition/shadow?since=`: attempts where `would_differ`, with both chosen sets and the deciding scores.
- `pnpm --filter @agent-plane/api asset-shadow-report`, modelled on `model-shadow-report.ts`: per-asset table plus would-differ count and rate over the window.
- **No activation in M6** (Q11). A later slice would mirror K13's fail-closed gate: config flag, a shadow log spanning ≥ 7 days, a signed and expiring review attestation, ≥ `k` invoked sessions for each asset whose rank changes, and a zero filter-violation audit.

## 5. Slices (stacked PRs, merge commits only, retarget to main before merging)

Gate for every plane slice: `pnpm typecheck && pnpm lint && pnpm test`. For cockpit: `npm test && npm run build`. Test secrets are `FAKE-*-not-real`. Each slice gets its own worktree. apps/web is out of scope.

| # | Slice | Base, waits on | Files | Tests | Drive and verdict | Model / effort |
|---|---|---|---|---|---|---|
| **S1** | Ledger and deriver: selected, attached, validated, outcome. Invocation is `not_observable` everywhere | main after #102 and today's slice 4 (orchestrator.ts) merge | `packages/core/src/asset-telemetry.ts`, `packages/core/src/index.ts`, `apps/api/src/db/migrations/035_asset_usage.sql`, `apps/api/src/modules/asset-telemetry.ts`, one call in `orchestrator.ts` settle path, boot wiring in `server.ts`, `packages/core/test/asset-telemetry.test.ts`, `apps/api/test/asset-telemetry.test.ts`, PROJECT_MEMORY | Deriver is byte-equal under different clocks, TZ and cwd; replay writes nothing; a different body under a key is a counted conflict and the first row stays; ambient → attached 0, validation none; Claude full + judge passed → `runtime_confirmed`; judge failed → `failed`, `not_run`; neutral cancel; zero-asset session gets a ledger row; boot backfill projects a session settled before a simulated crash and nothing twice; leak grep for FAKE values over the tables = 0 | `pnpm dev` with fake assistants as claude-code and codex plus Cockpit main on loopback (the S4 rig), one composed run each and one ambient; sqlite rows shown; restart the API and show the backfill adds 0 rows; `demo:a`, `demo:a5`, `demo:b`. **PASS** expected | Opus 5.5 / high |
| **S2** | Invocation evidence | S1 | `packages/core/src/asset-telemetry.ts` (matching rules only), `packages/adapters/src/fake.ts` (`[FAKE:SKILL:<name>]` emits a Skill tool call and a profile Read), `packages/core/test/asset-telemetry-invocation.test.ts`, `scripts/probe-claude-skill-input.ts`, PROJECT_MEMORY line | Distinct `toolUseId` counting across started/completed/failed (Codex completed-only works); MCP names matched against the **profile's own server names**, not `mcpToolName`'s first-separator split (an asset id containing `__` must still attribute correctly); unknown server → not counted; Skill call or profile Read counts the skill once per toolUseId; instructions stay `not_applicable`; app-server and cursor stay `not_observable` | Fake rig runs with skill and MCP markers, rows show the counts. The probe script runs one short Claude turn that is asked to use a profile skill and prints the Skill tool input keys: **BLOCKED** here without credentials, so itay runs it once and the matcher is pinned to what it prints. **PASS** on fake, plus the probe result | Sonnet 5.5 / high |
| **S3** | asset-usage v1 contract and the feed, API 2.7 | S1 (∥ S2: disjoint files) | `contracts/asset-usage/v1/**`, `docs/contracts/asset-usage-v1.md`, `apps/api/src/asset-usage-contract.ts`, the feed route in `server.ts`, `telemetry.read` in `packages/core/src/contracts.ts` and `CONTROL_PLANE_API_VERSION` 2.7, `apps/api/test/asset-usage-feed.test.ts`, PROJECT_MEMORY | Fixtures validate and fail as named; paging by `after` is stable across inserts; `limit` bounds; 403 without `telemetry.read`; an old credential still opens the UI; no hostname, absolute path or FAKE value in any page | Running API: curl the feed with a rotated credential, page through, re-run S1's drive and show only new events after the cursor. **PASS** expected | Sonnet 5.5 / high |
| **S4** | Shadow scorer, shadow log, inspection | S3 (needs `telemetry.read` and server.ts after it) and #102 (composer `service.ts`) | `packages/core/src/asset-shadow.ts`, `apps/api/src/db/migrations/036_asset_shadow_log.sql`, `apps/api/src/modules/asset-shadow.ts`, one call in `apps/api/src/modules/composer/service.ts` after the attempt row, scores and shadow routes in `server.ts`, `apps/api/src/bin/asset-shadow-report.ts`, tests, PROJECT_MEMORY | Formula table tests (`w(0)=0`, `w(k)=0.5`, no evidence → 0, neutral and not_run excluded, attached_only never ranks); preview twice with telemetry changed in between gives the **same** `compositionDigest` and two shadow rows; `would_differ` set only by a tie broken by lift; a throwing scorer still composes; a filtered asset never appears in a shadow choice | Fake rig: 24 scripted runs, half with an MCP marker on one asset and a forced failure on the other half; `asset-shadow-report` shows the lift and a would-differ preview; `demo:b`. **PASS** expected | Opus 5.5 / high |
| **S5** | Cockpit M10: vendor, pull, ledger, Installed counts | S3 merged (S2 for real invocation numbers) | cockpit `contracts/asset-usage/**`, new `assetUsage.ts` and test, `server.ts` (poller start and an aggregates route), the Installed view in `public/` and its `*PublicWiring.test.ts`, `docs/PROJECT_MEMORY.md` | Vendored sha256 manifest; duplicate pull adds nothing; a conflicting body is set aside; a digest not installed shows "revision no longer installed"; off under `READ_ONLY`; no plane secret written anywhere | `npm run dev` on loopback against S3's running plane with a scratch HOME; open Installed and see attached / invoked / not observable / last outcome for the drive's assets; restart and see no double count. **PASS** expected | Sonnet 5.5 / medium |

**Order and parallelism.** S1 → (S2 ∥ S3) → S4, with S5 after S3. S1 cannot start until #102 and today's slice 4 merge, because it adds one line to the settle path of `orchestrator.ts`, and S4 adds one to composer `service.ts`, which #102 owns now. Compare and race write no revision today (PROJECT_MEMORY M7), so they produce no rows until slice 4 changes that, and race losers are neutral anyway.

## 6. Open questions (my default in bold)

- **Q1** Rename M1's writer-less `asset_usage` to `asset_usage_m1` and create the new shape, rather than extend it with ALTERs? **Yes.** The M1 shape cannot say "not observable" and has no revision or session. A rename loses nothing even if a row exists.
- **Q2** Cockpit pulls a plane feed, rather than the plane POSTing to Cockpit as §3.5 and spec E say? **Pull**, and S3 edits §3.5 and spec E to match.
- **Q3** Score per `(asset id, digest)`, so a new digest starts at n = 0? **Yes.** The pooled per-id number is shown next to it but never ranks.
- **Q4** Cohort `(task_kind, harness)`, a 30-day window and `k = 10`? **Yes**, the routing telemetry window and K13's coding `k`.
- **Q5** Invocations counted per distinct `toolUseId`, with failed calls counted inside the total and also separately? **Yes.**
- **Q6** A Claude skill counts as invoked by a Skill tool call naming it **or** a Read of its profile SKILL.md? **Both.** You run S2's probe once (one short Claude turn on your credentials) to pin the Skill input key.
- **Q7** Task-level outcome is a read-time join in the plane, not a field of the v1 event? **Yes.** The event carries the session outcome and verification, which are final when it is written.
- **Q8** A new `telemetry.read` capability (API 2.7) in the observability set, rather than reusing `registry.read`? **New.** Cockpit's credential then needs a rotate with `--capabilities`.
- **Q9** Shadow log on every attempt that reached stage 3, previews included? **Yes**, best-effort and outside the attempt transaction.
- **Q10** No web UI for scores in M6, only the API and the CLI? **Yes.** apps/web belongs to the M7 thread.
- **Q11** M6 ships no activation path, not even one gated off? **Yes.** Activation is a later slice with K13-style gates.

## 7. Findings from reading the code

- `mcpToolName` (`packages/core/src/tool-floors.ts`) splits at the first separator, and `mcpServerName` keeps `_`. An asset id containing `__` would attribute a Claude MCP call to the wrong server. S2 matches against the profile's own server names instead. The tool gate has the same latent issue; not fixed here.
- The Codex SDK adapter emits MCP calls only at `item.completed`, so any count built on `tool.started` reads 0 for Codex.
- `RunStartedPayload` in `packages/core/src/events.ts` declares only `providerSessionRef` and `model`. Claude also writes `tools`, `version` and `profileEvidence` there. The type lags the payload. S1 reads evidence the way the runner already does, and the type is worth fixing in whichever slice next touches events.ts.
- Plan §3.5 and spec E say "push", and cockpit AGENTS.md says Cockpit consumes plane contracts read-only. Pull satisfies both (Q2).
- `graphify-out/graph.json`, which both AGENTS.md files say to query first, does not exist in either checkout.

**Verdict: SKIP** (plan only, no runtime surface).
