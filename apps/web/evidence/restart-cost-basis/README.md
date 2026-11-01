# Restart and cost basis: live acceptance

On 2026-11-01, `pnpm dev` ran with a scratch workspace, Harness single mode,
Composer and scheduler enabled, and the fake adapter. The web-only preload
`e2e/dev-fake-preload.mjs` supplied deterministic events including a measured
`usage.updated.costUsd` of $0.025. No provider credentials or quota were used.

Task `AG-mvxgijxi1` started with `[FAKE:LATE_SESSION] [FAKE:APPROVAL]`.
The API child (PID 2008640) was killed with SIGKILL while its session awaited
approval. The scratch dev process was restarted against the same database.
Recovery recorded `resume_offered` and parked the task in `WAITING_INPUT`.
The browser's Restart confirmation called POST `/api/tasks/AG-mvxgijxi1/restart`.
The old session became CANCELLED, a new session started, and its new approval
was answered. The task completed.

The browser driver needed retries for slow startup and navigation on this
single-CPU shared host. One retry corrected its assumption that the first
session in the list was the live continuation; session lists include the old,
cancelled session too. No task or accounting rows were edited for this drive.

Screenshots:

- [Restart confirmation after recovery](restart-confirmation.png)
- [Completed continuation](restart-completed.png)
- [Measured cost with `in_run` beside the method](measured-in-run.png)

The interrupted session has unknown cost. The continuation has measured $0.025
with basis `in_run`. The task aggregate remains a lower bound because of that
unknown session; the UI preserves the server's aggregate method.

Raw bounded capture (no credentials or provider transcript):

```text
kill -9 API child 2008640; task AG-mvxgijxi1
{"taskId":"AG-mvxgijxi1","state":"COMPLETED","costs":[{"method":"unknown"},{"method":"measured","usd":0.025,"basis":"in_run"}]}
```

## Reproduce

Create `/tmp/web-restart-drive/personal/config.yaml` with this scratch config:

```yaml
workspace: personal
api: { host: 127.0.0.1, port: 4296 }
assistants:
  fake-a: { provider: fake, enabled: true }
policy: { approvalMode: prompt-on-escalation }
execution: { harnessModes: { single: true } }
scheduler: { enabled: true }
composer: { enabled: true }
```

From the repo root, start:

```sh
AGENT_PLANE_HOME=/tmp/web-restart-drive AGENT_PLANE_WEB_PORT=5296 \
AGENT_PLANE_API_URL=http://127.0.0.1:4296 \
NODE_OPTIONS="--import $PWD/apps/web/e2e/dev-fake-preload.mjs" pnpm dev
```

In another terminal run:

```sh
pnpm --filter @agent-plane/api exec tsx ../web/e2e/drive-restart.ts
```

When it reports SIGKILL, stop and restart the scratch `pnpm dev` process with
the same command. The driver waits for recovery, clicks Restart, answers the
continuation's approval and captures the completed task and cost view.
`DRIVE_RECOVER_TASK=<id>` continues an interrupted browser drive on the same task.

## Verification

The focused browser coverage passed (2 tests), and all 100 web unit tests passed.
`pnpm test` was run twice. The retry stopped in core with 3 timing assertions
failing and 586 tests passing. See the [raw capture](core-gate-failure.txt).
Those thresholds and all core code are unchanged in this web-only branch.
