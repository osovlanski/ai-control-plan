# Restart and cost basis: live acceptance

On 2026-11-01, `pnpm dev` ran with a scratch workspace, Harness single mode,
Composer and scheduler enabled, and the fake adapter. The web-only preload
`apps/web/e2e/dev-fake-preload.mjs` supplied deterministic events including a
measured `usage.updated.costUsd` of $0.025. No provider credentials or quota
were used.

Task `AG-mvxkw5zz1` started with `[FAKE:LATE_SESSION] [FAKE:APPROVAL]`. The
API child was killed with SIGKILL while its session awaited approval, and the
scratch dev process was restarted against the same database. Recovery recorded
`lease_taken_over`, `directive_replayed` and `resume_offered` and parked the
task in `WAITING_INPUT` (`harness_error`). The task page showed exactly one
Restart button, in the header. Its confirmation called
`POST /api/tasks/AG-mvxkw5zz1/restart`: the old session became CANCELLED, a new
session started, its approval was answered, and the task completed.

Restarting the API invalidates the browser's session cookie, so the driver
resumes on a fresh login with `DRIVE_RECOVER_TASK=<id>`; no task or accounting
rows were edited.

Screenshots (cropped to the main column and palette-compressed):

- [Restart confirmation after recovery](assets/restart-cost-basis/restart-confirmation.png)
- [Completed continuation](assets/restart-cost-basis/restart-completed.png)
- [Measured cost with `in_run` beside the method](assets/restart-cost-basis/measured-in-run.png)

The interrupted session has unknown cost. Its continuation has measured $0.025
with basis `in_run`, so the task aggregate stays a lower bound.

```text
kill -9 API child 14041; task AG-mvxkw5zz1
Restart buttons on the task: 1
{"taskId":"AG-mvxkw5zz1","state":"COMPLETED","costs":[{"method":"unknown"},{"method":"measured","usd":0.025,"basis":"in_run"}]}
sessions: es_bab15006… CANCELLED, es_705c6e72… COMPLETED
```

## Where Restart appears

One per place, never per notice: in the task header whenever the session audit
carries `resume_offered`, and beside an error that names the restart route
(`namesRestartRoute`). Notice cards (failover, handoff) never render it. The
Shell view shows it once, in its status line.

## Reproduce

Create `/tmp/web-restart-drive/personal/config.yaml`:

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
the same command. If the driver then fails on a 401 (the old session cookie),
re-run it with `DRIVE_RECOVER_TASK=<id>`. It checks there is exactly one
Restart button, confirms it, answers the continuation's approval and captures
the completed task and cost view into `docs/demo/assets/restart-cost-basis/`
(uncompressed; compress before committing).
