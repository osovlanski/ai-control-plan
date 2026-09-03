# Execution Harness — Adversarial Review Log

Structured summaries only (findings, decisions, scores, resolutions). No raw model
transcripts are stored here, per AGENTS.md.

**Protocol:** Claude = architecture owner; Codex = adversarial reviewer (fresh findings by ID,
severity critical/high/medium/low, category scores, weighted readiness on the 9-category
rubric below, verdict). Loop until READY_TO_IMPLEMENT (overall ≥ 9.0/10, no CRITICAL, no
unresolved HIGH, boundary accepted by both) or 6 substantive rounds. Reviewer model: CLI
default (config unpinned) — codex-cli 0.151.0.

**Rubric weights:** separation 20% · lifecycle/contract 15% · approval/security/isolation 15%
· portability 10% · checkpoint/handoff 10% · reliability/recovery 10% · observability/
evaluation 10% · feasibility/migration 5% · doc consistency 5%.

**Reviewed artifact:** `docs/execution-harness.md`.

---

## Assumptions ledger (autonomous run — recorded, not interactively confirmed)

1. Agentic OS material is proposed design; only `revised-architecture.md` + code are
   implemented reality — source: AGENTS.md, PROJECT_MEMORY.md.
2. Session run in autonomous mode; claudex-loop's interactive gates (ledger confirmation,
   interrogation, final sign-off) are replaced by the goal's explicit ping-pong protocol and
   readiness gate — source: goal §13–15.
3. The Harness design must compose with, not replace, the 9-state task machine and the
   6-method adapter contract — source: `packages/core/src/state-machine.ts`, `adapter.ts`.
4. SQLite stays the durable system of record; remote runners stay deferred — source:
   ARCHITECTURE.md, ROADMAP.md.

---

## Rounds

### Round 1 — Codex (2026-08-31)

Verdict: **REVISE**. Weighted readiness **3.0/10**. Category scores: separation 4, lifecycle 3,
security 2, portability 4, continuity 3, reliability 2, observability 3, feasibility 3,
docs 3. Findings: 1 critical, 11 high, 4 medium.

| ID | Sev | Finding (summary) |
|---|---|---|
| C1-1 | critical | No mandatory Harness-side authorization boundary for caller-supplied paths and verification commands |
| C1-2 | high | Contradictory verification semantics: `completed`+failed-verification vs `VERIFYING → FAILED` |
| C1-3 | high | Idempotency prevents duplicate rows but not duplicate provider execution across the start gap |
| C1-4 | high | `CheckpointService` reuse as-is resolves worktree from the task row — breaks worktree-per-session |
| C1-5 | high | Session machine is a replacement of `RUN_STATES`, not a refinement; no migration/compat defined |
| C1-6 | high | Approval pause/resume not durable; `send` optional; today's relay guesses the owning run |
| C1-7 | high | "Observed" tool enforcement is not an acceptable implementation of allow/deny security policy |
| C1-8 | high | Recovery claims depend on volatile state the schema does not reconstruct |
| C1-9 | high | Checkpoint-before-yield stated as absolute invariant but only best-effort is possible |
| C1-10 | high | No atomic ordering across event persistence, state transitions, envelope, SSE; settler races |
| C1-11 | high | Hard budget caps unenforceable with optional `UsagePayload` fields and unknown accounting mode |
| C1-12 | high | Handoff ownership duplicated across four places; no atomic relation binding continuation state |
| C1-13 | medium | Pipeline risks an unnamed coordinator god object; no single-writer ownership model |
| C1-14 | medium | Provider neutrality asserted at import level; semantic portability unpinned (untyped payloads) |
| C1-15 | medium | No correlation ID or durable audit records; SSE not a durable delivery mechanism |
| C1-16 | medium | Strangler migration claims 84 tests pin behavior they don't cover; simultaneous cutovers |

### Round 1 — Claude resolution (revision 2 of `execution-harness.md`)

All 16 findings accepted (none rejected). Resolutions:

- **C1-1** → new §3 Workspace Authority: canonical roots, allowlist revalidation at the
  Harness trust boundary, symlink containment, ownership markers, reduced-env command policy;
  verification commands run under it, never via adapter tools. New invariant H-I11.
- **C1-2** → one canonical derivation: `VERIFYING` always exits to `COMPLETED`; verification
  reported separately on the result; `verification_failed` reserved for the plane's task-level
  records. Mapping table updated.
- **C1-3** → guarantee downgraded to at-least-once; start-intent/start-ack protocol
  (`providerStartAcked`); ambiguous-window recovery probes or orphans; provider idempotency
  keys passed where SDKs accept them, recorded in the manifest. H-I8 restated honestly.
- **C1-4** → CheckpointService extended, not reused as-is: session-scoped resolution
  (worktree/branch/baseRef/envelope from the session row); `checkpoints.session_id` column.
- **C1-5** → declared a replacement with an explicit old→new mapping table, SQL migration,
  dual-field API compatibility (`state` legacy + `sessionState`), mixed-version note.
- **C1-6** → durable `approvals` table with UNIQUE (session, provider_request_id), idempotent
  answers, expiry, exact relay; Prepare rejects prompt-on-escalation on adapters without
  `send()` (`policy_unenforceable`).
- **C1-7** → `ToolPolicy.mode: preventive | audit`; preventive unavailable ⇒ Prepare rejects;
  audit is an explicit opt-in recorded on the result. Silent downgrade banned (H-I10).
- **C1-8** → recoverable-data table enumerating recovery source per datum; budget counters
  recomputed from events; pending approvals/cancel intent durable; provider ref treated as
  evidence-to-probe; non-reconstructables always re-established or abandoned.
- **C1-9** → H-I4 rewritten as checkpoint-*attempt* + durability reporting
  (`checkpoint: {attempted, committed}` on the result).
- **C1-10** → transactional commit protocol: per-batch SQLite transaction (events + envelope +
  session CAS with version + lease token); SSE post-commit and explicitly non-durable
  (resync from durable reads); terminalization via CAS — one settler wins. H-I12.
- **C1-11** → `BudgetPolicy.enforcement: hard|advisory`; manifest `usageAccounting:
  delta|cumulative|none`; hard caps rejected at Prepare when unenforceable; lag-permitted
  overrun recorded on the result.
- **C1-12** → single handoff transaction owned by the source SessionRunner: checkpoint +
  envelope (derived from the immutable checkpoint snapshot) + terminal CAS + handoff row
  commit together; routing/recomposition is a separate plane-owned step; crash between the
  two leaves an unconsumed envelope, re-running only the decision step.
- **C1-13** → `SessionRunner` named as the single-writer coordinator; stages return
  values/directives and never write session state; guards are pure functions with counters on
  the durable session record.
- **C1-14** → typed payloads per event type; new manifest capability fields; adapter
  conformance suite as the portability proof (H-I7 restated).
- **C1-15** → `executionRequestId` as the correlation key on every row; guard decisions,
  enforcement fidelity, lease takeovers, recovery and finalization attempts persisted as typed
  audit events; Cockpit reads durable rows only.
- **C1-16** → staged migration: characterization tests first (stage 0), then contracts/schema,
  session-persistence cutover, event-path cutover, execution-driving cutover, decision-side
  extraction — each independently shippable with its own tests.
- Optional improvements adopted: cancellation removed from `FailureKind` (own outcome field),
  `parentTaskId` demoted to opaque `correlation` metadata, per-type `schemaVersion`,
  retention/GC section, size caps, property-based transition tests. Rejected (with reason):
  command/event ownership diagram replacing the pipeline diagram — the single-writer
  SessionRunner section conveys ownership textually; a second diagram adds surface without new
  constraints.

### Round 2 — Codex (2026-08-31)

Verdict: **REVISE**. Weighted readiness **6.7/10**. Category scores: separation 8, lifecycle 8,
security 5, portability 6, continuity 6, reliability 6, observability 7, feasibility 7, docs 7.
Resolved: C1-1, C1-2, C1-3, C1-4, C1-5, C1-8, C1-9, C1-13, C1-15, C1-16.
Unresolved: C1-6, C1-7, C1-10, C1-11, C1-12, C1-14. New findings:

| ID | Sev | Finding (summary) |
|---|---|---|
| C2-1 | high | Workspace authority constrains Harness code but not the provider process; `isolation: full` has no specified containment mechanism |
| C2-2 | high | Persisting immutable `ExecutionRequest` with raw prompt conflicts with redaction vs exact-replay semantics |
| C2-3 | medium | Conflicting approval answers silently treated as idempotent retries |
| C2-4 | medium | `outcome` described as terminal state "verbatim" but is actually derived; vocabulary mismatch |
| C2-5 | medium | Redaction not transactionally ordered before guards/derivation/audit records |

### Round 2 — Claude resolution (revision 3 of `execution-harness.md`)

All findings accepted. Resolutions:

- **C1-6 / C2-3** → approval creation is one transaction (row + `approval.requested` event +
  session CAS); answer lifecycle `pending → answered → delivering → delivered` with durable
  decision before relay, idempotent re-delivery, identical-answer no-op, conflicting-answer
  deterministic rejection + audit event.
- **C1-7 / C1-14** → callable contracts: `RunSpec.toolPolicy` consumed by adapters
  pre-execution (manifest `toolGating: preventive` only valid when consumed; conformance
  proves the gate behaviorally); `RunSpec.runControl.executionRequestId` as provider
  idempotency key; failure-normalization input contract with provider-shaped fixtures.
- **C1-10** → `guard_directives` persisted in the triggering event's transaction with
  `pending → applied` status; idempotent replay of unapplied directives on recovery. H-I14.
- **C1-11** → "hard" token/cost mode removed as unimplementable; `bounded` mode requires
  manifest `usageReportingLagMs` + accounting mode + `pricingVersion` for cost caps;
  reporting-stopped condition defined; `maxRuntimeMs` stays truly hard (local clock).
- **C1-12** → envelope consumption protocol `ready → claimed → consumed`; UNIQUE
  `execution_requests.origin_envelope_id` makes a second successor impossible at the DB layer.
- **C2-1** → workspace-authority scope honesty section: provider process is not contained by
  path canonicalization; `isolation: full` requires declared `processIsolation`
  (os-sandbox/provider-sandbox) verified by provisioning; otherwise partial/ambient reported
  and isolation-demanding requests rejected. H-I11 rescoped to Harness-owned activity.
- **C2-2** → raw prompt not persisted: `execution_requests` stores prompt provenance
  (source kind, source ref, template version, digest); replay re-renders deterministically
  from durable redacted inputs; digest is the integrity witness.
- **C2-4** → `ExecutionResult.terminalState` added verbatim; `outcome` documented as a fixed
  derivation mapping; result row persisted in the terminal CAS transaction.
- **C2-5** → redaction promoted from guard to ingestion boundary applied before guards,
  derivation, audit construction and all persistence paths; equivalent boundaries for
  non-event records. H-I13.
- Optional improvements adopted: `verification_failed` removed from `FailureKind`;
  handle-acquired vs first-event split ack markers; lease TTL/heartbeat/clock defaults and
  SQLite-stall behavior; checkpoint/clock suspension during `AWAITING_APPROVAL`/`PAUSED`;
  cross-table origin constraints; `execution_results` persisted rows; fault-injection tests
  for directive replay, approval delivery, envelope claim. None rejected.

### Round 3 — Codex (2026-08-31)

Verdict: **REVISE**. Weighted readiness **7.2/10**. Category scores: separation 8, lifecycle 8,
security 6, portability 7, continuity 7, reliability 6, observability 8, feasibility 7, docs 7.
Resolved: C1-7, C1-10, C1-12, C1-14, C2-3, C2-4, C2-5. Unresolved: C1-6 (delivery ambiguity),
C1-11 (reporting contract imprecise), C2-1 (full isolation from unverified manifest claim),
C2-2 (prompt exclusion breaks immutable-request/exact-replay claims). New findings:

| ID | Sev | Finding (summary) |
|---|---|---|
| C3-1 | high | Pre-guard redaction blinds security/lifecycle decisions (tool args, identifiers) |
| C3-2 | high | One-shot envelope consumption strands continuation when the claimed successor fails Prepare |
| C3-3 | medium | "Monotonic-adjusted" persisted lease expiry has no restart-safe representation |
| C3-4 | medium | Stale "hard budget" language survives in the §12 test plan |
| C3-5 | medium | Secret-resolution owner contradictory/unnamed |

### Round 3 — Claude resolution (revision 4 of `execution-harness.md`)

All findings accepted. Resolutions:

- **C1-6** → answer delivery declared at-least-once with an explicit `delivery_unknown` state
  after a crash; settlement via provider ack lookup (`approvalAckLookup`) where it exists,
  conformance-proven idempotent re-delivery where proven, otherwise surfaced as ambiguous with
  the session held — no pretended provider semantics.
- **C1-11** → behavioral usage-reporting contract: manifest `usageReporting {cadence,
  maxUnreportedTokens?}` proven by conformance; bounded enforcement evaluates at each
  accounting event; reporting-gap (a full cadence interval with no usage event) cancels;
  residual between-event risk recorded as overrun; unproven cadence ⇒ advisory only.
- **C2-1** → `isolation: full` requires mandatory per-session containment verification bound
  to the exact launch configuration; unverified ⇒ at most `partial` regardless of manifest.
- **C2-2** → exact byte replay declared a non-goal; request identity redefined as
  `requestFingerprint` over a canonical provenance object; semantic replay re-renders from
  durable redacted inputs; reusing an id with a different fingerprint is a rejected conflict.
- **C3-1** → two-view ingestion: unredacted in-memory policy view for guards/normalization/
  correlation (never persisted/logged/emitted); redacted durable view for every persisted or
  derived record. H-I13 rewritten; identifier-preservation regression test added.
- **C3-2** → envelope claim lifecycle gains `claimed → released`; failed successor Prepare
  supersedes the request and releases the envelope transactionally with attempt history;
  partial-unique constraint over non-superseded successors; claims expire via lease TTL.
- **C3-3** → persisted lease expiry is wall-clock + heartbeat seq; monotonic time in-process
  only; boot voids all leases (single-process); takeover CASes on token, not time.
- **C3-4** → §12 test plan reworded to bounded/advisory; "hard" reserved for local runtime.
- **C3-5** → `SecretBroker` named at the launch boundary: capability-scoped, memory-only,
  excluded from verification env, redacted diagnostics, dropped after launch.
- Optional improvements adopted: `delivery_unknown` naming; request payload fingerprint in
  idempotency check; envelope-claim expiry; directive replay cap (default 3) with
  orphan-fail; real-adapter proof required before declaring preventive gating/sandbox/cadence;
  redaction identifier-preservation test. None rejected.

### Round 4 — Codex (2026-08-31)

Verdict: **REVISE**. Weighted readiness **8.3/10**. Category scores: separation 9, lifecycle 8,
security 8, portability 9, continuity 8, reliability 7, observability 9, feasibility 8, docs 8.
Resolved: C1-6, C2-1, C2-2, C3-1, C3-3, C3-4, C3-5. Unresolved: C1-11 (cadence not
quantitative), C3-2 (§10 unconditional UNIQUE contradicts claim release). New findings:

| ID | Sev | Finding (summary) |
|---|---|---|
| C4-1 | medium | `delivery_unknown` has no defined path back into the session lifecycle |
| C4-2 | high | Two independent hard-runtime policy fields (`timeout.hardMs`, `budget.maxRuntimeMs`) with no precedence |
| C4-3 | high | Request fingerprint omits execution/authorization-affecting fields (taskId, attempt, workdir, permission policy, …) |

### Round 4 — Claude resolution (revision 5 of `execution-harness.md`)

All findings accepted. Resolutions:

- **C1-11** → bounded enforcement now requires a fully quantitative, conformance-proven
  contract: `usageReporting { cadence: "per-message" | { periodicMs }, maxUnreportedTokens }`
  with every field mandatory; unproven ⇒ advisory only. Manifest field list updated.
- **C3-2** → §10 now specifies the SQLite partial unique index verbatim
  (`WHERE origin_envelope_id IS NOT NULL AND superseded = 0`) plus the `superseded` column;
  constraints paragraph notes superseded rows are excluded so a corrected successor is
  accepted.
- **C4-1** → `delivery_unknown` keeps the session in `AWAITING_APPROVAL` with a durable
  `approvalDelivery: "unknown"` annotation surfaced through the read API, and four normative
  exits (retry-delivery, cancel, orphan, operator resolution), all Control-Plane-chosen.
- **C4-2** → `budget.maxRuntimeMs` removed; `timeout.hardMs` is the single authoritative
  hard-runtime field owned by `TimeoutGuard`; `RunSpec.env.maxRuntimeMs` is derived and
  validated equal at Prepare.
- **C4-3** → fingerprint redefined over a canonical projection of every execution-affecting
  and authorization-relevant field (taskId, attempt, assistant, model, composition revision,
  routing ref, full runSpec with prompt digest, policy, verification, origin, context refs);
  exclusions limited to `correlation` + `schemaVersion`; canonicalization algorithm + version
  recorded beside the fingerprint.
- Optional improvements adopted: "bounded-cap trip" wording; independent claim duration
  defaulting to lease TTL; operator/API representation of `delivery_unknown`; partial-index
  SQL example inline; canonicalization version recorded. None rejected.

### Round 5 — Codex (2026-08-31)

Verdict: **REVISE**. Weighted readiness **8.4/10**. Category scores: separation 9, lifecycle 8,
security 8, portability 9, continuity 8, reliability 8, observability 9, feasibility 8, docs 8.
Resolved: C1-11, C4-1, C4-2, C4-3. Unresolved: C3-2 (envelope consumed at Prepare — release
point too early: a Context/`adapter.start()` failure after Prepare strands the envelope).
New findings:

| ID | Sev | Finding (summary) |
|---|---|---|
| C5-1 | high | Isolation acceptance policy referenced normatively but absent from the execution contract (binary `isolated\|ambient` cannot express minimum acceptable fidelity) |

### Round 5 — Claude resolution (revision 6 of `execution-harness.md`)

All findings accepted. Resolutions:

- **C3-2** → envelope stays `claimed` through Prepare, Context/provisioning and
  `adapter.start()`; `consumed` commits in the same transaction as the destination session's
  first-event start acknowledgement. Any pre-execution failure (or claim expiry before ack)
  atomically supersedes the request and releases the envelope; ambiguous post-start crashes
  fall under the §9 at-least-once window with continuation via the new session's own
  checkpoints, never a second consumption.
- **C5-1** → `ExecutionPolicy.isolation` is now `{ required: "full" | "partial" | "ambient" }`
  — an explicit minimum-fidelity contract field. Prepare rejects below it; per-session
  verification below it fails the session before `RUNNING`; achieved tier always reported.
- Optional improvements adopted: handoff fault-injection cases for context render,
  provisioning verify and adapter startup failures; claim expiry atomically supersedes the
  owning request; test-plan wording "partial unique live-successor index"; operator
  resolution of `delivery_unknown` decides resume/cancel per the confirmed provider outcome.
  None rejected.

### Round 6 — Codex (2026-08-31)

Verdict: **REVISE**. Weighted readiness **8.6/10**. Category scores: separation 9, lifecycle 8,
security 9, portability 9, continuity 8, reliability 8, observability 9, feasibility 9, docs 8.
Resolved: C5-1. Unresolved: C3-2 (narrowed — normal pre-execution release correct, but claim
expiry in the post-start/pre-ack crash window could hand the envelope to a second successor
while the first provider session may still execute).

### Round 6 — Claude resolution (revision 7 of `execution-harness.md`)

C3-2 fix applied exactly as the reviewer's required change: once `adapter.start()` is
attempted, the claim enters `start_ambiguous` (committed with the durable start intent) and
automatic expiry release is prohibited; only recovery settles it — release when non-execution
is established by probing the start markers, otherwise consume/orphan under the documented
at-least-once semantics; synchronous start failure settles immediately. Optional improvements
adopted: `start_ambiguous` as a distinct claim state; fault-injection case for a crash after
handle persistence before the first provider event; "no duplicate continuation" wording
corrected to name the accepted at-least-once window; isolation fidelity ordering in core
contract tests. None rejected.

**Protocol note (transparency):** rounds 1–6 were the six substantive rounds. The next Codex
pass is a scoped confirmation strictly limited to whether revision 7 resolves C3-2 — no new
design content. If it does not confirm, the verdict is READY_TO_IMPLEMENT: NO at 8.6/10 with
C3-2 as the blocker; the scoring criteria are not weakened.

### Round 6 confirmation — Codex (2026-08-31)

**C3-2: Resolved. VERDICT: APPROVED.** All nine categories 9/10; weighted readiness
**9.0/10**. No critical findings, no unresolved high findings.

## Final gate

- Codex final score: **9.0/10** (all categories 9).
- Claude (architecture owner) final score: **9.2/10** — boundary and contracts judged solid;
  residual honestly-scoped risks listed in `execution-harness.md` (at-least-once
  provider-start window, real-adapter conformance pending implementation, remote runner
  deferred). Disagreement 0.2 < 1.0 → no additional mandatory round.
- Weighted readiness: **9.0/10** ≥ 9.0; no CRITICAL; no unresolved HIGH; Control Plane/Harness
  boundary accepted by both reviewers (separation scored 9/10); invariants H-I1..H-I14
  identified; test strategy defined (design §12); migration judged feasible (design §10,
  feasibility 9/10).
- **READY_TO_IMPLEMENT: YES — 9.0/10.** Implementation plan: `docs/harness-implementation-plan.md`.

**Totals:** 6 substantive rounds + 1 scoped confirmation. 27 findings raised (1 critical,
17 high, 9 medium), all resolved; 0 rejected by the architecture owner; every optional
improvement adopted except one (duplicate ownership diagram, rejected with reason, R1).
