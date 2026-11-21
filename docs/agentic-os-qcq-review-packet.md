# Quality, Cost & Quota: review packet for dispatch-changing follow-ups

Status: PROPOSED, 2026-11-21. Applies to `qcq-04-account-concurrency` and
`qcq-05-act-on-recommendation` only. `qcq-01` (advisory estimate, API 2.14) changes no dispatch,
budget or schedule and needs none of this. One reviewer, Opus High (or GPT-6.2-Astra High), reads
this packet with the implementation PR. Paid verification runs stay pending itay's budget approval;
any live scheduling change stays pending his rollout approval.

## What changes

- qcq-04: one shared concurrency limit per provider account, across single runs, compare/race
  candidates, autopilot attempts, failover and retries. Proposed shape: a K4b resource claim whose
  key is the account (from the manifest's `core.auth.account`, else the assistant id), claimed inside
  the same wake transaction as the dispatch and released at settle.
- qcq-05: an opt-in that turns a `run-in-window` recommendation into a scheduler `time` wait at the
  window start. Off by default; never for `wait-for-approval`.

## Questions the reviewer must answer, with a test for each

1. Concurrent reservations. Two wakes, a compare/race start and an autopilot attempt race for the
   last slot of one account. Exactly one claims it; the others wait with a `resource` wait, not an
   error. Two assistants on the same account share the limit; an assistant with no account is its
   own account. A config change that lowers the limit below the live claims never cancels a run.
2. Retries. A failover or retry releases the failed attempt's claim before (or atomically with)
   claiming for the next, so a retry cannot deadlock on its own claim, and the K2 retry delays still
   apply. A retry on another account claims there.
3. Restart recovery. A crash between claim and provider start, or between end and release, leaves
   no leaked claim: recovery reconciles claims with live runs and dispatch phases
   (`reserved`, `start_attempted`) before the first new claim. A deferred (qcq-05) wait survives a
   restart and fires once.
4. Quota resets. A reset is a recheck time, not headroom (QuotaProjection). A deferred start at a
   reset re-reads quota at wake; a still-blocked bucket re-waits with backoff and does not loop.
   A window that closes before the wake re-plans rather than starting late into closed hours.
5. Approval boundaries. No path auto-answers an approval, lowers the approval mode, or starts a task
   that a pending approval gates. The autopilot's `approvalMode` stays as configured. Acceptance
   commands, permissions and spend caps (Composer stage 5) are unchanged and still checked.
6. Explainability. Every refusal or wait names the account, the limit, the live claims and, for
   qcq-05, the recommendation (estimator version and evidence run ids) it acted on.

## Evidence to attach

- Gates: `pnpm typecheck && pnpm lint && pnpm test`.
- `pnpm demo:a` / `demo:a5` / `demo:b` with the limit set to 1 and two fake assistants on one
  account (injected clock, no credentials, no quota spend), showing one run and one resource wait.
- A restart test that kills the plane after claim and after end, then shows zero leaked claims.
- For qcq-05: a demo where a recommendation defers a fake task to Sunday 19:00 Asia/Jerusalem and
  the scheduler starts it once after a restart.

## Not in scope

Budget enforcement changes beyond the existing Composer caps, paid runs, and any live change on the
OCI box. Those need itay's explicit approval.
