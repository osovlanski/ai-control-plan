# Phase 8 close readiness (learning loop and memory)

Status: **PROPOSED** readiness record, 2026-11-07. Phase 8 is **not** closed. This file says which
success conditions already have evidence, which are shown only on fakes, which are not shown,
and the shortest path to closing the phase. It is not a close record. A close record belongs in
`docs/PROJECT_MEMORY.md`, in the same shape as "2026-11-05 — Phase 7b close record", once the
steps in §4 are done.

Checked against plan §6 (Phase 8 row), the PROJECT_MEMORY sections for M6 S1–S4, O6 S0–S6 and
K13 A1/A2/A4/K8 grounding, Cockpit's PROJECT_MEMORY (M10 #48, O6 S2 #49, O6 S6 #50), and the
tests on main `eca9746`. Where a doc and the diff disagree, the diff wins.

## 1. The condition, split

Plan §6 row 8 (content: M6, M10, O6, M12 part 2):

> Telemetry is idempotent; shadow scoring is inspectable; a stale memory bundle is visibly demoted
> without automatically changing production selection; per-model telemetry with resolved identity
> weighs more than priors as `n` grows, and activation waits for the shadow gate.

Plan §6 also says a phase closes only when **both repos'** slices are demonstrable and the condition
is "shown live". The 7b record set a precedent: an owner decision can close a phase with named
exclusions when a condition is shown on a fake provider only.

Status vocabulary below: **Shown** (live, on the operator plane or a real provider),
**Shown on fake only** (tests and fake-assistant drives against a real plane and real Cockpit on
loopback), **Not shown**.

## 2. Live facts this record may cite

Operator plane on OCI, recorded 2026-11-06 and 2026-11-07 (from the planning thread's OCI reports,
not re-observed here):

- O7b dogfood: tasks `AG-mw5ac0dd1` (Claude) and `AG-mw5ac0ds2` (auto, routed to Claude) each
  composed 1 skill, 1 fragment and 1 memory bundle. They wrote `asset_usage` 3 + 3 rows,
  `memory_shadow_log` 2 + 2 rows, and 3 memory proposals (1 + 2), which reached Cockpit's inbox
  and await the owner's review.
- K13: shadow decisions carry **no recommendation**. The AA catalog refresh stored 726 rows and
  mapped **0** (`AA_MODEL_MAP` grounding is in progress, see PROJECT_MEMORY "K8 AA map grounding
  diagnostic"). `sonnet` has **0** requested runs; `opus` → `claude-opus-5` has 4 (A0, CLI 2.1.238).
- O3 (2026-11-05, read-only, on the pre-refresh plane): activation gates `config`, `telemetry`,
  `shadow-reviewed` and `egress-verified` failed; every shadow recommendation was unset with
  `priorMissing` on every dimension.

Not recorded live: whether either dogfood bundle's `memory_shadow_log` action was `keep` or
`demote` (the operator-memory bundle was created on 2026-11-06, so `keep` is expected), any
`asset_shadow_log` row count, and any restart/replay of the live ledgers.

## 3. Conditions

| Condition | Evidence | Status |
|---|---|---|
| **Telemetry is idempotent** | Plane: migration 037 `asset_usage` refuses UPDATE/DELETE; writes are `INSERT … ON CONFLICT DO NOTHING` plus a body-digest compare (M6 S1, #132). Tests: `apps/api/test/asset-telemetry.test.ts` covers every call site and a `/restart`-released session seen again by boot recovery keeping one row. Feed: `asset-usage-feed.test.ts`; the S3 drive (2026-11-01) showed paging with no skip or repeat and a byte-equal feed across an API restart. Re-drive after S2 (2026-11-05): byte-equal across restart, backfill added 0. Memory proposals (039) and memory shadow (040) are also append-only with replay-insert-nothing, each driven across a restart (S5, S3). Cockpit: M10 #48 ledger keeps cursor and events in one atomic file; same `eventId` + same body adds nothing, a different body goes to `conflicts`. Live: the dogfood wrote 3 + 3 `asset_usage` rows and Cockpit pulled them, but **no live restart or re-poll was checked**. | Shown on fake only (live rows written; live replay not shown) |
| **Shadow scoring is inspectable** | Asset shadow (M6 S4, #151): `GET /api/composition/asset-scores`, `GET /api/composition/shadow`, `pnpm asset:shadow-report` (read-only, unmigrated); 24-run fake drive showed lift +0.506 / w 0.545 and a would-differ re-preview. Memory shadow (O6 S3, #153): `GET /api/composition/memory-shadow`; web chip (O6 S4, #154) renders `demote`/`drifted`/`unknown` with the rule as tooltip, e2e against a fake Cockpit. Model shadow (K13): every routing decision persists `explanation.modelRecommendation` with per-dimension n, weight, k and prior; `pnpm model:shadow-report` prints them and the activation gates (read-only since #147). Live: `memory_shadow_log` 2 + 2 rows exist; K13 decisions carry no recommendation, so there is nothing scored to inspect. | Shown on fake only (memory rows exist live; no live asset lift or model recommendation) |
| **A stale memory bundle is visibly demoted without automatically changing production selection** | Rule `memory-shadow/v1` (`packages/core/src/memory-shadow.ts`, `packages/core/test/memory-shadow.test.ts`): `demote` when `2·staleMembers ≥ members`. One call site after the attempt transaction; never touches the decision, spec, `compositionDigest` or `inputs_digest`. O6 S3 drive (2026-11-06): real Cockpit main `a9dd2b9` on loopback, fake-claude, `stale-gotchas` (4 of 7 aged 200 days) logged `demote` while production read back `included`; ageing a member between previews kept the same digest and decision. O6 S4 (#154) shows the "would demote" chip in the web. Live: the dogfood bundle was fresh, so no live `demote` exists. | Shown on fake only |
| **Per-model telemetry with resolved identity weighs more than priors as `n` grows** | Formula `w(n) = n/(n+k)` (k = 10 coding, 5 speed/cost): `packages/core/test/model-intelligence.test.ts` "w(0) = 0, w(k) = 0.5, w(4k) = 0.8", "a sufficient telemetry gap at n > k reverses a prior-best ranking", and "a falling rolling window takes the telemetry weight back down". Identity: K13 A1 (#156) binds an alias after 3 agreeing fresh runs; A2 (#155) stores the CLI version; A4 (#157) withholds benchmark priors unless `models.selection.baseConfigAttestedAt` is set. Live: `opus` binds (4 runs of `claude-opus-5`), but there are **no priors** (0 of 726 AA rows mapped, attestation not recorded as set), n = 4 is under k, and `sonnet` has 0 runs, so no live decision blends telemetry against a prior. | Not shown live (tests only; no fake drive of a live-plane decision with n > k either) |
| **Activation waits for the shadow gate** | `evaluateActivationGate` (K13 §9) requires `config`, `telemetry`, `shadow-week`, `shadow-reviewed`, `no-filter-violations`, `egress-verified`; `models.selection.enabled` defaults false with no env override. Tests: `model-intelligence.test.ts` "is SHADOW while the gate is closed, and commits nothing", "activates only when every gate passes", each gate failing alone, the 7-day boundary at ±1 ms, and a violation planted behind 1,200 clean decisions. Live: O3 read four gates failing and nothing applied; the 2026-11-07 decisions are still SHADOW. The gate has never opened anywhere but a fake clock. | Shown on fake only for the open transition; the closed gate holds live |

Cockpit's side of the phase (M10 #48, O6 S2 #49, O6 S6 #50) is merged with PASS drives, and the
live dogfood moved real proposals into Cockpit's inbox. Accepting one is not part of the condition.

## 4. Shortest path to close

Ordered. Steps 1–2 cost no quota; 3–5 need the operator plane on OCI.

1. **Ground the AA map** (the slice waiting on O12 phase 2's ids): copy `AA_MODEL_MAP` entries from
   the grounding list, merge, refresh the operator plane, and press Refresh. Pass: `mapped > 0` for
   the `claude-opus-5` / `claude-sonnet-5` rows. Without it no prior exists, so condition 4 has
   nothing to outweigh.
2. **Attest the base config** on OCI: set `models.selection.baseConfigAttestedAt` (A4), and merge
   P2 (identity basis in `model:shadow-report`) so the report shows each candidate's binding.
3. **Grow two cohorts past k.** Run at least 10 composed coding tasks with an explicit `sonnet`
   override and enough `opus` runs to reach 10 on the same task kind (A1 binds sonnet after 3).
   Then read `model:shadow-report` read-only (`--db`): show one decision whose coding dimension has
   `w > 0.5` for both candidates, with a non-null prior. That shows condition 4 live, and passes the
   `telemetry` gate.
4. **Re-drive idempotence and demotion live in one OCI session.** (a) Restart the operator plane
   and Cockpit, re-poll, and show `asset_usage`, `memory_shadow_log`, `memory_proposals` and
   Cockpit's two ledgers unchanged. (b) Declare a second memory bundle with at least half its members'
   `metadata.modified` older than 180 days, pin it, preview and start one composed task, and show
   `demote` in `memory-shadow` while production reads back `included`, plus the web chip. This
   closes conditions 1–3 live.
5. **Read the gate live and decide how to close.** With `model:shadow-report`, show the gates and
   that the decision stayed SHADOW. Opening the gate needs a week of shadow log, a fresh
   `shadowReviewedAt`, `egressVerifiedAt` and `enabled: true`; that is a week's wait, not work. The
   owner chooses whether Phase 8 closes on "the gate holds and is shown live" (the condition's words)
   or waits for one applied decision after the week.
6. **Write the close record** in PROJECT_MEMORY in the 7b format, update the plan §6 row 8, and
   name any exclusion the owner accepted in step 5.

If the owner accepts fake-only evidence for conditions 1 and 3 (as 7b did for K11), step 4 can be
skipped and the phase closes after steps 1–3, 5 and 6.
