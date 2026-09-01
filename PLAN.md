# Plan: Execution Harness — Orchestrator / Control-Plane Cutover (standing deferrals #1 + #2)

_Locked via claudex-loop — by Claude + itayosov. Rev 6 (post Codex Round 5 — MAX_ROUNDS=5
reached; the single R5 finding is folded in below but not re-reviewed by Codex)._

Worktree: `~/workspace/personal/ai-control-plan-harness`, branch `feat/execution-harness`.
Design source of truth: `../ai-control-plan-agentic-os/docs/execution-harness.md` rev 7
(§4 pipeline, §5 session lifecycle + RUN_STATES migration, §7 handoff, §8 reroute, §9
recovery, §10 module map) and `.../harness-implementation-plan.md`.
**Design is approved — implement it, do not redesign.** Single-process, local-first
(`DECISIONS.md`; §9 "single-process architecture"): migrations run at boot with the process
quiesced, `reconcileOnBoot` immediately follows and terminalizes any legacy in-flight rows —
there is no rolling / mixed-binary deploy window.

## Goal

Route **single-mode** task execution through `SessionRunner` instead of `Orchestrator`
driving adapters directly, behind `config.execution.harnessSingleMode` (default **OFF**; a
later commit flips it). The legacy consume/settle path stays intact and is selected whenever
the flag is OFF. Failover / retry / parallel-compare / verdict / task-machine logic stays in
`Orchestrator` (kept named `Orchestrator` this pass; cosmetic rename to `ControlPlane`
deferred). Land the `runs.state` vocabulary rewrite (deferral #2) as **`session_state` is the
authority for harness rows; `runs.state` is the authority for legacy rows; internal
consumers derive the effective state at read time** — no dual-writing, no drift. Cross-provider
handoff for flag-ON is a **fresh-prompt start** (`origin:{kind:"fresh"}` with a
handoff-rendered prompt) — exact parity with today's legacy handoff.

**Deferral (explicit, recorded post-cutover).** `docs/harness-implementation-progress.md`
lines 160-163 said the `handoff_envelopes` claim protocol
(`claim({requestId,insertRequest})` co-committed with the successor request insert,
`enterStartAmbiguous` co-committed with `PREPARED→STARTING`, `markConsumed` with the
first-event ack, `release` on pre-start failure — all currently **test-only** machinery) was
"only reachable once the runner drives the claim protocol — which is the orchestrator
cutover … Note it; don't force it." This pass **is** that cutover and elects to keep it
deferred: wiring it requires changing the Codex-clean `SessionRunner` core transaction path,
it is outside the user's brief for this pass, and flag-ON handoff has behavior parity
without it. Commit 8e records this as a **named standing deferral** with acceptance criteria
(see 8e step 4) — the deferral moves from "don't force it before the cutover" to "a
scoped follow-on phase after the cutover".

"Behavior preserved" is operational: `apps/api/test/characterization.test.ts`,
`orchestrator.test.ts`, `failover.test.ts`, `parallel.test.ts` stay **green and
byte-unedited** with the flag OFF. Flag-ON coverage lands in NEW files. Baseline after every
change: `pnpm typecheck && pnpm test && pnpm lint` — core 37, api 266, adapters 8, web 3,
lint clean. Do **not** build Phase 8 (remote runner). `FakeAdapter` + in-repo SQLite only.

## Phase-numbering reconciliation

The design's §5 shorthand "implementation plan phase 2" and `005_harness.sql`'s "Phase 3"
header predate the 8-phase `harness-implementation-plan.md`; both mean "the phase the write
path flips" = **this pass** (progress-doc: "the orchestrator cutover, post-Phase-7"). It is
design §10 migration steps 4 ("execution driving cutover") + 5 ("decision-side extraction"),
fused with the deferred destructive bits of steps 1–2. Nothing is renumbered. Commits below
are labelled 8a–8e only for this worktree's own commit log.

---

## Commit 8a — config flag (additive, zero behavior change)

1. `apps/api/src/config.ts`:
   - add `execution?: { harnessSingleMode?: boolean }` to `WorkspaceConfig`; `ResolvedConfig`
     inherits it.
   - `PERSONAL_DEFAULTS` / `WORK_DEFAULTS`: `execution: { harnessSingleMode: false }`.
   - `loadConfig`: `execution: { ...defaults.execution, ...file.execution }`, then an env
     override applied last — `AGENT_PLANE_HARNESS_SINGLE_MODE` in `{"1","true"}` → `true`,
     in `{"0","false"}` → `false`, unset → leave as merged.
   - `validate`: `typeof config.execution.harnessSingleMode === "boolean"` or push a problem.
   - `renderDefaultConfig`: the emitted doc carries `execution: { harnessSingleMode: false }`
     with a one-line comment.
2. `apps/api/test/config.test.ts`: default OFF; file `true` parses; env `=1` overrides file
   `false`; env `=0` overrides file `true`; non-boolean file value throws.
3. Nothing reads the flag yet.
4. `pnpm typecheck && pnpm test && pnpm lint`. Commit. Codex-review the diff (background).

## Commit 8b — pure extractions + one additive `EventRecorder` hook (legacy path unchanged)

1. New `apps/api/src/modules/harness/envelope-derivation.ts`:
   `export function deriveEnvelopeUpdate(envelope: TaskEnvelope, event: NormalizedEvent): boolean`
   — the exact phase-update + `switch` body from `Orchestrator.applyEvent` covering ONLY the
   envelope-shaping cases (`file.changed`→`changedFiles`, `test.result`→`testResults`,
   `message`→`completed` via `mergeTail`, `phase`), mutating `envelope` in place, returning
   `changed`. Move `mergeTail` here; `Orchestrator` imports it back.
   **Deliberately excluded** (run/adapter/DB side effects, not envelope shaping — kept in
   `Orchestrator.applyEvent` for legacy, handled explicitly bridge-side for flag-ON in 8c):
   `run.started` provider-ref persist, `usage.updated` (`runs.usage` write + `snapshotQuota`
   + `checkSoftThreshold`), `limit.approaching`/`limit.hit` (`snapshotQuota`, `run.limit`,
   soft-threshold checkpoint + notice).
2. `Orchestrator.applyEvent` delegates the envelope part to `deriveEnvelopeUpdate`; its
   observable behavior is unchanged (characterization + orchestrator suites prove it).
3. `apps/api/src/modules/harness/event-recorder.ts`: add ONE optional constructor param
   `afterInsertInTx?: (sessionId: string, committed: DurableEvent[], db: Db) => void`, invoked
   **inside** `recordBatch`'s transaction, after the per-batch `inTransaction` hook and before
   the session CAS. This lets flag-ON derive the `TaskEnvelope` transactionally with the
   event insert (closes Codex R1 #6 — no post-commit envelope write). The hook **must not
   write `runs`** (that column belongs to the fenced session CAS — Codex R2 #5); it only
   touches `tasks` (the envelope). Existing callers pass nothing; unchanged.
4. Unit tests: `envelope-derivation.test.ts` (each event kind → expected mutation; unrelated →
   `false`); extend `event-recorder.test.ts` with an `afterInsertInTx` case (runs in-tx; a
   throw rolls the batch back with the events).
5. Verify + commit + Codex-review.

## Commit 8c — control-plane bridge, flag-ON single-mode routing (flag still OFF by default)

### 8c.1 `SessionRunner.start()` — runner-owned handle (closes R1 #1, #25)

Add to `SessionRunner` (additive; `run()` stays for all existing callers/tests):

```ts
/** Synchronous setup, detached execution. The runner stays the ONLY session-row writer. */
start(request: ExecutionRequest): { sessionId: ExecutionSessionId; done: Promise<ExecutionResult> } {
  const { store } = this.deps;
  store.recordRequest(request);
  const session = store.createSession(request.executionRequestId);
  const sessionId = session.sessionId;
  if (session.state !== "PREPARED") {
    const existing = store.result(sessionId as string);
    if (existing) return { sessionId, done: Promise.resolve(existing) };
    return { sessionId, done: Promise.reject(new Error(`session ${sessionId} live without a result — recovery required`)) };
  }
  const lease = store.acquireLease(sessionId as string);
  if (!lease) return { sessionId, done: Promise.reject(new Error(`session ${sessionId} already leased`)) };
  const ctx = new RunContext(sessionId as string, request, lease, this);
  const done = (async () => { try { return await ctx.execute(); } finally { store.releaseLease(sessionId as string, lease); } })();
  return { sessionId, done };
}
```

`run()` is refactored to `const { done } = this.start(request); return done;` — one code path,
no duplication, `run()`'s current idempotency/último-result behavior preserved. `newExecutionSessionId`
is minted inside `createSession` (already the case) so the id is available synchronously here.

### 8c.2 `apps/api/src/modules/harness/control-plane-bridge.ts`

- `export interface BridgeStartInput { taskId; assistantId; attempt; prompt; workdir;
  worktree?: { repoPath; branch; worktreePath; baseRef }; approvalMode; maxRuntimeMs;
  routingDecisionRef }`
- `export function buildExecutionRequest(input): ExecutionRequest` — pure:
  - `executionRequestId: \`erq_${input.taskId}_${input.attempt}\`` (idempotency key, §2; no
    assistant in the id — assistant lives in the fingerprint — closes R1 #16)
  - `schemaVersion:1`, `taskId`, `attempt`, `assistantId`, `routingDecisionRef`
  - `runSpec`: identical to today's `startTask` build — `{ taskId, prompt, workdir,
    permissionPolicy:{mode:approvalMode}, env:{redactionRules:DEFAULT_REDACTION_RULES,
    maxRuntimeMs} }`
  - `policy`: `{ budget:{enforcement:"advisory"}, timeout:{hardMs:maxRuntimeMs},
    approval:{mode:approvalMode}, tools:{mode:"audit"}, checkpoint:{onSoftLimit:true},
    isolation:{required:"ambient"} }`
  - `context`: `worktree ? { worktree } : {}`
  - `verification: []`, `origin: { kind: "fresh" }` (always this pass — handoff parity note
    in the Goal), no `correlation`
- `export class HarnessBridge` — constructed in `buildServer`, injected into `Orchestrator`
  as a new optional last constructor arg. Fields: `{ runner: SessionRunner, store:
  SessionStore, approvals: ApprovalService }`. In-memory
  `planeOwnsTerminal = new Set<string>()` — the durable-parity of legacy's `run.handingOff`
  (single-process; §9). Methods:
  - `start(input: BridgeStartInput, onSettled: (r: ExecutionResult | null, sessionId: string)
    => void): { runId: string }` — `const req = buildExecutionRequest(input); const
    { sessionId, done } = this.runner.start(req); done.then(r => onSettled(r, sessionId))
    .catch(err => { log.error(err); onSettled(store.result(sessionId) ?? null, sessionId); });
    return { runId: sessionId }`. On a rejected promise with **no persisted result**,
    `onSettled` is called with `null` — `settleFromResult` then parks the task in
    `WAITING_INPUT` with a notice and leaves the session row for `HarnessRecovery` on next
    boot. **Nothing is ever fabricated** outside `SessionStore.terminalize` (closes R2 #4;
    reverses R1 #4's "synthesise" wording).
  - `markPlaneOwnsTerminal(sessionId)` / `consumePlaneOwnsTerminal(sessionId): boolean` —
    set/test-and-clear.
  - `requestCancel(sessionId)` → `store.requestCancel(sessionId)` (durable intent; the
    runner's loop + heartbeat observe it → terminal `CANCELLED` + checkpoint attempt, §9).
  - `answerApproval(sessionId, providerRequestId, approved)` → `approvals.answer(sessionId,
    providerRequestId, approved ? "approved":"denied", "user")`. The runner's
    `AWAITING_APPROVAL` poll delivers it via `adapter.send`.
  - `liveSessionId(taskId): string | undefined` — the newest `runs.id` for the task with
    `execution_request_id IS NOT NULL AND ended_at IS NULL`.
  - `latestSessionId(taskId): string | undefined` — newest `runs.id` with
    `execution_request_id IS NOT NULL` regardless of `ended_at` (for control ops that must
    win the race against `settleFromResult` — closes R1 #12).

### 8c.3 `Orchestrator` — all new branches guarded by `this.harnessRouting(taskId, options)`

`private harnessRouting(taskId, options): boolean` = `!!this.config.execution?.harnessSingleMode
&& !options.parallel && this.tasks.get(taskId)?.mode !== "compare" && this.tasks.get(taskId)?.mode
!== "race"`. Parallel/compare/race stay legacy this pass (explicit non-goal).

`private harnessOwns(taskId): boolean` = the newest `runs` row for the task has
`execution_request_id IS NOT NULL` (a task, once harness-routed, keeps all its control ops on
the harness branch even in the post-terminal / pre-settle window — closes R1 #12).

- **`startTask`**: after prompt render + worktree resolution + task→`RUNNING` + `publishState`,
  if `harnessRouting`:
  - `attempt = COALESCE(MAX(attempt) FROM execution_requests WHERE task_id=?, 0) + 1`
    (harness requests only, not run-count — closes R1 #15/#16). `startTask` for a
    non-parallel task is already single-flighted by the `isActive` guard, so the
    read-then-insert is safe. **No `UNIQUE(task_id, attempt)` index** — it would break the
    future parallel/compare cutover (N requests per logical attempt) and single-flight
    already covers this pass (closes R2 #7). A future parallel cutover defines its own
    attempt semantics.
  - `routingDecisionRef = String(options.routingDecisionRef ?? <id from a fresh
    persistRoutingDecision for this start>)` — see 8c.5.
  - `origin` is always `{ kind:"fresh" }` (handoff = fresh-prompt start, Goal note).
  - `this.harnessBridge.start({...}, (r, sid) => void this.settleFromResult(taskId,
    assistantId, sid, r))`; return `{ runId }`.
  - **Skip** the legacy `runs` INSERT, `ActiveRun` map entry, `adapter.start/resume`,
    `consume()`. `SessionStore` owns the `runs` row for this session.
- **`isActive(taskId)`**: `this.runsOfTask(taskId).length > 0 || this.harnessBridge?.liveSessionId(taskId) !== undefined`
  (closes R1 #10 — duplicate-start guard, `waitForSettled`).
- **`shutdown`**: after cancelling `ActiveRun`s, also `requestCancel` every
  `liveSessionId` task's session and wait for `liveSessions()` of this process to drain
  (bounded by `timeoutMs`) (closes R1 #10).
- **`createCheckpoint(taskId)`**: if `harnessOwns` → pass `this.harnessBridge.latestSessionId(taskId)`
  as the sessionId to `checkpoints.create` (session-scoped, closes R1 #11).
- **`cancelTask`**: if `harnessOwns` → for each live session `this.harnessBridge.requestCancel(sid)`
  **first** (durable intent), THEN `tasks.transition(taskId,"CANCELLED")` + `publishState`;
  the runner settles the session; `settleFromResult` sees the task already terminal and
  no-ops the task transition (closes R1 #3). Legacy branch (ActiveRun) unchanged — its
  tests pin the current order.
- **`respondApproval`**: if `harnessOwns` → `sid = liveSessionId(taskId)`; find the matching
  `approvals.pending(sid)` row by `provider_request_id === requestId`;
  `this.harnessBridge.answerApproval(sid, requestId, approved)`. Else legacy loop.
- **`handoff` (manual)**: if `harnessOwns` → capture `sid = liveSessionId(taskId)`,
  `markPlaneOwnsTerminal(sid)`, `requestCancel(sid)`, `await this.waitUntilSessionTerminal(sid)`,
  then `routeFor` → `startTask(target,{trigger:"handoff", routingDecisionRef:<id>, ...})`.
  The checkpoint: **do not call the legacy `checkpoints.create(taskId, current?.runId ?? null,
  "handoff")`** — `current` is a legacy `ActiveRun` and would be `null` here, producing an
  unscoped checkpoint (Codex R3 #1). The runner's `requestCancel` already produced a
  session-scoped `cancel` checkpoint on `sid`; the handoff-prompt render for `target` reads
  `this.checkpoints.latest(taskId)` which now resolves to it. If a fresh handoff-labelled
  checkpoint is still wanted, call `checkpoints.create(taskId, sid, "handoff")` with the
  captured harness `sid`. `settleFromResult` for the cancelled source sees `planeOwnsTerminal`
  set → does NOT transition the task (closes R1 #2).
- **`reconcileOnBoot`** — rewritten. The current loop (`orchestrator.ts:107-117`) fails
  **every** `runningTasks()` row via `tasks.transition(FAILED)` and only the follow-up
  `UPDATE runs` is scoped to `execution_request_id IS NULL`; a stranded terminal Harness
  result would be blanket-failed before any sweep could settle it, and the task-terminal
  guard in `settleFromResult` would then no-op the real outcome (Codex R4 #1). The
  task-level transition must be scoped to legacy-owned tasks, and the Harness result sweep
  must run first. New order:
  1. `await this.harnessRecovery?.reconcileOnBoot()` — unchanged. Per-session decides every
     live Harness session (§9): writes a terminal `execution_results` row for the
     orphaned / completed-from-verifying cases, leaves `resume_offered` sessions
     non-terminal for the Control Plane.
  2. **Harness in-flight sweep** — over **every** task `runningTasks()` returns
     (`state IN ('RUNNING','ROUTING','HANDING_OFF')` — Codex R5) where `harnessOwns(taskId)`:
     - `latestSessionId(taskId)` resolves to a terminal session with an `execution_results`
       row → `settleFromResult(taskId, assistantId, sid, result)` from the durable result
       (recovers a task stranded by a crash between session terminalization and the detached
       callback; also settles the sessions step 1 just terminalized) (closes R1 #4).
     - otherwise (crashed mid-`ROUTING` / mid-`HANDING_OFF`, or a `resume_offered` session
       this pass cannot act on — provider `resume()` is out of scope) →
       `tasks.transition(taskId, "WAITING_INPUT")` + notice `"execution harness task
       recovered at boot in <state> with no terminal session result — manual restart
       required"`. Same park-don't-fabricate shape as `settleFromResult(..., null)`; never
       left in an in-flight state (Codex R5 — the step-3 skip must not create permanent
       limbo). (`LIMIT_PAUSED` is **not** in `runningTasks()` so neither the legacy loop nor
       this sweep ever saw it — pre-existing legacy-shared gap, unchanged this pass.)
  3. **Legacy blanket-fail** — the existing loop over `runningTasks()`, now also skipping any
     task where `harnessOwns(taskId)` (every such task is handled by step 2). For the
     remaining legacy-live tasks, unchanged: `tasks.transition(FAILED)` + `UPDATE runs SET
     state='ENDED_ERROR', ended_at=? WHERE task_id=? AND ended_at IS NULL AND
     execution_request_id IS NULL`. Flag-OFF (no harness rows) `harnessOwns` is always
     false, so step 2 is a no-op and this is byte-identical to today.

### 8c.4 `settleFromResult(taskId, assistantId, sessionId, result: ExecutionResult | null)`

Guards first: `if (this.harnessBridge!.consumePlaneOwnsTerminal(sessionId)) return;`
`const row = this.tasks.get(taskId); if (!row || isTerminal(row.state)) return;`
`if (sessionId !== this.harnessBridge!.latestSessionId(taskId)) return;` (stale/superseded
result — closes R1 #5). Every `tasks.transition` wrapped in try/catch (legacy pattern).

**`result === null`** (runner promise rejected with no persisted `execution_results` row —
e.g. lease-acquisition failure, an unexpected throw before `finalize`): `tasks.transition(
taskId, "WAITING_INPUT")` + notice `"execution harness error on session <id> — recovery
required"`; the session row is left non-terminal for `HarnessRecovery.reconcileOnBoot()` on
the next boot. Nothing about the session is fabricated (closes R2 #4).

**Result → plane decision table** (closes R1 #13, #14; mirrors `settleRun` +
`session-runner.ts` `observe()` normalizations):

| `result.outcome` | `yield.kind` / `failure.kind` | condition | plane action |
|---|---|---|---|
| `completed` | — | `result.verification && !result.verification.passed` | `tasks.transition("WAITING_INPUT")` + notice "verification failed — awaiting your call" (defensive; this pass sends `verification:[]` so unreachable — full verdict policy is out of scope) |
| `completed` | — | else | `tasks.transition("COMPLETED")` + `publishState` (runner already attempted the completion checkpoint) |
| `yielded` | `limit` | `triggerEnabled("quota") && config.failover.auto` | `failoverTask(taskId, assistantId, "quota", <reason>, sessionId)` |
| `yielded` | `limit` | else | `cooldowns.penalize(assistantId,"limit",...)`; `tasks.transition("WAITING_INPUT")`; notice (parity with legacy `limited` non-failover branch) |
| `yielded` | `reroute` | `triggerEnabled("provider_unavailable") && config.failover.auto` | `failoverTask(taskId, assistantId, "failure", <reroute reason from result.yield.detail.reason>, sessionId)` |
| `yielded` | `reroute` | else | `tasks.transition("WAITING_INPUT")` + notice |
| `yielded` | `handoff` | — | `tasks.transition("WAITING_INPUT")` + notice (no automatic Harness-side target, §8) |
| `failed` / `timed_out` | `failure.kind === "provider_fault"` | `failure.retryable && triggerEnabled("provider_unavailable") && config.failover.auto` | `failoverTask(taskId, assistantId, "failure", <reason>, sessionId)` |
| `failed` / `timed_out` | `provider_fault` non-retryable, OR `auth` / `quota` / `budget_exceeded` / `tool_denied` / `workspace` / `policy_unenforceable` / `internal` / `orphaned` | — | `tasks.transition("FAILED")` + `publishState` (parity: legacy only fails over on an observed provider error; auth is normalized non-retryable, a denied approval never reaches here as a provider fault) |
| `cancelled` | — | — | task already `CANCELLED` via `cancelTask`; guard no-ops. If somehow not terminal → `tasks.transition("CANCELLED")` + `publishState` |

### 8c.5 supporting refactors

- `failover(run: ActiveRun, trigger)` → **`failoverTask(taskId, assistantId,
  trigger:"quota"|"failure", reasonText, fromRunOrSessionId)`**. Body unchanged (checkpoint
  "handoff", `cooldowns.penalize`, `routeFor`, `persistRoutingDecision`, `LIMIT_PAUSED` →
  `HANDING_OFF`, `handoffs` row with `from_run_id = fromRunOrSessionId`, `startTask(target,
  {trigger:"handoff", routingDecisionRef:<id>, ...})`). Legacy `settleRun` calls it with
  values pulled from `run`; `settleFromResult` calls it directly. It already has the routing
  `explanation` locally, so it passes its own `persistRoutingDecision` id down to `startTask`.
- `router.ts` `persistRoutingDecision(db, taskId, explanation): number` — return
  `Number(info.lastInsertRowid)`. The 3 existing callers may ignore the return (closes R1 #17).
- `StartOptions` gains `routingDecisionRef?: string`. The `/api/tasks/:id/start` route:
  `computeRoute` returns `{ explanation, routingDecisionId }` (it already calls
  `persistRoutingDecision` internally — surface the id); the route passes
  `routingDecisionRef: String(routingDecisionId)` into `startTask`. Failover / manual handoff
  pass their own. `startTask` flag-ON uses `options.routingDecisionRef`, falling back to a
  fresh `persistRoutingDecision` only if absent (closes R2 #6).
- `waitUntilSessionTerminal(sessionId, timeoutMs=10_000)` — poll `store.get(sessionId).state`
  for `isSessionTerminal`.

### 8c.6 `buildServer` — one composition root (closes R1 #24)

Construct once: `SessionStore`, `ApprovalService`, `EventRecorder` (with the envelope
`afterInsertInTx` + post-commit `publish`, 8d), `SessionRunner` (deps:
store, recorder, approvals, `checkpoints` [CheckpointService ≅ RunnerCheckpoints], `registry`
[≅ {adapter,manifest}], `softThresholdPct: config.failover.softThresholdPct`; **no `handoff`
dep** — the envelope-yield path is out of scope, so the runner never commits an envelope),
`HarnessBridge`. Inject the bridge into `Orchestrator`. `HarnessRecovery` reuses the same
`SessionStore`/`ApprovalService`. **Startup assertion**: `if (config.execution?.harnessSingleMode
&& !harnessBridge) throw new Error("harnessSingleMode ON but bridge not wired")`. When
`deps.orchestrator` is supplied (tests), the test owns wiring — the assertion still runs
against whatever bridge the test passed.

### 8c.7 verify

`pnpm typecheck && pnpm test && pnpm lint` — the 4 safety-net files + everything else green,
byte-unedited (flag OFF, nothing calls the bridge). Commit + Codex-review.

## Commit 8d — flag-ON SSE + envelope + side-effect parity

**Every legacy `applyEvent` / `consume()` side effect, with its flag-ON disposition:**

| Legacy effect (`orchestrator.ts`) | Flag-ON disposition |
|---|---|
| per-event `bus.publish(taskId, {kind:"event", event:{...safeEvent, seq}})` | **reproduced** — `EventRecorder.publish` post-commit callback: `for (const {seq,event} of durableEvents) bus.publish(taskId,{kind:"event",event:{...event,seq}})` — exact frame shape, pinned by a parity test (closes R1 #8) |
| `applyEvent` envelope shaping (changedFiles/testResults/completed/phase) | **reproduced transactionally** — `EventRecorder.afterInsertInTx`: `deriveEnvelopeUpdate(tasks.envelope(taskId), event)` → `tasks.saveEnvelope` inside the event tx (closes R1 #6) |
| `run.started` → persist `provider_session_ref` | **already done by the runner** — `store.ackHandle` CASes `providerSessionRef` (§9 step 3). Parity test asserts the column is set |
| `usage.updated` → `UPDATE runs SET usage` | **NOT reproduced on the session row** — writing `runs` outside the fenced session CAS would create a second unfenced writer (Codex R2 #5). Telemetry instead reads `execution_results.result.usage` for harness rows (8e). In-flight per-row usage is not needed (telemetry only scores terminal runs) |
| `usage.updated`/`limit.approaching` → `snapshotQuota` (feeds router eligibility/cooldowns) | **reproduced in `afterInsertInTx`** (transactional with the event insert, errors propagate — NOT in the swallowed `publish` closure, Codex R2 #8) via a shared `snapshotQuota(db, assistantId, event)` extracted from `Orchestrator`. `quota_snapshots` has no constraints beyond column types, so an INSERT failing there is genuinely exceptional and failing the batch loud is correct. Only writes `quota_snapshots`, never `runs` |
| `limit.approaching`/soft-threshold → eager checkpoint + `notice` | **owned by the Harness `BudgetGuard`/`QuotaGuard`** (§4) — the guard emits `checkpoint`/`YIELDED(limit)` directives. The operator `notice` text is **not** reproduced (intentional divergence — the durable `guard.decision` event + Cockpit render it). Documented + asserted: a `[FAKE:LIMIT]` flag-ON run produces a `guard.decision`/checkpoint, task fails over |
| `limit.hit` → `run.limit`, drives failover on drain | **reproduced via the result** — runner yields `YIELDED(limit)`; `settleFromResult` limit row above |
| `error` event → `run.sawError` | **reproduced via the result** — runner sets `failure.kind` |
| task-state `bus.publish({kind:"state",...})` on transitions | **reproduced** — `settleFromResult`/`startTask` call `publishState` on task transitions; additionally the `publish` callback emits a deduped `{kind:"state", state:{ state: <task state>, phase, assistantId }}` when the derived task phase changes, so the live view tracks phase mid-run (parity with legacy `applyEvent` phase push). Session-level states (STARTING/AWAITING_APPROVAL/VERIFYING/YIELDED) remain observable via the Phase-6 `/api/sessions/:id` durable endpoint — matches legacy, which never emitted per-run state (closes R1 #22 as far as parity requires) |
| `respondApproval` relay | **reproduced** — durable `ApprovalService` (8c.2). The runner emits an `approval.requested` durable event that flows through the `publish` hook to SSE. `ApprovalService.answer()` only updates the approval row — **no `approval.answered` durable event exists** (parity: legacy `respondApproval` emits none either, it just calls `adapter.send`). Resume is observable via the events that follow + the durable `/api/sessions/:id`. Adding a transactional `approval.answered` event is additive and out of scope (Codex R3 #2) |

`EventRecorder.publish` (post-commit, best-effort, already swallows throws) receives
`(sessionId, durableEvents)`; the callback resolves `taskId` from a `sessionId→taskId` cache
and does the **SSE** work only. `afterInsertInTx` (transactional, writes `tasks` +
`quota_snapshots`, never `runs`) does **task-envelope derivation** and **quota snapshots**.
Both wired only for the flag-ON `EventRecorder` built in `buildServer`.

**Tests** — new `apps/api/test/harness/cutover.test.ts` (real `SessionRunner` in `buildServer`,
`FakeAdapter`, flag ON):
- happy path → task `COMPLETED`; exactly one `runs` row with `execution_request_id` +
  `session_state='COMPLETED'`; an `execution_results` row with a non-empty `usage`; SSE
  `{kind:"event"}` frames captured off the bus with the exact legacy shape; envelope
  `changedFiles`/`testResults` populated; monotonic seq; `provider_session_ref` set.
- `[FAKE:APPROVAL]` → `approval.requested` SSE frame; `respondApproval(...,true)`→`COMPLETED`;
  `(...,false)`→`FAILED`, no failover (parity with `characterization.test.ts`).
- `cancelTask` mid-run → task `CANCELLED`, session terminal `CANCELLED`, `cancel` checkpoint
  attempt on the result; `settleFromResult` no-ops the task.
- `[FAKE:LIMIT]` → `failoverTask` fires, a second session on assistant B, task `COMPLETED`, a
  `handoffs` row `trigger='quota'`. (No `handoff_envelopes` row — handoff is a fresh-prompt
  start this pass.)
- `[FAKE:FAIL]` + `failover.auto:false` → task `FAILED`, one session row.
- manual `handoff(taskId, B)` mid-approval → durable cancel of A, `planeOwnsTerminal`
  honored (task NOT cancelled), a fresh session on B with a handoff-rendered prompt, task
  ends `RUNNING`, both sessions present, a `handoffs` row `trigger='manual'`.
- boot-strand recovery: seed a terminal harness session + `execution_results` row under a
  `RUNNING` task, call `reconcileOnBoot` → task settles to the result's outcome (COMPLETED
  for a completed result), **not** blanket-`FAILED` — with a co-seeded legacy in-flight run
  on another task in the same call to prove the legacy blanket-fail still fires for that one
  (Codex R4 #1).
- boot recovery of a Harness-owned task in `HANDING_OFF` and one in `ROUTING`, each with **no**
  terminal session result → `reconcileOnBoot` parks each in `WAITING_INPUT` + notice, never
  left in-flight, never blanket-`FAILED` (Codex R5 — the `harnessOwns` skip must not strand
  non-`RUNNING` in-flight states).
- rejected-runner recovery: force `SessionRunner.start` to reject with no `execution_results`
  row → `settleFromResult(..., null)` → task `WAITING_INPUT` + notice, session row untouched.

New `apps/api/test/harness/characterization-harness.test.ts` — re-runs start→COMPLETED,
denied-approval→FAILED, hard-limit→failover→COMPLETED with the flag ON, asserting the **same
task-level outcomes** (task states, `handoffs.trigger`, no-failover-on-denial). Run-row
assertions use `session_state`. The 4 original files are untouched (closes R1 #23).

Verify + commit + Codex-review.

## Commit 8e — `runs.state` vocabulary authority (deferral #2), read-time derivation

Closes R1 #19, #20, #21 — no dual-write, no drift.

1. Internal legacy-vocab consumers derive the effective state at read time:
   `CASE WHEN r.execution_request_id IS NULL
      THEN CASE r.state WHEN 'ACTIVE' THEN 'RUNNING' WHEN 'ENDED_OK' THEN 'COMPLETED'
                        WHEN 'ENDED_ERROR' THEN 'FAILED' ELSE r.state END
      ELSE r.session_state END AS state`
   - `apps/api/src/modules/telemetry.ts`: apply in the `scores()` SELECT; loop test becomes
     `row.state === "COMPLETED"`. Also `LEFT JOIN execution_results er ON er.session_id = r.id`
     and `COALESCE(r.usage, json_extract(er.result, '$.usage'))` for the token rollup so
     harness sessions contribute usage (closes R1 #7).
   - `apps/api/src/modules/orchestrator.ts` `comparison()`: apply in the `runs` SELECT;
     returned `state` is now unified vocab. (Parallel/compare stays legacy this pass, so
     harness rows are rare here, but the derivation is correct either way.)
   - `apps/web/src/TaskDetail.tsx:237`: renders `r.state` from the `comparison()` payload —
     now unified vocab; confirm the label/badge handles `RUNNING`/`COMPLETED`/`FAILED` (task
     states already use this vocab — `StateBadge` is fed task state elsewhere, so yes). No
     web logic change; a one-line comment noting the vocab source.
2. `apps/api/src/db/migrations/008_state_vocab_authority.sql` — **consistency backfill only,
   nothing depends on it being current**:
   ```sql
   -- Cosmetic/observability backfill: bring drifted legacy session_state in line
   -- with the frozen authoritative runs.state (execution-harness.md §5). Internal
   -- reads derive the effective state at read time (execution_request_id IS NULL
   -- => map(state)); this UPDATE is not load-bearing. Restricted to the five
   -- known legacy values — an unknown state is left as-is to surface, not masked.
   UPDATE runs SET session_state = CASE state
     WHEN 'STARTING' THEN 'STARTING' WHEN 'ACTIVE' THEN 'RUNNING'
     WHEN 'ENDED_OK' THEN 'COMPLETED' WHEN 'ENDED_ERROR' THEN 'FAILED'
     WHEN 'CANCELLED' THEN 'CANCELLED' END
   WHERE execution_request_id IS NULL AND state IN
     ('STARTING','ACTIVE','ENDED_OK','ENDED_ERROR','CANCELLED');
   ```
   No `UNIQUE(task_id, attempt)` index (Codex R2 #7 — it would block the future
   parallel/compare cutover). The legacy write path is **unchanged** — it keeps writing only
   `runs.state`; that is now explicitly the authority for legacy rows and read-time
   derivation handles it.
3. Tests:
   - `migration.test.ts`: (a) legacy-backfill fixture — post-001 `runs` rows in each legacy
     state, migrate through 008, assert `session_state` matches the §5 map for
     `execution_request_id IS NULL`; (b) harness-row-preservation fixture — post-005 seeded
     harness rows, assert 008 does not touch them; (c) an unknown legacy `state` value is
     left unchanged (not mapped to anything).
   - telemetry test: a completed harness session (`session_state='COMPLETED'`, an
     `execution_results` row with usage) counts toward `successRate` and contributes tokens.
   - `server.test.ts` boot assertion: `legacy-run` still `state='ENDED_ERROR'` (unchanged);
     no `session_state` assertion added for legacy rows (it is non-authoritative).
4. `docs/harness-implementation-progress.md`:
   - Mark standing deferrals #1 and #2 **resolved**; add the 8a–8e commit rows + their
     follow-ups.
   - Record the deferred cosmetic `Orchestrator`→`ControlPlane` rename and the deferred
     provider-`resume()` gap.
   - **Add a new named standing deferral: "Harness handoff-envelope claim protocol
     (post-cutover)".** Body: the orchestrator cutover (this pass) routes flag-ON
     handoff/failover as a fresh-prompt start with `origin:{kind:"fresh"}`. The landed but
     still test-only `handoff_envelopes` claim machinery is deliberately not wired. A
     scoped follow-on phase must:
     (a) co-commit `enterStartAmbiguous` with `PREPARED→STARTING` in `SessionStore`;
     (b) build the successor `ExecutionRequest` once and insert it via
     `handoff.claim(envelopeId, {requestId, insertRequest})` in the claim's own tx;
     (c) co-commit `markConsumed` with the successor's first-event ack;
     (d) `release` the envelope on pre-start failure, `enterStartAmbiguous` on an
     ambiguous start;
     (e) recover `claimed`/`start_ambiguous` envelopes in `HarnessRecovery.reconcileOnBoot`;
     (f) switch the flag-ON handoff/failover path from `origin:{kind:"fresh"}` to
     `origin:{kind:"handoff", envelopeId}` and render the successor prompt from the
     committed envelope.
     **Acceptance criteria:** `uq_live_successor` enforces one live successor per origin
     envelope; a crash between claim and first-event leaves a recoverable
     `start_ambiguous` row, never a double-start; the four safety-net test files stay
     green; a new test drives claim → consume → recover. This deferral supersedes
     progress-doc lines 160-163 ("don't force it before the cutover") — the cutover has
     landed; this is now its own phase.

Verify + commit + Codex-review.

## Per-commit Codex review

After each of 8a–8e: `git show <sha> > /tmp/p.diff`; background
`codex exec --sandbox read-only --skip-git-repo-check -c model_reasoning_effort=low
-o /tmp/review-<c>.txt "<prompt naming the phase + relevant §>"` with `run_in_background:true`;
poll `until [ -s /tmp/review-<c>.txt ]; do sleep 5; done`. Fold findings into a follow-up
commit per phase, as Phases 4–7.

## Key decisions & tradeoffs

1. **Read-time effective-state derivation, not dual-write** (revised after R1 #19/#21).
   `runs.state` is authoritative for legacy rows, `session_state` for harness rows;
   consumers `CASE` on `execution_request_id IS NULL`. Kills the drift class entirely, needs
   no legacy-write-path change, makes migration 008 non-load-bearing. Cost: a `CASE`
   expression in 3 SELECTs.
2. **`SessionRunner.start()` handle** (R1 #1/#25) — the runner remains the sole session-row
   writer; the bridge never touches `runs`. `run()` becomes `start().done`.
3. **In-memory `planeOwnsTerminal` set** for cancel/manual-handoff vs `settleFromResult`
   races (R1 #2/#5) — the durable-queue alternative is rejected as over-engineering for a
   single-process prototype; this is the exact shape of legacy's shipped `run.handingOff`
   flag, plus a boot-reconcile sweep (8c.3) for the crash window.
4. **`harnessOwns` = "newest run row is a harness row"**, not "a session is live" (R1 #12) —
   control ops stay on the harness branch through the post-terminal/pre-settle window.
5. **Full result→plane decision table** (R1 #13/#14) matching the runner's actual
   normalizations (`auth` non-retryable, `quota` retryable, `capability_missing`→reroute,
   generic provider error→`provider_fault`). Failover fires only on retryable
   `provider_fault` or `YIELDED(limit|reroute)` under `failover.auto` + trigger policy —
   parity with legacy "observed provider error" gating.
6. **Flag-ON handoff/failover = fresh-prompt start** (`origin:"fresh"`, handoff-rendered
   prompt) — exact legacy parity. Wiring the `handoff_envelopes` claim protocol into the
   runner's start-ack transactions is **rejected for this pass** (Codex R2 #1/#2/#3 wanted
   it): it is test-only machinery today, wiring it means changing the Codex-clean runner's
   core transaction path, and the user's brief did not ask for it. Tracked going forward by
   the named standing deferral **"Harness handoff-envelope claim protocol (post-cutover)"**
   (8e step 4, scope a–f + acceptance criteria), which explicitly supersedes progress-doc
   lines 160-163 — that "don't force it before the cutover" guard no longer applies now the
   cutover has landed.
7. **Transactional task-envelope enrichment + quota snapshots** via a new additive
   `EventRecorder.afterInsertInTx` hook (R1 #6, R2 #8) — `tasks`/`quota_snapshots` only,
   never `runs`; strictly better than legacy's post-commit non-transactional writes. The
   soft-threshold operator `notice` is an accepted divergence (the Harness guard path +
   durable `guard.decision` replace it, R1 #9).
8. **No new `runs` writer** (R2 #5). `runs.usage` is not written on the flag-ON path;
   telemetry reads `execution_results.result.usage` for harness rows. The only session-row
   writes remain the runner's fenced CAS via `SessionStore`/`EventRecorder`.
9. **`recoverResult` never fabricates** (R2 #4). A rejected runner promise with no persisted
   result → `settleFromResult(..., null)` parks the task `WAITING_INPUT` + notice; the
   session row is left for `HarnessRecovery` on next boot.
10. **Keep the class named `Orchestrator`**, **no `authority`/`verifyIsolation` wired
    flag-ON** — parity-preserving; isolation-tier enforcement and the cosmetic rename are
    separate.
11. **`persistRoutingDecision` returns its row id** (R1 #17, R2 #6) threaded via
    `StartOptions.routingDecisionRef` from `computeRoute` / failover / manual handoff — real
    routing→session audit join instead of a fabricated string.
12. **`attempt` from `MAX(execution_requests.attempt)+1`** under the existing single-flight
    guard (R1 #15/#16, R2 #7) — no unique index (would block the future parallel cutover),
    not a run-count that mixes legacy/parallel/cancelled rows.

## Toolchain

No installed skill pack matches (control-plane / SQLite / TS refactor). Section empty.

## Assumptions

_Confirmed ledger — sources in parentheses._

1. This pass = design §10 steps 4+5 + deferred destructive bits of 1–2; nothing renumbered
   (`execution-harness.md` §5/§10, `005_harness.sql` header, progress-doc deferrals).
2. Single-process, local-first: migrations at boot, process quiesced, `reconcileOnBoot`
   terminalizes legacy in-flight rows immediately — no rolling-deploy window (`DECISIONS.md`,
   §9, `index.ts:9-12`).
3. `SessionRunner.run()` already `recordRequest` + `createSession` + lease + execute; `start()`
   just exposes the synchronous prefix. Idempotent on an already-recorded PREPARED session
   (`session-runner.ts:112-139`).
4. `SessionRunner` never writes `runs.usage` — only in-memory tokens → `execution_results`
   at finalize (`session-runner.ts:594-604,900-907`). Flag-ON telemetry therefore reads
   `execution_results.result.usage` for harness rows (8e); no new `runs` writer is added.
5. Runner normalizations: `auth_failed`→`{auth,retryable:false}`, `quota_exhausted`→
   `{quota,retryable:true}`, `capability_missing`/`model_unsuitable`→`YIELDED(reroute)`,
   generic error→`provider_fault` (`session-runner.ts:606-625`).
6. `runs.state` has no CHECK constraint (`001_init.sql:72`). Legacy path updates `state` but
   never `session_state` post-insert (`orchestrator.ts:196,404`).
7. `SessionStore.transition`/`terminalize` dual-write `session_state`+`state`(legacy-mapped)
   for harness rows — those rows' `session_state` is always correct
   (`session-store.ts:275-276`).
8. `/api/sessions/*` already serve `sessionState` primary + `state` legacy, `JOIN
   execution_requests` (harness rows only) — untouched (`server.ts:403-455`).
9. `EventRecorder` has an optional post-commit `publish` never wired by `RunnerDeps`; a
   throwing `publish` is swallowed (`event-recorder.ts:52-58,120-125`). 8b adds
   `afterInsertInTx`.
10. `SessionRunner` does no `TaskEnvelope` enrichment and no `TaskEventBus` publish
    (`session-runner.ts`; cf `orchestrator.ts:245-363`).
11. `startTask` returns `{runId}` sync; `consume()` detached (`orchestrator.ts:219`).
12. Legacy control ops use the in-memory `active` map; harness equivalents:
    `store.requestCancel` (`session-store.ts:397`), `ApprovalService.answer`
    (`approval-service.ts:102`).
13. The `handoff_envelopes` claim protocol (`enterStartAmbiguous`/`markConsumed`/`release`,
    `claim({requestId,insertRequest})`) is **test-only** — no `src/` code path calls it; the
    runner does plain `SessionStore.transition` for PREPARED→STARTING→RUNNING. Wiring it is
    deferred per progress-doc lines 160-163 ("Note it; don't force it"). Flag-ON handoff =
    fresh-prompt start (`handoff.ts:145-233`, grep of `src/`).
14. `persistRoutingDecision` returns void; 3 callers, all can ignore a new return
    (`router.ts:160-164`; `orchestrator.ts:465,534`; `server.ts:95`).
15. Config flag `WorkspaceConfig.execution.harnessSingleMode`, default OFF, env-overridable,
    threaded via `ResolvedConfig` (`config.ts`).
16. `HarnessRecovery` already wired into `reconcileOnBoot` + `buildServer`
    (`server.ts:56-64`, `orchestrator.ts:101-121`).
17. Baseline core 37 / api 266 / adapters 8 / web 3, lint clean; flag-ON tests in new
    `apps/api/test/harness/` files; `FakeAdapter` + in-repo SQLite only.

## Risks / open questions

- **`SessionRunner` deps in `buildServer` for flag-ON.** store, recorder, approvals,
  checkpoints, registry, softThresholdPct. `handoff`/`authority`/`secretResolver`/
  `verifyIsolation` deliberately omitted (`isolation.required:"ambient"` passes Prepare
  without them; the envelope-yield path is out of scope; parity with legacy).
- **`sessionId → taskId` cache in the `publish` callback** — a session's task is immutable, so
  no invalidation; populated lazily, a miss does one `runs` SELECT.
- **`waitUntilSessionTerminal` in manual `handoff`** adds a poll loop on the request path;
  bounded 10s, same shape as the existing `waitUntilInactive`.
- **`attempt = MAX(execution_requests.attempt)+1` under single-flight** — no unique index
  backstop (would block the future parallel cutover). If a bug lets two flag-ON starts race
  for one task, both derive the same `executionRequestId` (`erq_<taskId>_<attempt>`). Two
  **identical** requests dedupe on `store.recordRequest` + `SessionRunner.start`'s PREPARED
  idempotency (second caller gets the same session, no second run). Two **divergent** requests
  (e.g. different assistant → same id, different `requestFingerprint`) hit
  `RequestFingerprintConflictError` on the second `recordRequest` and fail loudly — a safe
  conflict, not a corruption or a silent overwrite.
- **`comparison()` + flag-ON** — parallel stays legacy this pass so harness rows rarely land
  in a comparison, but if the flag is later flipped for parallel the `finishComparison`
  `outcome` writes (`winner`/`rejected`) still key off `runs.id`, unaffected by the state
  vocab. Noted, not blocking.
- **Provider-`resume()` for same-assistant continuation** (`resumableRef`) — out of scope;
  only reachable via a manual same-assistant re-start, which `routeFor` avoids.

## Out of scope

- Phase 8 remote runner.
- **Wiring the `handoff_envelopes` claim protocol** (`enterStartAmbiguous`/`markConsumed`/
  `release` co-commits in the runner's start-ack transactions) — tracked by the named
  standing deferral **"Harness handoff-envelope claim protocol (post-cutover)"** (8e step 4),
  which supersedes progress-doc lines 160-163. Flag-ON handoff/failover is a fresh-prompt
  start (legacy parity) this pass.
- Cosmetic `Orchestrator`→`ControlPlane` rename (separate no-logic commit).
- Parallel / compare / race routed through the Harness (stays legacy this pass).
- Provider-session `resume()` under flag-ON.
- Full task-verdict policy for `completed` + failed verification (this pass sends
  `verification:[]`; `settleFromResult` parks defensively).
- Flipping the flag default to ON.
- Removing the external legacy `state` field from run reads.
- Isolation-tier enforcement on the flag-ON path.
- Bounded cost caps; real-adapter conformance (deferrals #3, #4).
