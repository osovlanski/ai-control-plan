# `aos` CLI parity inventory

Status: inventory for `p1-3-aos-cli`. It lists what the Web UI does, which API route each action uses, and which `aos` command covers it, or should. Slice 1 (read-only) has shipped: `apps/cli` has three groups: `status` (`apps/cli/src/status.ts`), `task` with `ls`, `show`, `events [--follow]`, `verdict`, tlm-03's `provenance` and qcq-03's `estimate` (`apps/cli/src/task.ts`), and `runtimes` with nine commands (`apps/cli/src/runtimes.ts`); the entry point is `apps/cli/src/main.ts` and the package `bin` is `apps/cli/bin/aos.mjs`. Rows whose "Today" column is "—" are unbuilt; the "Proposed" column is a plan for them.

Source: the roadmap delta of 2026-11-20 (section A.2 drive against 170e627, matrix A.3, findings F1 to F7). It was not re-driven for this document. Where code and this file disagree, the code wins and this file needs a fix.

Scope rules:

- `aos` talks to the plane only through routes, on loopback, with the workspace credential. It never opens the database and never calls `loadConfig`.
- The CLI reuses the plane's own pure helpers (as `runtimes` does with `apps/web/src/shell/runtime-registry.ts`). It does not recompute routing, approval or verification state.
- Autopilot write routes need the `autopilot.operate` secret, which only the owner holds. They are out of p1-3.
- Read-only commands (slice 1) shipped ahead of `p0-7-replacement-drill` (decision D-D, 2026-11-21: they add no write path). The act half (slice 2) still depends on the drill.

How to run it: `pnpm -s aos …` from the repository root, or `apps/cli/bin/aos.mjs …` (the package `bin`). Both print only the command's output, so `--json` pipes into `jq`. Plain `pnpm aos …` also prints pnpm's script banner on stdout, which breaks a JSON parser (F1).

## Findings F1 to F7

- **F1** (fixed in slice 1): the documented `pnpm aos … --json` is not machine-readable, because pnpm prints its script banner on stdout. `apps/cli/package.json` now has `bin: { aos: ./bin/aos.mjs }`, and this file documents `pnpm -s aos`. `test/cli-hygiene.test.ts` runs the bin in a child process and pipes `--json` into a JSON parser. `pnpm exec aos` from the root still needs the root to depend on the package, which slice 1 does not change (root `package.json` is outside `apps/cli/**`).
- **F2** (fixed in slice 1): a missing credential surfaced as a raw `ENOENT … lstat`. It now says that no workspace credential was found at `<path>`, that you start the plane once (`pnpm dev`) or pass `--credential` or `AOS_CREDENTIAL_FILE`, and exits 1.
- **F3** (fixed in slice 1): provider aliases. `aos runtimes catalog <provider>` now accepts a harness name (`claude-code`, `codex`) when exactly one entry has it, and a miss lists every provider id with its harness name, so "claude" points at `anthropic (harness claude-code)`.
- **F4**: two ways to find credentials. `aos` uses the credential file; `morning-report.mjs` uses `--token-file` or `AGENT_PLANE_TOKEN`. One `connect()` should serve both, which happens when the report moves under `aos autopilot report`.
- **F5**: no read route lists pending approvals. The web derives them from task detail, sessions and events. A CLI `aos approvals` should either import the same pure helper (`execution.ts`), as `runtimes` does, or wait for a plane read. It should not recompute the logic separately.
- **F6**: routes that no web client calls: `POST /api/tasks/:id/composition/opt-ins`, `POST /api/schedules`, `DELETE /api/schedules/:id`, `GET /api/scores`, `GET /api/decisions*`, `GET /api/memory/proposals`, `GET /api/registry/*`, `GET /api/composition/{shadow,asset-usage,asset-scores}`, all of `/api/autopilot/*`, and `/api/sessions/:id/input-{capability,enablement}`. These are natural CLI-first rows.
- **F7** (fixed in slice 1): exit codes were stable in code, but `--help` never stated them. The top-level usage and each group's usage now list them.

## Web action, API route and CLI command matrix

Columns:
- **Today**: what `aos` offers now. "—" means nothing.
- **Proposed**: the command name I suggest.
- **Tier**: P0 = the daily-driver path (goal → watch → approve or stop → verdict), P1 = useful next, V = intentionally visual (no CLI equivalent planned), C = CLI-first (no web caller today, F6).

| Web action (component) | API route | Today | Proposed | Tier |
|---|---|---|---|---|
| Sign in from the launcher (`auth.ts`) | `POST /api/auth/bootstrap` | `pnpm --filter api open` | — (stays a browser flow) | V |
| Workspace header (`App.tsx`, `NewTask.tsx`) | `GET /api/workspace`, `/api/meta`, `/api/health` | **`aos status`** | — | P0 |
| Scheduler readout (`App.tsx`, `readouts.tsx`) | `GET /api/scheduler/status` | **`aos status`** | — | P0 |
| New mission / shell goal (`NewTask.tsx`, `ShellView.tsx:141`) | `POST /api/tasks` | — | `aos task new "<goal>" [--repo] [--profile] [--constraint] [--at <iso>]` | P0 |
| Route preview (`NewTask`, `ShellView`) | `POST /api/tasks/:id/route` | — | `aos task route <id> [--assistant]` | P0 |
| Composition preview (`NewTask`) | `POST /api/tasks/:id/compose` | — | `aos task compose <id>` | P1 |
| Run (`NewTask`, `ShellView`) | `POST /api/tasks/:id/start` | — | `aos task start <id> [--assistant] [--digest]` | P0 |
| Compare / race (`NewTask`) | `POST /api/tasks/:id/parallel` | — | `aos task compare\|race <id> <a> <b>` | P1 |
| Mission list / attention (`useBoard`, `Overview.tsx:29`) | `GET /api/tasks` | **`aos task ls [--attention] [--state] [--stage]`** (`--attention` = the plane's stage `needs-you`) | — | P0 |
| Mission detail (`TaskDetail`, `Inspector`) | `GET /api/tasks/:id`, `/context`, `/wait` | **`aos task show <id>`** (detail, stage from `GET /api/tasks`, and the provenance block) | `/context` and `/wait` are not read yet | P0 |
| Run and handoff provenance (`TaskProvenance`, `TaskDetail` Provenance tab, tlm-03) | `GET /api/tasks/:id/provenance` (API 2.12) | **`aos task provenance <id> [--json]`** (tlm-03); embedded by `aos task show` (same read, same `provenanceText`) | — | P1 |
| Run estimate and recommendation (`TaskDetail` Usage tab, qcq-03) | `GET /api/tasks/:id/estimate` (API 2.15), `GET /api/tasks/:id/estimates/recorded` (API 2.16) | **`aos task estimate <id> [--deadline] [--approval-required] [--assistant]`**, **`aos task estimate <id> --recorded`** (qcq-03) | — | P1 |
| Live activity (`TaskDetail.tsx:50`, SSE) | `GET /api/tasks/:id/events`, `/events/stream` | **`aos task events <id> [--follow] [--json]`** (NDJSON when following; exits when the stage is `done`) | — | P0 |
| Routing evidence (`TaskRouting`, `TaskDetail`) | `GET /api/tasks/:id/routing` | — | `aos task routing <id>` | P1 |
| Sessions, verification (`TaskDetail`, `reads.ts`) | `GET /api/tasks/:id/sessions`, `/api/sessions/:id`, `/verification`, `?groupId`, `?parentTaskId` | **`aos task verdict <id>`** (last ended run: `GET /api/sessions/:id` for a Harness run, else its `verification.result` event; label from the web's `verificationVerdict`) | `aos session show <id>` (not built) | P0 |
| Progress and handoff notes (`TaskDetail.tsx:364,485`) | `GET /api/tasks/:id/files/{progress,handoff}.md` | — | `aos task notes <id>` | P1 |
| Composition history, budget, memory shadow (`Composition.tsx`) | `GET …/composition`, `…/composition/budget`, `/api/composition/memory-shadow` | — | `aos task composition <id>` | P1 |
| Approve / deny (`TaskDetail`, `ShellView`, `MissionShell`) | `POST /api/tasks/:id/input` | — | `aos task approve\|deny <id> [--request <rid>]`, `aos approvals` (F5) | P0 |
| Cancel (`TaskDetail`, `Inspector`, `ShellView`) | `POST /api/tasks/:id/cancel` | — | `aos task stop <id>` | P0 |
| Run now (`Inspector`, `ShellView`) | `POST /api/tasks/:id/run-now` | — | `aos task run-now <id>` | P1 |
| Attach wait (`Inspector`) | `POST /api/tasks/:id/wait` | — | `aos task wait <id> --until <iso> [--quota]` | P1 |
| Checkpoint, list checkpoints (`TaskDetail`, `ShellView`) | `POST /api/tasks/:id/checkpoint`, `GET …/checkpoints` | — | `aos task checkpoint <id> [--list]` | P1 |
| Restart (`TaskDetail`, `Restart.tsx`) | `POST /api/tasks/:id/restart` | — | `aos task restart <id>` | P0 (recovery) |
| Hand off (`ShellView`), handoff history (`TaskDetail`) | `POST /api/tasks/:id/handoff`, `GET …/handoffs` | — | `aos task handoff <id> [--to]` | P0 (recovery) |
| Resolve comparison (`TaskDetail`) | `GET/POST /api/tasks/:id/comparison[/resolve]` | — | `aos task compare resolve <id> <run>` | P1 |
| Follow-up message (`FollowUpComposer.tsx:57`) | `POST /api/sessions/:id/inputs` | — | `aos session say <id> "<text>"` | P1 |
| Delivery recovery (`DeliveryRecovery`, `delivery.tsx`) | `GET /api/inputs/unresolved`, `POST /api/inputs/:id/{retry,cancel}` | — | `aos inputs ls\|retry\|cancel` | P1 |
| Schedules: list, show, overlap (`readouts.tsx`) | `GET /api/schedules[/:id]`, `PATCH /api/schedules/:id` | — | `aos schedule ls\|show\|set-overlap` | P1 |
| *(no web caller)* | `POST /api/schedules`, `DELETE /api/schedules/:id` | — | `aos schedule new\|rm` | C |
| Agents app (`shell/Agents.tsx`) | `/api/assistants*`, `/api/runtimes/catalog`, `/api/cooldowns` | **`aos runtimes …` (9 commands)** | keep; fix F1–F3 | done |
| Models and refresh (`Agents.tsx`) | `GET /api/models[/:id]`, `POST /api/models/refresh` | — | `aos models ls\|show\|refresh` | P1 |
| *(no web caller)* | `GET /api/scores`, `/api/decisions*`, `/api/composition/{shadow,asset-*}`, `/api/memory/proposals`, `/api/registry/*` | DB-reading bins | `aos telemetry …` read-only, over routes | C |
| *(no plane web; Cockpit view is backlogged)* | `GET /api/autopilot`, `/report`, `/scope`, `/publications`, `/externals`, `/restore*`, `/attempts/:id/acceptance` | `scripts/morning-report.mjs` | `aos autopilot status\|report\|attempts\|publications` | C |
| *(no web caller)* | `POST /api/autopilot/{start,stop,dispatch,windows,attestations,release}`, `…/requeue`, `…/resolve` | — | Out of p1-3. They need the `autopilot.operate` secret, which only you hold. A later `aos autopilot` write group would prompt for it, never store it. | C, owner |
| Orbital field, layout, Overview toggle, keyboard palette (`OrbitalField`, `CommandBar`) | reads above | — | none: visual by design | V |
| About, Applications placeholders, Settings text (`About.tsx`, `ApplicationWorkspace.tsx`) | none | — | none | V |
| Composition and verification rendering, mobile approvals (U3, U4) | reads above | — | the data is covered by `task show` / `verdict`; the cards stay visual | V |

**CLI-only workflows worth capturing** (each one is a reason to prefer the CLI, not just matching the web):
1. `aos task new "<goal>" --watch` exits on the verdict: 0 PASS, 1 FAIL, 3 waiting on you (approval or input), 4 blocked. This gives scripts and cron one call from goal to outcome.
2. `aos approvals` across all tasks, plus `aos task approve <id>` when only one request is open. This answers "what needs me" from SSH or a phone terminal.
3. `aos task events <id> --follow --json` as NDJSON, for `jq`, `grep` and log capture.
4. `aos status`, a one-shot health readout (meta, scheduler, cooldowns, unresolved inputs) with a non-zero exit when degraded. The heartbeat and Doctor could reuse it.
5. `aos autopilot report [--scope]`, replacing `morning-report.mjs` with the same output and one way to find credentials (F4).
6. `aos task provenance <id> --json | jq …` (shipped by tlm-03); `aos task show <id> --json | jq .provenance` (shipped by slice 1).

## Planned slices

- Slice 1, read-only inspection and hygiene (**shipped**): `aos status`, `aos task ls|show|events [--follow]|verdict`, fixes for F1, F2, F3 and F7, and observed-call parity rows for the P0 reads (`apps/cli/test/task-parity.test.ts`). Files: `apps/cli/**` only. `aos task routing` and `aos session show` were listed for this slice and are not built; they move to slice 2's read list.
- Slice 2, act: `task new|route|start|approve|deny|stop|restart|handoff`, `aos approvals`, and `--watch` with verdict exits.
- Later: `schedule`, `models`, `inputs`, read-only `autopilot` and `telemetry`, absorbing `scripts/morning-report.mjs`.
- `tlm-03` and `p1-3` both write `apps/cli/**`, so they must not run in parallel. tlm-03 shipped `aos task provenance` first; slice 1's `aos task show` should embed that same read (and `provenanceText`) as its provenance block rather than add another.

## Acceptance for the inventory (from the roadmap delta, A.6)

1. This file lists every route that `apps/web/src/api.ts` and `TaskDetail.tsx` call, each with a CLI command or an explicit V, C or owner reason. A test that fails when a web call has no row is part of p1-3, not of this document.
2. Each P0 row gets an observed-call parity test, from both the web client and the CLI, against a real plane.
3. Each command's `--help` lists its route, the capability it needs, `--json` and the exit codes: 0 ok, 1 failure, 2 usage; `--watch` adds 3 (waiting on you) and 4 (blocked).
