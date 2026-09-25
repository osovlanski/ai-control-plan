# K20 proposal: task classifier, floors first

Status: PROPOSED, 2026-09-25. Docs only. Nothing in this file is built. It revises the K20 entry in
`plans/jev-decision-service-plan.md` §5 in light of K19i. Where the two disagree, the owner decides.

## 1. Why K20 is next, and what changed since it was written

§5 orders the sites K19 (tool gate), then K20 (task classifier), then K21 (kernel judgements,
which never activate). K19 is done through K19k and waits only on its soak. K20 is the next
decision site.

§5 wrote K20 as "Jev replaces the four regexes". Since then, K19i settled how M16 decides:
deterministic rules decide, and the judge only proposes rules, offline, for a human to accept. This
proposal applies the same rule to the classifier.

## 2. What exists today

| Fact | Where | Consequence |
|---|---|---|
| The same four regexes exist in **three copies** | `apps/api/src/modules/telemetry.ts:360` (`classifyGoal`), `packages/core/src/model-selection.ts:290` (`classifyTaskKind`), `packages/core/src/decision.ts:639` (`classifyGoalRules`) | A change to one copy makes the router, K13 and the decision records disagree without any error. |
| The label is **recomputed from the goal at read time**, for every historical row | `telemetry.ts:68`, `telemetry.ts:242`, `router.ts:259` | Nothing stores a label. Changing the function silently re-cohorts all past telemetry, which is exactly what §5's cohort-safety rule forbids. |
| `\b` anchors only the first and last alternative of each group | the regexes themselves | `add` matches "address" and "padding". `test` matches "latest". `audit` matches anywhere. On the operator DB, "this is a test for checking the control panel tool…" is labelled `coding`. |
| Operator traffic lands almost entirely in `general` | operator DB, 2026-09-25: 13 of 14 goals `general`, 1 `coding` | The label barely separates operator work today. Any cohort keyed on it is effectively one cohort. |
| The site already exists in M16 | `DecisionSite` includes `task-classifier`. `RULES_BASIS` answers `kind` only. `GET /api/decisions?site=task-classifier` is accepted. | Recording needs no new site plumbing. No task-classifier row is written today. |

## 3. Scope

**In scope:**
1. **One classifier function.** Delete two of the three copies. `classifyGoal` and
   `classifyTaskKind` both call a single `classifyTaskV1` in `packages/core`, which stays byte-for-byte
   the current regexes. This step is a pure refactor, pinned by a golden test over the corpus in §6.
2. **Store the label at intake.** Add migration 028: `tasks.task_kind` and
   `tasks.classifier_version`, written once when the task is created. Telemetry reads the stored
   label. A row with no stored label falls back to `classifyTaskV1`, frozen, so every existing
   cohort keeps exactly its current label. Old rows are never backfilled with a newer version.
3. **Rules v2, in shadow.** `classifyTaskV2`, described in §4, is evaluated at intake next to v1.
   Both answers go into one `decision_records` row at site `task-classifier`, `mode: shadow`, with
   the rule that fired. **Routing, K13 weighting and the stored `task_kind` keep using v1.**
4. **The Nouls §5 names** (`needs_repo`, `high_stakes`, `long_horizon`), recorded as answers on the
   same row, each only where a deterministic rule has a basis for it (§4).

**Out of scope:**
- Any change to what routing or K13 reads. Activating v2 is a separate decision (§7).
- Any change to the label set. It stays `coding | review | research | general`, because a new label
  would invalidate every cohort.
- A hot-path model call of any kind.
- K21.

## 4. Floors-first design

The tool gate's contract, carried over to the classifier:

| Tool gate (K19i) | Classifier (K20) |
|---|---|
| A floor is a pure rule with one fixed sentence. | A rule is a pure predicate over the intent: goal, constraints, `repoPath`, overrides. It has a fixed label and one fixed sentence. |
| No floor fires → `approvalMode` decides, exactly as without M16. | No rule fires → **the v1 label stands**. v2 never produces a label on its own. It confirms v1 or overrides it, and each override names its rule. |
| Fail toward supervision: `opaque` prompts. | Fail toward today's behaviour: text a rule cannot read (empty, over the size cap, not Latin script) leaves v1 unchanged. It is recorded as `unread`, never guessed. |
| No-basis contract: absence is never 0 or false. | Same. `complexity` and `long_horizon` have no deterministic basis yet, so they are **absent** from every row, not `moderate` and not `0`. |

Rules for a first version. Each is a proposal to test on the corpus, not a committed list:

| Rule | Answer | Basis |
|---|---|---|
| `needs-repo` | `needs_repo = 1` iff `intent.repository` is set | Structural. This is a fact, not a judgement, so no judge is ever needed for it. |
| `explicit-review` | `kind = review` | "review", "audit" or "critique" as whole words, or a PR or diff reference with no edit verb |
| `explicit-change` | `kind = coding` | An edit verb as a whole word ("fix", "implement", "refactor", "add", "migrate") **and** a code object (file, function, test, branch or repo). This removes today's `add` and `test` substring hits. |
| `read-only-intent` | vetoes `coding` | A constraint or goal clause "do not modify", "read-only" or "no changes". It never assigns a label. It only blocks a `coding` override. |
| `explicit-research` | `kind = research` | "research", "investigate", "compare", "explain" or "why" as whole words, with no edit verb |
| `high-stakes` | `high_stakes = 1` | The goal names an action that a K19i floor would fire on: publish, force-push, a destructive SQL, `infra-destroy`, a deploy to production. This reuses the floor vocabulary. There is no second vocabulary to keep in sync. |

Properties to pin in tests, which mirror `tool-floors.test.ts`:
- Pure and deterministic, with bounded time on hostile input (one size cap, as with the floors'
  64 KiB).
- Every override names exactly one rule, and the v1 label is always recorded next to it.
- **Appended text cannot move v2 away from v1 unless a named rule fires.**
- **No text inside a goal can remove a named rule's conservative label.** This is the owner's
  per-PR test (§7), and the classifier's form of "a floor never removes a prompt". Each rule has
  one conservative answer:
  - `high-stakes`: `high_stakes = 1`.
  - `needs-repo`: `needs_repo = 1`.
  - `read-only-intent`: its veto on `coding`.
  - `explicit-review`: `review`.

  For every corpus goal on which a rule fires, the test inserts each K19h carrier at the start, at
  the end and between every pair of sentences. The rule must still fire with the same answer.
  Text can add a rule firing, but it can never remove one.

## 5. What stays offline

- **The judge.** A `decision:classifier-discovery` job, modelled on `decision:floor-discovery`:
  - It reads goals from a workspace DB (read-only, unmigrated) or from JSONL.
  - It asks the configured judge for `kind`, `complexity`, `high_stakes` and `long_horizon`.
  - For each disagreement with v2, it proposes either a new rule or a change to an existing one.
  - Its output is a markdown report for a human. It writes nothing to routing, to `tasks` or to
    `decision_records`.
- **`complexity` and `long_horizon`.** They stay offline-only until discovery yields a rule with a
  deterministic basis that a human accepts. Until then, K13 keeps its current weighting and never
  sees them.
- **The replay.** The ≥ 200-goal agreement run in §6 is offline, and so is any calibration of the
  judge (§7.3).
- The cost of the judge is paid per report, not per task. Running it nightly, like §7.2, is the
  owner's call.

## 6. Verification protocol

The verdicts follow AGENTS.md: PASS, FAIL, BLOCKED or SKIP, and no partial pass.

1. **Refactor golden test (scope 1).** Over the whole corpus, `classifyTaskV1` returns what each
   of the three current copies returns, label for label. Any difference is FAIL.
2. **Cohort-freeze test (scope 2).** On a copy of the operator DB, `telemetry.scores(kind)` for
   every kind is identical before and after migration 028. A second fixture then stores a v2-era
   label on a new task, and checks that old rows keep their v1 label. Run it against a copy, never
   against the operator DB.
3. **Rule tests (scope 3).** One positive and one negative case per rule. The known substring
   bugs are negatives ("address", "latest"). The hostile-size cap is tested.
4. **Carrier test (per PR, and the activation blocker in place of §7.2).** The property in §4: no
   goal text removes a named rule's conservative label. It runs over every corpus goal on which a
   rule fires × every K19h carrier × every insertion point. One failure is FAIL.
5. **Drive it.**
   - Start `pnpm dev` on a scratch workspace and create one task per rule.
   - Check that `GET /api/decisions?site=task-classifier` returns one row per task, carrying the
     v1 label, the v2 answer, and the rule or `unread`.
   - Check that the routing explanation and `tasks.task_kind` still show v1.
   - Report what was observed, not what the tests assert.
6. **Corpus replay, which is §5's "done when".** At least 200 goals are replayed offline through
   v1, v2 and the discovery judge. The report lists every v1/v2 and v2/judge disagreement, in full
   and not as counts. It is committed under `docs/eval-history/`. A human reads the report, and
   the reading is recorded before any activation discussion.
7. **Workspace suite.** `pnpm typecheck && pnpm test` passes, including `test:recovery-chaos`,
   which is untouched but must stay green.

**Corpus: drafted, waiting for owner approval.** `plans/k20-corpus-draft.jsonl` records each
goal's source:
- `operator-db`: task goals from the operator workspace.
- `eval-scenario`: goals from the harness scenarios under `eval/`.
- `repo-task-goal`: goals found in the repo's tests, fixtures and docs.
- `synthetic`: goals I wrote, labelled as synthetic.

The draft holds 208 goals:

| Source | Count | Notes |
|---|---|---|
| `operator-db` | 6 | Unique goals, verbatim, keyed by task id. |
| `eval-scenario` | 10 | Scenario goals under `eval/`. |
| `repo-task-goal` | 92 | Mostly short test stubs. Template strings are dropped, and `[FAKE:…]` and `[demo …]` markers are stripped. |
| `synthetic` | 100 | Each carries a `probe` tag: substring traps, read-only intent, high-stakes, the four kinds, long-horizon, needs-repo, ambiguous, mixed-language. |

The goals carry no expected labels. Labels come from the human reading in step 6, not from the
drafter.

Per the owner's instruction (2026-09-25), **no replay uses the corpus until the owner approves
it**. Step 6 stays BLOCKED until then.

The judge must never see a goal the owner has not cleared for egress. §7.1(5), the egress test,
applies to discovery just as it does to the gate.

## 7. Activation: not part of K20

In K20, v2 is recorded and never read by routing. Making routing and K13 read v2 would need all of
the following:
- The §7.1 preconditions for this site.
- A new `classifier_version` cohort. It starts empty, as the K13 cohorts do, and is never merged
  with the v1 cohort.
- An owner decision.

**Owner decision, 2026-09-25: §7.2 does not block K20's activation.** K20 reads no judge at
runtime. The same reasoning reclassified §7.2 for the tool gate in K19j. For K20, §7.1(6) is instead
the deterministic per-PR carrier test in §6 step 4: no text inside a goal can remove a named rule's
conservative label. §7.2 still binds any site that does read a judge at runtime (K21). The offline
discovery judge proposes rules and never decides, so §7.2 is a quality metric for it, not a gate.
Before any K20 activation, `plans/jev-decision-service-plan.md` §7.1(6) needs a matching edit.
