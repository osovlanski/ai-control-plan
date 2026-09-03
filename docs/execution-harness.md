# Execution Harness — Architecture

**Status:** Proposed (design only; no implementation on this branch)
**Revision:** 7 (post review round 6 — see `docs/harness-review.md`)
**Builds on:** `docs/revised-architecture.md` (Phases 0–5 implemented), `docs/agentic-os-plan.md`
(Composer / AgentSpec, proposed), `docs/ARCHITECTURE.md` (orchestrator concentration risk).
**Verification/operator companion:** `docs/operator-observability-verification.md` defines
multi-repository identities, deterministic verifier planning, Playwright provisioning, evidence
projection, Cockpit's managed/observed split and optional telemetry sinks. It refines this
document without changing the Control Plane/Harness responsibility boundary.

---

## 1. Why a Harness

Today `apps/api/src/modules/orchestrator.ts` (930 lines, the repo's top graph hub: 56 edges,
43 symbols) owns *both* halves of the problem:

- **deciding** — routing calls, failover target selection, cooldown penalties, comparison
  winner resolution, task-lifecycle transitions;
- **executing** — adapter start/resume, event consumption, timeouts, checkpoint triggers,
  approval relay, cancellation, worktree binding.

`docs/ARCHITECTURE.md` names this concentration the primary architectural risk, and
`docs/ROADMAP.md` ("Now") already commits to splitting lifecycle/comparison/approval/failover
behind explicit services. The **Execution Harness** is that split made first-class: everything
after a route (or composition) has been selected moves behind a narrow, provider-neutral
contract. The Harness executes; it never decides *who* executes.

### Responsibility boundary (normative)

| Concern | Owner |
|---|---|
| Prompt/task intake, task decomposition, subtask classification | Control Plane |
| Assistant selection, model selection, routing policy, capability matching | Control Plane |
| Cost/speed/quality preference profiles, re-routing decisions | Control Plane |
| Cross-task/subtask orchestration, parallel compare/race decisions | Control Plane |
| Approval **policy definition** (what needs approval, who answers) | Control Plane |
| Explainable routing/composition decisions | Control Plane |
| Task state machine (the 9 `TASK_STATES`) | Control Plane |
| Workspace authority checks + context materialization into the workspace | Harness |
| Execution session lifecycle (session state machine, §5) | Harness |
| Workspace/worktree binding for a session | Harness |
| Tool exposure + tool allow/deny **enforcement** (preventive; §4 guards) | Harness |
| Approval **enforcement** (durable pending record, relay, resume) | Harness |
| Runtime guards: token/cost/runtime budgets, timeout | Harness |
| Checkpoints, pause/resume, cancellation of a session | Harness |
| Provider session interaction via `AgentAdapter` | Harness |
| Handoff envelope assembly; session start from an envelope | Harness |
| Normalized execution events, artifact collection, telemetry emission | Harness |
| Failure normalization (`ExecutionFailure`), session recovery mechanics | Harness |
| Verification hook execution (running the checks) | Harness |
| Retry decision, handoff target, final task-lifecycle verdict | Control Plane |

**Anti-routing invariant (H-I1).** The Harness never selects or substitutes an assistant or
model. If execution evidence says the selected assistant/model is unsuitable, the session ends
`YIELDED` with a structured `RerouteRequest` (§8). Only the Control Plane's router may turn
that into a new route.

### Placement

```text
User / Cockpit
   ↓ intake
Control Plane: task decomposition → routing (later: Composer stages 1–6)
   ↓ ExecutionRequest (assistant + model + policy already decided)
EXECUTION HARNESS (SessionRunner, §4)
   prepare → context → guarded execute → observe → checkpoint → verify → finalize
   ↓ AgentAdapter (unchanged 6-method contract + proposed provision())
Claude / Codex / Cursor / Bedrock / OpenRouter / Fake
   ↑ NormalizedEvents, artifacts, ExecutionResult, RerouteRequest
Control Plane: verdict, retry, re-route, next subtask, Cockpit feeds
```

In Agentic OS terms the Harness is the runtime that consumes an `AgentSpec`: the Composer
(Control Plane) produces the spec; the Harness consumes its `policy`, `workspace`, `context`
and `provisioning` fields. Pre-Composer, the same fields arrive on the `ExecutionRequest`
directly — the Harness contract is identical in both eras.

---

## 2. Contract — Control Plane ↔ Harness

Provider-neutral. Every contract type carries its own `schemaVersion` (starting at 1),
independent of `CONTROL_PLANE_API_VERSION`. Reuse over invention: `NormalizedEvent`,
`TaskEnvelope`, `Checkpoint`, `RunSpec`, `PermissionPolicy` and the adapter contract are kept;
new types wrap rather than replace them.

```ts
/**
 * What the Control Plane hands the Harness. Immutable once accepted.
 *
 * Request identity & replay (settled R3, coverage fixed R4): the persisted
 * identity of a request is `requestFingerprint` — a digest over a canonical
 * JSON projection of EVERY execution-affecting and authorization-relevant
 * field: taskId, attempt, assistantId, model, compositionRevisionId,
 * routingDecisionRef, the full runSpec (prompt digest standing in for the
 * prompt, workdir, permissionPolicy, env), policy, verification, origin, and
 * context refs. The ONLY exclusions are purely observational metadata:
 * `correlation` and `schemaVersion`. The canonicalization algorithm and its
 * version are recorded beside the fingerprint. EXACT byte replay of the
 * in-memory request is explicitly a non-goal: prompts are deterministic
 * renders of durable, redacted inputs, so replay is SEMANTIC — re-render from
 * provenance — and the prompt digest is the integrity witness that the render
 * matched what ran. Resubmitting an executionRequestId with a DIFFERENT
 * fingerprint is rejected as a conflict, never treated as an idempotent retry.
 */
interface ExecutionRequest {
  schemaVersion: 1;
  executionRequestId: string;        // idempotency key — resubmission with the SAME
                                     // fingerprint returns the same session
  taskId: TaskId;
  correlation?: { parentTaskId?: TaskId; groupId?: string };  // opaque to the Harness —
                                     // carried for observability joins, never read by logic
  attempt: number;                   // 1..n; a retry is a NEW request with attempt+1,
                                     // issued by the Control Plane
  assistantId: AssistantId;          // decided by Control Plane — Harness never changes it
  model?: ModelRef;
  compositionRevisionId?: string;    // AgentSpec link (Agentic OS era); absent pre-Composer
  routingDecisionRef: string;        // explainability back-pointer
  runSpec: RunSpec;                  // existing contract: prompt, workdir, permissionPolicy, env
  policy: ExecutionPolicy;
  context: ExecutionContext;
  verification: VerificationSpec[];  // may be empty
  origin:
    | { kind: "fresh" }
    | { kind: "resume"; sessionId: ExecutionSessionId; checkpointId: string }
    | { kind: "handoff"; envelopeId: string };   // HandoffEnvelope (§7)
}

interface ExecutionPolicy {
  budget: BudgetPolicy;              // §4, BudgetGuard — includes enforcement fidelity
  timeout: { idleMs?: number; hardMs: number };
  approval: PermissionPolicy;        // existing type; Harness enforces, Control Plane defines
  tools: ToolPolicy;                 // §4, ToolPolicyGuard — includes enforcement mode
  checkpoint: { onSoftLimit: boolean; periodicMs?: number };
  /**
   * Minimum acceptable provider-process isolation fidelity (§3 tiers), an
   * explicit contract field — never implicit policy interpretation. Prepare
   * rejects the request (policy_unenforceable) when the verifiable tier for
   * this adapter/launch is below `required`, and a per-session verification
   * that comes back below `required` fails the session before RUNNING. The
   * achieved tier is always reported on the result.
   */
  isolation: { required: "full" | "partial" | "ambient" };
}

interface BudgetPolicy {
  // Token/cost accounting ONLY. Runtime has exactly one authoritative field:
  // ExecutionPolicy.timeout.hardMs, owned by TimeoutGuard (local clock, truly
  // hard). RunSpec.env.maxRuntimeMs is derived from it at Prepare and
  // validated equal — never a second deadline.
  maxTokens?: number;
  maxCostUsd?: number;                // requires pricingVersion when enforcement is "bounded"
  pricingVersion?: string;           // versioned pricing table used to derive cost from tokens
  /**
   * Token/cost caps are honest about what provider reporting permits. The
   * enforcement unit is the OBSERVABLE accounting event:
   * - "bounded": requires the adapter's manifest to declare a QUANTITATIVE
   *   usage-reporting contract, every field mandatory for this mode:
   *   `usageReporting: { cadence: "per-message" | { periodicMs: number };
   *   maxUnreportedTokens: number }` — and the conformance suite must prove
   *   both the cadence and that observed unreported consumption stays within
   *   the declared bound. The guard evaluates the cap at every usage event and
   *   cancels on observed excess; the residual risk is then genuinely bounded
   *   by maxUnreportedTokens and recorded as `overrun`. A reporting gap (no
   *   usage event across a full cadence interval while the stream is active)
   *   cancels with budget_exceeded and flags the gap. Prepare rejects bounded
   *   when the contract is undeclared or unproven, accounting mode is "none",
   *   or (for cost caps) pricingVersion is absent (policy_unenforceable).
   * - "advisory": records overruns without cancelling. Adapters without a
   *   proven quantitative contract get advisory only.
   * There is no "hard" token/cost mode: a truly hard cap requires a locally
   * metered execution boundary that does not exist here; naming it would lie.
   */
  enforcement: "bounded" | "advisory";
}

interface ToolPolicy {
  allow?: string[];
  deny?: string[];
  /**
   * "preventive": requires a CALLABLE enforcement path, not a manifest claim —
   * the adapter must accept `RunSpec.toolPolicy` (§6) and apply it before any
   * tool executes (Claude: permission rules/allowedTools; Codex: sandbox +
   * approval config). Prepare rejects preventive mode when the manifest's
   * `toolGating` is not "preventive" (failure: policy_unenforceable), and the
   * adapter conformance suite proves the gate behaviorally (§6, §12).
   * "audit": explicitly accepted detect-and-record mode — a matched deny still
   * ends the session (FAILED, tool_denied) but the side effect may already
   * have happened, and the result says so. Silent downgrade never occurs (H-I10).
   */
  mode: "preventive" | "audit";
}

interface ExecutionContext {
  worktree?: { repoPath: string; branch: string; worktreePath: string; baseRef: string };
  bundleRefs?: string[];             // composed context bundle digests (Agentic OS era)
  envelopeId?: string;               // when origin.kind === "handoff"
  priorCheckpointId?: string;
}

/** Durable record of one attempt to execute one request. One session IS one Run row (§10). */
interface ExecutionSession {
  sessionId: ExecutionSessionId;
  executionRequestId: string;
  state: ExecutionSessionState;      // §5
  version: number;                   // optimistic-concurrency counter; every write is a CAS
  leaseToken?: string;               // fencing token of the owning SessionRunner (§9)
  leaseExpiresAt?: string;
  providerSessionRef?: ProviderSessionRef;
  providerStartAcked: boolean;       // §9 start-intent/start-ack protocol
  cancelRequested: boolean;          // durable cancellation intent
  startedAt?: string; endedAt?: string;
}

interface ExecutionResult {
  schemaVersion: 1;
  sessionId: ExecutionSessionId;
  terminalState: ExecutionSessionState;   // the session's terminal state verbatim (§5)
  /**
   * outcome is DERIVED from terminalState by a fixed mapping:
   * COMPLETED→"completed", FAILED→"failed", CANCELLED→"cancelled",
   * TIMED_OUT→"timed_out", YIELDED→"yielded". Execution and verification are
   * reported SEPARATELY and never folded into each other: outcome describes
   * what the provider execution did; `verification` describes what the checks
   * found. outcome "completed" with verification.passed === false is legal and
   * expected — the Control Plane, not the Harness, decides the task verdict
   * (H-I6). A result row is persisted for EVERY terminal state in the same
   * transaction as the terminal CAS — the result is stored, not merely promised.
   */
  outcome: "completed" | "failed" | "cancelled" | "timed_out" | "yielded";
  yield?: { kind: "reroute" | "handoff" | "limit"; detail: RerouteRequest | HandoffRequest };
  failure?: ExecutionFailure;        // present iff outcome is failed/timed_out
  cancellation?: { requestedBy: "user" | "plane"; at: string };  // present iff cancelled
  verification?: EvaluationResult;   // absent when no VerificationSpec was given
  artifacts: ExecutionArtifact[];
  usage: UsagePayload & { accounting: "delta" | "cumulative" | "none"; overrun?: UsagePayload };
  checkpoint: { attempted: boolean; committed: boolean; checkpointId?: string; gitRef?: string };
  enforcement: {                     // honesty record (H-I10)
    tools: "preventive" | "audit" | "none";
    budget: "bounded" | "advisory" | "none";
    isolation: "full" | "partial" | "ambient";   // §3 — provider-process containment tier
  };
}

/** Normalized failure taxonomy — replaces provider error strings at the boundary. */
type FailureKind =
  | "provider_fault" | "auth" | "quota" | "timeout" | "budget_exceeded"
  | "tool_denied" | "workspace" | "policy_unenforceable"
  | "orphaned" | "internal";
  // NOTE: cancellation is an outcome, not a failure. verification_failed is
  // NOT a Harness failure kind — failed checks ride on `verification` and any
  // task-level failure records for them belong to the Control Plane.

interface ExecutionFailure {
  kind: FailureKind;
  retryable: boolean;
  providerDetail?: unknown;          // redacted before persistence; size-capped
  message: string;
}

interface ExecutionArtifact {
  kind: "diff" | "file_list" | "test_report" | "checkpoint" | "rendered_output";
  ref: string;                       // checkpoint id, git ref, event range — never inline blobs
  summary: string;                   // size-capped like event summaries
}

interface EvaluationResult {
  passed: boolean;                   // all `required` checks passed
  checks: Array<{ name: string; kind: VerificationKind; passed: boolean;
                  required: boolean; summary: string; ref?: string }>;
}

interface VerificationSpec {
  name: string;
  kind: "tests" | "typecheck" | "lint" | "api" | "browser" | "command"
      | "artifact_exists" | "evaluator" | "review";
  command?: string;                  // validated + executed by the WorkspaceAuthority (§3),
                                     // NOT via adapter tools
  required: boolean;                 // required:false checks report but never affect outcome
}
```

The Control Plane produces a persisted `VerificationPlan`; the Harness receives its flattened
`VerificationSpec[]` and runs the matching provider implementations. Repository-native commands
and configuration take precedence over execution-scoped defaults. In particular, Playwright is
the first `browser` provider and may be provisioned for a relevant Tester, but browser
applicability is decided outside the Harness. See the companion specification.

`NormalizedEvent` remains the event contract. Additions are additive to the closed set —
`checkpoint.created`, `verification.result`, `guard.decision` (audit) — and **every event type
gets a typed payload interface in `packages/core`** (today only `UsagePayload` is typed;
adapter conformance tests in §12 pin them). Events stay append-only and redacted.

---

## 3. Workspace authority (security boundary)

All filesystem and process activity of a session passes one Harness-side authority; nothing
else in the Harness touches paths or spawns processes.

- **Canonical roots.** At Prepare, `repoPath` is re-validated against the instance repo
  allowlist (same rule the router applies — revalidated here because the Harness is a trust
  boundary, not a trusting callee), then canonicalized (`realpath`); `worktreePath` must
  resolve inside the instance's worktree root or the repo itself. Symlink escape is checked on
  the resolved path, and generated files are written only under session-owned paths.
- **Write policy.** Context materialization (§4) writes only inside the session worktree or a
  per-session temp profile dir — never `~/.claude`/`~/.codex`/`~/.cursor` (agentic-os-plan
  provisioning rule, enforced here). Files carry ownership markers; an unowned existing file
  is never overwritten.
- **Command policy.** `VerificationSpec.command` runs as a child process of the authority:
  cwd pinned to the session worktree, environment reduced to an allowlist (no provider
  credentials — they exist only in provider tooling per the standing security rule), no shell
  interpolation of untrusted strings, wall-clock capped by the remaining session budget,
  output size-capped. Commands are declared in the request the Control Plane built — the
  Harness executes them but never invents them.
- **Secrets.** The authority never reads or renders secret values. Resolution has one named
  owner (R3 C3-5): a **`SecretBroker`** at the launch boundary — `ProviderSessionDriver` asks
  it to resolve the request's secret *references* immediately before `adapter.start()`; values
  exist only in memory, are injected into the provider launch environment by the adapter, are
  excluded from the reduced verification environment, never appear in the persisted request or
  any diagnostic (broker errors name the reference, never the value), and are dropped after
  launch. Capability-scoped: the broker resolves only references named by the accepted
  request.
- A workspace-authority rejection is `FAILED(workspace)` before any adapter call, with the
  specific check named in the failure message.

### Scope honesty: the provider process is NOT contained by this authority

The authority governs **Harness-owned** activity: context materialization, verification
subprocesses, profile writes, checkpoint commits. The provider process the adapter launches
(Claude/Codex/Cursor CLI or SDK runtime) executes with the user's ambient OS credentials and
is *not* confined by canonicalizing our own paths — it can, absent an OS sandbox, read files
and follow symlinks the Harness never touched. That is today's documented reality
(revised-architecture §12: provider credentials live in provider tooling; process-level
workspace isolation). The design therefore ties the claim to the tier it can prove:

- `enforcement.isolation: "full"` requires an OS-level process containment mechanism for the
  provider process (provider-native sandbox such as Codex's sandbox mode, an OS sandbox
  wrapper, or the future remote-runner boundary), declared by the adapter manifest
  (`processIsolation: os-sandbox | provider-sandbox | none`) **and verified per session**: a
  mandatory containment verification step (the provisioning `verify()` call, or an equivalent
  adapter probe) must confirm the sandbox is active for the *exact launch configuration of
  this session* before `full` may be reported. No verification ⇒ the session reports at most
  `partial`, whatever the manifest claims — a declaration is never a proof.
- Without such a mechanism, sessions report `isolation: "partial"` (worktree + profile
  discipline, ambient process) or `"ambient"`. The acceptance decision is an explicit
  contract field, not policy interpretation: `ExecutionPolicy.isolation.required` names the
  minimum acceptable tier; Prepare rejects below it (`policy_unenforceable`), and a
  per-session verification below it fails the session before `RUNNING` — the agentic-os-plan
  invariant 3 pattern applied to processes, not just config.
- H-I11 is scoped accordingly: it binds Harness-owned activity; provider-process containment
  is an isolation-tier fact reported on the result, never an implied guarantee.

---

## 4. Harness pipeline — one coordinator, single-writer

**`SessionRunner` is the named coordinator** — one instance per session, the *only* writer of
that session's row (enforced by lease + CAS, §9). It owns sequencing, cancellation, rollback
and terminal arbitration. The stage services below are its collaborators: they receive
explicit inputs, return values or directives, and **never write session state themselves**.
That is the answer to "eight coupled stages replacing one god object": coupling is confined to
one small sequencing class with a fixed order, while every stage and guard is independently
unit-testable against plain values (no pipeline construction required — see §12).

```text
Prepare → Context → [Guarded Execute + Observe] → Checkpoint → Verify → Finalize
```

| Stage | Service | Responsibility |
|---|---|---|
| Prepare | `SessionPreparer` | request validation, idempotent dedupe, workspace-authority checks, policy-enforceability check (reject `policy_unenforceable`), persist `PREPARED` session |
| Context | `ContextMaterializer` | render handoff/fresh prompt, write composed bundle via the workspace authority; Agentic OS era: adapter `provision()` |
| Execute | `ProviderSessionDriver` | adapter `start`/`resume`, event pump, `send()` relay, cancel |
| Observe | `EventRecorder` | seq assignment, redaction, transactional persistence (§9), post-commit SSE, envelope derivation |
| Checkpoint | `CheckpointService` | **extended, not reused as-is**: checkpoint creation becomes session-scoped — worktree, branch, baseRef and envelope snapshot resolve from the session row, not the task row (fixes the parallel-competitor mismatch found in review R1) |
| Verify | `VerificationRunner` | run `VerificationSpec[]` via the workspace authority after the provider stream ends |
| Finalize | `SessionFinalizer` | assemble `ExecutionResult`, release lease, dispose ephemeral profile, terminal event |

**Redaction: two views — ephemeral policy view, redacted durable view** (refined in R3;
closes R2 C2-5 and R3 C3-1). Redacting before *policy evaluation* would blind the very guards
that need raw facts (tool arguments for `ToolPolicyGuard`, provider identifiers for approval
correlation, raw errors for failure normalization). So ingestion splits:

- the **policy view** — the unredacted event, held in memory only, visible to guards, failure
  normalization and approval correlation inside the SessionRunner process; never persisted,
  never logged, never emitted;
- the **durable view** — the redacted projection, the only form that reaches persistence,
  derivation (envelope, directives, audit events, handoff envelopes, verification output,
  results), SSE and telemetry.

A regression test pins that redaction of the durable view does not alter routing-critical
identifiers (event seq, request ids, session refs). The same mandatory redaction applies to
every non-event record at its own write point.

**Guard directives are durable.** Guards are pure policy functions
`(sessionSnapshot, event | tick) → directive[]` (`continue`, `checkpoint`, `cancel(failure)`,
`pause`, `yield(kind)`), evaluated by the SessionRunner in one fixed, declared order. A
non-trivial directive is persisted **in the same transaction as its triggering event** with an
application status (`pending → applied`); a crash between committing the event and acting on
the directive is recovered by replaying unapplied directives idempotently (each directive's
action is a CAS or an idempotent service call, so replay cannot double-apply). Guards hold no
mutable state of their own; counters they need (token totals, last-event time) live on the
session record and are recomputed from persisted events on recovery. (Closes R2 C1-10.)

- `BudgetGuard` — token/cost accumulation per `BudgetPolicy.enforcement` and the adapter's
  declared accounting mode (`delta` vs `cumulative`; `none` forbids bounded caps at Prepare).
  Soft threshold → eager checkpoint; bounded-cap trip → cancel with `budget_exceeded` and the
  cadence-permitted overrun recorded. Runtime deadlines belong to `TimeoutGuard` alone.
- `TimeoutGuard` — hard + idle timeouts from durable timestamps (no bare `setTimeout`
  authority; a timer only prompts a durable check).
- `ToolPolicyGuard` — per `ToolPolicy.mode` (§2): preventive via adapter gating, or explicit
  audit mode; never a silent downgrade.
- `ApprovalGuard` — see approval protocol below.
- `QuotaGuard` — `limit.approaching` → eager checkpoint; `limit.hit` → `YIELDED(limit)`.
  Failover leaves the Harness entirely: target selection is Control Plane work.

### Approval protocol (durable, atomic, delivery-tracked)

One transaction commits together: the `approvals` row (`(session_id, provider_request_id)`
UNIQUE), the `approval.requested` event, and the session CAS to `AWAITING_APPROVAL` — the
pending approval, its audit event, and the paused session can never disagree (closes R2 C1-6).

Answer lifecycle is its own small state machine:
`pending → answered → delivering → delivered` (plus `pending → expired`):

- **answered** — the decision (`approved`/`denied`, `answered_by`, `answered_at`) is durable
  before any relay attempt.
- **delivering → delivered | delivery_unknown** — `adapter.send()` is attempted; success
  CASes to `delivered` and the session back to `RUNNING`. Delivery is **at-least-once, with
  ambiguity named**: a crash after `send()` was issued but before `delivered` committed
  recovers to `delivery_unknown`. From there: if the adapter's manifest declares
  `approvalAckLookup: true` (the provider exposes a queryable acknowledgement), recovery
  probes and settles the state; if the conformance suite has proven repeated answers for the
  same `provider_request_id` are accepted-or-no-op *for that adapter*, recovery re-delivers;
  otherwise the ambiguity is surfaced to the Control Plane/user as `delivery_unknown` with
  the session held — the design does not pretend provider semantics it cannot verify. If the
  provider session did not survive, the session is orphaned with the answered-undelivered
  state recorded.
- **`delivery_unknown` has a defined lifecycle path** (R4 C4-1). The session stays in
  `AWAITING_APPROVAL` — accurate: the provider is still awaiting an effective answer — with a
  durable session annotation `approvalDelivery: "unknown"` and a typed audit event, both
  surfaced verbatim through the read API so operator/Cockpit see "decision made, delivery
  unconfirmed", never a plain pending approval. Normative exits, all Control-Plane-chosen:
  (a) retry delivery where ack lookup or proven idempotent re-delivery exists (→ `delivered`,
  session `RUNNING`); (b) cancel the session (normal cancel path); (c) orphan if the provider
  session is gone; (d) operator resolution — the user confirms what the provider actually
  did, recorded as the settling audit event — the confirmed provider outcome decides the
  session's path: answer received and acted on → `delivered`, session `RUNNING` (or its
  natural next state); answer never received → re-deliver or cancel per the user's choice.
- **Idempotency vs conflict** (closes R2 C2-3): re-submitting the *identical* answer returns
  the original result as a no-op; a *conflicting* answer (approve after deny or vice versa) is
  rejected with a deterministic conflict response and a typed audit event — a flip is stale UI
  or an authorization problem, never a retry.
- **Expiry** (policy-set, default none) cancels the session cleanly.

Restart recovery re-reads `pending` and `answered`-undelivered rows and resumes the protocol.
Adapters without `send()`: Prepare rejects `prompt-on-escalation` requests against them
(`policy_unenforceable`) — an adapter that cannot relay answers cannot host a session whose
policy requires them.

---

## 5. Session lifecycle

The existing **task** machine (9 `TASK_STATES`) stays authoritative and untouched. The session
machine **replaces** today's thin `RUN_STATES` enum on the `runs` table — stated as a
replacement with an explicit migration, not a "refinement" (review R1, C1-5):

```text
PREPARED → STARTING → RUNNING ⇄ AWAITING_APPROVAL
                        │ ⇄ PAUSED → RESUMING → RUNNING
                        ├→ VERIFYING → COMPLETED
                        ├→ FAILED | CANCELLED | TIMED_OUT
                        └→ YIELDED (reroute_requested | handoff_requested | limit)
```

- **Terminal:** `COMPLETED`, `FAILED`, `CANCELLED`, `TIMED_OUT`, `YIELDED`.
- **Verification never rewrites the execution outcome.** `VERIFYING` always exits to
  `COMPLETED` (execution completed; that is what the state describes). The check results ride
  on `ExecutionResult.verification`; if the Control Plane decides to fail the task on that
  evidence, that record is task-level and plane-owned — no Harness failure kind exists for it.
  One canonical derivation, no dual representation (closes R1 C1-2).
- **`retrying` is not a session state.** A retry is a new session for a new request
  (`attempt+1`), decided by the Control Plane from `failure.retryable`.
- **`AWAITING_APPROVAL`** — budget/idle clocks paused, provider session held, durable pending
  row (§4). Task state remains `RUNNING`.
- **`PAUSED`/`RESUMING`** — explicit user/plane hold; resume via adapter `resume()` where the
  manifest allows, else checkpoint-restart as a new `origin: resume` request.
- Transition table lives in `packages/core` beside the task machine (same
  `assertTransition`/`InvalidTransitionError` style); every transition names its trigger;
  property-based tests sweep illegal transitions (§12).

### Migration of `RUN_STATES` (explicit)

| Old (`runs.state`) | New session state |
|---|---|
| `STARTING` | `STARTING` |
| `ACTIVE` | `RUNNING` |
| `ENDED_OK` | `COMPLETED` |
| `ENDED_ERROR` | `FAILED` |
| `CANCELLED` | `CANCELLED` |

A SQL migration rewrites existing rows (`PREPARED`, `AWAITING_APPROVAL`, `PAUSED`,
`RESUMING`, `VERIFYING`, `TIMED_OUT`, `YIELDED` occur only in new rows). API compatibility:
during the transition the run read endpoints serve both `state` (legacy vocabulary, derived by
the inverse mapping) and `sessionState`; comparison queries and the frontend move to
`sessionState` in the same phase the write path flips (implementation plan phase 2). Old rows
are terminal by construction (boot reconcile), so mixed-version recovery only ever reads new
vocabulary for live sessions.

### Task-state mapping (composition, not competition)

| Session signal | Task machine effect (Control Plane's call) |
|---|---|
| session `RUNNING` | task `RUNNING` |
| session `YIELDED(limit)` | task `LIMIT_PAUSED` → failover route or `WAITING_INPUT` |
| session `YIELDED(reroute/handoff)` | task `HANDING_OFF` or `WAITING_INPUT` |
| session `COMPLETED` + verification passed/absent | task `COMPLETED` |
| session `COMPLETED` + verification failed | Control Plane: retry / re-route / `FAILED` / `WAITING_INPUT` |
| session `FAILED`/`TIMED_OUT` | Control Plane: retry / failover / `FAILED` |
| session `AWAITING_APPROVAL`/`PAUSED` | task stays `RUNNING` (events annotate) |

---

## 6. Provider portability

Layering is strict: Control Plane → Harness core (provider-neutral) → `AgentAdapter` →
provider SDK/CLI.

- Harness core imports only `packages/core`. Provider specifics live in `packages/adapters`.
- The adapter contract keeps its 6 methods. The Agentic OS `prepare/provision/verify/dispose`
  extension is invoked from Context/Finalize stages when present and carries its own
  `provisioningContractVersion` in the manifest, honestly tiered (full/partial/ambient).
- **Every capability the Harness must enforce has a callable contract, not just a manifest
  claim** (closes R2 C1-7/C1-14). `RunSpec` gains two versioned inputs adapters consume at
  `start`/`resume`:
  - `toolPolicy?: ToolPolicy` — the adapter installs it *before* any tool executes
    (Claude: permission rules / allowed tools; Codex: sandbox + approval config; fake:
    scripted gate). A manifest may declare `toolGating: "preventive"` only if the adapter
    consumes this field; the conformance suite proves it behaviorally — a scripted forbidden
    tool call must be blocked pre-execution, not observed post-hoc.
  - `runControl: { executionRequestId }` — passed to provider SDKs as an idempotency key
    where supported (§9).
  - Failure normalization has an input contract too: an adapter maps every raw provider
    error to an `error` event whose typed payload embeds an `ExecutionFailure`; the
    conformance suite feeds each adapter its provider-shaped failure fixtures (auth expiry,
    quota, network, crash) and asserts the normalized kind.
- Manifest fields the Harness reads at Prepare: `usageAccounting: delta|cumulative|none`,
  `usageReporting { cadence, maxUnreportedTokens }` (quantitative contract required for
  bounded budget enforcement, §2), `toolGating:
  preventive|none`, `approvalRelay: boolean` (derived from `send`), `processIsolation:
  os-sandbox|provider-sandbox|none` (§3), `canResume` (existing), and
  `provisioningContractVersion` where provisioning exists. Manifest claims are honest exactly
  because the conformance suite tests the callable behavior behind each one.
- Capability gaps are Prepare-time facts: a policy the adapter cannot enforce rejects the
  request (`policy_unenforceable`) rather than degrading silently (H-I10).

---

## 7. Handoff — one transaction, provider-neutral

Cross-assistant continuation (Claude → checkpoint → envelope → Codex, and inverse) never uses
provider transcripts or hidden chain-of-thought.

```ts
interface HandoffEnvelope {
  schemaVersion: 1;
  envelopeId: string;
  taskId: TaskId;
  checkpointId: string;              // the durable anchor; envelope fields are derived FROM
                                     // this checkpoint's immutable snapshot, never from the
                                     // live mutable task envelope
  objective: string;
  currentSubtask?: string;
  completedActions: string[];
  outstanding: string[];
  decisions: Array<{ text: string; madeBy: string; at: string }>;  // provenance-tagged
  artifacts: { gitRef?: string; diffStat?: string; changedFiles: string[]; lastTests?: unknown };
  verificationStatus?: EvaluationResult;
  contextRefs: string[];             // digests/names — reconstructable state only
  workspace: { repoPath: string; branch: string };  // paths, never contents
  fromAssistantId: AssistantId;
  reason: string;
}
```

**Single ownership, single transaction** (closes R1 C1-12). Exactly one writer builds
continuation state: the source session's `SessionRunner`, at terminalization. One SQLite
transaction commits together: (a) checkpoint row (git commit ref already durable), (b)
envelope row derived from that checkpoint's snapshot, (c) source session terminal CAS, (d)
`handoffs` row referencing both. The Control Plane then — outside that transaction, because
routing is its own decision with its own audit row — picks a target (or recomposes, in
Agentic-OS terms: a new composition revision per plan invariant 4) and issues a new
`ExecutionRequest` with `origin: {kind: "handoff", envelopeId}`. The destination
`ContextMaterializer` renders the receiving prompt from the envelope.

**Consumption is a persisted protocol, not an assertion** (closes R2 C1-12; claim release
added in R3 for C3-2): `handoff_envelopes.state: ready → claimed → consumed`, with
`claimed → released` for a failed successor. `execution_requests.origin_envelope_id` carries a
**partial UNIQUE constraint over non-superseded requests** — the database, not recovery logic,
makes two *live* successors for one envelope impossible, while a failed attempt does not
strand the work:

- The plane claims the envelope (CAS `ready → claimed`, recording `claimed_by_request_id`) in
  the same transaction that inserts the successor request.
- **`consumed` is committed only at durable start acknowledgement** (R5/R6 C3-2): the
  envelope stays `claimed` through Prepare and Context/provisioning, and flips to `consumed`
  in the same transaction as the destination session's first-event ack (§9) — the moment
  execution provably began consuming the envelope's work.
- **Release is legal only while non-execution is certain.** A *pre-start* failure — Prepare
  rejection, context/provisioning failure, or claim expiry before any `adapter.start()`
  attempt — transactionally marks the failed request `superseded` and releases the envelope
  (`claimed → released → ready`), preserving the attempt history; the Control Plane can route
  a corrected successor.
- **Once `adapter.start()` has been attempted, the claim enters `start_ambiguous`** — in the
  same transaction as the durable start intent (§9 step 2) — and **automatic expiry release is
  prohibited** from that point. Only recovery may settle it, by probing the §9 markers
  (handle, provider ref, first event): non-execution *established* → release; execution
  possible or confirmed → `consumed` (continuing via the session's own checkpoints) or
  orphaned with the claim consumed. A synchronous `start()` failure settles it immediately
  (release). No path can hand the envelope to a second successor while the first provider
  session may still be executing; the residual double-execution window is exactly the §9
  at-least-once window, stated as such — not a duplicate *continuation* of the envelope.
- Claims expire on their own configurable duration (default: the lease TTL; independently
  raisable if routing/composition needs longer): expiry atomically supersedes the owning
  request AND releases the envelope in one transaction — never a released envelope with a
  live successor row.
- Crash between handoff transaction and claim → recovery finds a `ready` envelope on a
  terminal session and re-runs only the decision step; crash after the claim → the successor
  request already exists and resumes. No stranded envelope, and no duplicate *continuation* —
  the only double-work window is the explicitly accepted §9 at-least-once provider-start
  window, resolved by the `start_ambiguous` probe above.

Envelope rules: reconstructable state only; redaction pass before persistence; no provider
session blobs, no transcripts, no credentials; explainability rides on structured decisions
and summaries, never raw CoT.

---

## 8. Reroute protocol

```ts
interface RerouteRequest {
  sessionId: ExecutionSessionId;
  taskId: TaskId;
  reason: "capability_missing" | "auth_failed" | "quota_exhausted"
        | "repeated_provider_fault" | "model_unsuitable";
  evidence: Array<{ eventSeq: number; summary: string }>;   // points at persisted events
  checkpointId?: string;             // checkpoint attempt recorded per H-I4 semantics
  suggestion?: never;                // the Harness proposes no target — typed boundary
}
```

The session ends `YIELDED(reroute_requested)` through the same handoff transaction shape
(checkpoint attempt + envelope + terminal CAS); the Control Plane routes again with all its
own machinery (cooldowns, profiles, telemetry) and issues a fresh request or parks the task.

---

## 9. Reliability & recovery

SQLite remains the durable system of record. Guarantees are stated honestly for the current
single-process architecture, with remote-runner deltas named.

**Execution guarantee is at-least-once, not exactly-once** (closes R1 C1-3). The
start-intent/start-ack protocol narrows the window but cannot close it against a crash between
provider start and durable ack:

1. `PREPARED` row committed (unique `executionRequestId`) — duplicate *rows* are impossible.
2. CAS to `STARTING` (start intent, durable) → adapter `start()`.
3. Two distinct durable markers, not one ambiguous "first event/handle": handle acquisition
   → CAS `providerSessionRef` (handle-acquired); first streamed event → CAS
   `providerStartAcked = true`. Recovery can then distinguish "start returned but stream
   never began" from "stream was live".
4. Recovery finding `STARTING` with no ack must treat provider start as *unknown*: probe via
   `providerSessionRef` if any, else adapter-level session listing where the SDK offers one,
   else orphan the session. A retry after an ambiguous window **may duplicate provider-side
   work**; worktree isolation contains the blast radius (a duplicate writes to a new session
   worktree, never over the old one). Where provider SDKs accept client-supplied idempotency
   keys, adapters pass `executionRequestId` — recorded in the manifest so the plane knows
   which assistants close the gap.

**Transactional commit protocol** (closes R1 C1-10). Per event batch, one SQLite transaction
commits: event insert(s) with monotonic seq → envelope mutation → session-record CAS
(`version` check + `leaseToken` check). SSE publication happens strictly **after** commit and
is explicitly non-durable — UI/Cockpit resync from durable reads on reconnect (SSE is a
notification channel, not a delivery guarantee; no outbox is built until a consumer needs
more than resync, per YAGNI with the seam named). Terminalization is a CAS on
(`version`, expected non-terminal state): two would-be settlers (event-drain vs lease sweeper
vs cancel) collapse to one winner; the loser's CAS fails and it stops. The in-memory
`handingOff` flag is replaced by the durable `settlementOwner` + CAS, removing the race window.

**Leases with fencing** (closes R1 C1-8/C1-10). An active session row carries
`leaseToken` (random per SessionRunner instance) + `leaseExpiresAt`, renewed on event commits
and on a heartbeat tick. Every write CASes on the token — a stale runner (paused process,
delayed callback) that lost its lease cannot write. The sweeper takes over only by acquiring a
new token via CAS on the expired one. Parameters are config with stated defaults: lease TTL
60s, heartbeat 15s. Clock semantics (R3 C3-3): the *persisted* `leaseExpiresAt` is wall-clock,
paired with a monotonically increasing `heartbeatSeq`; monotonic time is used only *within* a
process to schedule heartbeats. On boot, all leases are conservatively void — this is a
single-process architecture, so a booting process knows no runner is alive — which sidesteps
wall-clock jumps across restarts entirely; within a running process a wall-clock correction
cannot revive a lease because takeover CASes on the token, not on time alone. A long SQLite
stall past the TTL costs the runner its lease, and its next CAS failing is the designed
outcome, not a corruption. Directive replay is capped (default 3 attempts); a permanently
failing idempotent action orphan-fails the session with a typed audit event rather than
looping. Periodic checkpoints and idle/budget clocks are suspended during `AWAITING_APPROVAL`
and `PAUSED` (nothing is executing; a paused session checkpoint would duplicate the
pause-entry checkpoint).

**What recovery can and cannot reconstruct** (closes R1 C1-8) — enumerated:

| Runtime datum | Recovery source |
|---|---|
| Session state, attempt, origin | session row |
| Event history, last seq | `events` (append-only) |
| Budget counters | recomputed from persisted `usage.updated` events |
| Pending approvals | `approvals` rows (§4) |
| Cancellation intent | `cancelRequested` column |
| Provider session liveness | probe via `providerSessionRef` + manifest `canResume` — a ref is *evidence to probe*, never proof of resumability |
| Adapter handle, event iterator, timers | **not reconstructable** — always re-established via `resume()` or abandoned |
| Ephemeral profile / provision state | provision marker file + `dispose()` idempotency; orphan sweeper deletes unreferenced profiles |

Boot reconcile (improving today's blanket fail-all): for each live-vocabulary session —
probe-resumable → offer/perform resume (new request, `origin: resume`); not resumable →
terminal `FAILED(orphaned)` with a **checkpoint attempt** whose outcome (committed or not) is
recorded on the result (H-I4 is an *attempt + reporting* invariant, not an impossibility
claim — closes R1 C1-9). Cancel order fixed: durable `cancelRequested` → adapter cancel →
drain → checkpoint attempt → terminal CAS.

**Concurrency isolation.** Worktree-per-session (never two assistants in one tree); parallel
competitors are N independent sessions with sibling worktrees; checkpoints are session-scoped
(§4) so a competitor can never commit a sibling's tree.

**Now vs remote-runner era.** All of the above lands in-process now. Deferred to a remote
runner, if ever: cross-process heartbeats, at-least-once event delivery with consumer dedup by
`(sessionId, seq)`, runner authentication. The contract already carries the keys; the seam is
preserved without building it.

---

## 10. Persistence & module map

No new store; ordered SQLite migrations extend the existing schema:

| Table | Change |
|---|---|
| `runs` | is the session table: add `execution_request_id` (UNIQUE), `session_state`, `version`, `lease_token`, `lease_expires_at`, `provider_start_acked`, `cancel_requested`, `settlement_owner`, `attempt`; migrate state vocabulary (§5) |
| `execution_requests` | new: immutable request — policy/verification/origin as JSON + key columns, plus `origin_envelope_id` and `superseded` (0/1) with a **partial unique index** so only one *live* successor per envelope exists while a released claim stays retryable (§7): `CREATE UNIQUE INDEX uq_live_successor ON execution_requests(origin_envelope_id) WHERE origin_envelope_id IS NOT NULL AND superseded = 0`. **The rendered prompt is NOT stored** (settled R2 C2-2 / R3): the row stores the canonical provenance object and `request_fingerprint` (§2) — `prompt_source: fresh\|handoff\|resume`, source ref (checkpoint/envelope id), template version, rendered-prompt digest. Request identity is the fingerprint; exact byte replay is an explicit non-goal (semantic replay re-renders from provenance; the digest witnesses integrity); an `executionRequestId` reused with a different fingerprint is rejected. No unredacted free text lands in this table |
| `approvals` | new: durable approval rows incl. delivery state machine columns (§4) |
| `guard_directives` | new: directive + application status, committed with the triggering event (§4) |
| `execution_results` | new: one row per terminal session, written in the terminal CAS transaction (§2) |
| `handoff_envelopes` | new: typed envelope rows referencing `checkpoints`, with `state: ready\|claimed\|consumed` (§7) |
| `checkpoints` | + `session_id` column (session-scoped resolution, §4) |
| `events` | unchanged shape; additive event types; per-type payload typing in core |
| `handoffs`, `quota_snapshots`, `routing_decisions` | unchanged |

Cross-table constraints (DB-enforced, not convention): `origin.kind = "handoff"` ⇒
`origin_envelope_id` NOT NULL, uniqueness via the partial index above (superseded rows
excluded so a corrected successor is accepted); `origin.kind = "resume"` ⇒ prior session +
checkpoint FK valid; envelope rows FK their checkpoint; results FK their session. These
constraints are load-bearing — they, not recovery code, carry the no-duplicate-continuation
guarantee.

Retention/GC (R1 optional, adopted): execution requests and envelopes follow the existing
30-day completed-task retention; ephemeral profiles and orphaned worktrees are swept by the
existing retention job extended with a provision-marker scan; `providerDetail` and
verification outputs are size-capped at write time.

Code ownership:

| Location | Gains |
|---|---|
| `packages/core` | contract types (§2), session state machine + transitions, `HandoffEnvelope`, `RerouteRequest`, verification types, typed event payloads — types + pure logic only |
| `apps/api/src/modules/harness/` | `SessionRunner`, stage services, guards, workspace authority |
| `apps/api/src/modules/orchestrator.ts` | **shrinks** to Control Plane: task transitions, retry/failover/reroute decisions, parallel compare/race resolution, handoff target selection — calls the Harness, never adapters |
| `packages/adapters` | manifest fields (§6), conformance suite, later `provision()` |
| `api` routes | session/approval/verification reads; approval POST → durable protocol; legacy `state` field served during migration |
| frontend/Cockpit | read-only consumers (§11); no execution logic |

### Migration path (staged, characterization-first — closes R1 C1-16)

The existing 84 tests pin *external* behavior (API + task lifecycle), not the new internals —
so each stage below lands its own tests **before** its cutover, and each stage is
independently shippable and revertible:

0. **Characterization tests** for current orchestrator behavior at its public API (start,
   failover, handoff, approval relay, cancel, parallel) — the safety net the strangler needs.
1. **Contracts + schema**: core types, session state machine, migrations (additive columns,
   state vocabulary rewrite + legacy read mapping). No behavior change.
2. **Session persistence cutover**: runs written/read via session records (CAS, leases,
   start-ack), orchestrator internals unchanged otherwise.
3. **Event path cutover**: EventRecorder transaction protocol replaces inline inserts.
4. **Execution driving cutover**: SessionRunner + guards replace ActiveRun/consume/settle;
   orchestrator delegates; durable approvals replace try-every-run relay.
5. **Decision-side extraction**: failover/retry/parallel/verdict logic remains in the
   (renamed) control-plane orchestrator; Harness API is the only execution path.

Each of 2–5 keeps the public API green against stage-0 tests plus its own new suite.

---

## 11. Agentic OS integration, subtasks, Cockpit

**Flow:** User/Cockpit → intake → decomposition → routing/Composer → `ExecutionRequest` →
Harness → adapter → provider → events/checkpoints/artifacts → verification →
`ExecutionResult` → Control Plane verdict → Cockpit.

**Recursive execution.** Decomposition is Control Plane work: a parent task spawns N subtasks,
each a full `Task` with its own routing decision, request (own assistant/model/policy) and
session, correlated via `correlation` metadata. The Harness is recursion-agnostic — it sees
flat requests; fan-out/fan-in and aggregation live in the Control Plane. A running agent that
discovers new work reports it in the envelope (`outstanding`); it never spawns sessions.

**Observability is durable and correlated** (closes R1 C1-15). `executionRequestId` is the
correlation key threading routing decision → session → events → approvals → checkpoints →
envelope → verification → result; every row above carries it (directly or via `sessionId`).
Guard decisions, enforcement fidelity, lease takeovers, recovery decisions and finalization
attempts are themselves typed audit events in the append-only `events` table — Cockpit reads
durable rows and can distinguish "stage didn't happen" (no event) from "unknown" (nothing is
inferred from SSE, which is resync-notification only).

**Cockpit** (per `../cockpit/docs/specs/E-agentic-os-role.md`) stays a read-only consumer over
the versioned observability capabilities (`contracts.ts`): routing/planning (task `ROUTING`),
queued (`PREPARED`), executing (`RUNNING`), waiting-for-approval, paused, verifying,
completed/failed, handoff (`YIELDED(handoff)` + task `HANDING_OFF`), retry (`attempt > 1`),
reroute (`YIELDED(reroute)`). Drill-down: Task → subtasks → assistant/model → session → phase
→ checkpoints → handoffs → verification → result — all durable reads. No execution logic in
Cockpit.

---

## 12. Testing strategy

Fake adapters (existing `FakeAdapter` pattern: scripted event streams, no live providers),
in-repo SQLite test DBs, the existing vitest stack. Layers:

1. **Pure-unit**: session transition table (property-based sweep: every illegal
   transition throws), guards as pure functions against synthetic snapshots/events, workspace
   authority path/command checks (symlink escape, allowlist, env reduction).
2. **Adapter conformance suite** (runs against fake now, real adapters in CI-with-creds
   later): typed payloads, failure normalization, accounting-mode honesty, usage-reporting
   cadence, approval id uniqueness + repeated-answer semantics, resume semantics. The fake
   adapter cannot validate provider behavior — so an adapter may not *declare*
   `toolGating: preventive`, `processIsolation`, or a bounded-budget cadence until its real
   conformance run has passed; until then Prepare rejects policies that need those claims.
3. **Harness integration (fake adapter)**: approval pause/resume, idempotent re-answer,
   expiry; auto-approve path; denied approval ends without failover; cancellation at each
   state incl. cancel-vs-completion race (CAS settles exactly one winner); hard + idle
   timeout (hard runtime = local clock); bounded budget trip (delta and cumulative
   accounting, reporting-gap cancellation) with prior soft checkpoint;
   `policy_unenforceable` rejections (bounded budget on an adapter without a proven
   usage-reporting cadence, prompt-on-escalation on no-send adapter, preventive tools on
   no-gating adapter);
   checkpoint/resume round-trip; handoff transaction → second fake consumes envelope;
   reroute yield with no Harness-side target; duplicate `executionRequestId` → same session,
   one adapter start; workspace isolation (two parallel sessions, disjoint worktrees,
   session-scoped checkpoints); verification failure after successful execution (outcome
   `completed`, verification failed, plane decides); event seq monotonicity + redaction +
   post-commit SSE.
4. **Fault injection**: crash between STARTING and ack (recovery probes/orphans, never
   double-writes a worktree); kill mid-`RUNNING` then boot reconcile (resume-offer vs
   orphan+checkpoint-attempt); lease expiry with a stale writer (fenced CAS rejected);
   transaction failure between event insert and state CAS (no partial visibility); crash
   between committed event and unapplied guard directive (replay applies exactly once); crash
   between `answered` and `delivered` approval (re-delivery idempotent; conflicting answer
   rejected); crash around envelope claim (partial unique live-successor index blocks a
   second live successor); failed successor during context rendering or provisioning
   verification (envelope released + request superseded, corrected successor accepted);
   pre-start claim expiry (atomic supersede + release); crash after handle persistence but
   before the first provider event (`start_ambiguous`: no expiry release, recovery
   probe settles release vs consume); synchronous `adapter.start()` failure (immediate
   release); isolation minimum-fidelity ordering (`full > partial > ambient`) in core
   contract tests.
5. **Characterization** (migration stage 0): current public-API behavior pinned before any
   cutover.

---

## 13. Invariants (summary)

- **H-I1** Harness never selects/substitutes assistant or model; reroute is a yield, not a swap.
- **H-I2** Task machine (9 states) is Control Plane-only; session machine is run-level only.
- **H-I3** Every session ends in exactly one terminal state (CAS-enforced) and produces exactly one `ExecutionResult`.
- **H-I4** Before yield/cancel/orphan the Harness *attempts* a checkpoint and the result records whether one committed — durability status is reported, never assumed.
- **H-I5** Handoff envelopes contain reconstructable state only — no transcripts, credentials, or CoT; derived from an immutable checkpoint snapshot in one transaction.
- **H-I6** Execution outcome and verification result are separate fields with one canonical derivation; the task verdict is the Control Plane's.
- **H-I7** Harness core has zero provider imports; provider semantics are pinned by the adapter conformance suite.
- **H-I8** `executionRequestId` maps to at most one session row; provider-side execution is at-least-once, stated honestly.
- **H-I9** All persisted execution data passes redaction first; sizes are capped at write time.
- **H-I10** Enforcement the platform cannot provide is rejected at Prepare or explicitly accepted as audit mode — never silently downgraded; the result records actual enforcement fidelity, including the provider-process isolation tier.
- **H-I11** All **Harness-owned** filesystem/process activity passes the workspace authority (canonical roots, allowlist, symlink containment, reduced env, no secret rendering). Provider-process containment is a separately declared isolation tier (§3), reported, never implied.
- **H-I12** Every session write is a CAS under a fencing lease token; at most one settler wins terminalization.
- **H-I13** Unredacted content exists only in the in-memory policy view; every persisted, derived, emitted or logged record is produced from the redacted durable view.
- **H-I14** Every state-changing directive, approval decision and handoff consumption is durable before (or atomically with) its side effect, and replay after a crash is idempotent.
