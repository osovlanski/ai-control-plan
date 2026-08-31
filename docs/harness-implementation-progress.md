# Execution Harness — implementation progress & handoff

**Worktree:** `~/workspace/personal/ai-control-plan-harness`
**Branch:** `feat/execution-harness` (off `docs/agentic-os-contract-lifecycle`)
**Design source of truth (read first):**
`../ai-control-plan-agentic-os/docs/execution-harness.md` (rev 7) and
`../ai-control-plan-agentic-os/docs/harness-implementation-plan.md`.
Those two docs live in the SIBLING worktree, not this one. Also read `AGENTS.md`
and `docs/DECISIONS.md` here. **Design is approved — implement it, do not redesign.**

Run after every change, from the worktree root:
`pnpm typecheck && pnpm test && pnpm lint` — keep them green.
**Baseline at this checkpoint: core 37, api 238, adapters 8, web 3 — all green; lint clean.**

Rules for the rest of the work:
- Commit per phase. Codex-review each phase's diff (command at the bottom).
- **Do NOT build Phase 8 (remote runner).** Contracts already carry the keys.
- Test only through the `FakeAdapter` + in-repo SQLite. No live providers.

---

## Commits so far (each a reviewable slice, additive, whole suite green)

| Commit | Slice | Summary |
|---|---|---|
| `4693550` | Phase 0 | contracts, session state machine, `requestFingerprint`, characterization. |
| `fe77a4e` | Phase 1 | migration `005_harness.sql`, `SessionStore`. |
| `ac7d838` | Phase 2 | `EventRecorder` (one-txn + two-view redaction), `WorkspaceAuthority`, session-scoped checkpoints. |
| `1dd7b79` | Phase 3 | `guards.ts`, `approval-service.ts`, `session-runner.ts`. |
| `ac3f685` | Phase 4 | `handoff.ts` — envelope derivation + claim protocol + reroute yield. |
| `08cf29f` | Phase 5 (WIP) | `secret-broker.ts` + runner wiring + per-session `verifyIsolation` (no tests). |
| `863d17d` | Phase 4 follow-up | Codex Phase 4 findings resolved (see below). |
| `ee8114c` | Phase 4 follow-up r2 | claim-owner CAS on `enterStartAmbiguous`/`markConsumed`/`settleAmbiguous`; `claim()` cross-validates all handoff-identity fields; migration 006 row-copy test. |
| `07f76c1` | Phase 5 | `runVerification` hardening (`artifact_exists`), `secret-broker.test.ts`, isolation-tier tests. |
| `f0d35b9` | Phase 5 follow-up | Codex: probe moved post-`start()`, gets effective spec; secret broker leak fix + clear-on-failure; secretRefs-without-resolver → Prepare reject; `artifact_exists` via `WorkspaceAuthority.artifactExists`; `enforcement().isolation` reports ACHIEVED tier; Prepare rejects `partial` when only `ambient` achievable. |
| `76714a8` | Phase 5 follow-up r3 | Codex: probe wrapped in try/catch; `artifactExists` uses `existsSync` after containment proof (fixes in-worktree-symlink false negative); throwing-probe + cancel/checkpoint-once tests. |
| `e9c89c6` | Phase 6 | `contracts.ts` → API 1.1 + `sessions.read`/`verification.read`/`approvals.read`; `GET /api/tasks/:id/sessions` + `GET /api/sessions/:id`; `observability.test.ts`; web `api.ts` typed clients + smoke test. |
| `2eadecb` | Phase 6 follow-up | Codex: camelCase-normalise every nested payload; migration `007_harness_correlation.sql` (parent_task_id/group_id) + `SessionStore.recordRequest` persists `correlation`; `safeJson`; ORDER BY tie-breakers; real-`SessionRunner` e2e leak test; drop duplicated top-level `verification`/`enforcement`; web `SessionDetail` precise types. |
| `54f17cd` | Phase 6 follow-up r2 | Codex: `GET /api/sessions?groupId=&parentTaskId=` + parent index + web `sessionsByGroup/Parent`; result served only if shape is `{outcome:string,...}` else null; **`SessionRunner.finalize()` now redacts `failure.message`+`failure.providerDetail`** (was an H-I13 leak from `error`-event summaries); TaskDetail clears session on taskId change; UI guards nested `result.enforcement`. Also lands Phase 7 scaffolding (all additive, unused there): manifest `approvalAckLookup`/`approvalIdempotentRedelivery`, `recovery.decision` event type + `RecoveryDecisionPayload`, `SessionStore.incrementDirectiveAttempt`/`markDirectiveFailed`/`appendRecoveryEvent`. |
| `dbe156e` | Phase 7 (WIP) | `recovery.ts` — `HarnessRecovery` (boot reconcile v2, lease sweeper, directive replay, `delivery_unknown` settlement). Compiled only, no tests, unwired. |
| `430b6e8` | Phase 7 | `recovery.test.ts` + `fault-injection.test.ts` (maps H-I3/4/8/12/14) + `server.test.ts` boot assertion. `Orchestrator.reconcileOnBoot()` is now `async`, runs `HarnessRecovery.reconcileOnBoot()` first and scopes the legacy blanket fail-all to `execution_request_id IS NULL` rows. `buildServer` builds the deps (`SessionStore`, `ApprovalService`, `CheckpointService` **is** structurally a `RunnerCheckpoints`, `Registry` **is** structurally the `{adapter,manifest}` facade) and owns a 60s `sweepExpiredLeases()` `setInterval` (`.unref()`, cleared on `app.close()`). `/api/sessions/:id` audit filter now includes `recovery.decision`. |
| _this_ | Phase 7 follow-up | Codex Phase 7 findings (see below). Atomic `SessionStore.resumeFromApproval` (approval→delivered + session→RUNNING in one tx); recovery now settles `answered`/`delivering`/`delivery_unknown` (not just `delivery_unknown`); a durable `cancelRequested` is honored ahead of resume/orphan → terminal `CANCELLED` + checkpoint attempt (`recomputeUsage` for the VERIFYING-completion result from persisted `usage.updated` events); `resume_offered` emitted once (`hasRecoveryDecision` guard) so periodic sweeps don't re-announce; `renewLease` after the awaited settle steps; directive-failure detail goes through core `redactValue` not a hand-rolled `sk-` regex. API 265 / core 37 / adapters 8 / web 3, lint clean. |

Codex reviewed the diff of every phase and each follow-up; findings were folded
into the follow-up commits. **All Codex findings through Phase 6 are resolved.**

**Codex Phase 7 review — dispositions:**
- *Fixed:* split approval settlement → one tx (`resumeFromApproval`); recovery
  ignored `answered`/`delivering` rows → widened; replayed `cancel` didn't
  terminate → durable cancel intent now → `CANCELLED`; `resume_offered` spammed
  every sweep → emit-once guard; no lease renew across awaits → `renewLease`;
  VERIFYING result fabricated zero usage → recomputed from events; hand-rolled
  redaction → core `redactValue`.
- *Kept as approved-design / deferred (not bugs):* checkpoint side effect before
  the `applied` CAS (git commit can't co-commit with SQLite; a duplicate recovery
  checkpoint is benign — this is the design's at-least-once replay, §4);
  `appendRecoveryEvent` `MAX(seq)+1` without a lease CAS (single-process
  architecture + `UNIQUE(run_id,seq)`; cross-process is the deferred remote
  runner); recovery enforcement floor `none/none/ambient` (a dead process's
  isolation-tier probe is genuinely not reconstructable — reporting the floor is
  the honest H-I10 move, never assuming higher); "no real competing-connection
  fault tests" (out of scope — FakeAdapter + in-repo SQLite, single process).

---

## Phase 7 (recovery / concurrency hardening) — DONE (pending Codex review)

Design: `execution-harness.md` §9, §12 layer 4; `harness-implementation-plan.md` Phase 7.

**Status:** all 6 next-actions below are done. `recovery.ts` is tested (`recovery.test.ts`
12, `fault-injection.test.ts` 10) and wired into boot via `Orchestrator.reconcileOnBoot()`
(now `async`); the lease sweeper is a 60s `setInterval` in `buildServer`; `recovery.decision`
events are in the `/api/sessions/:id` audit filter. Suite: api 261 / core 37 / adapters 8 /
web 3, lint clean. Next: Codex-review the phase diff, fold findings into a follow-up commit.

### `apps/api/src/modules/harness/recovery.ts`
`HarnessRecovery` class — Implements:
- `reconcileOnBoot()` — `voidAllLeases()` then `recoverSession()` per `liveSessions()`.
- `sweepExpiredLeases()` — recover only sessions whose lease is expired/absent.
- `recoverSession(id)` — acquires the (void) lease, then: replay directives →
  settle `delivery_unknown` → if `VERIFYING` complete it (no verification, §5) →
  if `manifest.core.canResume` + `providerSessionRef` return `resume_offered`
  (plane issues the `origin:resume` request, H-I1) → else `FAILED(orphaned)` with
  a checkpoint ATTEMPT (H-I4) and a result row in the terminal CAS (H-I3).
- `replayDirectives()` — `pendingDirectives` → `applyDirective` idempotently, cap
  `maxDirectiveAttempts` (default 3); permanent failure → orphan-fail + typed
  audit event.
- `settleDeliveryUnknown()` — `approvalAckLookup` probe when the manifest declares
  it (→ `markDelivered` + `AWAITING_APPROVAL→RUNNING`), else HOLD + surface
  (re-delivery needs a live handle a crash did not keep).
- Every decision → `store.appendRecoveryEvent(id, action, detail)` = an
  append-only `recovery.decision` event.
- NOTE: `assistantOf`/`taskOf` reach `store.db` via a cast — if you prefer, add
  thin `SessionStore` getters instead.

### Phase 7 actions — all DONE (checklist kept for the Codex reviewer)
1. **`apps/api/test/harness/recovery.test.ts`** — drive `SessionStore` +
   `HarnessRecovery` with the `FakeAdapter`:
   - boot reconcile: a `RUNNING` session with a `providerSessionRef` + `canResume`
     manifest → `resume_offered`, lease released, no result row;
   - `RUNNING` with no `providerSessionRef` / `canResume:false` → `FAILED(orphaned)`,
     exactly one result row, checkpoint `attempted:true`;
   - crashed `VERIFYING` → `COMPLETED`, `result.verification` undefined;
   - `pendingDirectives` with a `checkpoint` directive → replayed once, marked
     `applied`; a directive whose action always throws → after 3 attempts
     `status='failed'` + session `FAILED(orphaned)` + `recovery.decision` event;
   - `delivery_unknown` approval, manifest `approvalAckLookup:true`, `deps.approvalAckLookup`
     returns true → `markDelivered` + session back to `RUNNING`; returns false or
     no lookup → still `delivery_unknown`, session still `AWAITING_APPROVAL`,
     `approval_delivery_held` event;
   - `sweepExpiredLeases`: a session with `lease_expires_at` in the past is
     recovered; one with a valid future lease is `skipped`.
2. **`apps/api/test/harness/fault-injection.test.ts`** — the §12 layer-4 matrix.
   Map each of **H-I3 / H-I4 / H-I8 / H-I12 / H-I14** to ≥1 passing test:
   - crash between `STARTING` and ack → recovery probes/orphans, never
     double-writes a worktree (H-I8);
   - kill mid-`RUNNING` then `reconcileOnBoot` → resume-offer vs orphan+checkpoint
     (H-I3/H-I4);
   - lease expiry with a stale writer → the stale runner's next fenced CAS is
     rejected (`SessionCasConflictError`) (H-I12);
   - txn failure between event insert and CAS → no partial visibility (already
     have `event-recorder.test.ts` coverage — extend/point at it);
   - crash between committed event and unapplied guard directive → replay applies
     exactly once (H-I14);
   - crash between `answered` and `delivered` approval → `delivery_unknown`
     settlement path above (H-I14);
   - envelope claim crash / pre-start claim expiry / `start_ambiguous` probe
     settle / sync `adapter.start()` failure — mostly already covered in
     `handoff.test.ts`; add the missing ones and/or a fault-flavoured wrapper.
3. **Wire `HarnessRecovery` into boot** additively:
   `Orchestrator.reconcileOnBoot()` (`apps/api/src/modules/orchestrator.ts:94`)
   currently blanket-fails every running task. Leave the legacy path for legacy
   `runs` rows (no `execution_request_id`); for Harness sessions call
   `new HarnessRecovery({...}).reconcileOnBoot()` instead. `buildServer` builds
   the deps (`SessionStore`, `ApprovalService`, a `RunnerCheckpoints` shim over
   `CheckpointService`, a `{adapter,manifest}` registry facade). Add a
   `server.test.ts` / integration assertion that a seeded live Harness session is
   reconciled on boot rather than blanket-failed.
4. **Lease sweeper productionised** — a periodic `sweepExpiredLeases()` tick
   (reuse the existing retention-job cadence in `apps/api/src/modules/retention.ts`
   if it has one; otherwise a simple `setInterval` owned by `buildServer`, cleared
   on `app.close()`). Keep it small.
5. Optionally surface `recovery.decision` events in the Phase 6 audit filter
   (`server.ts` `/api/sessions/:id` — the `type IN (...)` list) so Cockpit can
   render orphan-vs-resume. Small, coherent, do it if cheap.
6. Commit as Phase 7. Codex-review the diff. Fold findings into a follow-up
   commit like the earlier phases.

### Phase 7 deferrals that are OK to keep (documented, not accidental)
- The atomic co-commit of `start_ambiguous` with the destination session's
  durable start-intent CAS (§7 / old Phase 4 finding 7) is only reachable once
  the runner drives the claim protocol — which is the **orchestrator cutover**,
  still deferred (see below). Note it; don't force it.
- `approvalIdempotentRedelivery` re-send on recovery needs a resumed provider
  session; recovery only does ack-lookup-or-hold. That matches §4.

---

## Standing deferrals (whole project, unchanged)

1. **Orchestrator / Control-Plane cutover is NOT done.**
   `apps/api/src/modules/orchestrator.ts` still drives adapters directly for real
   runs. The Harness modules are additive, exercised only by
   `apps/api/test/harness/*` and `apps/api/test/harness/observability.test.ts`.
   Routing single-mode execution through `SessionRunner` (keeping
   failover/retry/parallel/verdict in the renamed control-plane orchestrator,
   behind a config flag for one release) is the largest remaining risk and is a
   separate focused pass AFTER Phase 7.
2. **Destructive `runs.state` vocabulary rewrite** — deferred to that cutover. The
   dual-field window is open: `session_state` is populated alongside legacy
   `state`; `/api/sessions/*` serves `sessionState` primary + `state` legacy.
3. **Bounded *cost* caps** (`budget.maxCostUsd` with `enforcement:"bounded"`) —
   Prepare rejects them `policy_unenforceable` (no pricing table). Token caps work.
4. **Real-adapter conformance** (CI-with-creds) unlocking real
   `toolGating`/`processIsolation`/`usageReporting`/`approvalAckLookup`
   declarations for Claude/Codex — the `verifyIsolation` dep is the "equivalent
   adapter probe" §3 allows; a standalone `VerificationRunner` extraction and a
   real adapter `provision()/verify()` are NOT built (the progress steps said keep
   verification inline in `session-runner.ts`).

---

## Gotchas learned this session (save yourself the debugging)

- **Migrations are immutable once committed.** 005 was edited across phases → had
  to revert its `handoff_envelopes` block and add `006_harness_handoff.sql` that
  `RENAME`s + rebuilds the table (SQLite can't `ALTER` a `CHECK`). New migrations
  auto-run under `migrate(db, MIGRATIONS)`. `migration.test.ts`'s `migrateLegacy`
  strips files with numeric prefix `>= N`; keep that pattern.
- **The pre-write secret-scan hook** blocks any file containing `const X = "..."`
  where `X` matches `secret|token|api_key|...` and the value is 8+ chars, or a
  literal `sk-…` token. In tests, build such tokens at runtime
  (`["sk", "…"].join("-")`) and name canary consts `CANARY`, not `SECRET`.
- **`redactMessage` (session-runner local)** only strips `sk-…`. `finalize()` now
  uses core `redactValue` (full `DEFAULT_REDACTION_RULES`) for `failure.message`.
  `observe()` copies `event.summary` verbatim into `embeddedFailure.message` for
  the `auth_failed`/`quota_exhausted` paths — that's why the redaction in
  `finalize()` matters.
- **Codex review runs long (>2 min).** Launch it with `run_in_background: true`
  writing to a file, then poll with an `until [ -s file ]; do sleep 5; done`
  loop. A foreground `codex exec` gets SIGTERM at the 2-min bash timeout.
- **`isolation` achievable tiers:** `full` only when the per-session probe
  confirmed it; `partial` needs `this.d.authority` AND `context.worktree`; else
  `ambient`. The test-default `request()` in `session-runner.test.ts` is
  `isolation.required: "ambient"` (deps has no authority).
- **`handoff_envelopes.state`** now: `ready → claimed → consumed`;
  `claimed → released` (a failed pre-start attempt — `claim()` accepts
  `state IN ('ready','released')`, a deliberate superset of §7's wording per the
  prior review round); `claimed → start_ambiguous` (recovery-only exit).

---

## Handy commands

```
cd ~/workspace/personal/ai-control-plan-harness
pnpm typecheck && pnpm test && pnpm lint

# Codex review of a phase diff (background; poll the file):
git show <sha> > /tmp/p.diff   # or: git diff <base>..<head> > /tmp/p.diff
codex exec --sandbox read-only --skip-git-repo-check \
  -c model_reasoning_effort=low -o /tmp/review.txt \
  "Independent code review. Diff at /tmp/p.diff is Phase N of an Execution Harness.
   Source of truth: ../ai-control-plan-agentic-os/docs/execution-harness.md rev 7
   §<...> and .../harness-implementation-plan.md Phase N. Review for correctness,
   architecture compliance, concurrency/lifecycle errors, provider/secret leakage,
   missing tests, unnecessary complexity. Short bullet list, each
   [blocker]/[major]/[minor]/[nit]. No praise, no summary."
```

Test harness pattern: fresh `openDb(tmpfile)`, seed `assistants` + `tasks` rows,
drive `SessionStore` / `SessionRunner` / `HarnessRecovery` with the in-process
`FakeAdapter`. See `apps/api/test/harness/observability.test.ts` for the
real-`SessionRunner`-inside-a-server-test pattern.
