# K12 live acceptance follow-up — 2026-09-14

Evaluated PR #40 at `9ee1faba2c776d253ef5bcec49d7cf76fc1fd396`, against
`origin/main` `5257926dacc73a7367a821b732be00b455d9a546`.

**K12 implementation COMPLETE; live acceptance PARTIAL.** The Claude warning
scenario remains open. The real Codex unavailable-session projection passed.
This record does not clear the Green-Light-A K12 acceptance gate.

> **CLOSED 2026-09-15.** The remaining Claude warning-band scenario was
> demonstrated live during the Green-Light-A acceptance campaign. See
> "Closure — 2026-09-15" at the end of this document. This section is kept as
> the record of what was still open on 2026-09-14.

## Exact acceptance and checklist

Kernel-services §5.2, item 4:

> Real-provider evidence (credential-gated eval): a Claude session driven past `warnRatio`
> produces a provider-reported observation and, when the provider auto-compacts, an observed
> `compact_boundary`; a Codex session renders "occupancy unavailable" and no invented number.

| Required proof | Result |
|---|---|
| Real Claude session above canonical `warnRatio` (0.70) | OPEN: provider returned `rate_limit`; no warning-band proof retained |
| Provider-reported observation for that warning state | OPEN: capability declaration and the earlier K9 low-pressure smoke are insufficient |
| Observed `compact_boundary` when that provider auto-compacts | OPEN as a conditional part of the same Claude scenario; scripted adapter tests are not live evidence |
| Real Codex session renders unavailable, without an invented number | PASS for an actual failed provider session: real capability, HTTP context read, actual web ContextReadout rendering |

The contract does not require a successful Codex turn. This evidence is stronger
than an auth-file check: a provider session reference was received and the
Harness session was persisted. It proves the unavailable presentation after a
provider fault, not working Codex execution or receipt of token accounting.
Existing automated tests separately prove accounting cannot become occupancy.

## Bounds and isolation

The initial attempt allowed one session per provider, 120 seconds each, no
failover or scheduler retries, and at most 64 KiB of synthetic Claude prompt
input. Actual prompt sizes: Claude **51,254 bytes**, Codex **220 bytes**. Both
prompts requested a fixed short reply and prohibited tools and file changes.
Input byte bounds are not claimed as token counts or occupancy measurements.

Each attempt used `bootScenario` → production `buildServer` → authenticated
`POST /api/tasks` / `POST /api/tasks/:id/start` → single-mode Harness → real
registry adapter, in a fresh `AGENT_PLANE_HOME` and standalone disposable Git
repository/worktree. Claude used `prompt-on-escalation`; Codex used its existing
workspace sandbox. K13 stayed SHADOW, scheduler/quota probes were off, and no
provider compaction command was issued. No database observations were inserted.

The temporary collector initially queried `events.task_id`, which does not
exist (events belong to runs). Its final collection failed after the sessions
ended. It was corrected to join through `runs`; the analogous result query now
uses `execution_results.session_id`. Those first attempts are not counted as
passing API/render assertions. Claude was not retried. One explicitly bounded
Codex-only diagnostic retry (30 seconds, the same 220-byte prompt) saved the
complete projection assertions. Total: one Claude and two Codex invocations;
no further provider calls.

Raw diagnostic output and the newly created disposable provider transcripts
were removed after extraction. Workspace databases, credentials minted for
those temporary workspaces, and Git fixtures were removed. No credential,
provider transcript, sensitive prompt content or generated provider text is committed.
Only the sanitized facts below were retained.

## Claude result

- UTC **15:29:13.341–15:29:27.780**, 2026-09-14 (14.439 seconds including cleanup).
- Agent SDK **0.3.238**; runtime transcript version **2.1.238**. This is the
  runtime actually observed, not the version of a different CLI on PATH.
- Requested selector `sonnet`; resolved identity **`claude-sonnet-5`**, source
  **`run.started`**. One persisted session; terminal state **YIELDED**; task
  **WAITING_INPUT**.
- The disposable provider transcript's structured API-error record contained
  **`error: rate_limit`**. Only that error classification was retained.
- No usable warning-pressure acceptance evidence was saved. No occupancy,
  window, pressure, price or boundary count is inferred from the rate limit or
  the input size. Further stress would consume quota without proving this gate
  while the provider is rate-limited, so the pressure attempt stopped.

## Codex result

The first invocation (15:29:28.112–15:29:34.312 UTC) reached FAILED but its final
collection was incomplete; it supplies no passing assertion here.

The corrected collection ran at **15:31:11.981–15:31:15.544 UTC**, 2026-09-14
(3.563 seconds including cleanup), using Codex SDK/CLI **0.149.0**:

| Evidence | Recorded result |
|---|---|
| Actual adapter context capability | occupancy `unavailable`; effective window `unavailable`; compaction `none` |
| Task start | HTTP 200; one persisted Harness session; actual provider session reference received |
| Execution outcome | FAILED, `provider_fault`; this record does not diagnose that separate execution failure |
| Requested / resolved model | both null in the canonical run projection; no alias or historical model inferred |
| Provider event counts | `run.started`: 1; `error`: 4; `run.ended`: 3 |
| Context / accounting events | zero `context.observed`; zero `usage.updated`; zero compaction observations |
| Authenticated context read | `status: unavailable`; reason `openai does not expose live context occupancy`; actual session ID present; no observation or pressure |
| Actual `ContextReadout` rendered from that response | “Occupancy unavailable” present; actual session shown; no numeric percentage |

The renderer assertion used `react-dom/server` on the production component,
with the actual HTTP response, not a fixture. Browser closure tests separately
exercise the surrounding V3 inspector. This was not a live Cockpit browser run.

## Safe reproduction

Use the existing PR worktree, with dependencies installed and provider login
already configured. Never put credentials in commands or config committed to
Git. The following disposable collector runs **one** selected real provider;
there are no automatic retries. Run Claude only when quota is available. It
reproduces the bounded probe, not a guarantee of warning pressure: if 64 KiB
cannot reach the warning band, stop and keep that acceptance open.

Save this as `eval/.k12-live-probe.ts` temporarily (remove it after the run):

```ts
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { bootScenario } from './harness/boot.js';
import { prepareFixture } from './harness/prepare-fixture.js';
import { ContextReadout } from '../apps/web/src/board/readouts.js';
const requireWeb = createRequire(new URL('../apps/web/package.json', import.meta.url));
const { createElement } = requireWeb('react');
const { renderToStaticMarkup } = requireWeb('react-dom/server');
const provider = process.env.K12_LIVE_PROVIDER;
assert.ok(provider === 'anthropic' || provider === 'openai', 'explicit live opt-in required');
const assistantId = provider === 'anthropic' ? 'personal-claude' : 'personal-codex';
const fixture = prepareFixture('context-continuation');
const boot = await bootScenario({ harnessSingle: true, repoAllowlist: [fixture.path],
  extraConfigYaml: `failover:\n  auto: false\nscheduler:\n  enabled: false\n  quotaProbe: false\npolicy:\n  approvalMode: ${provider === 'anthropic' ? 'prompt-on-escalation' : 'auto-approve'}\n` });
const { built, db } = boot;
let taskId: string | undefined;
let timer: ReturnType<typeof setTimeout> | undefined;
try {
  assert.equal(built.registry.manifest(assistantId)?.core.auth.state, 'ok');
  const records = provider === 'anthropic' ? Array.from({ length: 700 }, (_, i) =>
    `Synthetic record ${i}: amber cedar delta orbit harbor meadow vector ${i * 17}.`).join('\n') : '';
  const goal = 'Read these synthetic records and reply only ACCEPTANCE_OK. Do not call tools, access files, spawn agents, browse, or modify anything.\n' + records;
  assert.ok(Buffer.byteLength(goal) <= 65536);
  const created = await built.app.inject({ method: 'POST', url: '/api/tasks',
    headers: boot.client.headers, payload: { goal, repoPath: fixture.path,
      overrides: { assistantId, ...(provider === 'anthropic' ? { model: 'sonnet' } : {}) } } });
  assert.equal(created.statusCode, 201);
  taskId = created.json().taskId;
  timer = setTimeout(() => { void built.orchestrator.cancelTask(taskId!); }, 120000);
  const started = await built.app.inject({ method: 'POST', url: `/api/tasks/${taskId}/start`,
    headers: boot.client.headers, payload: { assistantId } });
  assert.equal(started.statusCode, 200);
  await built.orchestrator.waitForSettled(taskId!, 125000);
  const context = (await built.app.inject({ method: 'GET',
    url: `/api/tasks/${taskId}/context`, headers: boot.client.headers })).json();
  const markup = renderToStaticMarkup(createElement(ContextReadout, { context }));
  const events = db.prepare(`SELECT type, COUNT(*) AS n FROM events
    WHERE run_id IN (SELECT id FROM runs WHERE task_id = ?) GROUP BY type`).all(taskId);
  const observations = db.prepare(`SELECT payload FROM events WHERE type = 'context.observed'
    AND run_id IN (SELECT id FROM runs WHERE task_id = ?)`).all(taskId) as { payload: string }[];
  // Allowlist scalar facts: never log event summaries, raw payloads or provider text.
  console.log(JSON.stringify({ provider, state: built.tasks.get(taskId!)?.state, events,
    observations: observations.map(({ payload }) => {
      const o = JSON.parse(payload);
      return { observedAt: o.observedAt, occupancySource: o.occupancySource,
        occupancyTokens: o.occupancyTokens, effectiveWindowTokens: o.effectiveWindowTokens,
        effectiveWindowSource: o.effectiveWindowSource, pressure: o.pressure };
    }), status: context.status, sessionPresent: !!context.sessionId,
    unavailableRendered: markup.includes('Occupancy unavailable'),
    numericPercentageRendered: /\d+%/.test(markup) }));
  if (provider === 'openai') {
    assert.equal(context.status, 'unavailable');
    assert.equal(context.observation, undefined);
    assert.ok(markup.includes('Occupancy unavailable'));
    assert.equal(/\d+%/.test(markup), false);
  }
} finally {
  if (timer) clearTimeout(timer);
  await built.orchestrator.shutdown();
  await boot.close();
  fixture.cleanup();
}
```

```sh
K12_LIVE_PROVIDER=openai pnpm --filter @agent-plane/eval exec tsx --tsconfig ../apps/web/tsconfig.json .k12-live-probe.ts
# Separate opt-in, only with available Claude quota:
K12_LIVE_PROVIDER=anthropic pnpm --filter @agent-plane/eval exec tsx --tsconfig ../apps/web/tsconfig.json .k12-live-probe.ts
rm eval/.k12-live-probe.ts
```

Retain only the allowlisted result, and remove any newly created disposable
provider transcript after extraction. A terminal-session HTTP read correctly
marks past Claude observations stale and removes the live percentage. To prove
the warning gauge itself, capture the actual HTTP/renderer assertion while that
session is live; do not relabel terminal evidence as live or lower `warnRatio`.

**Single remaining proof:** a real Claude session above `warnRatio = 0.70`
with its provider-reported observation projected truthfully to the operator,
and an observed `compact_boundary` if the provider auto-compacts.

---

## Closure — 2026-09-15

The single remaining proof named above was demonstrated against merged
`origin/main` `33b8112ee4b6549468d42c3981f4835a2df6d68a` (K5 overlap queue, #37;
K12/K14 closure, #40) in a fresh `AGENT_PLANE_HOME` with a disposable Git
fixture and a disposable database. `warnRatio` was not changed, no database row
was inserted, no `ContextObservation` was manufactured, and occupancy was never
derived from token accounting. Pressure was reached by prompt size alone.

### Bounds declared before the run

One real Claude session per attempt, 180 s wall budget, a single prompt of at
most 2 MiB, scheduler and quota probes off, failover off, K13 SHADOW, no
provider compaction command issued, no automatic retry.

### Result

| Attempt | Requested selector | Resolved identity | Occupancy (provider-reported) | Effective window (provider-reported) | Pressure | Above `warnRatio` 0.70 |
|---|---|---|---|---|---|---|
| Warning band | `haiku` | `claude-haiku-4-5-20251001` | 159,045 | 200,000 | **0.7952** | yes |
| Near-critical | `haiku` | `claude-haiku-4-5-20251001` | 193,813 | 200,000 | **0.9691** | yes |

Both observations carry `occupancySource: provider-reported` and
`effectiveWindowSource: provider-reported`, and both were recorded by the
production `SessionRunner` sampling path from the adapter's own
`getContextUsage` control request.

### Operator projection, captured while the session was live

`GET /api/tasks/:id/context` was polled during the run and the response was
rendered through the production `ContextReadout` with `react-dom/server`:

| Projection | Warning band | Near-critical |
|---|---|---|
| `status` | `known` | `known` |
| Rendered pressure | `<strong>80%</strong>` | `<strong>97%</strong>` |
| Rendered occupancy | `159k / 200k tokens` | `194k / 200k tokens` |
| Rendered freshness | Live | Live |
| Rendered method | Provider-reported | Provider-reported |

The same read taken after the session settled correctly reported the
observation stale and withheld the percentage, reproducing the terminal-read
behaviour already described above.

### Auto-compaction

No `compact_boundary` was observed in either attempt, and the contract does not
require one to occur. The forwarding path itself is unchanged and remains
covered by the deterministic suites.

### Note on effective windows

The window the provider manages against is the acceptance denominator, and it
is model-dependent: a 1M-context Sonnet session in the same harness reported an
effective window of 967,000 tokens, against which the same prompt sizes sit far
below `warnRatio`. Reaching the warning band on that window costs roughly four
times the tokens for the same proof, so the bounded probe used a 200,000-token
window instead. The threshold itself was never lowered.
