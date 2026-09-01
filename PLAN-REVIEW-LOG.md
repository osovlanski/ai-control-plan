# Plan Review Log: Execution Harness — Orchestrator / Control-Plane Cutover

Phases 0-1 (recon + interrogation) complete — plan locked with the user.
Two load-bearing ambiguities resolved by the user before drafting:
1. `session_state` becomes internal-read authority; `runs.state` frozen for legacy rows.
2. Keep the class named `Orchestrator` this pass (rename deferred).
Remaining load-bearing decisions (Q1–Q6) locked at Claude's recommendations via the
"accept all recommendations" escape hatch.

MAX_ROUNDS=5. PLAN_FILE=PLAN.md. Reviewer model: to be echoed before Round 1.

---

## Round 1 — Codex (VERDICT: REVISE)

25 findings. Full text:

1. Critical — bridge pre-creates the session row, violating "SessionRunner is the only session-row writer"; unleased PREPARED interval races startup. Fix: runner-owned prepare/start API returning the session id synchronously.
2. Critical — manual handoff races settleFromResult: cancel → outcome="cancelled" → callback sends task to CANCELLED while handoff() expects LIMIT_PAUSED/HANDING_OFF. Fix: durable plane settlement intent consumed atomically by result settlement.
3. Critical — cancelTask terminalizes the task before persisting cancel_requested (design §9 order: durable intent → adapter cancel → drain → checkpoint → CAS). Fix: persist cancel intent for all live sessions first, task transition after.
4. Critical — detached run().then(onSettled).catch() has no recovery: lease conflict / callback throw / rejection leaves the task permanently RUNNING even with an execution_results row. Fix: catch reloads the durable result and idempotently settles, else durable pending-plane-decision.
5. Critical — plane settlement has no CAS / no attempt verification; cancel, handoff, boot recovery, completion callback can all concurrently call tasks.transition; settleFromResult keyed by task/assistant not session. Fix: CAS a plane-decision record keyed by sessionId, reject stale/superseded.
6. Critical — envelope bridge mutates the task envelope after the event tx commits, contradicting §9's event+envelope+session-CAS transaction. Fix: derive via EventRecorder.recordBatch inTransaction; reserve the post-commit callback for SSE only.
7. High — usage claim false: SessionRunner.observe() accumulates tokens in memory only; finalize() writes execution_results; runs.usage is never set → telemetry's runs.usage input is null for harness sessions. Fix: persist usage on the session row during usage-event commits, or read execution_results.result.usage.
8. High — SSE pseudocode shape-ambiguous; literal DurableEvent {seq,event} would nest inside the legacy `event` field. Fix: destructure `for (const {seq,event} of durableEvents) bus.publish(taskId,{kind:"event",event:{...event,seq}})`; pin the frame shape in a parity test.
9. High — not all legacy event side effects reproduced: quota snapshots, run.started provider-ref (assumed), notices, limit.approaching checkpoint warning. "Behavior preserved" while testing only terminal outcomes is too weak. Fix: enumerate every legacy applyEvent side effect and implement or document+test each divergence.
10. High — isActive() backed solely by the in-memory ActiveRun map → harness tasks report active:false; duplicate-start protection, waitForSettled, shutdown all break. Fix: activity + shutdown query/control live harness sessions too.
11. High — createCheckpoint() gets its session id from soleRun() → a manual checkpoint during a harness session has session_id=NULL. Fix: resolve the unique live harness session and pass its id.
12. High — harnessOwns() unsafe: after ended_at is written but before the detached callback settles, approval/cancel/handoff fall into the legacy branch ("no active run"); also assumes one harness session. Fix: route by latest unsuperseded request/result + pending plane settlement, not ended_at IS NULL.
13. High — settleFromResult omits the verdict for outcome="completed" + failed required verification (design §5 assigns retry/reroute/fail/park to the plane). Fix: branch on result.verification?.passed === false.
14. High — failure parity incomplete: excludes budget_exceeded, treats retryable auth as provider-unavailable (runner normalizes auth_failed as non-retryable), auto-reroutes every yielded reroute without checking failover.auto/trigger. Fix: complete result→plane decision table over every FailureKind × retryability × trigger × failover.auto; test every row.
15. High — executionRequestId = erq_<taskId>_<attempt>_<assistantId> not safely deterministic: attempt = 1 + COUNT(runs) is not atomic and not retry-idempotent. Fix: allocate attempts transactionally with UNIQUE(task_id, attempt); persist/reuse a plane-issued request id for retries.
16. High — attempt counting includes parallel/legacy/cancelled/unrelated rows; assistant in the id makes one logical attempt's identity routing-dependent. Fix: next attempt from MAX(execution_requests.attempt) under a tx; keep assistant in the fingerprint, not the id.
17. High — routingDecisionRef = rd_<taskId>_<attempt> is fabricated; routing_decisions uses an integer id and the insert helper returns nothing. Fix: persistRoutingDecision returns its inserted id; thread that value.
18. High — flag-ON handoff sends origin:{kind:"fresh"}, bypassing the landed handoff-envelope claim/consumption protocol (§7, migrations 005/006) — loses atomic source terminalization, successor uniqueness, start_ambiguous recovery. Fix: issue the successor from the committed envelope with origin:{kind:"handoff",envelopeId} through the claim protocol.
19. High — migration unsafe in rolling/mixed-binary deploy: 008 can map a live legacy ACTIVE row to RUNNING, an old process then writes only state='ENDED_OK', COALESCE prefers the stale session_state. Fix: quiesced single-binary migration, or derive legacy rows from state based on execution_request_id IS NULL.
20. Medium — 008 maps every unknown/null legacy state to FAILED (hides corruption); the "pre-005 DB with harness rows untouched" fixture is impossible. Fix: restrict to the five known values, assert on unknowns, separate migration-stage fixtures.
21. Medium — permanent dual writer of state + session_state recreates the drift mechanism across SQL call sites. Fix: centralize legacy run transitions in one store method/trigger; remove dual writes when the flag-off window closes.
22. Medium — session-state SSE not sourced from session transitions; STARTING/AWAITING_APPROVAL/resume/verification/timeout/yield observable only by interpreting events. Fix: publish a post-commit session-state notification from every SessionStore transition; clients resync the durable record.
23. Medium — plan requires the four files UNEDITED then explicitly extends characterization.test.ts in Commit 4. Fix: keep all four byte-identical; new file for flag-ON characterization.
24. Medium — runner-per-server is not "inert" with the flag off if recovery is always instantiated; supplying deps.orchestrator bypasses bridge injection. Fix: one execution-service composition root; assert flag ON ⇒ fully wired bridge/runner/recorder.
25. Simpler alternative — expose a single runner-owned start(request): {sessionId, result: Promise<ExecutionResult>}; durable plane-decision consumer keyed by sessionId; envelope mutation inside the recorder tx; derive legacy compatibility fields at read time rather than two writable vocabularies.

### Claude's response (plan rev 2)

Accepted and folded in:
- #1/#25 → new `SessionRunner.start(): {sessionId, done}`; `run()` becomes `start().done`. Bridge never writes `runs`. (8c.1)
- #2/#5 → in-memory `planeOwnsTerminal` set (durable-parity of legacy `run.handingOff`, single-process) + `settleFromResult` guards: task-terminal check, `sessionId === latestSessionId` staleness check, try/catch transitions. Durable plane-decision QUEUE rejected as over-engineering for a single-process prototype — logged. (8c.2/8c.4)
- #3 → flag-ON `cancelTask` calls `requestCancel` (durable) for every live session first, task transition after. Legacy branch order unchanged (its tests pin it). (8c.3)
- #4 → bridge `.catch` calls `recoverResult(sessionId)` (reload `store.result`, else synthesise minimal FAILED); + `reconcileOnBoot` sweep for RUNNING tasks whose latest harness session is terminal-with-result. (8c.2/8c.3)
- #6 → new additive `EventRecorder.afterInsertInTx` hook; task-envelope derivation + `runs.usage` write run inside the event tx. Post-commit `publish` reserved for SSE + quota snapshots. (8b/8d)
- #7 → `afterInsertInTx` writes `runs.usage` for harness rows + telemetry `LEFT JOIN execution_results` / `COALESCE(r.usage, json_extract(er.result,'$.usage'))`. (8d/8f)
- #8 → exact frame `for (const {seq,event} of durableEvents) bus.publish(taskId,{kind:"event",event:{...event,seq}})` + parity test. (8d)
- #9 → full side-effect table in 8d with per-effect disposition; quota snapshots reproduced (router depends on them); soft-threshold notice is a documented+tested divergence (guard path replaces it).
- #10 → `isActive` + `shutdown` harness-aware. (8c.3)
- #11 → `createCheckpoint` resolves the live harness session id. (8c.3)
- #12 → `harnessOwns(taskId)` redefined = "newest run row for the task is a harness row" — control ops stay on the harness branch through the post-terminal/pre-settle window. (8c.3)
- #13 → `settleFromResult` branches on `result.verification?.passed === false` → park WAITING_INPUT (defensive; this pass sends `verification:[]` so unreachable — full verdict policy out of scope, logged).
- #14 → complete result→plane decision table (8c.4) matching the runner's actual normalizations (auth non-retryable, quota retryable, capability_missing→reroute, generic→provider_fault); failover only on retryable provider_fault or YIELDED(limit|reroute) under failover.auto + trigger.
- #15/#16 → `attempt = COALESCE(MAX(execution_requests.attempt WHERE task_id=?),0)+1`; id `erq_<taskId>_<attempt>` (no assistant); `uq_execution_requests_task_attempt` unique index in 008.
- #17 → `persistRoutingDecision` returns `lastInsertRowid`; threaded as `routingDecisionRef`.
- #18 → 8e: flag-ON handoff/failover goes through `HandoffService` claim protocol (`origin:{kind:"handoff",envelopeId}`), envelope claimed in the same tx as the successor request insert; `uq_live_successor` enforces uniqueness; provider-fault failover has the plane derive+claim the envelope from a plane-created checkpoint.
- #19/#21 → dropped dual-write entirely. Read-time derivation: `CASE WHEN execution_request_id IS NULL THEN map(state) ELSE session_state END`. `runs.state` authoritative for legacy rows, `session_state` for harness rows. Migration 008 is a non-load-bearing consistency backfill. No mixed-binary window (single-process, boot-quiesced).
- #20 → 008 restricted to the five known values, no ELSE (unknown left as-is to surface); separate legacy-backfill vs harness-preservation migration fixtures.
- #22 → 8d publishes a deduped `{kind:"state"}` frame from the publish callback on task-phase change (parity with legacy `applyEvent` phase push); session-level states remain observable via the Phase-6 durable `/api/sessions/:id` endpoint (matches legacy, which never emitted per-run state). Full per-transition session-state SSE deferred as additive.
- #23 → flag-ON characterization in a NEW file `characterization-harness.test.ts`; the four named files stay byte-identical.
- #24 → single `buildServer` composition root; startup assertion `harnessSingleMode ON ⇒ bridge wired`.

Rejected / narrowed (with reason):
- #5 durable plane-decision queue — rejected for a single-process local-first prototype; the in-memory flag + boot sweep is the exact shape of the shipped legacy `run.handingOff` path.
- #13 full verdict policy — out of scope; this pass sends no verification specs, defensive park only.
- #19 "require compatibility triggers / read from state for all rows" — narrowed: read-time derivation keyed on `execution_request_id IS NULL` already achieves the safe outcome without triggers.

---

## Round 2 — Codex (VERDICT: REVISE)

Confirmed addressed from R1: #1/#25, #2/#5, #3, #6, #7–#12, #13/#14, #15–#17, #19–#21, #22–#24. 8 remaining:

1. Critical — 8e claims handoff start transitions "already implemented", but the runner never calls enterStartAmbiguous/markConsumed/release; PREPARED->STARTING and STARTING->RUNNING are plain SessionStore.transition. Fix: extend the store transactions to co-commit those.
2. Critical — proposed claim wiring doesn't match HandoffService.claim's API: it's claim(envelopeId,{requestId,insertRequest(db)}) and owns its own tx. Fix: build the full successor request first, call claim(envelopeId,{requestId,insertRequest: db=>store.recordRequestIn(db,request)}), then let start() dedupe it.
3. Critical — the handoff flow is circular: failoverTask must claim+insert the successor, but the request is built inside startTask which only gets the envelope origin after the claim; prompt/worktree/attempt/routing must be identical or fingerprint conflict. Fix: one prepareExecutionRequest(...) computed once; claim that exact request, start that exact object.
4. High — recoverResult fabricates an ExecutionResult never persisted, contradicting H-I3; a rejected promise can be a CAS/lease race where another settlement owns the durable outcome. Fix: reload the durable result; if absent, invoke recovery or leave for the boot sweep — never synthesize a terminal result outside SessionStore.terminalize.
5. High — afterInsertInTx doing UPDATE runs SET usage is another unfenced session-row writer, violating SessionRunner-only ownership + §9 lease/version fencing. Fix: fold the usage patch into EventRecorder's existing fenced session CAS, not a hook-owned update.
6. High — initial routing-decision threading still unspecified: the API route persists the decision before startTask but startTask receives neither it nor its id. Fix: add routingDecisionRef to StartOptions; pass the id returned by the API's persistRoutingDecision; failover/handoff pass their own.
7. Medium — uq_execution_requests_task_attempt(task_id,attempt) isn't in the 005–007 identity model and blocks future parallel requests sharing one logical attempt; single-flight already makes it unnecessary. Fix: omit the index, or define globally-sequential-per-task attempt semantics and reconcile with the parallel cutover.
8. Medium — quota snapshots in the best-effort swallowed publish callback silently lose durable routing telemetry. Fix: write them in afterInsertInTx or a separately error-reported path; leave only SSE in publish.

### Claude's response (plan rev 3)

- #1/#2/#3 → **rejected the fix; removed Commit 8e entirely.** Flag-ON handoff/failover is now a fresh-prompt start (origin:"fresh", handoff-rendered prompt) = exact legacy parity. Wiring the handoff_envelopes claim protocol into the runner's start-ack transactions is test-only machinery today; wiring it means changing the Codex-clean runner core, the user's brief didn't ask for it, and progress-doc lines 160-163 explicitly say "Note it; don't force it." Logged as out-of-scope / own future phase. Removes findings #1/#2/#3 with the section.
- #4 → recoverResult no longer fabricates. Rejected promise + no persisted result → onSettled(null) → settleFromResult(...,null) parks the task WAITING_INPUT + notice; session row left for HarnessRecovery. Added a rejected-runner-recovery test.
- #5 → dropped the runs.usage write. afterInsertInTx now touches only `tasks` (envelope) + `quota_snapshots`, never `runs`. Telemetry reads execution_results.result.usage for harness rows (8e). No new session-row writer.
- #6 → StartOptions.routingDecisionRef added; computeRoute returns {explanation, routingDecisionId}; the /start route threads it; failover + manual handoff pass their own persistRoutingDecision id.
- #7 → omitted uq_execution_requests_task_attempt. attempt = MAX(execution_requests.attempt)+1 under the existing single-flight guard; a future parallel cutover defines its own semantics.
- #8 → quota snapshots moved into afterInsertInTx (transactional with the event insert, errors propagate) — out of the swallowed publish closure.

Net: 8e (envelope claim) deleted; 8f→8e (state vocab). Plan is smaller and lower-risk. Rev 3.

---

## Round 3 — Codex (VERDICT: REVISE)

Framing: "Deferring claim-protocol wiring is acceptable for a narrowly defined behavior-parity
cutover. However, the cited progress note does not quite support the stated rationale. Lines
160–163 say not to force the protocol before the orchestrator cutover; this plan **is** that
cutover. The deferral can still be chosen, but the progress document must explicitly establish
the new post-cutover deferral and its future acceptance criteria." 4 findings:

1. High — Manual harness handoff still falls through to the legacy checkpoint statement, which uses `current?.runId ?? null` (a legacy `ActiveRun`, `null` on the harness branch) → unscoped checkpoint. Fix: capture the harness source `sid` and either rely on the runner's session-scoped `cancel` checkpoint or call `checkpoints.create(taskId, sid, "handoff")`.
2. Medium — The plan says `approval.answered` durable events flow through SSE, but `ApprovalService.answer()` only updates the approval row; no source code emits such an event. Fix: remove that claim, or explicitly add a transactionally persisted `approval.answered` event (additive, out of scope).
3. Medium — The progress update only says to mark deferrals #1 and #2 resolved; it does not carry forward the newly chosen handoff-claim deferral. Fix: add a named standing deferral covering claim insertion, `start_ambiguous`, consumption, release, recovery, and the eventual switch from `origin:"fresh"` to `origin:"handoff"`, with acceptance criteria.
4. Low — The risk section says racing starts necessarily dedupe, but identical task/attempt IDs with different assistants produce a fingerprint conflict, not a dedupe. Fix: say identical requests dedupe while divergent requests conflict safely (`RequestFingerprintConflictError`).

### Claude's response (plan rev 4)

- #1 → 8c.3 manual-handoff bullet rewritten: capture `sid = liveSessionId(taskId)`; do **not**
  call the legacy `checkpoints.create(taskId, current?.runId ?? null, "handoff")` (`current` is
  a legacy `ActiveRun`, `null` here); the runner's `requestCancel` already left a session-scoped
  `cancel` checkpoint on `sid` that the `target` handoff-prompt render picks up via
  `checkpoints.latest(taskId)`; if a handoff-labelled checkpoint is still wanted, call
  `checkpoints.create(taskId, sid, "handoff")` with the captured `sid`.
- #2 → 8d `respondApproval` table row corrected: only `approval.requested` is a durable event
  (runner-emitted, flows through `publish`); `ApprovalService.answer()` writes the row only, no
  `approval.answered` event exists (parity — legacy `respondApproval` emits none either). Adding
  one is additive / out of scope.
- #3 → 8e step 4 expanded: adds a named standing deferral **"Harness handoff-envelope claim
  protocol (post-cutover)"** with a 6-point scope (a–f: `enterStartAmbiguous` co-commit,
  single-build + `claim()` insert, `markConsumed` co-commit, `release`/ambiguous handling,
  boot recovery, `origin:"fresh"`→`origin:"handoff"` switch) and acceptance criteria
  (`uq_live_successor`, crash→recoverable `start_ambiguous` never double-start, safety-net files
  green, new claim→consume→recover test). Explicitly notes it supersedes progress-doc lines
  160-163.
- #4 → Risk bullet reworded: identical requests dedupe (`recordRequest` + `start()` PREPARED
  idempotency); divergent requests (different assistant → same `erq_<taskId>_<attempt>` id,
  different `requestFingerprint`) hit `RequestFingerprintConflictError` on the second
  `recordRequest` — a safe loud conflict, not corruption. (`RequestFingerprintConflictError`
  confirmed present: `session-store.ts:31`.)

No scope change. Rev 4. All 4 findings were plan-precision / doc fixes, not design defects.

---

## Round 4 — Codex (VERDICT: REVISE)

"The four Round 3 findings are addressed." 1 material flaw + 1 doc cleanup:

- Critical — `reconcileOnBoot()` is not actually scoped to legacy tasks. It transitions every `tasks.runningTasks()` row to `FAILED`; only the subsequent `UPDATE runs` is filtered by `execution_request_id IS NULL` (`orchestrator.ts:107-117`). Therefore a stranded terminal Harness result is failed before the proposed result-settlement sweep, and the planned boot recovery test cannot pass. Fix: run the Harness result-settlement sweep first, then blanket-fail only tasks having a live legacy run and no current Harness-owned session/result.
- Minor documentation cleanup: the Key Decisions and Out-of-scope sections still attribute the post-cutover claim deferral directly to old lines 160–163; point them to the new named deferral that explicitly supersedes those lines.

### Claude's response (plan rev 5)

- Critical → 8c.3 `reconcileOnBoot` bullet rewritten from a one-line "add a sweep after the
  blanket-fail" into an explicit 3-step order: (1) `harnessRecovery.reconcileOnBoot()`
  unchanged (per-session §9 decisions, writes terminal `execution_results` rows for
  orphaned / completed-from-verifying, leaves `resume_offered` non-terminal); (2) **Harness
  result-settlement sweep** — non-terminal `RUNNING` + `harnessOwns` + `latestSessionId`
  terminal-with-result → `settleFromResult` from the durable result; (3) **legacy
  blanket-fail** — the existing `orchestrator.ts:107-117` loop, now *also* skipping any
  `harnessOwns(taskId)` task at the `tasks.transition` level (not just the `UPDATE runs`
  filter), so a Harness-owned task is never blanket-stomped — it is settled by step 2 or
  left `RUNNING` for the Control Plane / a later `settleFromResult(..., null)`. The 8d
  boot-strand recovery test tightened: assert the stranded Harness task settles to
  COMPLETED (not `FAILED`) while a co-seeded legacy in-flight run on another task still gets
  blanket-failed in the same call.
- Minor → Key Decision #6 and Out-of-scope bullet 2 now point to the named standing
  deferral "Harness handoff-envelope claim protocol (post-cutover)" (8e step 4) as the
  forward tracker; both note it explicitly supersedes progress-doc lines 160-163 (the
  pre-cutover "don't force it" guard no longer applies).

No design change. Rev 5. Critical was a plan-precision defect (the described scoping did not
match the code it was scoping); minor was a cross-reference cleanup.

---

## Round 5 — Codex (VERDICT: REVISE) — MAX_ROUNDS reached

"The two Round 4 findings are addressed for `RUNNING` tasks, but recovery still misses other
in-flight task states." 1 finding:

- High — The Harness settlement sweep only considers tasks in state `RUNNING`, while `runningTasks()` also includes `ROUTING` and `HANDING_OFF`, and failover can remain in `LIMIT_PAUSED` across the awaited checkpoint. Because step 3 skips every `harnessOwns(taskId)` task, a crash in `HANDING_OFF` or `LIMIT_PAUSED` can leave it stranded forever. Fix: query all nonterminal in-flight states (`RUNNING`, `ROUTING`, `LIMIT_PAUSED`, `HANDING_OFF`); settle ordinary durable results and explicitly park ambiguous handoff/failover states in `WAITING_INPUT` with a recovery notice. Add boot tests for Harness-owned `HANDING_OFF` and `LIMIT_PAUSED`.

### Claude's response (plan rev 6) — folded in, NOT re-reviewed (loop hit MAX_ROUNDS=5)

Valid — the Rev 5 fix introduced this by adding the `harnessOwns` skip in step 3 without
widening step 2 past `RUNNING`. 8c.3 `reconcileOnBoot` step 2 rewritten as a **Harness
in-flight sweep** over every state `runningTasks()` returns (`RUNNING`, `ROUTING`,
`HANDING_OFF`):
- terminal session + `execution_results` row → `settleFromResult` from the durable result
  (as before);
- otherwise (crashed mid-`ROUTING` / mid-`HANDING_OFF`, or a `resume_offered` session this
  pass can't act on) → `tasks.transition(WAITING_INPUT)` + a "manual restart required"
  notice — same park-don't-fabricate shape as `settleFromResult(..., null)`, never left
  in-flight.
- `LIMIT_PAUSED` is **not** a state `runningTasks()` returns, so neither the legacy loop nor
  this sweep ever observed it — a pre-existing legacy-shared gap, called out in the plan,
  unchanged this pass (widening `runningTasks()` would perturb the flag-OFF safety-net
  suites and is out of scope).
8d boot tests added: a Harness-owned `HANDING_OFF` task and a `ROUTING` task, each with no
terminal session result → parked `WAITING_INPUT`, never in-flight, never blanket-`FAILED`.
Flag-OFF behavior byte-identical (no harness rows ⇒ `harnessOwns` always false ⇒ step 2
no-op, step 3 == today's loop).

**MAX_ROUNDS=5 reached with VERDICT: REVISE.** Per the claudex-loop rule the interrogation
stops here. The R5 fix is a localized boot-recovery scoping change (states iterated + a park
branch), no design change, flag-OFF-inert; it ships in Rev 6 and is verified by the two new
8d boot tests during implementation rather than by another Codex round.
