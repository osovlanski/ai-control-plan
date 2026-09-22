# M16 Decision Service — Jev (System One) in the Agentic OS kernel

**Status:** Proposed — revision 1 (planning only; nothing in this document is implemented).
**Date:** 2026-09-22
**Written against:** `ai-control-plan` `main@91c9781` (Agentic OS Shell mode over kernel records).
**Owner runbook:** §9 — the OCI apply procedure. Read §0 and §9 first if you are executing this.

**Companion documents:** `docs/agentic-os-kernel-services.md` (M12–M15, K1–K16),
`docs/execution-harness.md` (Harness, guards, approvals), `docs/agentic-os-k13-model-selection.md`
(shadow → gated activation, the precedent this plan copies), `plans/implementation-plan.md`
(Phases 0–5), `docs/agentic-os-eval-plan.md`.

**New designations introduced here:** service **M16 Decision Service**; slices **K17–K22**.
K1–K16 are taken (K15 runtime enum and K16 timer consolidation remain deferred); nothing below
renumbers or reopens them.

---

## 0. The one-paragraph version

Every agent harness contains a classifier that decides, before a tool runs, whether the action is
safe. In Claude Code, Codex and Cursor that classifier is closed. TypeSafe AI's **Jev** makes the
same primitive a public HTTP call: unstructured state in, *typed decisions with probabilities*
out — no generation, nothing to parse. This plan adopts that primitive as a first-class kernel
service (**M16**) behind a provider seam, and uses it for the four places where this control plane
currently guesses with regexes and thresholds: the **tool gate**, the **task classifier**, the
**context breakpoint**, and **failure attribution**. It ships shadow-first, fails closed to the
deterministic rules that exist today, and never lets a probability override a rule that says *no*.

---

## 1. External sources and what each one contributes

| Source | What it actually demonstrates | What this plan adopts | What it rejects |
|---|---|---|---|
| [LangChain — *Building a Harness with Jev*](https://www.langchain.com/blog/building-a-harness-with-jev) | Two decision nodes beside the agent loop: `ModelRouterMiddleware` (pick the cheapest model that can do the task) and `AutoModeMiddleware` (inspect proposed tool calls, block risky ones **before** execution). Explicit framing: this classifier step "has been locked away in the closed source parts of the harness". | The two-node shape — **router at the top, gate at the bottom** — mapped onto our existing `router.ts` and `guards.ts` rather than onto a new agent framework. | LangChain/LangGraph itself. We do not take a framework dependency; we take the pattern. `AutoModeMiddleware` is experimental and Python-only; our harness is TypeScript and already owns the tool boundary. |
| [TypeSafe AI — *Introducing System One Models & Jev*](https://typesafe.ai/blog/introducing-system-one-models-and-jev) + `docs.typesafe.ai` | Three primitives — **Noul** (yes/no → probability 0–1), **Choice** (one of named criteria → `choice` + `probabilities` + `confidence`), **Score** (ordered rubric → `score` + `probabilities` + `confidence`). One `state`, many questions, evaluated in parallel in one request. Single endpoint, Bearer auth. | The primitive set and the request shape, transcribed into our own `packages/core` types so the kernel never imports a vendor SDK. | The performance claims (see §8). "200× faster / 400× cheaper" is a vendor number on classification tasks; this plan measures our own p50/p95 before any activation. |
| [JetBrains Junie / Junie CLI](https://junie.jetbrains.com/docs/junie-cli.html) | Instruction-file precedence with explicit layering (`.junie/AGENTS.md` > root `AGENTS.md` + `.junie/rules/*.md`, legacy `guidelines.md` still honoured), **trust-gated project config** (project `config.json` is read only when the project is trusted), headless CI invocation (`junie --auth="{token}" "…"`), ACP agent-endpoint mode, and `/usage` reporting cost and **which models a session actually used**. | (a) Trust-gating as the model for *which repo may contribute state to a decision* — §4.4; (b) per-session model/cost accounting as an operator surface we already half-have via K7/K14; (c) headless-first parity, which this repo already enforces. | Junie as an adapter. It is a plausible fifth assistant environment, but adding one is a separate slice with its own capability manifest; this plan does not smuggle it in. Recorded as a follow-on in §10. |
| [`ipenywis/laya-ultrafast`](https://github.com/ipenywis/laya-ultrafast) | A working **local, open-weight port** of a hosted typed-decision model: plan **once** with a large text model, then make narrow typed decisions in the hot loop with a 421M-param local model (~33 ms median), combined with deterministic rules. | The strongest architectural argument in the set: **the decision port must have more than one implementation.** Hosted Jev, a cheap structured call to an already-authorized provider, and pure rules are three implementations of one interface. This is what lets the Work workspace run the same gate without gaining a new vendor. | Its runtime. MLX/Apple-Silicon-only is not deployable on the OCI server, and this repo does not host model weights. The *pattern* ports; the implementation does not. |

**The synthesis:** LangChain says *where* the decision nodes go. TypeSafe says *what shape* a
decision has. Junie says *how instruction and trust boundaries scope the state you feed it*. Laya
says *never let one vendor be the only implementation of a hot-path decision*.

---

## 2. Gap matrix — where this control plane currently guesses

Every row cites running code. This is the honest case for M16; rows without a real gap are marked
so that we do not invent work.

| Decision the kernel makes today | How it is made now | Status | Evidence |
|---|---|---|---|
| Is this tool call safe to run? | Substring `allow`/`deny` match, evaluated on `tool.started` — i.e. **after** the tool has begun — and the only outcome is cancelling the whole session | **GAP — the largest one** | `apps/api/src/modules/harness/guards.ts` `toolPolicyGuard()`: `tools.deny?.some(d => name.includes(d))`, then `action: "cancel"`, `failure: tool_denied`. The comment already concedes "in preventive mode the adapter should already have blocked this pre-exec" |
| Should this approval be auto-approved? | Whole-workspace mode: `auto-approve` \| `prompt-on-escalation` \| `read-only`. No per-call judgement | **GAP** | `apps/api/src/config.ts` `ApprovalMode`; `guards.ts` `approvalGuard()` pauses on every `approval.requested` regardless of what is being approved |
| What kind of task is this? | Four regexes over the goal string | **GAP** | `apps/api/src/modules/telemetry.ts:360` `classifyGoal()` — `/\bfix|implement|refactor|add|bug|test|build|migrate\b/` etc. This feeds telemetry cohorts **and** K13 model-selection cohorts, so its error rate propagates into routing |
| Which assistant environment? | Hard filters + deterministic profile rules + telemetry scores, with a persisted explanation | **NO GAP — keep** | `apps/api/src/modules/router.ts` `route()`. Explainable and auditable. M16 may supply an *input*; it never replaces this |
| Which model inside that environment? | K13: priors + own telemetry, blended, shadow by default with an activation gate | **NO GAP — keep, reuse the discipline** | `packages/core/src/model-selection.ts`. The activation-gate pattern in that file is the template §5 copies |
| Is the session at a good point to yield for context? | Pressure threshold only; no notion of a semantic breakpoint | **GAP (secondary)** | `apps/api/src/modules/harness/context-guard.ts` — acts only on `ContextObservation.pressure` |
| Was that failure a quota limit or a transient provider fault? | Event-type driven (`limit.hit` / `limit.approaching`) plus provider error shape | **PARTIAL** | `guards.ts` `quotaGuard()`; `orchestrator.ts` `failoverTask()`. Correct when the provider says so; a guess when it does not |
| How deeply should this change be verified? | Derived from changed files (`impact:frontend` etc.) | **PARTIAL** | `packages/core/src/verification-planner.ts` `planVerification()` |
| Is an agent decision worth checkpointing now? | Soft token threshold (`softThresholdPct`), once | **PARTIAL** | `guards.ts` `budgetGuard()` |

---

## 3. Architecture — M16 sits beside the kernel, never inside a provider

The kernel-services separation is `runtime → harness → model → assets → context`. M16 is
**orthogonal to all five**: it answers bounded questions *about* state that the other layers own,
and it owns no state of its own.

```text
                 ┌──────────────────────────────────────────────┐
  task intake ──►│ K20 Task Classifier   (Choice + Score + Noul)│──► router.ts inputs
                 └──────────────────────────────────────────────┘
                 ┌──────────────────────────────────────────────┐
  pre-tool    ──►│ K19 Tool Gate         (Score + Nouls)        │──► allow | prompt | block
                 └──────────────────────────────────────────────┘
                 ┌──────────────────────────────────────────────┐
  kernel ticks──►│ K21 Kernel Judgements (shadow only)          │──► recorded, not acted on
                 └──────────────────────────────────────────────┘
                              │
                              ▼
                 ┌──────────────────────────────────────────────┐
                 │  DecisionProvider (packages/core/decision.ts)│
                 │   • TypeSafeDecisionProvider  (Jev, hosted)  │
                 │   • ModelDecisionProvider     (Anthropic /   │
                 │       OpenAI structured output — reuses an   │
                 │       already-authorized account)            │
                 │   • RulesDecisionProvider     (today's regex │
                 │       and threshold behaviour — the default  │
                 │       and the fallback, always present)      │
                 └──────────────────────────────────────────────┘
```

### 3.1 Invariants (these are the load-bearing part of this plan)

- **I-D1 — A rule that denies is final.** A probability may *narrow* auto-approval or *add* a
  prompt. It may never override a deterministic deny, widen `policy.approvalMode`, or unblock
  anything the repo allowlist, workspace authority or tool deny-list refused. The gate is a
  *second* lock, never a replacement key.
- **I-D2 — Fail closed, degrade loud.** Any transport error, timeout, `429`, `529`, malformed
  body or low-confidence answer resolves to the **more conservative** outcome, falls back to
  `RulesDecisionProvider`, and writes a `degraded` decision record naming the reason. A gate that
  fails open is worse than no gate.
- **I-D3 — Shadow is the default and the only mode that ships enabled.** Exactly as K13. A
  decision site becomes `applied` only through the activation gate in §5.4.
- **I-D4 — The state is untrusted.** Everything we would send — goal text, file contents, diffs,
  tool arguments, terminal output — is attacker-influenceable. State is redacted, bounded and
  structurally fenced before it leaves (§4.4), and the gate's own prompt cannot be relocated by
  content inside the state.
- **I-D5 — No fabricated confidence.** The repo's standing rule (review §3.4). We record Jev's
  returned probabilities verbatim, and we do not trust them until §7.3 has measured calibration
  against observed outcomes. An unmeasured `confidence` is evidence of a claim, not of a fact.
- **I-D6 — One vendor is never the only implementation.** The laya lesson. `RulesDecisionProvider`
  is always compiled in and always reachable; no build, workspace or test may depend on Jev being
  available.
- **I-D7 — Egress is per-workspace and opt-in.** Personal and Work workspaces decide separately.
  A workspace that has not opted in never emits a byte to a third-party decision vendor; it runs
  `RulesDecisionProvider` or `ModelDecisionProvider` against an account it already trusts.

---

## 4. Domain types and the vendor boundary

### 4.1 Core types — `packages/core/src/decision.ts` (new, pure, no I/O)

```ts
/** The three System One primitives, transcribed. The kernel never imports a vendor SDK. */
export type DecisionQuestion =
  | { kind: "noul";   instructions: string; criteria?: { true?: string; false?: string } }
  | { kind: "choice"; instructions: string; criteria: Record<string, string | null> }
  | { kind: "score";  instructions: string; criteria: readonly string[] };

export type DecisionAnswer =
  | { kind: "noul";   value: number }                                            // P(true), 0..1
  | { kind: "choice"; value: string; probabilities: Record<string, number>; confidence: number }
  | { kind: "score";  value: string; probabilities: Record<string, number>; confidence: number };

export interface DecisionRequest {
  /** Redacted, bounded, fenced. Built only by a DecisionStateBuilder (§4.4). */
  state: DecisionState;
  questions: Record<string, DecisionQuestion>;
  /** Named call site — `tool-gate`, `task-classifier`, … Used for records and activation. */
  site: DecisionSite;
  budgetMs: number;
}

export interface DecisionOutcome {
  answers: Record<string, DecisionAnswer>;
  provider: "typesafe" | "model" | "rules";
  /** Model identity as the provider reported it, never as we assumed it (K7 discipline). */
  modelReported?: string;
  latencyMs: number;
  /** Set whenever the primary provider did not answer. Names the reason, never the secret. */
  degraded?: { from: "typesafe" | "model"; reason: string };
}

export interface DecisionProvider {
  readonly id: "typesafe" | "model" | "rules";
  describe(): DecisionCapability;            // reachability, limits, egress class
  decide(req: DecisionRequest): Promise<DecisionOutcome>;
}
```

### 4.2 Adapter — `packages/adapters/src/typesafe.ts` (new)

Transport only. `POST {baseUrl}/v1/systemone`, `Authorization: Bearer …`, body
`{ state, model, questions }`. Documented account limits to honour: **1,200 req/min**, **64k
context per request (32k for state plus the longest question)**. Documented failures to map
explicitly: `401` (bad key → disable the provider for the process and warn once), `422`
(malformed request → a bug in *our* serializer, surface loudly, never retry blindly), `429` and
`529` (back off, then degrade per I-D2).

Two base URLs are supported from day one, because both appear in the vendor's own docs: the direct
API, and an OpenRouter-compatible route (`~typesafe/jev-latest`). That is not a preference — it is
so that a workspace already routing through OpenRouter (this repo has `openrouter.ts` and an
`OPENROUTER_API_KEY` convention in the README) does not need a second vendor relationship.

### 4.3 The second implementation — `ModelDecisionProvider`

The same `DecisionProvider` interface, answered by a cheap structured-output call to the
Anthropic or OpenAI account the workspace already holds. This is deliberately *not* a fallback of
convenience: it is what makes I-D6 and I-D7 real, and it is the only decision provider the Work
workspace can use before a vendor review clears TypeSafe. It will be slower and more expensive per
call than Jev; §7 measures exactly how much, which is also the honest measurement of Jev's value.

### 4.4 `DecisionStateBuilder` — the untrusted-input boundary (I-D4)

This is the part that most deserves review, and it borrows Junie's trust model.

- **Scoped by workspace trust.** A repo outside `repoAllowlist` contributes **no** content to a
  decision state — only structural facts (path count, whether a path is inside the worktree).
  This mirrors Junie reading project `config.json` only for a trusted project.
- **Redacted first.** The existing `packages/core/src/redaction.ts` runs before any serialization.
  Secrets resolved by `SecretBroker` are excluded by construction (they exist only in the launch
  env map and are already excluded from the reduced verification environment).
- **Bounded.** Hard cap well under the documented 32k state budget, with deterministic truncation
  that is *recorded* — a truncated state is a named condition in the decision record, not a silent
  one.
- **Fenced.** State is sent as a **JSON object with named fields**, never as a concatenated
  string. The documented API accepts an object state, and structure is the cheapest defence
  available: instructions live in `questions`, which content inside `state` cannot reach.
- **Content is never the whole answer.** The gate's questions are asked about *the action*
  (command, paths, network reach, reversibility), with file content as supporting context only.
  A question whose answer can be flipped by a sentence in a README is a question we do not ask.

---

## 5. Slices K17–K22

Each slice is a vertical increment that ends runnable and demonstrable, per the repo's standing
rule. No slice starts until the previous one's success condition is *observed*, not asserted.

### K17 — The seam (no vendor call yet)

- `packages/core/src/decision.ts`: types above + `RulesDecisionProvider`, which reproduces
  today's behaviour exactly — `classifyGoal()`'s regexes as a Choice, the `tools.allow/deny`
  substring match as a Noul, the context pressure threshold as a Score. **No behaviour changes.**
- `DecisionService` in `apps/api/src/modules/decision.ts`: provider registry, per-site budget,
  timeout, single-flight, circuit breaker, fallback chain `typesafe → model → rules`.
- Config: a `decisions:` block in `~/.agent-plane/<workspace>/config.yaml` (§9.2), resolved in
  `apps/api/src/config.ts` alongside the existing fail-closed `models` block.
- Secret handling: `TYPESAFE_API_KEY` is a **reference**, resolved through `SecretBroker` at the
  call boundary — never read directly, never persisted, never in a fingerprint or a diagnostic.

**Done when:** `pnpm typecheck && pnpm test` green; every existing test passes unchanged with the
service installed and `RulesDecisionProvider` selected; no network call exists yet.
**Verdict required:** PASS or SKIP (types/tests only is a legitimate SKIP here).

### K18 — Decision records + shadow plumbing

- Migration: `decision_records` (append-only, per the DB-is-truth rule) — id, workspace, task id,
  session id, `site`, provider, `model_reported`, question-set hash, answers JSON, latency ms,
  input tokens, `mode` (`shadow` | `applied`), `degraded_reason`, `state_truncated`, created_at.
- The rules provider's answer is recorded on **every** call, so a shadow comparison always has a
  baseline even before Jev is reachable.
- `GET /api/decisions` behind a new `decisions.read` observability capability; bump
  `CONTROL_PLANE_API_VERSION` additively (2.1 → 2.2), leaving `NORMALIZED_EVENT_VERSION` at 1.0.
  Existing clients keep working; the capability gates the new endpoint only.

**Done when:** a `pnpm demo:b` run writes decision records for every gate evaluation, readable
over the API, with `provider: "rules"` and `mode: "shadow"` throughout. (`demo:b`, not `demo:a` —
see the correction in §11.)
**Verdict required:** PASS — drive it against a running `pnpm dev` API and paste the rows.

### K19 — The Tool Gate (the slice that justifies the plan)

Wire Jev at the **pre-execution** boundary, which is where `guards.ts` admits it should be and
currently is not.

Question battery (one request, all questions share one state — the documented parallel-evaluation
property is exactly what makes this affordable):

| Key | Type | Asks |
|---|---|---|
| `denied` | Noul | Is this tool call denied by the workspace's tool allow/deny policy? (the rules baseline — see the §11 correction) |
| `risk` | Score `[none, low, medium, high, severe]` | How much damage could this action do if the agent has misunderstood the task? |
| `destructive` | Noul | Does this action delete, overwrite or force-push data that is not recoverable from git? |
| `outside_repo` | Noul | Does this action read or write outside the task's worktree and allowlisted repo? |
| `exfiltration` | Noul | Does this action send repository content to a network destination? |
| `credential_reach` | Noul | Does this action read credentials, tokens, `.env` files or provider config? |

Mapping, subordinate to I-D1:

```text
rules deny                      → block            (rules win; Jev is not consulted for an override)
rules allow + risk ≤ low        → auto-approve     (this is the only widening, and only within approvalMode)
rules allow + risk ≥ medium
  or any Noul ≥ threshold       → prompt operator  (new outcome: was previously silent auto-approval)
provider unreachable / degraded → prompt operator  (I-D2)
read-only workspace             → unchanged        (mode is a ceiling, never raised)
```

**Activation precondition — I-D8 (added 2026-09-22, K19b).** The gate MUST REFUSE to activate
(`mode: applied`) at a site whose registered provider chain contains no judging provider. With
`RulesDecisionProvider` alone, `risk`, `destructive`, `outside_repo`, `exfiltration` and
`credential_reach` are all ABSENT on every call; absence resolves to the conservative outcome per
the no-basis contract and I-D2, so the `rules allow + risk ≥ medium → prompt operator` row would
fire for **every** rules-allowed tool call. That is the exact inverse of the intended behaviour —
the gate would prompt on everything, and an operator drowning in prompts switches it off, which
costs more safety than the gate ever bought. Refusing to activate is therefore not a convenience
check: it is what keeps I-D2's fail-closed posture from degenerating into a fail-noisy one that
gets disabled.

Concretely, at activation the service resolves the site's chain and refuses `applied` unless at
least one registered provider's `describe()` reports it can answer the site's judged keys. The
refusal is loud (config validation, alongside the existing fail-closed `models` block), names the
site, and leaves the site in `shadow` — it never silently downgrades. K19c owns the wiring; this
invariant is stated here because K19c cannot be reviewed without it.

Two structural changes fall out and are part of this slice:

1. `toolPolicyGuard` gains a **`prompt`** outcome. Today its only lever is `cancel`, which kills
   the session for a recoverable disagreement. A gate that can only execute the death penalty is
   not a gate. `DirectiveAction` gains nothing new — `pause` already exists and already routes
   into the durable `ApprovalService` protocol (pending → answered → delivering → delivered),
   which is exactly the machinery this needs and which already handles crash-safety and conflict.
2. The evaluation moves ahead of `tool.started` for adapters that expose a pre-exec hook (Claude's
   `canUseTool` already round-trips through `approval.requested`). Adapters that do not are
   recorded honestly as **audit-tier** enforcement — the manifest already carries an enforcement
   tier and we do not claim preventive enforcement we cannot perform.

**Done when:** in shadow mode, a run containing a deliberately dangerous action (the FakeAdapter's
scripted switches make this deterministic and credential-free) records a `high` risk score and the
prompt that *would* have been raised, while execution is unchanged. Then, with the site activated
in a scratch workspace, the same run pauses for approval and the operator answer is delivered
through the existing approval protocol.
**Verdict required:** PASS with the raw event timeline attached. Ambiguous output is FAIL.

### K20 — Task classifier

Replace the four regexes at the *input* of routing, not inside it.

- `kind`: Choice over the existing labels `coding | review | research | general` — **the same four**,
  because changing the label set would invalidate every telemetry cohort in the database.
- `complexity`: Score `[trivial, small, moderate, large, architectural]` → an input to the K13
  model-selection dimension weighting, still subject to every hard filter (a benchmark prior may
  not bypass a filter, and neither may a classification).
- `needs_repo`, `high_stakes`, `long_horizon`: Nouls, recorded and surfaced in the routing
  explanation.

**Cohort safety — non-negotiable.** Runs classified by M16 carry a `classifier_version`, exactly
as `HARNESS_MAJOR` fences incomparable telemetry. A cohort never spans classifier versions and old
rows are never backfilled. Without this, activating K20 silently poisons K13's evidence.

**Done when:** the shadow report shows the Jev/regex agreement rate over ≥ 200 historical goals
replayed offline, with every disagreement listed for human reading. Activation requires the
disagreements to have been *read*, not merely counted.
**Verdict required:** PASS with the report committed under `docs/eval-history/`.

### K21 — Kernel judgements, shadow only, no activation path in this plan

Recorded and compared, never acted on:

- **Context breakpoint (K11/K9):** Noul — "is this a clean breakpoint to yield and continue in a
  fresh session?" Today the yield lands wherever the pressure threshold falls, which is why the
  continuation is bounded and explicitly "never called lossless".
- **Failure attribution:** Choice `[quota_limit, provider_fault, task_failure, user_stop]` over
  the error state. The repo already distinguishes these (a user-denied approval is an intentional
  stop, not a provider fault); this measures how often the event-driven answer and the classified
  answer differ.
- **Verification depth:** Choice over the plan `verification-planner.ts` would produce.
- **Checkpoint timing:** Score on accumulated meaningful work, against `softThresholdPct`.

**Done when:** each site has ≥ 100 shadow records and a disagreement summary. **Nothing here ships
enabled, and this plan does not grant it an activation path** — that is a separate decision with
its own evidence.

### K22 — Operator surface, eval and calibration

- `eval/scenarios/decision-shadow.ts`, modelled on the existing `model-shadow.ts`.
- `pnpm decision:shadow-report`, mirroring `model:shadow-report`.
- Shell panel: per-site agreement rate, p50/p95 latency, cost, fallback rate, truncation rate.
- **Calibration check (§7.3)** — the piece that makes I-D5 enforceable rather than aspirational.

---

## 6. What this plan deliberately does not do

- **No LangChain, LangGraph or Python runtime.** The pattern ports; the stack does not.
- **No local model weights.** Laya's MLX runtime is Apple-Silicon-only and this repo hosts no
  weights. If a local decision model ever becomes deployable on the OCI host, it is a fourth
  `DecisionProvider` and nothing above it changes — which is the entire point of the seam.
- **No Junie adapter.** Noted as a follow-on in §10.
- **No new infrastructure.** No queue, no cache, no second database. The standing rule holds: none
  of those arrive without a failing requirement that names them.
- **No change to `route()`'s hard filters, the 9-state machine, the normalized event contract, or
  the loopback-only bind.** M16 supplies inputs and a second lock; it does not get a vote on
  architecture that is already settled.
- **No automatic model-level selection changes.** K13 owns that and keeps its own gate.

---

## 7. Evidence, acceptance and the activation gate

### 7.1 Before any site is activated

1. ≥ 14 days of shadow records for that site, or ≥ 500 decisions, whichever comes first.
2. Disagreements with the rules baseline **read by a human**, with the reading recorded.
3. p95 latency within the site's budget (`tool-gate` is in the hot path; a slow gate is a broken
   gate).
4. Measured cost per 1,000 decisions from our own token accounting — not from the vendor's
   comparative claim.
5. Egress test green: a test that asserts exactly what leaves the process for a decision, in the
   spirit of the existing K8 egress verification.
6. Prompt-injection suite green (§7.2).
7. Calibration measured (§7.3).

### 7.2 Prompt-injection suite — mandatory for K19

A classifier placed in the security path becomes a target. Fixtures containing content that
attempts to talk the gate into approving — instructions embedded in READMEs, source comments,
test fixtures, commit messages and tool output — must produce **no reduction in risk score**
relative to the same action without the injected text. A measurable reduction fails the slice and
blocks activation. This suite runs in CI, not once.

### 7.3 Calibration — the standing "no fabricated confidence" rule, enforced

Bucket returned probabilities into deciles and compare each bucket to the observed outcome
frequency (for the tool gate: operator decisions on prompted actions; for the classifier: human
label agreement). A well-calibrated 0.9 is right about 90% of the time. Until a site's buckets are
measured, its `confidence` field is recorded and **not used in any threshold**. This is the same
discipline that made the repo refuse synthetic benchmark scores.

### 7.4 Activation gate — config shape, copying K13

```yaml
decisions:
  provider: typesafe            # typesafe | model | rules   (default: rules)
  egress: opt-in                # per-workspace; Work workspace defaults to `model` or `rules`
  sites:
    tool-gate:
      mode: shadow              # shadow | applied           (default and fail-closed: shadow)
      shadowReviewedAt: ""      # ISO 8601 operator attestation; must span ≥ 7 days, < 30 days old
      egressVerifiedAt: ""      # ISO 8601; expires after 30 days
      calibrationMeasuredAt: "" # ISO 8601; new gate condition specific to M16
      injectionSuitePassedAt: ""# ISO 8601; new gate condition specific to M16
```

`mode: applied` is necessary but **not sufficient** — every attestation must be present, in date,
and the runtime checks must pass, exactly as `evaluateActivationGate()` does for K13. A missing or
expired attestation degrades the site to shadow and says so in the record.

---

## 8. Risks, stated plainly

| Risk | Why it is real | Mitigation in this plan |
|---|---|---|
| **The gate can be talked into approving** | The state contains attacker-influenceable repository content | I-D1 (rules-deny wins), I-D4 (structured state, action-focused questions), §7.2 injection suite in CI |
| **Vendor performance claims are unverified** | "200×/400×" is a vendor number on classification, and early access opened ~2026-09-15 — there is very little independent evidence | Nothing activates on a vendor claim; §7.1(3)(4) measure our own latency and cost, and `ModelDecisionProvider` gives the honest comparison baseline |
| **Repository content leaves for a new vendor** | Decision state contains code | I-D7 per-workspace opt-in, redaction, bounding, egress test; Work workspace defaults away from TypeSafe |
| **Early-access availability and pricing change** | The product is new and behind a waitlist | I-D6: rules provider always compiled in; no test, build or demo may depend on Jev reachability |
| **Latency in the hot loop** | A per-tool-call round trip on every action | Per-site budget, single-flight, circuit breaker; the gate degrades to *prompt*, which is safe, not to *allow* |
| **Silent telemetry poisoning** | A new classifier changes cohort membership | K20's `classifier_version` fence; cohorts never span versions; no backfill |
| **Calibration drift after a model update** | `jev-latest` is a moving selector, exactly like the CLI aliases K13 refuses to resolve | Record `model_reported` per decision (K7 discipline); a changed identity expires `calibrationMeasuredAt` and drops the site to shadow |
| **Over-prompting kills the benefit** | A gate that prompts constantly gets switched off by the operator, which is a worse end state than no gate | Prompt rate is a first-class metric in the K22 panel and a named acceptance criterion, not an afterthought |

---

## 9. OCI runbook — how to execute this plan

### 9.0 Preconditions

```bash
cd ~/workspace/personal/ai-control-plan
git fetch origin main && git status --porcelain     # must be clean
pnpm install --frozen-lockfile
pnpm typecheck && pnpm test                          # must be green BEFORE any change
```

Record the baseline test counts. The repo's rule is that `pnpm typecheck && pnpm test` is the
gate, not the verification — every slice below also names what to *drive*.

### 9.1 Credentials

```bash
# Never in config.yaml, never in git. Session env or the operator's secret store only.
export TYPESAFE_API_KEY="..."          # TypeSafe dashboard (early access)
# Optional alternate route, if this workspace already uses OpenRouter:
#   base_url https://openrouter.ai/api with model ~typesafe/jev-latest
export ANTHROPIC_API_KEY="..."         # already present — ModelDecisionProvider fallback
export OPENAI_API_KEY="..."            # already present — ModelDecisionProvider fallback
```

`.gitignore` already covers local config; confirm with `git check-ignore -v` before the first
commit of any config sample. Provider transcripts and credentials are never committed.

### 9.2 Workspace config

Add the `decisions:` block from §7.4 to `~/.agent-plane/personal/config.yaml`. Leave every site at
`mode: shadow`. Do **not** add it to the Work workspace until §7.1(5) egress evidence exists.

### 9.3 Execution order

| Step | Slice | Gate before moving on |
|---|---|---|
| 1 | K17 seam | `pnpm typecheck && pnpm test` green, existing tests unchanged |
| 2 | K18 records | `pnpm dev`, run `pnpm demo:b`, read rows back over `GET /api/decisions` |
| 3 | K19 tool gate (shadow) | Shadow records for a dangerous scripted action; injection suite green |
| 4 | K20 classifier (shadow) | Offline replay report over ≥ 200 goals, committed to `docs/eval-history/` |
| 5 | K22 report + panel | `pnpm decision:shadow-report` produces a readable report |
| 6 | K21 kernel judgements | Shadow records only; no activation |
| 7 | Activation review | §7.1 checklist complete, per site, with attestations dated |

Each step is one commit on the working branch, with the evidence in the commit body.

### 9.4 Verification protocol

Per `AGENTS.md`: report one verdict — **PASS** (drove it, it did the thing), **FAIL**, **BLOCKED**
(say exactly where it stopped) or **SKIP** (no runtime surface). No partial passes; "3 of 4" is
FAIL. Ambiguous output is FAIL with the raw capture attached. The diff is ground truth.

Drive it where it executes:

```bash
pnpm dev                       # API on 127.0.0.1:4176, web on 127.0.0.1:5176
pnpm demo:a                    # durable waits / quota / idle probe, injected clock, no credentials
pnpm demo:b                    # model intelligence end to end in SHADOW mode
pnpm --filter @agent-plane/web test:e2e
pnpm eval                      # includes the new decision-shadow scenario after K22
```

For the browser surfaces on a headless OCI host, use
`pnpm --filter @agent-plane/api open --headless` and the SSH forwards in
[`docs/headless-open.md`](../docs/headless-open.md). Nothing here requires opening a port.

### 9.5 Rollback

Every slice is reversible by configuration alone: set `decisions.provider: rules` (or remove the
block entirely) and the kernel returns to today's behaviour with no code revert, because
`RulesDecisionProvider` reproduces it exactly. That property is a design requirement of K17, and
it is the first thing to test in step 1 — not an afterthought at step 7.

---

## 10. Follow-ons this plan names but does not take

- **Junie as a fifth assistant environment.** It has a headless CLI with token auth, an ACP agent
  endpoint, session resume and per-session model/cost reporting — a plausible adapter. It needs
  its own capability manifest, its own honest `reportsLimits` answer, and its own slice.
- **Instruction-file layering.** Junie's explicit precedence (`.junie/AGENTS.md` > root
  `AGENTS.md` + `.junie/rules/*.md`) is a cleaner articulation than most harnesses have, and this
  repo's own `AGENTS.md` already states a compatible rule. Worth aligning when the Composer (M2)
  is built, not before.
- **A local decision model.** If a deployable open-weight typed-decision model appears for Linux
  on the OCI host, it is a fourth `DecisionProvider` behind the same interface. The seam exists
  precisely so that this is a small change.
- **`decisions.read` for Cockpit.** The capability lands in K18; the Cockpit-side presentation is
  that repo's slice.

---

## 11. Standing rules this plan inherits

- DB is the source of truth; Markdown is a projection; events are append-only.
- Explanations are persisted for every routing decision, failover — and now every decision record.
- Native SDKs over CLI scraping; fail loud on schema drift.
- **Correction (2026-09-22, K19a):** §5 K18 and the §9.3 step table named `pnpm demo:a` as the
  acceptance vehicle for decision records. That was wrong. `apps/web/e2e/demo-a.spec.ts` never
  sets `execution.harnessModes.single`, so its tasks run the legacy orchestrator path, which has
  no tool gate and therefore evaluates nothing for the gate to record; `demo-b.spec.ts:178` does
  set it. Both references now read `pnpm demo:b`. Demo A itself is unchanged — it is a published
  runbook with committed assets.
- **Correction (2026-09-22, K19a):** the §5 K19 battery listed five questions, none of which
  `RulesDecisionProvider` has a basis for. That contradicts §5 K18 ("the rules provider's answer is
  recorded on **every** call, so a shadow comparison always has a baseline") and I-D1, whose
  `rules deny → block` line is part of the same mapping. `denied` is now the battery's first row:
  one request, one state, one record, with the rules baseline and the judged questions side by
  side. It is the only battery key the rules provider answers; the other five come back absent per
  the no-basis contract on `DecisionProvider`.
- **Correction (2026-09-22, K19b):** §5 K19 specified the mapping from answers to outcomes but
  never stated what happens when no provider can answer the judged questions. Nothing in §5, §7.1
  or §7.4 prevented activating `tool-gate` with only `RulesDecisionProvider` registered — in which
  case the conservative resolution of five absent answers turns every rules-allowed tool call into
  an operator prompt. The activation precondition (I-D8) is now stated in §5 K19: the gate refuses
  `mode: applied` at a site with no judging provider in its chain. §7.1's seven activation
  preconditions are necessary but were not sufficient; this is the eighth, and it is a structural
  check, not an evidence one.
- No new infrastructure without a failing requirement that names it.
- Workspace isolation, explainable routing, approval boundaries and provider-adapter portability
  are preserved by construction — M16 adds a provider seam, it does not pierce an existing one.
- Agentic OS material under `docs/` and `plans/` is proposed design unless implementation evidence
  says otherwise. **This document is proposed design.**
