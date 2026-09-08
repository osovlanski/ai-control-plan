# K10 blocker — no callable mid-run compaction control in today's Claude integration

Status: **blocked, not implemented.** K10 (provider-command context compaction)
was taken through the real-adapter conformance gate required by
`docs/agentic-os-kernel-services.md` §4.3.2 and §5.2 (K10 acceptance items
11–13) before any Control Plane behaviour was written. The gate failed on the
mechanism, not on the plane design, so nothing was built: no adapter compaction
control, no compaction directive, no `context.compaction.requested` /
`.relieved` / `.unrelieved` / `.unknown` events, no `maxCompactionsPerSession`
or `minTurnsBetweenActions` enforcement, and no capability change. Every adapter
still declares `context.compact: "none"`.

K9 (observation) and K11 (bounded checkpoint-backed continuation) are unchanged
and remain the shipped behaviour: a fresh critical observation checkpoints and
yields `context`, and the Control Plane continues from that checkpoint.

## What the gate required

The K10 product outcome is an intervention *inside a running session*:

```
fresh pressure >= actRatio  ->  request compaction on THIS conversation
                            ->  event pump keeps running
                            ->  observe the boundary / a fresh sample
                            ->  relieved (continue) or unrelieved (K11)
```

That requires a compaction control which (a) is callable, (b) targets the live
conversation, (c) does not start a second session, (d) acknowledges success or
failure, and (e) can be issued at the moment pressure is observed — which, in
this Harness, is mid-turn, because a session is one long agentic turn.

## What was measured

Three bounded live probes against the installed stack — Claude Agent SDK
**0.3.238**, Claude Code CLI **2.1.263**, local CLI login. Trivial prompts, no
provider transcript retained, nothing written to the repository, no credential
material recorded.

| # | Probe | Result |
|---|---|---|
| 1 | `/compact` pushed as a user message at a turn boundary of a *one-turn* conversation | Recognised and executed: `system/status status=compacting`, then `status=null compact_result=failed compact_error="Not enough messages to compact."`. Same `session_id` throughout; one distinct session. `getContextUsage()` answered before and after. |
| 2 | `/compact` pushed **mid-turn**, while the agent was running Bash steps | **Not executed.** It was delivered to the model as ordinary user text; the model itself reported that "`/compact` arrived mid-turn as text, not as a CLI command". No `status=compacting`, no boundary, no compaction. The pump kept running and `getContextUsage()` still answered mid-turn (`totalTokens=39072`). |
| 3 | Four real turns, then `/compact` at a turn boundary | **Succeeded.** `status=compacting` → `compact_result=success` after **88.4 s**; `compact_boundary` with `trigger: "manual"`, `pre_tokens 48930 → post_tokens 18342`. One distinct `session_id`; no second session. The next fresh `getContextUsage()` read `42095` against `rawMaxTokens 1000000`. |

Probe 3 is the positive proof that the provider mechanism exists and is
correlatable: a plane-requested compaction reports `trigger: "manual"`, whereas
provider auto-compaction (what K9 records today) reports `trigger: "auto"`.

## Why it still cannot be used

Three findings, each independently blocking.

**1. There is no compaction control request.** The SDK's control protocol in
0.3.238 has no compaction verb. The complete set of control subtypes in
`sdk.mjs` is `apply_flag_settings, background_tasks, cancel_async_message,
channel_enable, claude_authenticate, claude_oauth_callback,
claude_oauth_wait_for_completion, generate_session_title, get_context_usage,
get_settings, get_usage, initialize, interrupt, mcp_*, message_rated,
mirror_error, read_file, reload_plugins, reload_skills, remote_control,
rewind_files, seed_read_state, set_cwd, set_max_thinking_tokens, set_model,
set_permission_mode, side_question, stop_task, submit_feedback,
ultrareview_launch`. The `Query` interface exposes `getContextUsage()` — which
is why K9 observation works — but no compaction counterpart. The only way to
reach compaction is a user message carrying the `/compact` text.

**2. The user-message path only works at a turn boundary.** Probe 2 shows that
the same message injected while a turn is in flight is *not* interpreted as a
command; it is appended to the conversation as literal user text. So the path is
not merely unacknowledged mid-turn — using it mid-turn silently pollutes the
provider conversation with a stray message and compacts nothing. That is the
opposite of I-C1's spirit and cannot be shipped.

**3. In this Harness the only turn boundary is the end of the run.**
`ClaudeAdapter.launch` passes `RunSpec.prompt` to `query()` as a **string**. The
SDK sets `isSingleUserTurn: true` for a string prompt and closes stdin on the
first `result` message (`sdk.mjs`: "First result received for single-turn query,
closing stdin"). One session is one turn: the run ends exactly where a
`/compact` would become executable. Compaction at that point relieves nothing —
the work is already done and the session is settling. There is no point in a
session's life where the plane can both issue the command and keep working in
that conversation.

A fourth fact bears on any future design: compaction took **88 seconds** in
probe 3. Any implementation that awaited the outcome inline would stall the
event pump for that long, which §4.3.2 explicitly forbids — the outcome has to
be read from the stream (`status`, `compact_boundary`) and a later fresh
observation, never awaited synchronously.

## Rejected workarounds

- **Interrupt, then compact, then re-prompt.** `Query.interrupt()` does end the
  turn and would create a boundary, but it aborts in-flight work, discards the
  turn the operator is paying for, and needs a re-prompt to resume — which is
  K11's job, done worse and without a checkpoint anchor. It also breaks the
  "event pump keeps running" invariant it was supposed to serve.
- **Lowering the auto-compaction threshold** via `applyFlagSettings` (the
  `autoCompactWindow` / `autoCompactEnabled` settings keys are real and
  merge mid-session). This does not request a compaction; it re-tunes provider
  auto-management and leaves the decision, the timing and the outcome with the
  provider. The resulting boundary reports `trigger: "auto"` and is
  indistinguishable from ordinary autocompaction, so correlating it with a plane
  directive would be an inference, not evidence — §4.3.2 requires the opposite.
  It is a candidate *nudge*, not a compaction control, and declaring
  `compact: "provider-command"` on the back of it would be false.
- **Codex App Server `thread/compact/start`.** Still beyond the installed SDK
  (0.149.0) and still needs an app-server transport that does not exist here.
  Unchanged since K9.
- **Multi-turn sessions in the plane**, so that intermediate turn boundaries
  exist. This is a redesign of the execution model, not a context feature, and
  even then compaction would only be possible between turns — where a checkpoint
  plus K11 already relieves pressure with durable, auditable evidence.

## Smallest future seam

In preference order, smallest first:

1. **A `compact` control request in the Agent SDK**, shaped like
   `get_context_usage`: callable mid-turn on the live session, resolving with an
   acknowledgement (or the existing `compact_result` / `compact_error` pair) and
   emitting `compact_boundary` with `trigger: "manual"`. With that, K10 is a
   small change: an optional `compactContext?(handle): Promise<void>` on
   `AgentAdapter` next to `observeContext`, `context.compact:
   "provider-command"` on the Claude manifest only, a durable non-idempotent
   `compact` directive in the existing `guard_directives` table (which needs an
   `unknown` status and an "issued" phase, i.e. one migration), the five
   `context.compaction.*` events, and the `actRatio` rung in
   `evaluateContextGuard` ahead of the existing `criticalRatio` yield. The plane
   design in §4.3.2 needs no revision.
2. **Failing that, mid-turn command expansion for queued user messages** — the
   CLI executing a queued `/compact` as a command rather than appending it as
   text. Weaker: the acknowledgement would be the `status` / boundary pair only,
   and the adapter would first have to move to streaming-input mode with a live
   input channel so the run does not end at the first `result`. That change also
   alters run-lifecycle semantics (`run.ended` currently follows stream end) and
   would need its own conformance pass.

Until one of those exists, the ladder for a Claude session under critical
context pressure is the K11 one that ships today: checkpoint, `YIELDED(context)`,
Control Plane continuation from that checkpoint.

## What stays true meanwhile

- No adapter declares `context.compact: "provider-command"`.
  `packages/adapters/test/context-capability.test.ts` still pins every adapter
  to `"none"`, and `evaluateContextGuard` still declines to yield when a
  `provider-command` capability is declared — an honest, inert K10 seam.
- `ContextPolicy` keeps `warnRatio 0.70`, `actRatio 0.85`, `criticalRatio 0.92`
  and the task-level bounds. `maxCompactionsPerSession` and
  `minTurnsBetweenActions` were **not** added: they are compaction-only bounds,
  and adding enforced-by-nothing fields would misrepresent what the guard does.
  They belong with the seam above.
- Provider auto-management remains primary (CR-34). Claude's own autocompaction
  is the only mechanism that operates without a turn boundary, and K9 records it
  as `context.compaction.observed` with `requestedByPlane: false` — observed,
  never claimed as an Agentic OS action.
- `/clear` is never issued (I-C3), no pruning exists, and no speculative Codex
  compaction was added.

## Re-verifying this finding

The probes are not committed (they are throwaway scripts that spend real
tokens). To repeat the decisive one: open a `query()` with an async-iterable
prompt, run a few turns, push a user message whose text is `/compact` **while a
turn is in flight**, and watch the stream. Today it arrives as text. When it
arrives as `status=compacting` followed by a `compact_boundary` with
`trigger: "manual"`, and `getContextUsage()` reports relief on the same
`session_id`, finding 2 is obsolete and K10 can proceed to finding 3's adapter
change.
