# Demo A.5 — dependency waits, recurring schedules and the Cockpit scheduling surface

Demo A.5 is the repeatable end-to-end demonstration of the merged kernel-scheduler
slices **K4** (dependency waits) and **K5** (recurring schedules), plus the **K6**
Cockpit surface that presents and commands Control Plane schedule state. Like
Demo A it is an integration and validation artefact: it adds no kernel semantics
of its own.

At completion the product claim it backs is:

> Agentic OS can schedule its own future work, create recurring work, chain tasks
> by dependency, and operate those schedules through Cockpit without Cockpit
> becoming a second scheduler.

## 1. What Demo A.5 proves

| Claim | Evidence |
|---|---|
| A task can wait on other tasks and wakes only when they are terminal | K4: task B is `WAITING_RESOURCE` with `Dependency wait · K4`, the dependency task id and the failure policy on show; task A completing on the FakeAdapter wakes B through the existing generation-aware wake, and B routes and completes with no operator action and no recreation of B |
| A dependency wait is distinct from time / quota / input waits | The Orbital Schedule tab labels the wait `Dependency wait · K4`, separate from `Time wait · K1`, `Quota wait · K2`, `WAITING_INPUT` and approvals; the Cockpit `WAITING_RESOURCE` list uses a per-kind badge |
| A failed dependency applies its policy | K4 failure case: task A fails; the dependant with `onDependencyFailure: "cancel"` moves to `CANCELLED`, condition `cancelled`, `dependency.failed` recorded, and it never routes or starts a provider |
| Self-dependency is rejected at attach | `POST /api/tasks/:id/wait` with `dependsOn: [self]` returns `409` with a named error — K4 guards the wait, not just the wake |
| A recurring schedule creates exactly one task per occurrence | K5: `POST /api/schedules` persists the schedule with a plane-computed `nextFireAt`; one `scheduler.tick()` at the occurrence instant inserts one unique occurrence and one task, advances `nextFireAt`; a duplicate tick at the same instant creates nothing |
| The occurrence task uses the existing K1 dispatch protocol and routes at fire time | The occurrence task carries a `Time wait · K1` condition (`Scheduled occurrence <instant>`), goes through `dispatch.reserved → start_attempted → started`, and routing is decided at the wake, not at schedule creation |
| Cockpit renders plane schedules and `WAITING_RESOURCE` tasks from reads alone | K6: `GET /api/control-plane/schedules` returns the rows with `nextFireAt` **verbatim from the plane** plus a humanized cron for display; `GET /api/control-plane/tasks` surfaces the `WAITING_RESOURCE` dependency task with its `dependsOn` and policy. Cockpit computes no next-fire value |
| Creating a schedule without `commands.write` fails closed | K6: a read-only credential gets `canCreate: false`; a direct `POST /api/control-plane/schedules` returns `403` **and the request never reaches the plane** (the client checks the credential grant before any network call) |
| A `commands.write` credential creates a schedule through the plane | K6: the same reads succeed, and `createSchedule` issues one authenticated `POST /api/schedules` to the plane, which persists it and returns the row with the plane's `nextFireAt` |
| A Control Plane outage isolates only that source | K6: with the plane down, `GET /api/control-plane/schedules` returns `502` (the frontend marks the Agentic OS source stale); an unrelated Cockpit schedule source (`GET /api/scheduled/cloud`) still answers `200` |
| No bearer secret leaks | The Cockpit demo scans every response body and its JSON artefact for the demo credential value and asserts it is absent; the client keeps the secret in a closure and never returns or logs it |

The Orbital positions remain an operator index, not a forecast — see
[`docs/ui/orbital-operator.md`](../ui/orbital-operator.md).

## 2. Why the demo is two commands, not one

K4 and K5 live in `ai-control-plan`; K6 lives in `cockpit`. A single automated
command spanning both would need two live servers and a real cron timer, which is
disproportionate for the slice and is explicitly deferred in
`cockpit/docs/agentic-os-k6-cockpit.md`. Each half is instead proven
deterministically in its own repo, and this runbook is the cross-repo contract.

- **Plane half** (`ai-control-plan`): `pnpm demo:a5` — Playwright `demo-a5`
  project, `apps/web/e2e/demo-a5.spec.ts`, driving the Orbital operator UI
  against a real in-process API + FakeAdapter + injected clock. Proves K4, K5 and
  the K1 dispatch of an occurrence.
- **Cockpit half** (`cockpit`): `npm run demo:a5` — `demoA5.test.ts` under
  `node --test`, booting the real Cockpit Express app against a faithful
  in-process HTTP stub of the plane speaking the API 2.x contract shapes. Proves
  the K6 read/create/gating/isolation behaviour. The persisted scheduler
  semantics (next-fire computation, unique occurrences, K1/K4 wake) are **not**
  re-proven here — the plane half owns that.

## 3. Prerequisites

- Node 22, with `pnpm install` in `ai-control-plan` and `npm install` in
  `cockpit` already run.
- For both deterministic commands: nothing else. In-process servers, temporary
  workspace homes, the deterministic FakeAdapter and a stub plane — no provider
  credentials, no wall-clock waits, no real quota consumption.
- For a real cross-repo walkthrough (section 6): an API credential minted after
  K1 so it carries `schedules.read`; add `commands.write` to it to exercise
  creation. Mint with `pnpm --filter @agent-plane/api rotate`.

## 4. Deterministic demo

```bash
# in ai-control-plan
pnpm demo:a5

# in cockpit
npm run demo:a5
```

`pnpm demo:a5` builds the web app and runs the spec under the Playwright
`demo-a5` project (trace, video, screenshots kept). Artefacts land in
`apps/web/test-results/demo-a5-*-demo-a5/` (git-ignored):

| File | Content |
|---|---|
| `demo-a5-1-dependency-waiting.png` | Task B parked: `Dependency wait · K4`, dependency task id, failure policy |
| `demo-a5-2-dependency-released.png` | After task A completes: B woke, condition `consumed`, dispatch chain, `COMPLETED` |
| `demo-a5-3-dependency-failed-cancel.png` | Failure policy: dependency failed → dependant `CANCELLED`, `dependency.failed` in the log |
| `demo-a5-4-schedule-occurrence-executed.png` | K5 occurrence task: `Time wait · K1` (`Scheduled occurrence …`), full dispatch chain, `COMPLETED` |
| `trace.zip`, `video.webm` | Playwright trace and recording (regenerated every run, not committed) |

The four stills committed under `docs/demo/assets/` come from this run. Refresh
them after a UI change:

```bash
pnpm demo:a5
cp apps/web/test-results/demo-a5-*-demo-a5/demo-a5-[1234]-*.png docs/demo/assets/
```

`npm run demo:a5` in `cockpit` writes a captured-scenario transcript to
`cockpit/docs/demo/demo-a5-cockpit.json` (statuses and response bodies for the
read-only, `commands.write` and outage scenarios) for manual inspection. It has
no browser step: Cockpit's Schedule tab is plain server-rendered markup, and its
K6 wiring is asserted in `controlPlanePublicWiring.test.ts` and `server.test.ts`.
Capture the tab visually during the section 6 walkthrough if a screenshot is
needed.

## 5. Expected state progression

**Scenario B — dependency wait (K4).** `POST /api/tasks` for task A (no wait);
`POST /api/tasks` for task B with `wait: { kind: "dependency", dependsOn: [A],
onDependencyFailure }` → B is `WAITING_RESOURCE`, generation 1, the Schedule tab
shows `Dependency wait · K4`, `WAIT SUBJECTS: <A> · on failure: <policy>` → task A
runs on the FakeAdapter and reaches `COMPLETED` → the terminal event wakes B
(`wake(B, 1, "event")`), B routes and completes, condition `consumed`,
`dispatch.started` in the log. Failure case: A reaches `FAILED` → B with
`onDependencyFailure: "cancel"` → `CANCELLED`, condition `cancelled`,
`dependency.failed` recorded, no dispatch.

**Scenario A — recurring schedule (K5).** `POST /api/schedules` with `{ goal,
cron, timezone }` → `201` with `nextFireAt` computed by the plane in the schedule
timezone; `GET /api/schedules` lists it → advance the clock to the occurrence
instant and `scheduler.tick()` → one occurrence `outcome: "created"`, one task,
`lastFiredAt` set and `nextFireAt` advanced → the occurrence task carries a
`Time wait · K1` condition and is dispatched (`dispatch.reserved → start_attempted
→ started`); routing is decided at that instant → the task completes. A second
`tick()` at the same instant creates nothing.

**Scenario C — authorization (K6).** Read-only credential
(`["schedules.read","tasks.read"]`): `GET /api/control-plane/schedules` →
`canCreate: false`, rows rendered with the plane's `nextFireAt` and a humanized
cron; `GET /api/control-plane/tasks` → the `WAITING_RESOURCE` dependency task;
`POST /api/control-plane/schedules` → `403`, and the plane receives no request.
`commands.write` credential: the same reads, and `POST` issues one authenticated
`POST /api/schedules` to the plane, which returns the persisted row.

**Scenario D — sources (K6).** The Agentic OS / Control Plane source is rendered
distinctly from Cockpit's own local and cloud schedule sources. With the plane
down, `GET /api/control-plane/schedules` returns `502` and the frontend marks
that source stale; `GET /api/scheduled/cloud` still returns `200`. No persistent
plane-schedule cache is introduced — K6 did not implement one.

## 6. Real cross-repo walkthrough (manual)

```bash
# 1. plane on the Oracle machine, loopback only
pnpm --filter @agent-plane/api start        # 127.0.0.1:4176

# 2. a Cockpit pointed at it, with a credential that carries commands.write
CONTROL_PLANE_URL=http://127.0.0.1:4176 \
CONTROL_PLANE_CREDENTIAL_PATH=~/.agent-plane/<workspace>/api-credential.json \
  npm start --prefix ../cockpit          # 127.0.0.1:8787
```

Both bind loopback only. Do not change the bind address, auth mode or firewall to
make the demo easier to reach. From a laptop, forward the ports:

```bash
ssh -N -L 4176:127.0.0.1:4176 -L 8787:127.0.0.1:8787 <user>@<oracle-host>
```

Then in Cockpit's **Schedule** tab:

1. **Agentic OS / Control Plane** → *New recurring schedule* → a goal, a 5-field
   cron a minute or two out, an IANA timezone → the row appears with `nextFireAt`
   **from the plane**; Cockpit shows no next-fire it computed.
2. When the occurrence fires, the plane creates one task and parks it; it appears
   under **Waiting on resources** as a `time` wait with the next check instant.
3. At the instant, the K1 wake routes and runs it — no Cockpit involvement.
4. For a dependency-wait task, the row lists the dependency task ids and the
   failure policy; when the dependency completes, the K4 wake proceeds.

With a read-only credential, step 1's form is replaced by
"This Cockpit credential is read-only (no commands.write) — schedule creation is
disabled", and a direct `POST /api/control-plane/schedules` returns `403`.

## 7. Deliberately not implemented

- **K4b resource slots** (`kind: "resource"`, `maxConcurrent`) and
  **`overlap: "queue"`** — both stay deferred; `overlap` is `skip` only.
- **Edit / enable / disable / delete of plane schedules from Cockpit** — K6 is
  read + create; the K5 API supports the rest and a later slice can expose it
  with no new Cockpit semantics.
- **A persistent Cockpit-side cache of plane schedules** — not implemented; a
  plane outage marks the source unavailable rather than serving stale rows.
- **A single automated command spanning both live servers** — replaced by the two
  deterministic per-repo commands above.
- **K7+ execution identity/catalog, K9+ context lifecycle, K13 model selection.**

## 8. Regression contract

Demo A.5 does not weaken Demo A. Both are kept green:

- `pnpm demo:a` (K1/K2/K3 through the Orbital UI) still passes.
- `apps/api` scheduler, dependency and schedule tests
  (`test/scheduler.test.ts`, `test/schedules.test.ts`, `test/quota-scheduler.test.ts`)
  still pass; `test:harness-on` and `test:recovery-chaos` are unaffected.
- The only production change on the plane side is truthful copy in the Orbital
  Inspector (K4/K5 shown as implemented, not planned); no scheduler semantics
  changed.
- On the Cockpit side no production code changed — `demoA5.test.ts` is additive.

## 9. Defects found

None. Integration surfaced one pre-existing **demo-harness** issue, not a kernel
defect: the Playwright per-test budget (30 s) is too tight for the Demo A / A.5
walkthroughs on a loaded box (Demo A runs ~35 s), so `apps/web/playwright.config.ts`
now sets `timeout: 120_000`. No K4/K5/K6 behaviour was changed.
