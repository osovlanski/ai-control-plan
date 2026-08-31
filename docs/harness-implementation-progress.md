# Execution Harness — implementation progress & handoff

**Worktree:** `~/workspace/personal/ai-control-plan-harness`
**Branch:** `feat/execution-harness` (off `docs/agentic-os-contract-lifecycle`)
**Design source of truth:** `docs/execution-harness.md` (rev 7), `docs/harness-implementation-plan.md`.
Do **not** redesign the Harness; implement the approved design.

Run after every change: `pnpm typecheck && pnpm test && pnpm lint`
(from the worktree root). Baseline at last checkpoint: **core 37, api 201,
adapters 8, web 2 — all green; lint clean.**

---

## Commits so far (each a reviewable phase, additive, existing suite green)

| Commit | Phase | Summary |
|---|---|---|
| `4693550` | 0 | Contracts (`packages/core/src/execution.ts`), session state machine (`session-state.ts`), `requestFingerprint` (`fingerprint.ts`), additive event types, `apps/api/test/characterization.test.ts`. |
| `fe77a4e` | 1 | Migration `005_harness.sql` (additive), `SessionStore` (fingerprint dedupe, one-session-per-request, CAS-under-live-lease, atomic terminalize+result, start-ack, leases). |
| `ac7d838` | 2 | `EventRecorder` (one-txn commit + two-view redaction), `WorkspaceAuthority` (path/process boundary, O_NOFOLLOW writes, reduced-env commands), session-scoped checkpoints. |
| `1dd7b79` | 3 | `guards.ts` (pure), `approval-service.ts` (durable protocol), `session-runner.ts` (single-writer pipeline, heartbeat tick loop, atomic pause, co-committed guard directives, reroute yield). |
| `ac3f685` | 4 | `handoff.ts` — envelope derivation from immutable checkpoint snapshot, `ready→claimed→consumed/released/start_ambiguous` claim protocol, one-live-successor via `uq_live_successor`. |
| `08cf29f` | 5 (WIP) | `secret-broker.ts` + runner wiring + per-session `verifyIsolation`. **Compiles, green, but NO dedicated tests yet.** |

**Cross-model review:** Codex (`codex exec --sandbox read-only ...`) reviewed
the diff of each of Phases 0–4. Rounds 0–3 findings were resolved and folded
into the amended phase commits (see each commit message's "Codex review …
resolved" section). Phase 4's Codex findings are **still open** — see below.

---

## Deliberate deferrals (documented, not accidental)

1. **Orchestrator/Control-Plane cutover is NOT done.** `apps/api/src/modules/orchestrator.ts`
   still drives adapters directly for real runs. The Harness modules are
   additive and exercised only by `apps/api/test/harness/*`. The plan's
   Phase 3/5 "cutover" (route single-mode execution through `SessionRunner`,
   keep failover/retry/parallel/verdict in the renamed control-plane
   orchestrator, flip behind a config flag for one release) is the largest
   remaining risk and was left for a focused pass.
2. **Destructive `runs.state` vocabulary rewrite** — deferred to the cutover
   (the dual-field window is open: `session_state` is populated alongside the
   legacy `state`).
3. **Guard-directive replay worker** and **full boot reconcile** — Phase 7.
4. **Bounded *cost* caps** (`budget.maxCostUsd`) — Prepare rejects them as
   `policy_unenforceable` (no pricing table); token caps work.

---

## OPEN: Codex Phase 4 findings to resolve (do these first in the next session)

Review text: not saved to repo; re-run if needed:
`git show ac3f685 | codex exec --sandbox read-only --skip-git-repo-check -c model_reasoning_effort=low "<same prompt shape as prior phases>"`

- **[blocker] `005_harness.sql` was edited in place across phases.** Phase 4
  added `start_ambiguous` + `claimed_at`/`start_attempted_at` to
  `handoff_envelopes` by editing 005 (which Phase 1 already committed). A DB
  that applied 005 at Phase 1 will never gain them. **Fix:** revert 005's
  `handoff_envelopes` block to its Phase-1 form and add
  `006_harness_handoff.sql` that `DROP`s + recreates `handoff_envelopes`
  with the new state list + timestamp columns (table is empty in this
  train, safe). Update `apps/api/test/harness/db`-style table-list assertions
  if any. (Attempted this session, reverted to keep the tree green — do it
  properly with 006.)
- **[blocker] `SessionRunner.buildReroute` ignores its `_envelopeId` param.**
  `RerouteRequest` (core) has no `envelopeId` field — it carries
  `checkpointId`. Either (a) drop the dead param and add
  `HandoffService.bySourceSession(sessionId)` / `byCheckpoint(id)` read
  methods so the plane finds the reroute envelope, or (b) add `envelopeId?`
  to `RerouteRequest` in core if the design review agrees.
- **[major] `settleAmbiguous(envelopeId, outcome, requestId)`** does not check
  `requestId === claimed_by_request_id`. Add `AND claimed_by_request_id = ?`
  to both CAS branches and supersede the *stored* id.
- **[major] `released` state is unreachable.** `release()` and negative
  `settleAmbiguous` write straight to `ready`. Make them land in `released`
  and have `claim()` accept `state IN ('ready','released')` (preserves the
  "this envelope had a failed attempt" signal, matches §7).
- **[major] Yield still terminalizes with a fabricated `envelopeId`** when the
  checkpoint didn't commit or `deps.handoff` is absent. Make
  `HandoffRequest.envelopeId` optional in core; when there is no envelope,
  omit it and let the plane park the task (no fake `"pending"` / checkpoint
  id).
- **[major] `HandoffService.claim()` trusts the `insertRequest` callback.**
  After it runs, `SELECT id, task_id, origin_envelope_id FROM
  execution_requests WHERE id = ?` and assert id/envelope/task match, else
  throw + rollback.
- **[major] `enterStartAmbiguous` fault window.** Per §7 it must commit in the
  same transaction as the durable start-intent (§9 step 2). For a
  handoff-origin successor the runner's `PREPARED→STARTING` CAS should also
  flip the envelope to `start_ambiguous`. Needs an `extra`-style hook on
  `SessionStore.transition` (mirrors the `terminalize({extra})` hook already
  added). Pair this with Phase 7 recovery work.
- **[minor] `expireClaim` does read-then-CAS** — fold staleness check + release
  into one transaction.
- **[minor] Missing tests:** envelope redaction across every field; competing
  DB connections; recovery with a mismatched request id; checkpoint/handoff
  failure during terminalization; migration upgrade from an already-applied
  005.

---

## Next: finish Phase 5

`docs/harness-implementation-plan.md` Phase 5. WIP already in `08cf29f`.

1. **`apps/api/test/harness/secret-broker.test.ts`** — allowed vs disallowed
   ref, missing value → `SecretResolutionError` (names ref, not value), no
   partial env, `dispose()` clears + blocks re-resolve, `refToEnvName`
   mapping.
2. **`session-runner.test.ts`** additions — a request with
   `context.secretRefs` + `deps.secretResolver`: the resolved value reaches
   `adapter.start`'s `spec.secretEnv`; it is NOT in the persisted
   `execution_requests.canonical_projection` / fingerprint; a verification
   command run via the authority does NOT see it (authority rebuilds env
   from an allowlist — already true, assert it).
3. **Isolation tiers** — `policy.isolation.required: "full"` + a manifest
   declaring `processIsolation: "os-sandbox"` + `deps.verifyIsolation`
   returning true → `result.enforcement.isolation === "full"`; returning
   false → `FAILED(policy_unenforceable)` before RUNNING; `required: "full"`
   with no sandbox in the manifest → still rejected at Prepare (already
   covered by the Phase 3 policy_unenforceable test — extend it).
4. **Verification hardening** in `session-runner.ts` `runVerification`:
   support `kind: "artifact_exists"` (check a path under the worktree via
   `authority.resolveWrite` + `fs.existsSync`); confirm `required: false`
   checks report but never flip `passed` (the `.filter(c => c.required)` is
   already there — add a test).
5. Commit as Phase 5. Codex-review the diff.

---

## Then: Phase 6 (Cockpit observability)

`docs/execution-harness.md` §11, plan Phase 6. All **additive read-only**.

- `packages/core/src/contracts.ts` — add the new observability capabilities
  (session reads, verification reads, approval reads) to
  `OBSERVABILITY_CAPABILITIES`; bump `CONTROL_PLANE_API_VERSION` per the
  versioning rule and update `GET /api/meta` (`apps/api/src/server.ts`).
- New read endpoints in `apps/api/src/server.ts` for: session by id
  (`sessionState` primary, legacy `state` still served — flip the Phase 1
  dual-field window here), the durable drill-down (task → subtasks →
  session → phase → checkpoints → handoffs → verification → result), guard
  decisions / enforcement fidelity / lease takeovers as typed audit events
  from `events`.
- Contract tests on the payload shapes; a first frontend smoke test
  (`apps/web` — this is where the first frontend tests land per ROADMAP).
- Every §11 state distinction must be renderable from durable reads alone
  (no inference from SSE).

## Then: Phase 7 (recovery / concurrency hardening)

`docs/execution-harness.md` §9, §12 layer 4, plan Phase 7.

- **Boot reconcile v2** (`SessionStore.liveSessions()` already exists):
  `voidAllLeases()` then, per live session — probe-resumable → offer/perform
  resume (new `origin: resume` request); not resumable → terminal
  `FAILED(orphaned)` with a **checkpoint attempt** recorded on the result
  (H-I4). Replace `Orchestrator.reconcileOnBoot`'s blanket fail.
- **Guard-directive replay worker**: on recovery, `SessionStore.pendingDirectives(sessionId)`
  → re-apply each idempotently (cap attempts, default 3; a permanently
  failing one orphan-fails the session with a typed audit event).
- **Lease sweeper** productionized (takeover CAS on the expired token).
- **Approval `delivery_unknown` settlement path** (§4): ack-lookup probe
  where the manifest declares `approvalAckLookup`, else proven-idempotent
  re-delivery, else hold + surface. Currently the runner just fails the
  session with the row left `delivery_unknown`.
- **Fault-injection matrix** (`apps/api/test/harness/fault-*.test.ts`):
  crash between STARTING and ack; kill mid-RUNNING then boot reconcile;
  lease expiry with a stale writer; txn failure between event insert and
  CAS; crash between committed event and unapplied directive; crash between
  `answered` and `delivered`; envelope claim crash; pre-start claim expiry;
  `start_ambiguous` probe settle; sync `adapter.start` failure.
- Map H-I3/4/8/12/14 each to at least one passing fault test.

## Optional / out of scope

Phase 8 remote-runner seam — **do not build** unless a real remote use case
is proven (plan is explicit). The Phase 0 contracts already carry the keys.

---

## Handy commands

```
cd ~/workspace/personal/ai-control-plan-harness
pnpm typecheck && pnpm test && pnpm lint

# Codex review of the last phase's diff:
git show <sha> | codex exec --sandbox read-only --skip-git-repo-check \
  -c model_reasoning_effort=low \
  -o /tmp/codex-review.txt \
  "Independent code review. Stdin is the diff of Phase N of an Execution Harness. \
   Source of truth: docs/execution-harness.md rev 7 §<...> and \
   docs/harness-implementation-plan.md Phase N. Review for correctness, \
   architecture compliance, concurrency/lifecycle errors, provider leakage, \
   missing tests, unnecessary complexity. Short bullet list, each \
   [blocker]/[major]/[minor]/[nit]. No praise, no summary."
```

Test harness pattern: fresh `openDb(tmpfile)`, seed `assistants` + `tasks`
rows, drive `SessionStore` / `SessionRunner` with the in-process
`FakeAdapter` (+ small inline adapters for edge cases). No live providers.
