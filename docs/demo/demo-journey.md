# Demo journey — goal to verified outcome, in Web and CLI, with fakes only

Status: **recorded (D1, D2).** `pnpm demo:journey` runs this script as
`apps/web/e2e/demo-journey.spec.ts` (Playwright project `demo-journey`) and writes
`demo-out/`. D2 added the phone scene (7) and turned the CLI halves of scenes 4 and 9
into real read-only `aos task` commands on the same task id. Only `aos task new`,
`aos approvals` and scene 10 stay `ROADMAP`.

The journey runs about 4 minutes in 10 scenes. It uses the real Web UI, the real
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

Scenes that mix labels show both (for example `REAL + SIM-PROVIDER`, or `REAL + ROADMAP` where a real terminal sits next to a not-built command).

## 2. Scenario (synthetic data)

- **Workspace**: a temporary `AGENT_PLANE_HOME` and a scratch git repo `demo-notes` with a README. Nothing from a real workspace is used.
- **Agents**: two fake assistants. `fake-a` ("Claude-like") and `fake-b` ("Codex-like"). The catalogue shows both as "Fake (tests)".
- **Policy**: `approvalMode: prompt-on-escalation`, `execution.harnessModes.single: true`, and the fake Cockpit registry on so the composition preview renders.
- **Task 1**: `Add a changelog entry for the retry fix [FAKE:APPROVAL]`. Covers routing, approval and verification.
- **Task 2**: `Regenerate the API reference [FAKE:LIMIT]`. Covers recovery: a quota hit, a checkpoint, then a handoff to `fake-b`.
- **Task 3**: `Update the release notes [FAKE:APPROVAL]`. Covers the phone scene. `fake-a` is cooling down after task 2, so the route picks `fake-b`.
- **Same task in Web and CLI**: the CLI scenes talk to the same plane with `AOS_API_URL` and `AOS_CREDENTIAL_FILE` from the temporary home, so the task id on screen in the Web matches the id in the CLI transcripts (scenes 4 and 9 both use task 1).
- **Time**: the plane runs on the harness's injected clock. No wall-clock waits, and the recording masks ids and timestamps when comparing runs.
- **Credentials**: only `FAKE-*-not-real` values. The run unsets `ANTHROPIC_*`, `OPENAI_*` and `OPENROUTER_*` and asserts that every configured assistant has provider `fake` before the first scene.

## 3. Script

| # | Label | Scene | On-screen caption |
|---|---|---|---|
| 1 | `REAL` | Agents app next to `aos runtimes ls`. | "Two agents are ready." The same lifecycle shows in the Web and in the terminal. |
| 2 | `REAL` | Shell: type the goal for task 1. A route preview shows the chosen agent (`fake-a`), the 2 candidates and the reason, plus a composition preview. | "The route is explained before anything runs." |
| 3 | `REAL + SIM-PROVIDER` | Run: the mission streams planning, tool and file events. | "Agent output is scripted by the fake provider." |
| 4 | `REAL + SIM-PROVIDER` | Approval: an inline approval card appears and the user approves it in the Web, next to the real `aos runtimes show fake-a` and `aos task show <id>` transcripts for the same task id. | "Approval is a boundary the plane enforces." |
| 5 | `REAL + SIM-PROVIDER` | Verification: the verdict panel shows `test.result` and `verification.result`, then COMPLETED. | "Done means verified, not claimed." |
| 6 | `REAL + SIM-PROVIDER` | Recovery: task 2 hits the fake quota, checkpoints, `fake-a` goes into cooldown and the task is handed off to `fake-b` and completes. The routing history shows both decisions. | "A quota hit becomes a handoff, not a failure." |
| 7 | `REAL + SIM-PROVIDER` | Phone: a phone-sized viewport on task 3. The page is locked mid-run (tab hidden, network offline, live stream frames dropped), the fake asks for approval meanwhile, then the page returns. Every durable event is shown once, the pending approval is back, and one tap (even doubled) sends exactly one answer. | "Lock the phone and come back: the events and the approval are still there. One tap approves once." |
| 8 | `SIM-PR` | Publication through the autopilot lane only: one draft PR carrying the `aos-publication` marker, against a fake GitHub and a bare repo with `FAKE-*-not-real` tokens. | "Autopilot publication against a fake GitHub. Interactive tasks don't open PRs yet." |
| 9 | `REAL + ROADMAP` | The same task 1 in a real terminal: `aos task ls` and `aos task verdict <id>` (full `aos task events <id>` in the transcript). Below them, `aos task new … --watch` and `aos approvals` as text cards that call nothing. | "The same task from the terminal. Creating and approving from the CLI is not built yet." |
| 10 | `ROADMAP` | Closing card listing what is not built: chat-publish ("Draft PR #N opened · PASS"), subtasks (vNext 10–13), approving from Claude on the phone through MCP (`apps/mcp` is a draft) and creating or approving a task from the CLI. | "What is not built yet." |

Pace: scenes 1–7 take about 30 seconds each, scene 8 about 25 seconds, scene 9
about 25 seconds and scene 10 about 15 seconds. Narration is optional. The captions carry the
message so the recording is understandable muted.

## 4. What is simulated

| Thing | Simulated? | How |
|---|---|---|
| Assistant output, tool calls, file edits | Yes | `FakeAdapter` scripted events. Prompt switches `[FAKE:APPROVAL]`, `[FAKE:LIMIT]`. |
| Test and verification results | Yes | The fake emits `test.result` and `verification.result` with harness mode on. |
| Quota limit and cooldown | Yes | Deterministic `[FAKE:LIMIT]` path on the injected clock. |
| The phone lock | Yes | The spec sets the page hidden, takes the network offline and drops live stream frames (as `apps/web/e2e/reconnect.spec.ts` does). A browser cannot be locked from Playwright. The plane, its events and the approval are real, and the page recovers through durable reads. The viewport is phone-sized (iPhone 13), not a real device. |
| Cockpit registry (composition preview) | Yes | The e2e `fake-cockpit.ts`. |
| Pull request | Yes | In-process fake GitHub (`autopilotGitHub`) and a real `git` CLI against a local bare repo. |
| Routing, approvals, checkpoints, handoff, scheduler, task state | No | Real plane code and real persisted state. |
| Web UI, `aos runtimes` and read-only `aos task` (`ls`, `show`, `events`, `verdict`) | No | Real code. |
| `aos task new`, `aos approvals`, chat-publish, subtasks, approving from Claude on the phone through MCP | Not built | `ROADMAP` cards only. No ROADMAP scene may call a route that does not exist. |

## 5. Reproducing it

```
pnpm install --frozen-lockfile
pnpm demo:journey            # builds the web app, then runs the demo-journey Playwright project
DEMO_DWELL_MS=20000 pnpm demo:journey   # holds each scene on screen, for a paced recording
```

It writes, under the repository root:

- `demo-out/scenes.json`: each scene's id, label, caption, task id and the routes or commands behind it.
- `demo-out/scenes/<id>.png`: one screenshot per scene, label and caption on screen.
- `demo-out/cli/*.txt`: the `aos runtimes ls` / `show fake-a` and `aos task ls` / `show` / `events` / `verdict` transcripts, run against the same plane (7 files).
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
4. The task id in scene 4's Web screenshot matches the one in the `aos task show` transcript, and scene 9's transcripts use the same id.
5. Two consecutive runs produce identical `scenes.json` once ids and timestamps are masked.
6. A secret scan of `demo-out/`, the trace and the transcripts finds only `FAKE-*-not-real` tokens, and no bearer, cookie or credential-file contents.
7. This page uses the same words as the on-screen labels.
8. Scene 7 asserts the recovery: the events shown after the return equal the plane's durable events one for one, and exactly one approval request leaves for a doubled tap.
9. The gate passes (`pnpm typecheck && pnpm lint && pnpm test`) with the observed `pnpm demo:journey` output attached.

## 7. Roadmap

- **D1**: the recorded spec (`apps/web/e2e/demo-journey.spec.ts`, a `demo-journey` Playwright project, `demo:journey` scripts).
- **D2** (this page): phone scene (milestone B1) and real read-only CLI scenes (p1-3 slice 1, E1).
- **Next**: `aos task new --watch` and `aos approvals` (p1-3 slice 2) turn the `ROADMAP` lines in scene 9 into real commands; a phone approval through MCP (`apps/mcp`) would add a scene.
