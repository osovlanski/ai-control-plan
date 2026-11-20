# Jev shadow site for model selection: design note

Status: **proposed design, not implemented.** Docs only. Nothing here runs, spends or changes routing until itay approves it (see "Gates before any run").
Extends plan [§D.6](agentic-os-auto-copilot-plan.md) (Jev candidate sites) with a fourth site. §D.6 lists classification, review escalation and prioritisation; model selection is not on that list, so adding it is itay's call. It stays inside §D.6's limits: never the tool gate, never a scheduler, never applied.

## 1. What it is

A new `DecisionSite` value, `model-selection`, answered by `TypeSafeDecisionProvider` (Jev, pinned `jev-1.13`) in **shadow only**. For each routing decision that already produces a K13 recommendation (`routing_decisions.explanation.modelRecommendation`), Jev is asked one `choice` question over the same eligible candidates. Its pick is stored beside K13's. It is never read by routing, `pickModel`, the K13 activation gate, `ExecutionRequest.model` or `RunSpec.model` (CR-33 is untouched). Rules reports no basis for this site (I-D5), so the baseline in each record is K13's recommendation, not a rules answer.

## 2. What Jev reads (the `DecisionState`)

Built after K13's hard filters, so Jev only ever sees candidates that survived them. A candidate that failed a hard filter is not in the state and cannot be picked.

| Field | Source | Notes |
|---|---|---|
| `taskKind`, `classification` weights | `classifyTask()` | labels and numbers only, no task text |
| `candidates[]` | K13 `ModelRecommendation.candidates` with empty `filterFailures` | `label` (`assistant/selector`), price per Mtok, per-dimension blended score, `n` per dimension, prior tier |
| `k13Pick` | withheld | **not** shown to Jev, so the two picks are independent |

Question: `choice`, one key `pick`, criteria keyed by candidate label. Instructions say the state is untrusted data (same `UNTRUSTED` framing as the tool gate) and name no preferred model. One request per decision, bounded by `decisions.budgetMs`. Jev's probabilities are recorded verbatim.

## 3. Privacy and egress

- Egress is `third-party` (I-D7). The site stays off unless itay has approved TypeSafe/OpenRouter egress for it, as he did for floor discovery on 2026-10-21. That approval does not carry over by itself.
- The state holds no prompt, repository path, file content, task title, or workspace name. Only the fields in §2. `scopeDecisionState` must be given an allow-list for the new site, and a test asserts that a task with a secret-shaped title leaves no trace in the serialised state.
- The record stores the question-set hash and the answers, never the state (the `decision_records` invariant).
- Workspace isolation: shadow calls run only for workspaces whose policy already permits `third-party` decision egress. A read-only or no-egress workspace is skipped and logged as `skipped: egress`.

## 4. Log and row shape

No new table is needed for the first cut. Use `decision_records` (migration 025, append-only):

- `site = 'model-selection'`, `provider = 'typesafe'`, `mode = 'shadow'`, `task_id` set, `model_reported` = the versioned Jev id, `input_tokens` from Jev's own accounting, `degraded_reason` set on timeout or error.
- `answers_json` = `{ pick: { kind: "choice", value: "<label>", probabilities, confidence } }`.

The K13 side is already durable in `routing_decisions.explanation`. The report joins the two on `task_id`. A thin read-only report (`pnpm model:jev-shadow-report`, opened read-only with `--db`, like D1 and M6 S4) computes agreement, disagreement rows, latency, cost and the audit below. If a join proves too slow or awkward, a dedicated `model_selection_shadow_log` table (append-only, like `asset_shadow_log`) is the fallback, and that would be the only migration.

**Audit that must be zero:** any Jev pick that is not one of the eligible candidate labels in that decision. Such an answer is discarded, recorded with `degraded_reason = 'pick-outside-eligible-set'`, and counted. It is the same kind of invariant as `countHardFilterViolations`, but it is **not** merged into that gate: Jev's log can never affect K13's activation.

Failure mode: timeout, error or malformed answer means no row for `pick` (no basis), never a default pick. A Jev failure never delays or alters routing; the call is fire-and-forget after the routing decision commits, with its own budget.

## 5. Pass bar (fixed before any run)

All of these, over one contiguous window, or the site stays shadow and is not proposed for anything further:

1. **Safety:** 0 picks outside the eligible set; 0 effect on routing (routing decision identical with the site on and off, the same regression K13 already asserts).
2. **Operations:** answer coverage at least 95%, p95 latency under 500 ms, cost under $0.10 per 1,000 decisions (the §D.6 bar).
3. **Sample:** at least 200 shadow decisions, of which at least 50 disagree with K13.
4. **Quality on disagreements:** on disagreement rows where both picks have cohort telemetry at or above K13's `k`, Jev's pick is not worse than K13's on measured completion rate and median cost, and itay (or a reviewer he names) reads 20 sampled disagreements and finds no pick he would call wrong.

Agreement with K13 is reported, not a bar: matching K13 proves nothing about quality, and the point of the site is the disagreements. Passing this bar only earns a second proposal. It does not activate anything. Applying Jev's pick would need its own plan, its own gate and an explicit owner decision, and §D.6's "never a scheduler" still applies.

## 6. Gates before any run

- **D-7:** the shadow experiment is capped at **$1 on OpenRouter** and needs itay's approval. No spend before that. D-7 as written measures Jev on classification, so itay also has to say whether the same $1 covers this site or this site needs its own line. Rough size: 200 decisions at the §D.6 ceiling is about $0.02, but one request per decision with up to ~10 candidates may run larger than a classifier call, which the first 20 calls would show.
- The live operator config still lacks `typesafeApiKeyRef` and `typesafeRoute` (O2, 2026-11-05). That is itay's secret setup on the box.
- `p1-8-jev-shadow` (classification) runs first. This site reuses its harness, report shape and approval, so it should not start earlier.
- Contract and code come in later PRs: core type and site mapping, state builder with the allow-list, report, then the OCI run. Each is its own slice.

## 7. Open questions for itay

1. Is model selection allowed as a Jev site at all? It extends §D.6.
2. Does D-7's $1 cover this site, or does it get its own cap?
3. Is the quality bar in §5.4 acceptable, given that the pick is never executed and so cannot be scored on its own outcome? The alternative is a small paid A/B on real runs, which is spend and is out of scope here.
4. Should the site be skipped in workspaces with no third-party egress (proposed), or fail closed per workspace config?
