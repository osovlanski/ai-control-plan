# Autopilot operator runbook

How itay runs the autopilot day to day: set it up, open a window, start it, watch it, stop it, and
clear whatever it leaves for a human. Design: `docs/agentic-os-auto-copilot-plan.md` (§C.2 attempts,
§C.0 who may do what). Backup and restore have their own page, `restore-runbook.md` (added by
PR #188); host setup is `setup/README.md`.

Conventions. Every command runs on the box, as the plane user. The API is loopback only
(`<port>` is the plane's port; 4176 on the reference box). `$OP` is the `autopilot.operate`
secret, typed with `read -rs OP` and never put in a file, a log or this repo. `$CRED` is an
ordinary credential: `tasks.read` for reads, `commands.write` for `stop`. Calls look like
`curl -s -H "Authorization: Bearer $OP" -H 'content-type: application/json' -d '{...}' localhost:<port>/api/autopilot/...`.

## Who may do what

| Action | Route | Needs |
|---|---|---|
| Read state, attempts, publications, externals, report | `GET /api/autopilot`, `/publications`, `/externals`, `/report`, `/restore` | `tasks.read` |
| Stop (`now` or `drain`) | `POST /api/autopilot/stop` | `commands.write` |
| Start, release, windows, attestation, dispatch, requeue, resolve a publication or external, restore reconcile/report | the other `POST` routes | `autopilot.operate` (the operator secret only) |

Stopping is always allowed and starting is not, on purpose.

## 1. One-time setup (box, itay)

1. Host: `setup/README.md` ("Apply"): `sudo ./aos-setup --no-net`, then `sudo ./aos-setup`, then
   `sudo /usr/local/lib/aos/aos-status` must print `ok` on every line. Restart the plane's user
   manager if `ubuntu` was just added to group `aos`.
2. Operator secret: `pnpm --filter @agent-plane/api rotate-operate -- --hash sha256:<hex>`
   (secret made on your own device) or without `--hash` to print one once. Never from an agent session.
3. `<workspace>/config.yaml` needs all of these before a start is accepted. `GET /api/autopilot`
   lists the ones missing under `settings`; a start names the first as `setting`.
   - `execution.harnessModes.single: true`, `execution.agentUser: {}`
   - `composer.enabled: true` and `composer.requireRevision: true`
   - `scheduler.resources: { oci-heavy: 1 }` and `scheduler.admission.oci-heavy: {}` (without
     admission every launch is refused `host_busy`)
   - `autopilot.repos`, `autopilot.backlogRepo` and `autopilot.github.tokenFile` (a 0600 file of the
     plane user). Without them the dispatcher selects nothing and `dispatcher.problems` says why.
   - Optional: `autopilot.heartbeat: { urlFile, intervalMs }` (section 5), `autopilot.backup`
     (restore runbook), `autopilot.approvalMode` (default `auto-approve`).
4. Add the dead-man's-switch check (section 5) and keep a backup before the first window.

## 2. Open a night

1. Billing attestation (D-13). Re-do it before it expires, every `attestationMaxAgeDays` (30):

   ```sh
   curl -s -X POST -H "Authorization: Bearer $OP" -H 'content-type: application/json' \
     -d '{"extraUsageOff":true,"autoReloadOff":true}' localhost:<port>/api/autopilot/attestations
   ```

   Do it only after you checked in the Claude account that both are off. Anything else is
   recorded and admits nothing.
2. A window. Times are ISO instants; it must end in the future, must not overlap another, and
   `maxItems` defaults to `autopilot.itemsPerWindow` (3). A launch needs at least `minSliceMs`
   (10 min) left, and a session's deadline is `graceMs` (2 min) before the close.

   ```sh
   curl -s -X POST -H "Authorization: Bearer $OP" -H 'content-type: application/json' \
     -d '{"opensAt":"2026-11-18T23:00:00Z","closesAt":"2026-11-19T05:00:00Z","maxItems":3}' \
     localhost:<port>/api/autopilot/windows
   ```

3. Check, then start:

   ```sh
   curl -s -H "Authorization: Bearer $CRED" localhost:<port>/api/autopilot     # settings [] , billingAttestation.current true, dispatcher.problems []
   curl -s -X POST -H "Authorization: Bearer $OP" localhost:<port>/api/autopilot/start
   ```

   A `409 autopilot_start_refused` names the `setting` to fix. After a restore the same refusal
   asks for `restore.reconcile` or `restore.report` (restore runbook).
4. Optional: `POST /api/autopilot/dispatch` runs one dispatcher tick now. The timer ticks every
   `dispatchIntervalMs` (60 s) and on every start, release, window change, resolve and settle.

The dispatcher takes the first `queued` or `retryable` item of `docs/progress/backlog.yaml` at a
freshly fetched `origin/main` whose lane is `oci-loop`, is `night: true`, whose repo is in
`autopilot.repos` and whose dependencies are merged, and only while running, inside an open window
with charges left, with a current attestation.

## 3. Watch

- `GET /api/autopilot`: `status` (`stopped`, `draining`, `running`), `stopReason`, the open
  `window` and its `charged`, `nextWindowOpensAt`, the current `attempt`, `billingAttestation`,
  `settings`, `dispatcher`, `restore`.
- Attempt states (§C.2.1). In flight: `reserving`, `admitted`, `running`, `suspended` (cut by the
  window or by a restore, resumes in a later window), `settled`, `accepting`, `accepted`,
  `publishing`, `publish_uncertain`. Final: `published` (a draft PR exists), `closed`, `failed`,
  `blocked`, `cancelled`, `conflict`, `external`.
- A parked task waits in `WAITING_INPUT` with a typed reason: `stopped`, `window_closed`,
  `budget_exhausted`, `billing_expired`, `host_busy`, `composition_unavailable`, `not_owner`.
  `host_busy` retries itself every `hostRetryMs` (2 min). For the others, fix the cause, then
  `POST /api/autopilot/release`: it puts the held task back in the queue and launches nothing by
  itself, so releasing while the cause still holds parks it again. It answers 409 when nothing is held.
- Acceptance evidence for an attempt: `GET /api/autopilot/attempts/<id>/acceptance`.
- Morning report: `node scripts/morning-report.mjs --token-file <file with a tasks.read credential>`
  (`--window <id>`, `--json`), or `GET /api/autopilot/report`. It lists outcomes, runtime, tokens
  and overshoot, charges, stop reason, unresolved remote effects, heartbeat gaps and attestation age.
  Read "Unresolved remote effects" first: every line there waits for you.

## 4. Stop

```sh
curl -s -X POST -H "Authorization: Bearer $CRED" -H 'content-type: application/json' -d '{"mode":"drain"}' localhost:<port>/api/autopilot/stop
curl -s -X POST -H "Authorization: Bearer $CRED" -H 'content-type: application/json' -d '{"mode":"now"}'   localhost:<port>/api/autopilot/stop
```

- `drain`: no new launch; the phase that is running finishes. Status shows `draining`.
- `now` (the default when no mode is given): also cancels a running session (its scope stops),
  finishes the attempt `cancelled`, and stops an acceptance run. Status `stopped`.
- Two things stop it without you: a GitHub 401/403 (`stopReason: github-auth`; put in a new token
  file, then start), and a restore (`stopReason: restored`).
- Independent of the plane, `aos-close.timer` stops every agent scope within a minute of a
  window's close, and each scope has its own `RuntimeMaxSec`. Both bound a dead plane, not a
  hostile agent (`setup/README.md`).

## 5. Heartbeat (D-14)

While the autopilot is not `stopped` (running or draining) the plane sends a bare GET to the URL
in `autopilot.heartbeat.urlFile` every `intervalMs` (default 10 min, minimum 1 min). Set up the
check (Healthchecks.io style, 10 minute period, grace of a few minutes, email to you), put its
URL in a file of the plane user with mode 0600, and set the key. An email means the box, the
plane or the network is down while it should be working. Stopping the autopilot writes a
`paused` row so stopped time is never counted as a gap. The report shows `silence` and `failed`
gaps, or "not tracked" if the key is missing.

## 6. What waits for you

| You see | Meaning | You do |
|---|---|---|
| Attempt `publish_uncertain`, publication in `GET /api/autopilot/publications` | A push or PR create had no readable answer. It is never re-sent on its own. | Look on GitHub for a PR with `aos-publication: <id>`. Then `POST /api/autopilot/publications/<id>/resolve` with `{"action":"retry"}` or `{"action":"abandon"}` (abandon ends the attempt `cancelled`). |
| Attempt `blocked` (for example an approval expired) or `cancelled` | Final. Nothing retries it. | Fix the cause, then `POST /api/autopilot/attempts/<id>/requeue`. It stays final, becomes retryable, and still counts toward `attemptsPerItem` (2). Only `blocked` or `cancelled`, once. |
| Item `blocked` because its `os/<id>` ref holds pushed work | The dispatcher will not reuse a ref that has more than the reservation commit. | Open a PR from it yourself, or delete the ref. |
| Publication `conflict` | A PR for the head exists without our marker, with another's, on another base or at another SHA. | It is not adopted. Decide by hand on GitHub. |
| `external_record` in the report | A restore found a reservation or marker PR it does not know. | Restore runbook, section 4. |
| `autopilot.parked` for `billing_expired` | The attestation is older than 30 days. | Re-attest (section 2), then release. |

## 7. Backup and restore

Before a window, take a backup (`pnpm --filter @agent-plane/api backup`). Nothing runs it on a
schedule yet and nothing copies it off the box: do that by hand. Restore, the report you must read
back and the start that follows are in `restore-runbook.md`.

## Not built yet

The nightly backup timer, the off-host copy (D-11), the replacement-host drill with token and
secret rotation, narrowing the plane user's sudo (`setup/sudoers.d/aos-operator`, needs your OK),
and the proof rows still open in plan §G (G15 live, then G16 and the rest). Codex as a fallback
lane is P1-0 and is not part of this loop.
