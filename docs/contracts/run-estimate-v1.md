# Run estimate contract v1

Status: normative for run estimate v1 (API 2.15, backlog `qcq-01-estimates-advisory`, Quality, Cost
& Quota milestone, 2026-11-21). `packages/core/src/run-estimate.ts` is the only implementation; the
api module `apps/api/src/modules/run-estimate.ts` only gathers inputs. No JSON Schema is published
yet: one lands with the first consumer (Cockpit vendoring, `qcq-03-estimate-surfaces`). The Web task
detail (Usage tab) and `aos task estimate` read both routes as served (qcq-03, API 2.16).

The key words MUST, MUST NOT, SHOULD and MAY are used as in RFC 2119.

## Advisory

Both reads are advisory. No dispatch, reservation, budget, schedule, approval or acceptance path
reads them, and a read writes nothing (no routing decision, dispatch or wait). Every recommendation
carries `advisory: true` and `unchanged: ["acceptance tests", "permissions and approval mode",
"spend limits", "dispatch and scheduling"]`. A change that lets either answer affect dispatch or
enforcement is a new contract version and goes through `docs/agentic-os-qcq-review-packet.md`.

## `GET /api/tasks/:id/estimate`

Capability `routing.read`. Query, all optional: `deadline` (ISO instant), `approval=required` (a
human approval, such as a budget approval, precedes the start) and `assistant` (what-if: estimate as
if that assistant were pinned). Unknown task: 404. Bad parameter: 400.

```text
{ taskId, advisory: true,
  routing: { chosen, ruleFired, whatIf },
  estimate: RunEstimate,
  recommendation: ScheduleRecommendation,
  policy: { timezone, eveningsAllowed, weekendsAllowed } }
```

`routing` is the router run over the same pure inputs `routeTask` reads, not persisted.

### RunEstimate

- `estimatorVersion` is `run-estimate/1`. A change to cohorts, quartiles or confidence bumps it.
- `subject`: `assistantId`, `provider`, `model` and `modelSource` (task override; K13 applied; or the
  assistant default, naming a shadow suggestion that was not applied), `effort` and `effortSource`
  (effort is not recorded in the execution identity yet, so it is `null`), `taskKind`.
- `evidence`: `cohort` is the narrowest of `assistant+model+kind`, `assistant+kind`, `assistant` with
  at least 3 ended, non-cancelled runs that ended before `asOf`, else the narrowest non-empty one,
  else `none`. At most the 20 most recent are used. `runIds` lists them. `missing` lists what was
  not available, in words.
- `confidence`: `unknown` with no runs; `low` under 3 runs or at the `assistant` level; `high` at
  the full level with at least 8; else `medium`. The top-level value is the lower of duration and
  token confidence.
- Ranges are nearest-rank quartiles `{ low: p25, typical: p50, high: p75 }`, or `null` when there is
  no evidence. A figure is never invented: no usage evidence means `tokens.input` and
  `tokens.output` are `null` and `tokens.confidence` is `unknown`.
- `tokens`: settled input and output tokens per run (the Composer's max(in-run, records) rule),
  with `runsWithUsage` and `runsMissingUsage`. A run with zero tokens and no usage records counts as
  missing.
- `durationMs`: `ended_at - started_at` of the cohort.
- `waitUntilStartMs`: the latest of the task's active scheduler wait, the proposed assistant's quota
  retry (a recheck time, not observed headroom) and, when `scheduling.accountConcurrency` is set and
  the account is full, the time behind its live runs. `reasons` says which.
- `approvalWait`, apart from the wait until start: `pending` approvals on the task's runs,
  `required` from the query, the share of cohort runs that waited on an approval and their total
  wait.
- `spend` keeps three things apart. `billing` is the provider default (`api` for OpenRouter and
  Bedrock, `subscription` for Anthropic, OpenAI and Cursor, `none` for fakes, else `unknown`;
  `billingBasis: "provider default"`). `apiUsd` is metered dollars, only for `api`.
  `apiEquivalentUsd` is what the tokens would cost on the API, only for `subscription`, and is never
  spend. `subscriptionQuota` is the provider's own usage of the fullest fresh bucket, with
  `perRunShare: "unknown"` because a run's share of a quota is not observable.

### ScheduleRecommendation

`action` is one of `run-now`, `run-in-window`, `wait-for-approval`, `wait-for-quota-reset`, decided
in this order:

1. A pending or required approval: `wait-for-approval`. `startAt` is `null`; `window` is the next
   working-hours span, when an approver is expected.
2. A quota blocker: `wait-for-quota-reset` at the retry.
3. A deadline whose latest start (`deadline - duration.high`) is within `scheduling.dueSoonMs`:
   `run-now`, `speedWeight: 1`.
4. No duration evidence: `run-now`; no window fit can be checked, so nothing is deferred.
5. Inside an allowed evening or weekend span that fits `duration.high`: `run-now`, `speedWeight: 0.5`.
6. In working hours with pressure (typical duration at least `offHoursMinDurationMs`, a quota bucket
   at 80% or more, or the account at its advisory limit) and an allowed off-hours span that fits
   before the deadline: `run-in-window`, `speedWeight: 0.5`. Otherwise `run-now`, `speedWeight: 1`.
7. Outside every allowed span: the next allowed span (work or off-hours) that fits, else `run-now`.

`expectedCompletion` is `startAt` plus the duration range, or `null`. `meetsDeadline` is whether
`startAt + duration.high` is no later than the deadline, or `null`. `reasons` explains the choice
and names local times in the policy's zone. Windows are found at 5-minute resolution over 14 days,
on wall-clock time, so a DST change is handled by the zone database.

## `GET /api/estimates/accuracy`

Capability `routing.read`. Query `limit` 1..500 (default 50). Replays the versioned estimator:
each ended run is estimated from the runs that ended before it started, never from itself, and
compared with what it recorded. Per metric (`duration`, `tokensIn`, `tokensOut`): `evaluated`,
`withinRange` (actual in `[low, high]`), `withinRangeRate`, `medianAbsPctError` (|actual - typical|
/ actual). Also `noEstimate`, `byConfidence` and the per-run `rows`.

## Recorded estimates (qcq-02, API 2.16)

Every run start stores the estimate as it stood at that instant: `GET /api/tasks/:id/estimate`
with `assistant` set to the assistant the run started on (the same what-if an operator can ask
for), written to `run_estimates` (migration 056) right after the run row exists. One row per run;
the table is append-only (update and delete triggers abort). The orchestrator calls the recorder on
all four start paths (legacy and Harness, operator start and scheduler dispatch, parallel
candidates included) and swallows any failure: recording MUST NOT change, delay past the run row,
or fail a start, and no dispatch, budget, schedule or approval path reads the stored rows.

The stored estimate is taken after the run row exists, so `capacity.activeRuns` (and so an account
at its advisory limit) counts the run itself. The actual outcome is not copied: it is read from the
run's own records (`ended_at`, settled usage) when a read joins the two.

### `GET /api/tasks/:id/estimates/recorded`

Capability `routing.read`. Unknown task: 404.

```text
{ taskId, advisory: true,
  records: [{ runId, assistantId, estimatorVersion, recordedAt,
              estimate: RunEstimate, recommendation: ScheduleRecommendation,
              actual: { state, endedAt, durationMs, tokens: { input, output } | null,
                        costUsd, costMethod } | null }] }
```

Oldest first. `actual` is `null` until the run ends. `tokens` is `null` when the run has no usage
evidence, by the same rule as the estimator.

### `GET /api/estimates/accuracy?source=recorded`

`source` is `replay` (default, unchanged) or `recorded`; anything else is 400. `recorded` scores
the stored estimates of the `limit` most recently ended, non-cancelled runs that have one, against
what each run recorded, with nothing re-estimated. `method` names which; each recorded row carries
`estimatorVersion`, the version that produced the stored estimate.

## Config: `scheduling`

All keys optional; unknown keys are a config error. Personal default: `timezone: Asia/Jerusalem`,
`workDays: [0,1,2,3,4]` (Sunday to Thursday), `workHours 09:00–18:00`, `evening 19:00–23:00`
(`allowed: false`), `weekend` days `[5,6]` `10:00–22:00` (`allowed: false`), `dueSoonMs` 4 h,
`offHoursMinDurationMs` 30 min, `accountConcurrency: null`. Other workspaces default to UTC,
Monday to Friday. Evenings and weekends are recommended only once allowed:

```yaml
scheduling:
  evening: { allowed: true }
  weekend: { allowed: true }
```
