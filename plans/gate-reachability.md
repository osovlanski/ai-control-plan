# Gate reachability and decision-provider reachability (design review, 2026-10-04)

**Status:** review of wiring on `main@bd67c09` (after #71). Proposals in Part D are proposals only;
implementation is a separate slice. Nothing here changes code, floors, providers or activation.

**Scope.** Which agent actions reach the M16 tool gate, and when; which decision providers are
reachable from which parts of the Agentic OS. Out of scope: floor patterns and corpora, activation,
switching discovery to Jev, K21, remote mode.

**Method.** Every claim cites `file:line` on `main@bd67c09`. Every "every" or "all" claim names the
search that backs it; the searches and their full hit lists are in Appendix A. "Unknown" means the
code and the SDK typings do not settle it and nothing was run that does. Three things were driven
rather than read:

1. **The live server** (`buildServer`, the composition root `apps/api/src/index.ts:9` uses) on three
   scratch workspaces with `decisions.provider: typesafe`, `typesafeRoute: openrouter`, dummy
   `TYPESAFE_API_KEY` and `ANTHROPIC_API_KEY`, a fake assistant, and every outbound `fetch`,
   `http.request` and `https.request` logged (Appendix B).
2. **The floor discovery bin** against a scratch workspace whose config says `provider: typesafe`
   with a dummy `TYPESAFE_API_KEY` and no `ANTHROPIC_API_KEY`, with `fetch` logged (Appendix B).
3. **The operator soak**, read from a copy of the operator DB made with SQLite's backup API (the live
   file's checksum was unchanged), and `toolGateSoakCheck` run on that copy (Appendix C).

---

## Part A — Tool gate reachability

### A.1 How the gate is reached at all

- The gate exists only inside the Execution Harness `SessionRunner`. `toolGate` is defined at
  `composition.ts:205-256` and handed to the one `SessionRunner` (`composition.ts:257-271`);
  `evaluateGuards` is called only from `session-runner.ts:476` and `:706` (Appendix A, S5).
- A task reaches the `SessionRunner` only when `harnessRouting()` is true
  (`orchestrator.ts:250-260`): `execution.harnessModes.single` on, not `parallel`, and task mode not
  `compare` or `race`; or a scheduler dispatch recorded with `execution_path = 'harness'`
  (`orchestrator.ts:251-254`, written at `scheduler.ts:749` from the flag at reservation time).
- **Legacy path: no gate at all (K18 claim confirmed).** The legacy start
  (`orchestrator.ts:585-640`) starts the adapter and consumes its events with no guard and no gate.
  Driven: scenario C (Appendix B) ran the fake assistant's `rm -rf ./dist`, an MCP call and a `Read`
  of `/etc/hosts` on the legacy path and wrote **zero** `tool-gate` rows.
- The gate evaluates exactly two event types (`session-runner.ts:1365-1377`):
  - `approval.requested` → hook `pre-exec`, **only if** the adapter can relay an answer
    (`session-runner.ts:1367-1372`: manifest `approvalRelay`, else `typeof adapter.send`).
  - `tool.started` → hook `post-start`.
  - Anything else (`tool.completed`, `file.changed`, …) is never evaluated.
- Recorded tier is `preventive` for `pre-exec` and `audit` for `post-start`
  (`composition.ts:250`).
- **In shadow (the only mode this build opens) nothing is pre-exec in effect.** Every evaluation
  except `applied` + `pre-exec` is fire-and-forget (`session-runner.ts:1354-1357`), and `applied` is
  refused for the build's own providers (`composition.ts:195-202`). A `preventive` row records that a
  hook existed where an applied gate *could* have held the tool, not that anything was held.
- Which adapters can relay (`send`): Claude (`claude.ts:446`) and Fake (`fake.ts:254`) only
  (Appendix A, S12). Codex, OpenRouter, Cursor and Bedrock have no `send`.
- Under `prompt-on-escalation`, a harness session on an adapter that cannot relay fails before start
  with `policy_unenforceable` (`session-runner.ts:339`, `:1030-1031`). So on the harness path those
  four adapters never run under `prompt-on-escalation`. On the legacy path there is no such check
  (`orchestrator.ts:594` passes the mode straight to the adapter).

### A.2 Per-adapter facts the matrix rests on

Which adapters emit gate-visible events (Appendix A, S13): Claude `claude.ts:309` (`tool.started`)
and `:427` (`approval.requested`); Codex `codex.ts:184` and `codex-app-server-runtime.ts:82`
(`tool.started`, shell only); Cursor `cursor.ts:227` (`tool.started`); Fake `fake.ts:31, 186, 196`
(`tool.started`) and `:234` (`approval.requested`). Bedrock emits neither.

- **Claude** (`claude.ts`).
  - `auto-approve` → `permissionMode: "bypassPermissions"` and **no `canUseTool`**
    (`claude.ts:173-178`). No `approval.requested` is ever raised, so every tool is post-start
    (**K19c claim confirmed**).
  - `prompt-on-escalation` → `permissionMode: "default"` and `canUseTool` installed
    (`claude.ts:175-177`), which emits `approval.requested` (`claude.ts:415-430`). The CLI calls it
    only for calls its own rules resolve to "ask"; calls its rules allow (read-only built-ins such as
    `ToolSearch`, observed below) never reach it and are post-start only.
  - `read-only` → `permissionMode: "default"`, no `canUseTool`. Per the SDK typings, without a
    permission surface "ask" decisions are terminal denials (`sdk.d.ts:4498`, SDK 0.3.238).
    Allowed-by-rule tools still run and are post-start rows.
  - Every `tool_use` block emits `tool.started` from the assistant message
    (`claude.ts:301-312`). The SDK forwards subagent `tool_use` blocks by default, with
    `parent_tool_use_id` set (`sdk.d.ts:1679-1682`); the adapter does not filter on it, so Task-style
    subagent tool calls produce post-start rows.
  - `settingSources` is not passed (`claude.ts:161-179`), so the SDK loads user, project and local
    settings (`sdk.d.ts:2004-2014`, "When omitted, all sources are loaded"), including their hooks.
    The operator host's `~/.claude/settings.json` has 0 `permissions.allow` entries and hooks on 9
    events (SessionStart, UserPromptSubmit, PreToolUse, Notification, Stop, SessionEnd,
    PostToolUse, PreCompact, PostCompact). Hooks run inside the CLI and emit no tool event.
  - **Double counting.** A call that needs permission produces a `tool.started` row (from the
    assistant message) **and** an `approval.requested` row. Operator DB: all 19 `pre-exec` rows ever
    recorded follow a `tool.started` for the same tool in the same run (Appendix C, C.3).
- **Codex SDK** (`codex.ts`). Always `sandboxMode: "workspace-write"`, `approvalPolicy: "never"`
  (`codex.ts:112-119`), whatever `approvalMode` says. `tool.started` only for `command_execution` at
  `item.started` (`codex.ts:180-188`). `file_change` emits only `file.changed` after the fact
  (`codex.ts:251-258`); `mcp_tool_call` emits only `tool.completed`/`tool.failed`
  (`codex.ts:260-265`); `web_search` is dropped (`codex.ts:270-272`).
- **Codex app-server** (`codex-app-server-runtime.ts`, only with `options.appServerInput` and
  session input on, `codex.ts:59`). Same event shape (`:82`, `:121-131`), but it does honour
  `read-only` with a read-only sandbox (`:57`).
- **OpenRouter** is the Codex SDK adapter with another model provider (`openrouter.ts:29-55`). Same
  rows as Codex SDK.
- **Cursor** (`cursor.ts`). `agent -p --output-format json` with no permission or sandbox flag
  (`cursor.ts:140-146`); `permissionPolicy` is never read (Appendix A, S14). `tool.started` carries
  only `{ tool }` (`cursor.ts:225-228`), so the gate sees no command and no input: every Cursor tool
  call floors as `opaque` (checked: `toolActionFromEvent({tool:"edit_file"})` gives no
  `commandText`, and the floors return `[opaque]`). The mapping itself is marked "THE UNVERIFIED
  PIECE" in the source (`cursor.ts:200`). What `agent -p` does on a write without a flag: **unknown**.
- **Bedrock** (`bedrock.ts`). Emits `run.started`, `message`, `run.ended`, `limit.hit`, `error`
  only (`bedrock.ts:152-189`). No tool event, so the gate never evaluates (**K19c claim
  confirmed**). The hosted agent's tools run remotely.
- **Fake.** Relays approvals (`fake.ts:117`, `:254`); `[FAKE:APPROVAL]` raises `approval.requested`
  in every mode (`fake.ts:166`).

### A.3 Matrix — harness path (`harnessModes.single: true`, task mode `single`, not parallel)

Cell = `reaches gate? / hook / recorded tier`. "post-start" means fire-and-forget after the event;
it can only record (and `toolPolicyGuard` can cancel the session on a rules deny,
`guards.ts:142-163`). "pre-exec" means the gate runs while the adapter waits for an answer; in shadow
it still only records.

| Adapter × tool class | `auto-approve` | `prompt-on-escalation` | `read-only` |
|---|---|---|---|
| **Claude** shell (`Bash`) | yes / post-start / audit | permission-requiring call: yes / **both** post-start (audit) and pre-exec (preventive), 2 rows; rule-allowed call: post-start / audit | rule-allowed call: post-start / audit; "ask" call is denied by the CLI, still 1 post-start row |
| Claude file tools (`Read`, `Write`, `Edit`, …) | yes / post-start / audit | `Read`-class (allowed by CLI rules): post-start / audit. `Write`/`Edit`: both rows, as shell | as shell |
| Claude MCP tools | yes / post-start / audit | both rows (observed: `mcp__plugin_claude-mem_mcp-search__search`, Appendix C) | as shell |
| Claude subagent (Task) — the Task call | yes / post-start / audit | as its permission rule says (unknown whether "ask") | as shell |
| Claude subagent — tools inside the subagent | yes / post-start / audit (SDK forwards `tool_use`) | post-start / audit; whether `canUseTool` also fires for subagent calls: **unknown** | post-start / audit |
| Claude hooks (settings, plugins), MCP server processes | **no** | **no** | **no** |
| **Codex SDK** shell | yes / post-start / audit | **never runs**: `policy_unenforceable` at prepare | yes / post-start / audit — and **not read-only**: sandbox stays `workspace-write` |
| Codex SDK file changes (`apply_patch`) | **no** (only `file.changed`) | never runs | **no**, and writes are allowed |
| Codex SDK MCP tools | **no** (only `tool.completed`) | never runs | **no** |
| Codex app-server (shell / file / MCP) | post-start audit / **no** / **no** | never runs | post-start audit / **no** / **no**; sandbox read-only |
| **OpenRouter** (Codex SDK harness) | as Codex SDK | never runs | as Codex SDK (not read-only) |
| **Cursor** any tool | yes / post-start / audit, always `opaque` | never runs | yes / post-start / audit; mode not enforced by the adapter |
| **Bedrock** anything | **no** | never runs | **no** |
| **Fake** scripted shell / MCP / Read | post-start / audit | post-start / audit | post-start / audit |
| Fake `[FAKE:APPROVAL]` | pre-exec / preventive (answered yes at once, `session-runner.ts:1272-1281`) | pre-exec / preventive (waits for a human) | pre-exec / preventive (answered no) |

### A.4 Matrix — every other execution path

| Path | Reaches gate? | Evidence |
|---|---|---|
| Legacy orchestrator (`harnessModes.single: false`), any adapter, any mode | **no** | `orchestrator.ts:585-640`; scenario C wrote 0 tool-gate rows |
| `compare` / `race` / `parallel` tasks, even with `harnessModes.single: true` | **no** (legacy) | `orchestrator.ts:256-259` |
| Scheduler dispatch reserved while the flag was off, run after it was turned on | **no** (legacy) | `orchestrator.ts:251-254`, `scheduler.ts:749` |
| Harness session after the flag is turned off | yes (stays harness-owned) | `composition.ts:75-91`, `server.ts:136-146` |

### A.5 Confirmations asked for

- *Claude installs `canUseTool` only under `prompt-on-escalation`; under `auto-approve` it runs with
  `bypassPermissions`, no pre-exec hook* — **confirmed**, `claude.ts:173-178`.
- *Bedrock emits no tool events, so the gate never evaluates there* — **confirmed**,
  `bedrock.ts:152-189`; Appendix A, S13 lists no Bedrock emitter.
- *The legacy orchestrator path has no gate at all* — **confirmed** by search (S5) and by drive
  (scenario C).

---

## Part B — Does the soak measure a gate or an audit log?

**Operator workspace, as configured** (`~/.agent-plane/personal/config.yaml`, keys read by name):

- `policy.approvalMode: prompt-on-escalation`.
- `execution.harnessModes.single: true`, `maxConcurrentProviderStarts: 2`, a curated
  `providerProfile` (claude-mem only).
- `decisions`: no `provider` (resolves to `rules`), no site mode (resolves to `shadow`); `mcpTools`
  declares claude-mem's `get_observations`, `smart_search` and `search` `read-only`.
- Assistants: `personal-claude` (anthropic), `personal-codex` (openai), `personal-ox-alpha`
  (openrouter, enabled).
- The running API is the checkout `ai-control-plan-operator` at `2e3c9f4`, started
  2026-09-26 16:28. Between `2e3c9f4` and `main` the gate wiring files are unchanged
  (`composition.ts`, `session-runner.ts`, `guards.ts`, `claude.ts`, `tool-floors.ts`); only Codex
  session-input files differ. Jev (#71) is **not** on the operator build: there,
  `decisionProviders()` returns the model judge only (`2e3c9f4:decision.ts:303-304`).
- Not read: the systemd unit's environment (the read was refused in this session). So whether
  `ANTHROPIC_API_KEY` or `TYPESAFE_API_KEY` is in the operator process's environment is **unknown**.

**What the soak recorded** (DB copy, Appendix C):

| | Rows | `pre-exec` (preventive) | `post-start` (audit) | Distinct tool calls |
|---|---|---|---|---|
| Since T0 (2026-09-25T21:31:57Z) | 3 | 1 (33%) | 2 (67%) | 2 |
| All time (from 2026-09-24) | 42 | 19 (45%) | 23 (55%) | 23 |

- Every row is `provider: rules`, `mode: shadow`, not degraded, no tokens. All from
  `personal-claude`; no Codex or OpenRouter run has ever gone through the harness on this
  workspace (4 Codex runs, all legacy, 2026-09-15).
- Since T0 there is **one task** (2026-09-26 16:41). The 3 rows are `ToolSearch` (post-start only)
  and one claude-mem `search` call counted twice: post-start, then pre-exec. No task has been
  created since 2026-09-26T16:41:23Z.
- All time, every one of the 19 pre-exec rows duplicates a post-start row for the same call.

**Plain answer.** In shadow nothing can block, so every row is audit by construction. Read as "would
an applied gate have been able to hold this call", the soak is **mixed and tiny**: 1 of its 2 calls
since T0 had a pre-exec hook. On Claude under `prompt-on-escalation`, calls the CLI's own rules allow
have no pre-exec hook. On Claude under `auto-approve` (the personal default, `config.ts:259`), no
call would have one. On Codex, OpenRouter, Cursor and Bedrock, none could.

**It is about to pass a precondition it has not earned.** `toolGateSoakCheck` passes §7.1(1) at
"≥ 14 days and at least one row" (`decision.ts:307`). Run on the DB copy with `now =
2026-10-09T21:32:00Z`, it returns `volume.pass: true` on **n = 3** (Appendix C, C.4).

**What the soak can support as activation evidence:**
- That the harness → gate → record wiring works on the operator's real Claude sessions, and that
  floors do not prompt on the two calls seen (`ToolSearch`, a declared read-only MCP tool).

**What it cannot support:**
- Any prompt rate (§7.1(7)): 2 distinct calls, and the row count double-counts every
  permission-requiring call.
- Any statement about tools the CLI auto-allows (no pre-exec hook), about `auto-approve`, or about
  Codex, OpenRouter, Cursor, Bedrock, compare/race tasks, subagents or hooks.
- §7.1(1)'s intent ("enough shadow decisions to judge"): it passes on the clock, not on volume.
- Activation of the gate as a *preventing* control for any adapter/mode pair other than Claude under
  `prompt-on-escalation`, and there only for calls that reach `canUseTool`.

---

## Part C — Decision-provider reachability

### C.1 Consumers (Appendix A, S1–S4, S10, S11)

`new DecisionService(` has exactly two production call sites (S1): `composition.ts:184` and
`decision-floor-discovery.ts:49`. `.decide(` on a service has exactly one production caller (S2):
`decision-floor-discovery.ts:50`. (`recovery.ts:140` is `HarnessRecovery`'s own `decide`; the two
provider-internal calls are the rules baseline inside each judge; `composition.ts:223` is the rules
provider called directly.)

| Consumer | Providers it can reach | Config read | Awaited? | Hot path? | Egress |
|---|---|---|---|---|---|
| Tool gate (`composition.ts:205-256`) | **rules only**: a `RulesDecisionProvider` instance (`:204`) called directly (`:223`); verdict from floors + `toolDeniedRules` (`:226-237`) | none of `decisions.provider`/`typesafe*`; reads `mcpTools` (`:235`) and site mode | only `applied` + `pre-exec` (`session-runner.ts:1354-1359`); `applied` is closed (`composition.ts:195-202`) | yes, per tool call | none (driven, Appendix B) |
| Live `DecisionService` (`composition.ts:184-189`) | registers `model` + `typesafe` + rules (`decision.ts:341-351`, `:392`) | `decisions.provider`, `typesafeApiKeyRef`, `typesafeRoute` | n/a | constructed at startup | none: its **only** use is `.activation()` (`composition.ts:190`); no `.decide()` caller exists (S2). `activation()` returns before `describe()` for `shadow` (`decision.ts:440`); `describe()` reads env only (`decision-typesafe.ts:117-121`, `decision-model.ts:146-154`) |
| K19c shadow evaluation | same as the tool gate (it is the tool gate in `shadow`) | — | no | yes | none |
| K20 task classifier (`tasks.ts:84` → `decision.ts:141-152`) | **rules only**, via `taskClassifierAnswers`, never through a service | none | synchronous, at intake | yes, task intake | none |
| K21 sites | **none exist.** `context-breakpoint` is a `DecisionSite` (`core/decision.ts:35`) with a rules basis (`:699`, `:755`) and no production caller (S11) | — | — | — | — |
| Floor discovery bin (`decision-floor-discovery.ts`) | **model → rules**. `provider: "model"` is hard-coded (`:48`); `typesafe` is registered without a key reference, so unreachable (`decision.ts:346`) | **not** `decisions.provider`, **not** `typesafeRoute`; only `mcpTools` and `dbPath`, and only without `--db`/`--actions` (`:40-43`) | yes | offline | Anthropic (Haiku) with `ANTHROPIC_API_KEY` |
| `floor-discovery.ts` module | whatever `decide` it is given (`:91-95`) | — | yes | offline | — |
| Injection-frequency bin | none (reads JSONL) | — | — | offline | none |
| Nightly `eval.yml` — injection suites (`:48-62`) | `model` (`decision-injection.test.ts:133`; `decision-second-lock.test.ts:66` defaults to `model`; `DECISION_EVAL_PROVIDER` is not set and no TypeSafe secret is passed) | — | yes | offline (CI) | Anthropic, fixtures only |
| Nightly `eval.yml` — floor discovery (`:70-77`) | model → rules (the bin) | — | yes | offline (CI) | Anthropic, tool calls of synthetic eval scenarios |
| Developer-run `decision-second-lock.test.ts` with `DECISION_EVAL_PROVIDER=typesafe` | typesafe → rules (`:66-73`) | env | yes | offline | OpenRouter + TypeSafe or TypeSafe, fixtures only |

**Owner decisions, checked:**
- *K19i: no judge on the hot path; the gate reads rules and floors only* — **holds** on every
  composition path (C.2, question 6).
- *#71: Jev serves offline roles only* — **holds**. No production code path calls Jev; only a
  developer-run test does.
- *#71: the discovery job's provider is unchanged* — **holds**: `model` is hard-coded
  (`decision-floor-discovery.ts:48`).

### C.2 The six questions

**1. With `decisions.provider: typesafe` on the operator workspace, does the live server send
anything to OpenRouter or TypeSafe at runtime?** **No** — on `main`. Driven: scenarios A, B and C
(harness `prompt-on-escalation`, harness `auto-approve`, legacy) made **0** outbound requests, every
row was `provider: rules`, and the K20 intake row was `rules` (Appendix B). Structurally: the live
`DecisionService` has no `.decide()` caller. On the operator's **running build `2e3c9f4`** the same
setting does not boot at all: `typesafe` is not registered there, and the `DecisionService`
constructor refuses an unregistered provider at startup. Only a discovery job could send to a
decision vendor, and the shipped one cannot (question 2). Separate from decisions: the live process
does talk to OpenRouter whenever `personal-ox-alpha` runs, because that assistant's model is served by
OpenRouter (`openrouter.ts:27-50`). That is agent traffic, not decision state, and it does not reach
TypeSafe.

**2. Can the owner put Jev on discovery without putting it on the live chain?** The premise that
both read `decisions.provider` is **false**: the discovery bin never reads it (`:48`). Driven: a
workspace configured `provider: typesafe`, `typesafeRoute: openrouter`, with `TYPESAFE_API_KEY` set
and no Anthropic key, ran the bin and got "model provider has no credential (ANTHROPIC_API_KEY
unset)", 0 judged, and no outbound request (Appendix B). So:
- **Config cannot put Jev on discovery at all.** It needs a code change to the bin. This is a real
  gap.
- Conversely, `decisions.provider` on the live server is **dead config**: it chooses the head of a
  chain nobody asks. It still triggers I-D7's opt-in validation (`config.ts:552-566`), so the
  egress opt-in is checked on the process that never egresses and not on the process that would.

**3. Egress map.**

| From | To | Data | Redaction | §4.4 boundary |
|---|---|---|---|---|
| Live API, tool gate and K20 intake | nobody | — | — | — |
| Live API, `personal-ox-alpha` runs | OpenRouter (and the model's host) | the whole agent session: prompt, files read, tool output | the provider sees raw content; the plane redacts only what it stores | not applicable (agent traffic) |
| Live API, Claude/Codex runs | Anthropic / OpenAI | the whole agent session | as above | not applicable |
| Floor discovery (operator or nightly), today | Anthropic (`claude-haiku-4-5`) | per unfloored distinct call: tool name and `commandText` (≤ 2,000 chars, `core/decision.ts:373-376`), in two question groups | yes, twice: events are redacted at storage (`EventRecorder`, `composition.ts:128-130`), and the builder redacts again (`core/decision.ts:581-596`) | redacted, bounded (12k state cap, `:370`) and scoped per question group (`decision-model.ts:179-183`). **Trust gate does not cover `commandText`**: only `pathSamples` is trust-gated (`core/decision.ts:605`) and no judge reads it. For a non-shell tool `commandText` is `JSON.stringify(input)` (`tool-floors.ts:1127-1128`), so up to 2,000 chars of a `Write`'s file content leave, from any repo, allowlisted or not |
| Floor discovery with Jev via `openrouter` (not wired; needs a code change) | **OpenRouter and TypeSafe** | the same state, twice per decision (one request per group) | as above | as above |
| Floor discovery with Jev via `direct` (not wired) | TypeSafe | as above | as above | as above |
| Nightly `eval.yml` | Anthropic, from GitHub's runner | fixtures and synthetic scenario tool calls; no operator data | as above | as above |

**4. Failure behaviour on the live path with a negative OpenRouter balance.** There is no live
path to Jev, so nothing happens at a tool call or at task intake: neither is blocked or delayed.
On the discovery path, were Jev wired in:
- A `402` throws `typesafe provider 402 <error_type>` (`decision-typesafe.ts:221`; pinned by
  `decision-typesafe.test.ts:196-198`). A `429` retries at most twice inside the budget, then throws
  (`:198-205`).
- `DecisionService` keeps that reason as `degraded` and falls through to `model`
  (`decision.ts:483-487`); after 3 consecutive failures the `typesafe` circuit opens for 30 s
  (`:502-509`). This is loud (I-D2): the reason lands in the report.
- **But discovery throws Haiku's fallback answer away.** Any outcome carrying `degraded` is counted
  unjudged (`floor-discovery.ts:118-123`), even when the model judge answered. So §4.2's condition
  "keep Haiku behind it in the chain" buys nothing for discovery: with Jev failing, every call is
  unjudged.

**5. Credentials and pinning.**
- `TYPESAFE_API_KEY` is resolved per call from `process.env[ref]` through a `SecretBroker` scoped to
  that one reference and disposed at once (`decision.ts:353-363`). The provider refuses a `NAME=` or
  whitespace value before sending (`decision-typesafe.ts:137-139`). How the key file
  (`~/.agent-plane/personal/typesafe.key`) gets into the environment is outside the repo; not
  verified here.
- **`sk-or-v1-…` key with `typesafeRoute: direct`.** Nothing checks the key against the route at
  startup (`config.ts:552-566`, `decision.ts:341-351`), so it does **not** fail at startup. On the
  first call: a `401` disables the provider until restart, loudly (`decision-typesafe.ts:207-210`).
  Any other auth status, such as the `403` §11 records for a request with no key, is not special-cased:
  each call fails with `typesafe provider 403 …` and is retried at circuit-breaker pace (3 calls, then
  one per 30 s). Which status TypeSafe returns for a well-formed wrong key is **unknown**. Today no
  production caller sends with this key at all.
- **Pinning: not pinned.** Every path sends `jev-latest`: it is the default
  (`decision-typesafe.ts:34`, `:183`), `decisionProviders()` passes no `model` (`decision.ts:345-349`),
  and no config key exists for one (Appendix A, S9). §4.2's condition "pin `jev-1.13`" cannot be met
  by configuration.
- **`model_reported`:** the provider sets `modelReported` only when the vendor returns a string
  `model`, and only from the first group's answer (`decision-typesafe.ts:159`). No production path
  writes a Jev decision row: rows are written only with a DB and a record context
  (`decision.ts:425-427`), and the discovery bin passes neither (`decision-floor-discovery.ts:49-50`).
  The candidates file does not name the model that proposed each candidate
  (`floor-discovery.ts:141-164`). A candidate therefore cannot be traced to a model identity.

**6. Does "the gate never reads a typesafe answer" hold on every composition path?** **Yes.**
- `buildHarnessComposition` has two non-test callers (S7): `server.ts:147` and
  `eval/scenarios/boot-crash-recovery.ts:39` (no provider override). `buildServer` has two production
  callers (S6), `index.ts:9` and `scripts/measure-launch.ts:41`, neither passing `decisionProviders`.
- The overrides at `composition.ts:59` and `server.ts:83` feed only the `DecisionService`
  constructor (`composition.ts:186`) and open `applied` for an injected chain
  (`composition.ts:195`). The gate's `evaluate` never touches the service: it calls the local rules
  instance (`:204`, `:223`).
- `decision-typesafe.test.ts` drives this with both injected and production providers and
  `applied` requested (`:312-360`); Appendix B drives it on `buildServer` with 0 outbound requests.
- The guarantee is structural, not typed: the service is in scope at `composition.ts:184` and one
  `decisions.decide(...)` line inside `evaluate` would break it. The test above is what pins it.

### C.3 Deviations and inaccuracies found

- **The brief's premise in C.2(2) is wrong:** the discovery bin does not read `decisions.provider`.
- **PROJECT_MEMORY's Jev entry says "`provider: typesafe` now boots".** True on `main`; false on
  the operator's running build `2e3c9f4`.
- **I-D7's opt-in is validated on the wrong process** (C.2(2)).
- **§4.2's adoption conditions cannot all be met by configuration:** the pin (C.2(5)) and the
  "Haiku behind Jev" fallback (C.2(4)).
- **§4.4's "a repo outside `repoAllowlist` contributes no content" does not hold for
  `commandText`** on the discovery egress path (C.2(3)). K19e noted this for the gate; it matters
  now because discovery is the path that egresses.

---

## Part D — Gaps ranked by exposure

**Status (K19l, 2026-10-05):** #1, #7, #9 and the pin and model record in #10 are implemented on
branch `claude/k19l-honest-evidence`. #9 went further than proposed. An untrusted repo's whole
command is withheld (§4.4), not only its content fields. The owner has not decided whether to put
Jev on discovery. The default stays `model`.

Exposure is what flows through each gap on the operator workspace today (all-time harness traffic:
23 Claude tool calls; since T0: 2) and what would flow under the defaults.

| # | Gap | Exposure today | Smallest fix (proposal) | Owner decision? |
|---|---|---|---|---|
| 1 | **The soak passes §7.1(1) on the clock**: n = 3 passes on 2026-10-09 (`decision.ts:307`). Rows double-count permission-requiring calls, and a `preventive` row does not distinguish an adapter/mode pair that could hold a call | every activation decision for the tool gate | In `toolGateSoakCheck`, count distinct calls (dedupe a `pre-exec` row against the `post-start` row of the same session and tool) and require a floor of distinct `pre-exec` calls for the adapter/mode pair being activated, even at 14 days. Plan §7.4 precondition added by this review | No (evidence rule, no provider or egress change) |
| 2 | **Claude: no pre-exec hook under `auto-approve`, and none for CLI-allowed tools under `prompt-on-escalation`** | Operator: 4 of 23 calls had no pre-exec hook; under `auto-approve` (the personal default) 100% | Install an SDK `PreToolUse` hook callback (fires for every tool, including auto-allowed and subagent calls) that round-trips through `approval.requested`, answered at once by the plane unless an applied gate prompts. Narrower: keep `canUseTool` under `auto-approve`; it still misses rule-allowed tools | No egress change. It changes Claude's launch, so it needs the adapter's capability-manifest and regression evidence (K19d's open item) |
| 3 | **Audit-only adapter/mode pairs can be activated**: Codex, OpenRouter, Cursor, Bedrock and Claude-`auto-approve` have no pre-exec hook, yet `applied` is a single workspace switch | zero today (`applied` closed); every tool call of those adapters once opened | Activation refuses `applied` per assistant whose manifest has no `approvalRelay`, and for Claude under `auto-approve` until #2 lands; the refusal is logged and the site stays `shadow` for that assistant | No |
| 4 | **Codex/OpenRouter: file changes and MCP calls never reach the gate; `read-only` is not enforced on the SDK path** (`codex.ts:115`) | 0 harness runs on the operator; any Codex/OpenRouter run in a workspace that uses `auto-approve` or `read-only` | Emit `tool.started` for `file_change` and `mcp_tool_call` at `item.started` (both runtimes). Refuse `read-only` at prepare for adapters that do not honour it (`checkEnforceability`), as `prompt-on-escalation` already is | No |
| 5 | **Legacy path is ungated**: compare/race/parallel tasks and legacy-reserved dispatches | 0 compare/race tasks on the operator; all tasks if the flag is off | Refuse `applied` while `harnessModes.single` is off, and record a `notice` on every compare/race start that it runs ungated | No |
| 6 | **Hooks, MCP server processes and plugin code run outside the gate** in every adapter and mode | every operator Claude session (9 hook events; the claude-mem stdio server) | Document as outside the gate's boundary in §7.4. Optionally launch with `settingSources` limited so only declared hooks load | Yes, if `settingSources` changes (it changes what the provider loads) |
| 7 | **No configuration puts Jev on discovery; `decisions.provider` is dead config for the live server; I-D7 is validated on the wrong process** | blocks the pending owner decision | Add `decisions.discoveryProvider` (`model` default) and `decisions.typesafeModel` (a pinned id), read only by the discovery bin, which then runs `validateDecisions`' I-D7 checks itself. Leave the live server reading neither | **Yes** (egress) |
| 8 | **Discovery discards the fallback judge's answer** when the head degrades (`floor-discovery.ts:118`) | every Jev failure once wired; with today's `model` head, none | Count a `degraded` outcome whose `provider` is a judge as judged by that provider, and name both in the report | **Yes** (changes which provider's answers count) |
| 9 | **`commandText` carries file content past the trust gate** on the discovery egress path | every unfloored `Write`/`Edit` in the discovery window, to Anthropic today and to two more parties with Jev | Before judging, replace content-bearing fields of a non-shell tool's input (`content`, `new_string`, `old_string`) with their length | **Yes** (changes judge inputs and what egresses) |
| 10 | **Jev unpinned; candidates carry no model identity** | none until #7 | Pass the pinned model from #7; add `modelReported` to each candidate and to the report header | Pin: **yes** (part of #7). Recording the model: no |
| 11 | **`sk-or-v1-…` key on the `direct` route is not caught before a request** | none today | Refuse in `TypeSafeDecisionProvider.decide` before sending, as the `NAME=` check does, naming the route | No |
| 12 | **Cursor: every call is `opaque` and the adapter enforces no mode** | 0 on the operator | Map the tool input from Cursor's JSON once the schema is verified; until then treat Cursor as #3 (audit-only, refused for `applied`) | No |
| 13 | **Bedrock: unreachable** | 0 on the operator | Already recorded (K19c); covered by #3 | No |

---

## Appendix A — Search log (full hit lists)

Run from the repository root on `main@bd67c09`. Test files are excluded unless the search says
otherwise; the test hits for S1–S3 were checked separately and construct services only inside
tests.

**S1** `grep -rn "new DecisionService(" --include=*.ts apps/api/src eval scripts apps/web/e2e`
```
apps/api/src/modules/harness/composition.ts:184:  const decisions = new DecisionService(
apps/api/src/bin/decision-floor-discovery.ts:49:const service = new DecisionService(config, decisionProviders(config));
```

**S2** `grep -rn "\.decide(" --include=*.ts apps/api/src packages/core/src packages/adapters/src eval scripts`
```
apps/api/src/modules/decision-typesafe.ts:125:    const baseline = await this.rules.decide(req);
apps/api/src/modules/decision.ts:480:        const outcome = await withTimeout(provider.decide(req), req.budgetMs, id);
apps/api/src/modules/decision-model.ts:158:    const baseline = await this.rules.decide(req);
apps/api/src/modules/harness/recovery.ts:140:      return await this.decide(sessionId, s0, lease);
apps/api/src/modules/harness/composition.ts:223:      const outcome = await rules.decide(req);
apps/api/src/bin/decision-floor-discovery.ts:50:const report = await discoverFloorCandidates(actions, (req) => service.decide(req), mcpTools);
```

**S3** `grep -rn "decisionProviders" --include=*.ts apps/api/src eval scripts apps/web/e2e`
```
apps/api/src/server.ts:83:  /** M16 decision providers beyond rules. Test/scratch only — production registers `decisionProviders()` (K19d: the model judge). */
apps/api/src/server.ts:84:  decisionProviders?: DecisionProvider[];
apps/api/src/server.ts:156:    decisionProviders: deps.decisionProviders,
apps/api/src/modules/decision.ts:341:export function decisionProviders(config: DecisionServiceConfig): DecisionProvider[] {
apps/api/src/modules/harness/composition.ts:45:import { DecisionService, decisionProviders, insertDecisionRecord } from "../decision.js";
apps/api/src/modules/harness/composition.ts:59:  /** Replaces `decisionProviders(config.decisions)`. Test/scratch only — production registers `decisionProviders()` (K19d: the model judge). */
apps/api/src/modules/harness/composition.ts:60:  decisionProviders?: DecisionProvider[];
apps/api/src/modules/harness/composition.ts:186:    deps.decisionProviders ?? decisionProviders(config.decisions),
apps/api/src/modules/harness/composition.ts:195:  if (activation.mode === "applied" && !deps.decisionProviders) {
apps/api/src/bin/decision-floor-discovery.ts:18:import { DecisionService, decisionProviders } from "../modules/decision.js";
apps/api/src/bin/decision-floor-discovery.ts:49:const service = new DecisionService(config, decisionProviders(config));
```

**S4** `grep -rn "insertDecisionRecord(" --include=*.ts apps/api/src` (every writer of `decision_records`)
```
apps/api/src/modules/decision.ts:95:export function insertDecisionRecord(
apps/api/src/modules/decision.ts:144:  insertDecisionRecord(
apps/api/src/modules/decision.ts:426:      insertDecisionRecord(this.db, req, outcome, record, new Date(this.clock()).toISOString());
apps/api/src/modules/harness/composition.ts:241:      insertDecisionRecord(
```

**S5** `grep -rnE "toolGate\b|evaluateGuards\(" --include=*.ts apps/api/src`
```
apps/api/src/modules/harness/session-runner.ts:134:  toolGate?: {
apps/api/src/modules/harness/session-runner.ts:476:        const directive = evaluateGuards(this.snapshot, { kind: "event", event, atMs: this.runner.clock(), gate });
apps/api/src/modules/harness/session-runner.ts:706:        const d = evaluateGuards(this.snapshot, { kind: "tick", atMs: this.runner.clock() });
apps/api/src/modules/harness/session-runner.ts:1349:    const gate = this.d.toolGate;
apps/api/src/modules/harness/composition.ts:205:  const toolGate: NonNullable<RunnerDeps["toolGate"]> = {
apps/api/src/modules/harness/composition.ts:268:    toolGate,
apps/api/src/modules/harness/guards.ts:77:export function evaluateGuards(snap: GuardSnapshot, trigger: GuardTrigger): GuardDirective {
```

**S6** `grep -rn "buildServer(" --include=*.ts apps/api/src eval scripts apps/web/e2e`
```
apps/api/src/server.ts:109:export function buildServer(deps: ServerDeps): BuiltServer {
apps/api/src/index.ts:9:const { app, registry, orchestrator, scheduler, modelCatalog } = buildServer({ config, db });
eval/harness/boot.ts:53:  const built = buildServer({ config, db, ...(opts.modelCatalogSources ? { modelCatalogSources: opts.modelCatalogSources } : {}) });
scripts/measure-launch.ts:41:  const built = buildServer({ config, db });
apps/web/e2e/harness.ts:95:  const built = buildServer({
apps/web/e2e/demo-a.spec.ts:72:  built = buildServer({ config, db, now: () => clock, quotaProbeFn: demoProbe });
apps/web/e2e/auth.spec.ts:13:  (one line; buildServer({config,db,now:()=>clock}))
apps/web/e2e/headless-open.spec.ts:15:  const built = buildServer({ config, db });
apps/web/e2e/demo-a5.spec.ts:51:  built = buildServer({ config, db, now: () => clock });
```

**S7** `grep -rn "buildHarnessComposition(" --include=*.ts apps/api/src eval scripts apps/web/e2e`
```
apps/api/src/server.ts:147:  const composed = buildHarnessComposition({
apps/api/src/modules/harness/composition.ts:93:export function buildHarnessComposition(deps: HarnessCompositionDeps): HarnessComposition {
eval/scenarios/boot-crash-recovery.ts:39:    const composed = buildHarnessComposition({
```

**S8** `grep -rnE "decisions\.(provider|typesafeApiKeyRef|typesafeRoute)|config\.provider\b|typesafeRoute" --include=*.ts apps/api/src`
```
apps/api/src/config.ts:132:    typesafeRoute?: "direct" | "openrouter";
apps/api/src/config.ts:201:  typesafeRoute?: "direct" | "openrouter";
apps/api/src/config.ts:499:    throw new Error(`${configPath}: decisions.provider must be one of …`);
apps/api/src/config.ts:505:  const route = file?.typesafeRoute;
apps/api/src/config.ts:507:    throw new Error(`${configPath}: decisions.typesafeRoute must be direct | openrouter, …`);
apps/api/src/config.ts:514:    ...(route !== undefined ? { typesafeRoute: route } : {}),
apps/api/src/config.ts:553:  const ref = decisions.typesafeApiKeyRef;
apps/api/src/config.ts:555:    throw new Error(`Invalid config at ${path}:\n  - decisions.typesafeApiKeyRef must be a non-empty string`);
apps/api/src/config.ts:559:      `Invalid config at ${path}:\n  - decisions.typesafeApiKeyRef: sending decision state to TypeSafe is opt-in …`,
apps/api/src/config.ts:562:  if (decisions.provider === "typesafe" && ref === undefined) {
apps/api/src/config.ts:564:      `Invalid config at ${path}:\n  - decisions.provider: typesafe needs decisions.typesafeApiKeyRef; …`,
apps/api/src/config.ts:684:      "# decisions.provider: M16 Decision Service seam (K17). No vendor provider exists yet — `rules`",
apps/api/src/modules/decision-typesafe.ts:6: * whatever `decisions.provider` says (composition.ts calls the rules provider
apps/api/src/modules/decision-typesafe.ts:31:/** The two documented endpoints (`decisions.typesafeRoute`). `/v1/systemone` is appended to either. */
apps/api/src/modules/decision.ts:23:   * The TypeSafe key's reference NAME (`decisions.typesafeApiKeyRef`). Naming
apps/api/src/modules/decision.ts:28:  /** Which endpoint serves Jev (`decisions.typesafeRoute`); default `direct`. */
apps/api/src/modules/decision.ts:29:  typesafeRoute?: "direct" | "openrouter";
apps/api/src/modules/decision.ts:330: * Registering is not selecting: the chain starts at `config.provider`, whose
apps/api/src/modules/decision.ts:348:      baseUrl: TYPESAFE_ROUTES[config.typesafeRoute ?? "direct"],
apps/api/src/modules/decision.ts:399:    if (!this.providers.has(config.provider)) {
apps/api/src/modules/decision.ts:401:        `decisions.provider: ${JSON.stringify(config.provider)} is not registered in this build ` +
apps/api/src/modules/decision.ts:403:          `decisions.provider to use rules.`,
apps/api/src/modules/decision.ts:441:    const chain = FALLBACK_ORDER.slice(Math.max(FALLBACK_ORDER.indexOf(this.config.provider), 0));
apps/api/src/modules/decision.ts:460:    const startIdx = FALLBACK_ORDER.indexOf(this.config.provider);
```
No hit in `apps/api/src/bin/`: the discovery bin reads none of these keys.

**S9** `grep -rnE "typesafe\.ai|openrouter\.ai|jev-latest|jev-1|DEFAULT_TYPESAFE_MODEL|TYPESAFE_ROUTES" --include=*.ts apps/api/src packages`
```
apps/api/src/config.ts:128:     * `api.typesafe.ai`; `openrouter` is OpenRouter's System One API, the same
apps/api/src/modules/decision-typesafe.ts:10: * Transport, checked against docs.typesafe.ai on 2026-10-04:
apps/api/src/modules/decision-typesafe.ts:11: * `POST https://api.typesafe.ai/v1/systemone`, Bearer auth, body
apps/api/src/modules/decision-typesafe.ts:15: * `https://openrouter.ai/api/v1/systemone` with an OpenRouter key, maps
apps/api/src/modules/decision-typesafe.ts:16: * `jev-latest` to `~typesafe/jev-latest`, and adds `usage.cost` (USD), which
apps/api/src/modules/decision-typesafe.ts:32:export const TYPESAFE_ROUTES = { direct: "https://api.typesafe.ai", openrouter: "https://openrouter.ai/api" } as const;
apps/api/src/modules/decision-typesafe.ts:34:export const DEFAULT_TYPESAFE_MODEL = "jev-latest";
apps/api/src/modules/decision-typesafe.ts:42: * state as a known failure mode (jev-1.13 jaggedness #6).
apps/api/src/modules/decision-typesafe.ts:183:    const body = JSON.stringify({ state, model: this.opts.model ?? DEFAULT_TYPESAFE_MODEL, questions });
apps/api/src/modules/decision-typesafe.ts:189:        res = await fetch(`${this.opts.baseUrl ?? TYPESAFE_ROUTES.direct}/v1/systemone`, {
apps/api/src/modules/decision.ts:16:import { TYPESAFE_ROUTES, TypeSafeDecisionProvider } from "./decision-typesafe.js";
apps/api/src/modules/decision.ts:348:      baseUrl: TYPESAFE_ROUTES[config.typesafeRoute ?? "direct"],
packages/adapters/src/openrouter.ts:27:    const baseUrl = options.baseUrl ?? "https://openrouter.ai/api/v1";
```
No `jev-1.13` model id anywhere in code: the pin does not exist.

**S10** `grep -rn "recordTaskClassification(" --include=*.ts apps/api/src`
```
apps/api/src/modules/tasks.ts:84:    recordTaskClassification(this.db, taskId, intent, now);
apps/api/src/modules/decision.ts:141:export function recordTaskClassification(db: Db, taskId: string, intent: ClassifierIntent, createdAt: string): void {
```

**S11** `grep -rnE "\"(tool-gate|task-classifier|context-breakpoint)\"" --include=*.ts apps/api/src packages/core/src`
```
apps/api/src/config.ts:140, 203, 275, 501, 511         (site mode config, tool-gate only)
apps/api/src/server.ts:300                              (knownSites filter for GET /api/decisions)
apps/api/src/modules/decision-typesafe.ts:120, 126      (judges tool-gate only)
apps/api/src/modules/decision.ts:147                    (K20 intake row)
apps/api/src/modules/decision.ts:439                    (activation, tool-gate)
apps/api/src/modules/decision-model.ts:152, 159         (judges tool-gate only)
apps/api/src/modules/floor-discovery.ts:113             (discovery request)
apps/api/src/modules/harness/composition.ts:190, 222    (gate)
packages/core/src/decision.ts:35, 697, 698, 699, 743, 749, 755   (type and rules basis)
```
`context-breakpoint` has no producer outside `packages/core` and the read filter.

**S12** `grep -nE "^\s+(async )?send\(" packages/adapters/src/*.ts`
```
packages/adapters/src/claude.ts:446:  async send(handle: RunHandle, input: RunInput): Promise<void> {
packages/adapters/src/fake.ts:254:  async send(handle: RunHandle, input: RunInput): Promise<void> {
```

**S13** `grep -nE "type: \"(tool\.started|approval\.requested)\"" packages/adapters/src/*.ts`
```
packages/adapters/src/claude.ts:309:              type: "tool.started",
packages/adapters/src/claude.ts:427:      type: "approval.requested",
packages/adapters/src/codex-app-server-runtime.ts:82:        if (item.type === "commandExecution") this.emit(state, { type: "tool.started", …
packages/adapters/src/codex.ts:184:            type: "tool.started",
packages/adapters/src/cursor.ts:227:      return [{ type: "tool.started", summary: tool, payload: { tool }, raw: parsed }];
packages/adapters/src/fake.ts:31:    { type: "tool.started", summary: "$ ls src", payload: { toolUseId: "t1", tool: "shell", command: "ls src" } },
packages/adapters/src/fake.ts:186:      emit({ type: "tool.started", summary: `MCP ${m[1]}`, …
packages/adapters/src/fake.ts:196:      emit({ type: "tool.started", summary: `Read ${filePath}`, …
packages/adapters/src/fake.ts:234:      type: "approval.requested",
```
No hit in `bedrock.ts` or `openrouter.ts` (OpenRouter delegates to `codex.ts`).

**S14** `grep -nE "permissionPolicy|permissionMode|canUseTool:|approvalPolicy|sandboxMode|sandbox:" packages/adapters/src/*.ts`
```
packages/adapters/src/claude.ts:120:        permissionModes: ["default", "acceptEdits", "bypassPermissions", "dontAsk", "auto"],
packages/adapters/src/claude.ts:173:        permissionMode: run.permissionPolicy.mode === "auto-approve" ? "bypassPermissions" : "default",
packages/adapters/src/claude.ts:174:        allowDangerouslySkipPermissions: run.permissionPolicy.mode === "auto-approve" ? true : undefined,
packages/adapters/src/claude.ts:175:        canUseTool:
packages/adapters/src/claude.ts:176:          run.permissionPolicy.mode === "prompt-on-escalation"
packages/adapters/src/codex-app-server-runtime.ts:57:      sandbox: run.permissionPolicy.mode === "read-only" ? "read-only" : "workspace-write",
packages/adapters/src/codex-app-server-runtime.ts:58:      approvalPolicy: "never",
packages/adapters/src/codex.ts:45: *   (workspace-write, approvalPolicy "never"); supportsMidRunInput: false.
packages/adapters/src/codex.ts:91:        sandboxModes: ["read-only", "workspace-write", "danger-full-access"],
packages/adapters/src/codex.ts:115:      sandboxMode: "workspace-write" as const,
packages/adapters/src/codex.ts:118:      approvalPolicy: "never" as const,
```
No hit in `cursor.ts`, `bedrock.ts` or `openrouter.ts`: those adapters do not read the approval mode.

**S15** `grep -nE "case \"[a-z]+\":" apps/api/src/modules/registry.ts` (every adapter the registry builds)
```
197:    case "anthropic":
199:    case "openai":
201:    case "openrouter":
203:    case "cursor":
205:    case "bedrock":
209:    case "fake":
```

## Appendix B — Drives

**B.1 Live server, `decisions.provider: typesafe`, `typesafeRoute: openrouter`, dummy keys.** A
scratch script built the server with `buildServer({ config, db })`, patched `globalThis.fetch`,
`http.request` and `https.request` to log every outbound request, and ran one fake-assistant task
per scenario (goal `fix the build [FAKE:APPROVAL] [FAKE:MCP:mcp__notion__notion-create-pages]
[FAKE:READ:/etc/hosts]`).

```
### A harness, prompt-on-escalation
task-classifier rules shadow
tool-gate rules shadow post-start audit      auto-approve  no floor fired; approvalMode decides
tool-gate rules shadow pre-exec   preventive prompt        floors: [recursive-forced-rm] …
outbound requests during scenario: 0 []
### B harness, auto-approve
task-classifier rules shadow
tool-gate rules shadow post-start audit      auto-approve  no floor fired; approvalMode decides
tool-gate rules shadow pre-exec   preventive prompt        floors: [recursive-forced-rm] …
tool-gate rules shadow post-start audit      prompt        floors: [opaque] … (an MCP tool …)
tool-gate rules shadow post-start audit      prompt        floors: [path-outside-worktree] …
outbound requests during scenario: 0 []
### C legacy path (harnessModes.single=false)
task-classifier rules shadow
outbound requests during scenario: 0 []
TOTAL outbound requests across all scenarios: 0
```
`model_reported` and `degraded_reason` were NULL on every row. Scenario A stopped at the pre-exec
prompt, which waits for a human, so its later calls never ran.

**B.2 Discovery bin on a workspace configured for Jev.** Workspace `config.yaml`:
`decisions: { provider: typesafe, typesafeApiKeyRef: TYPESAFE_API_KEY, typesafeRoute: openrouter }`;
one recorded `tool.started` (`$ ls src`); `TYPESAFE_API_KEY` set to a dummy value, no
`ANTHROPIC_API_KEY`; `fetch` logged through `NODE_OPTIONS=--import`.

```
floor discovery: 1 calls, 1 distinct, 0 floored, 0 judged, 1 unjudged, 0 candidates
  (unjudged: model provider has no credential (ANTHROPIC_API_KEY unset))
```
No `EGRESS` line was printed: no request was made, to TypeSafe, OpenRouter or anyone else.

## Appendix C — Operator soak, from a DB copy

Copy made with `better-sqlite3`'s `backup()` from a read-only handle; the live
`agent-plane.db` checksum was identical before and after.

**C.1** `decision_records`: 42 rows, all `site = 'tool-gate'`, `provider = 'rules'`,
`mode = 'shadow'`, 2026-09-24T13:25:33Z to 2026-09-26T16:41:59Z; `degraded_reason`,
`model_reported` and `input_tokens` NULL on all 42.

**C.2** By hook, all time: post-start/audit 23 (14 auto-approve, 9 prompt); pre-exec/preventive 19
(10 auto-approve, 9 prompt). Since T0: post-start/audit 2, pre-exec/preventive 1, all
`auto-approve` (the gate added nothing). Runs: `personal-claude` 9 legacy and 16 harness;
`personal-codex` 4 legacy (2026-09-15). Tasks: 24, all mode `single`; newest created
2026-09-26T16:41:23Z.

**C.3** Pairing, harness runs, all time: 23 `tool.started`, 19 `approval.requested`; 19 of 19
approvals follow a `tool.started` of the same tool in the same run. Since T0, in session
`es_d9d2443d…`: `ToolSearch` (tool.started only); `mcp__plugin_claude-mem_mcp-search__search`
(tool.started, then approval.requested).

**C.4** `toolGateSoakCheck(db, { since: "2026-09-25T21:31:57.293Z", now })`:
```
now 2026-10-04T14:00:00Z  volume { n: 3, days: 8.69,  pass: false }
now 2026-10-09T21:32:00Z  volume { n: 3, days: 14.00, pass: true }
byHook: post-start 2 calls 0 prompts; pre-exec 1 call 0 prompts
```
