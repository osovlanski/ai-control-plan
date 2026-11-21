# Demo journey — goal to verified outcome, in Web and CLI, with fakes only

Status: **recorded (D1).** `pnpm demo:journey` runs this script as
`apps/web/e2e/demo-journey.spec.ts` (Playwright project `demo-journey`) and writes
`demo-out/`. Scenes 4 (its `aos task show` half), 8 and 9 stay `ROADMAP`.

The journey runs about 4 minutes in 9 scenes. It uses the real Web UI, the real
`aos` CLI and a real control plane, with deterministic fake providers and
synthetic data. It needs no provider credentials and makes no model calls.

## 1. Labels

Every scene shows one label on screen, in these words. They mean the same thing
in this page, in `demo-out/scenes.json` and in the captured screenshots.

| Label | Meaning |
|---|---|
| `REAL` | Real plane, real Web UI or CLI code, real routes. |
| `SIM-PROVIDER` | Assistant output is scripted by the `FakeAdapter`. No model ran. |
| `SIM-PR` | Pull request publication runs against an in-process fake GitHub and a local bare repo. No GitHub call is made. |
| `ROADMAP` | Not built. A static card, never presented as working. |

Scenes that mix labels show both (for example `REAL + SIM-PROVIDER`).

## 2. Scenario (synthetic data)

- **Workspace**: a temporary `AGENT_PLANE_HOME` and a scratch git repo `demo-notes` with a README. Nothing from a real workspace is used.
- **Agents**: two fake assistants. `fake-a` ("Claude-like") and `fake-b` ("Codex-like"). The catalogue shows both as "Fake (tests)".
- **Policy**: `approvalMode: prompt-on-escalation`, `execution.harnessModes.single: true`, and the fake Cockpit registry on so the composition preview renders.
- **Task 1**: `Add a changelog entry for the retry fix [FAKE:APPROVAL]`. Covers routing, approval and verification.
- **Task 2**: `Regenerate the API reference [FAKE:LIMIT]`. Covers recovery: a quota hit, a checkpoint, then a handoff to `fake-b`.
- **Same task in Web and CLI**: the CLI scenes talk to the same plane with `AOS_API_URL` and `AOS_CREDENTIAL_FILE` from the temporary home, so the task id on screen in the Web matches the id in the CLI transcript.
- **Time**: the plane runs on the harness's injected clock. No wall-clock waits, and the recording masks ids and timestamps when comparing runs.
- **Credentials**: only `FAKE-*-not-real` values. The run unsets `ANTHROPIC_*`, `OPENAI_*` and `OPENROUTER_*` and asserts that every configured assistant has provider `fake` before the first scene.

## 3. Script

| # | Label | Scene | On-screen caption |
|---|---|---|---|
| 1 | `REAL` | Agents app next to `aos runtimes ls`. | "Two agents are ready." The same lifecycle shows in the Web and in the terminal. |
| 2 | `REAL` | Shell: type the goal for task 1. A route preview shows the chosen agent (`fake-a`), the 2 candidates and the reason, plus a composition preview. | "The route is explained before anything runs." |
| 3 | `REAL + SIM-PROVIDER` | Run: the mission streams planning, tool and file events. | "Agent output is scripted by the fake provider." |
| 4 | `REAL + SIM-PROVIDER` | Approval: an inline approval card appears and the user approves it in the Web, next to the real `aos runtimes show fake-a` transcript. `aos runtimes show` prints no task id, so the task id beside it is the one selected in the Web, on a `ROADMAP` line for `aos task show <id>`. | "Approval is a boundary the plane enforces." The `aos task show <id>` half of this scene is `ROADMAP` until p1-3 slice 1 ships. |
| 5 | `REAL + SIM-PROVIDER` | Verification: the verdict panel shows `test.result` and `verification.result`, then COMPLETED. | "Done means verified, not claimed." |
| 6 | `REAL + SIM-PROVIDER` | Recovery: task 2 hits the fake quota, checkpoints, `fake-a` goes into cooldown and the task is handed off to `fake-b` and completes. The routing history shows both decisions. | "A quota hit becomes a handoff, not a failure." |
| 7 | `SIM-PR` | Publication through the autopilot lane only: one draft PR carrying the `aos-publication` marker, against a fake GitHub and a bare repo with `FAKE-*-not-real` tokens. | "Autopilot publication against a fake GitHub. Interactive tasks don't open PRs yet." |
| 8 | `ROADMAP` | The same task in the CLI: `aos task new … --watch` exiting on the verdict, and `aos approvals`. Shown as text cards. | "Not built yet. Becomes a real scene after p1-3 slices 1 and 2." |
| 9 | `ROADMAP` | Closing card listing what is not built: chat-publish ("Draft PR #N opened · PASS"), subtasks (vNext 10–13) and mobile approvals (U4). | "What is not built yet." |

Pace: scenes 1–6 take about 30 seconds each, scene 7 about 25 seconds and
scenes 8–9 about 20 seconds each. Narration is optional. The captions carry the
message so the recording is understandable muted.

## 4. What is simulated

| Thing | Simulated? | How |
|---|---|---|
| Assistant output, tool calls, file edits | Yes | `FakeAdapter` scripted events. Prompt switches `[FAKE:APPROVAL]`, `[FAKE:LIMIT]`. |
| Test and verification results | Yes | The fake emits `test.result` and `verification.result` with harness mode on. |
| Quota limit and cooldown | Yes | Deterministic `[FAKE:LIMIT]` path on the injected clock. |
| Cockpit registry (composition preview) | Yes | The e2e `fake-cockpit.ts`. |
| Pull request | Yes | In-process fake GitHub (`autopilotGitHub`) and a real `git` CLI against a local bare repo. |
| Routing, approvals, checkpoints, handoff, scheduler, task state | No | Real plane code and real persisted state. |
| Web UI and `aos runtimes` CLI | No | Real code. |
| `aos task new/show`, `aos approvals`, chat-publish, subtasks, mobile approvals | Not built | `ROADMAP` cards only. No ROADMAP scene may call a route that does not exist. |

## 5. Reproducing it

```
pnpm install --frozen-lockfile
pnpm demo:journey            # builds the web app, then runs the demo-journey Playwright project
DEMO_DWELL_MS=20000 pnpm demo:journey   # holds each scene on screen, for a paced recording
```

It writes, under the repository root:

- `demo-out/scenes.json`: each scene's id, label, caption, task id and the routes or commands behind it.
- `demo-out/scenes/<id>.png`: one screenshot per scene, label and caption on screen.
- `demo-out/cli/*.txt`: the `aos runtimes ls` / `show fake-a` transcripts, run against the same plane.
- `demo-out/playwright/…/video.webm` and `trace.zip`.

A second test in the same file runs after the journey: it replaces the run's session cookie,
bootstrap token and bearer in the trace (Playwright records request headers; all three die with
the run's temporary plane) and then scans `demo-out/` for credential values, bearer values and any
`FAKE-*` token that is not `-not-real`.

The plane runs on the harness's injected clock, but the fake adapter stamps its events and its
quota reset time with wall-clock time, so `scenes.json` holds no timestamps and the spec compares
it to the expected script with task ids masked.

## 6. Acceptance for the recording (D1)

1. `pnpm demo:journey` exits 0 from a clean checkout after `pnpm install --frozen-lockfile`, with no provider credentials and outbound network blocked except loopback. It makes no model calls.
2. It writes a video, a trace, one screenshot per scene, the CLI transcripts and `demo-out/scenes.json` listing each scene's id, label, task id and the route or command behind it.
3. The label is visible in every scene's screenshot and the spec asserts it.
4. The task id in scene 4's Web screenshot matches the one in the CLI transcript.
5. Two consecutive runs produce identical `scenes.json` once ids and timestamps are masked.
6. A secret scan of `demo-out/`, the trace and the transcripts finds only `FAKE-*-not-real` tokens, and no bearer, cookie or credential-file contents.
7. This page uses the same words as the on-screen labels.
8. The gate passes (`pnpm typecheck && pnpm lint && pnpm test`) with the observed `pnpm demo:journey` output attached.

## 7. Roadmap

- **D1**: the recorded spec (`apps/web/e2e/demo-journey.spec.ts`, a `demo-journey` Playwright project, `demo:journey` scripts). Scenes 4 and 8 stay `ROADMAP` for the CLI task half.
- **D2**: after p1-3 slices 1 and 2, scenes 4 and 8 become `REAL` CLI scenes on the same task id.
