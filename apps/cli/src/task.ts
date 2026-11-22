/**
 * `aos task`: task reads over the plane's own routes. `provenance` (tlm-03) is the CLI side of
 * tlm-02a's `GET /api/tasks/:id/provenance` (API 2.12); `ls`, `show`, `events` and `verdict` are
 * p1-3 slice 1 (docs/cli/aos-parity.md). Every command is read-only.
 *
 * The plane makes every cross-record join (run → routing decision, dispatch, checkpoint, handoff
 * record, Harness envelope) and names the source of each one. This file only prints what it is
 * served: it never joins records itself, and it says "inferred" or "unrecorded" wherever the plane
 * does, so a guessed join never reads as a stored one. `show` embeds that same read and text as its
 * provenance block. The stage, the verification verdict and the task state are printed as the
 * plane serves them; the verdict label uses the web's own pure helper (`orbital.ts`), so the CLI
 * and the UI read one verification identically and neither recomputes it.
 */
import { parseArgs } from "node:util";
import { redactSecrets } from "@agent-plane/core";
import type {
  Continuation, HandoffProvenance, JoinSource, RoutingDecisionRef, RunProvenance, TaskProvenance,
} from "../../api/src/modules/provenance.js";
import type { SessionDetail, TaskDetail, TaskEvent, TaskSummary, VerificationView } from "../../web/src/api.js";
// Pure, type-only-importing helpers of the web UI: the same verdict and check wording.
import { verificationCheckView, verificationFromEvent, verificationVerdict } from "../../web/src/orbital.js";
import { PlaneError, type PlaneClient } from "./client.js";
import { checkEstimate, checkRecorded, estimateText, recordedText } from "./estimate.js";

export type TaskCapability = "tasks.read" | "sessions.read" | "events.read" | "events.stream" | "routing.read";

export interface TaskDeps {
  /** A client whose credential holds `capability`; resolved lazily so `--help` reads no file. */
  connect(capability: TaskCapability, options: { api?: string; credential?: string }): PlaneClient;
  out(text: string): void;
  err(text: string): void;
}

export const USAGE = `usage: aos task <command> [options]

Read (every command is read-only):
  ls [--attention] [--state <S>] [--stage <S>]
                               tasks, newest first, with the plane's state and stage; --attention
                               keeps stage needs-you (GET /api/tasks; tasks.read)
  show <id>                    one task: goal, state, stage, wait, runs and their models, then the
                               provenance block (GET /api/tasks/:id, GET /api/tasks/:id/provenance,
                               GET /api/tasks for the stage; tasks.read, sessions.read). --json
                               adds "stage" and "provenance" to the served detail.
  events <id> [--follow]       the task's activity, oldest first (GET /api/tasks/:id/events;
                               events.read). --follow then streams new activity and exits when the
                               task reaches stage done (GET /api/tasks/:id/events/stream;
                               events.stream). With --json, --follow prints NDJSON: one served
                               event row per line, then one stream frame per line.
  verdict <id>                 the last ended run's verification: the plane's passed flag, read as
                               passed, failed or blocked, with each check (GET /api/tasks/:id and
                               GET /api/tasks for the stage, then
                               GET /api/sessions/:id for a Harness run or, for a legacy run, its
                               verification.result event from GET /api/tasks/:id/events;
                               tasks.read, sessions.read, events.read)
  provenance <id>              where each run came from: routing decision, launch (operator,
                               scheduler dispatch, handoff, compare/race), the run it continues,
                               and every handoff, each join labelled with its source
                               (GET /api/tasks/:id/provenance, API 2.12; sessions.read)
  estimate <id> [--deadline <iso>] [--approval-required] [--assistant <id>]
                               the plane's ADVISORY run estimate and scheduling recommendation:
                               runtime, model, effort, duration and token ranges, wait until
                               start, approval wait, and API spend, API-equivalent and
                               subscription quota on separate lines (GET /api/tasks/:id/estimate,
                               API 2.15; routing.read). --assistant asks a what-if.
  estimate <id> --recorded     the estimate stored at each run's start beside what the run then
                               recorded (GET /api/tasks/:id/estimates/recorded, API 2.16;
                               routing.read)

Options:
  --json                       print the plane's response body as served (show and verdict: the
                               served reads, combined under named keys)
  --api <origin>               plane origin on loopback (default: workspace config, or AOS_API_URL)
  --credential <path>          bearer credential file (default: the workspace's, or AOS_CREDENTIAL_FILE)

Join sources: a stored key (execution_request, dispatch, handoff_record, handoff_envelope,
checkpoint), "inferred" (no key exists, so the plane followed the stated rule printed below the
runs), or "unrecorded" (nothing names it; never back-filled).

Exit codes: 0 ok, 1 failure (including an unknown task, or a stream that ended before the task
was done), 2 usage. A read that succeeds exits 0 whatever the verdict says.`;

/**
 * The routes each command can reach, for `--help` and the parity test. `verdict` reaches the
 * session read for a Harness run and the events read for a legacy one, never both for one run.
 */
export const COMMAND_ROUTES: Readonly<Record<string, readonly string[]>> = Object.freeze({
  ls: ["GET /api/tasks"],
  show: ["GET /api/tasks/:id", "GET /api/tasks/:id/provenance", "GET /api/tasks"],
  events: ["GET /api/tasks/:id/events"],
  "events --follow": ["GET /api/tasks/:id/events/stream", "GET /api/tasks/:id/events"],
  verdict: ["GET /api/tasks/:id", "GET /api/tasks", "GET /api/sessions/:id", "GET /api/tasks/:id/events"],
  provenance: ["GET /api/tasks/:id/provenance"],
  estimate: ["GET /api/tasks/:id/estimate"],
  "estimate --recorded": ["GET /api/tasks/:id/estimates/recorded"],
});

const SOURCES: readonly JoinSource[] = ["execution_request", "dispatch", "handoff_record", "handoff_envelope", "checkpoint", "inferred", "unrecorded"];

/**
 * A shape check, not a contract validator (tlm-02a ships none): enough that a plane older than
 * API 2.12, or a body of another shape, is refused instead of printed as if it were provenance.
 */
export function checkProvenance(body: unknown, taskId: string): TaskProvenance {
  const fail = (why: string) => { throw new PlaneError(`The plane's provenance for ${taskId} is not the API 2.12 shape, so nothing is shown: ${why}`); };
  if (typeof body !== "object" || body === null || Array.isArray(body)) return fail("not an object");
  const p = body as Partial<TaskProvenance>;
  if (p.taskId !== taskId) fail(`taskId is ${JSON.stringify(p.taskId)}`);
  if (!Array.isArray(p.runs)) fail("runs is not a list");
  if (!Array.isArray(p.handoffs)) fail("handoffs is not a list");
  if (typeof p.owner !== "object" || p.owner === null) fail("owner is missing");
  if (typeof p.inferenceRules !== "object" || p.inferenceRules === null) fail("inferenceRules is missing");
  for (const r of p.runs!) {
    if (typeof r?.runId !== "string" || !r.routingDecision || !SOURCES.includes(r.routingDecision.source)) fail(`run ${JSON.stringify(r?.runId)} has no labelled routing decision`);
    if (r.continuedFrom && !SOURCES.includes(r.continuedFrom.source)) fail(`run ${r.runId} has an unlabelled continuation`);
  }
  for (const h of p.handoffs!) {
    if (typeof h?.id !== "string" || !h.from || !SOURCES.includes(h.from.source)) fail(`handoff ${JSON.stringify(h?.id)} has no labelled source run`);
  }
  return body as TaskProvenance;
}

const or = (v: string | number | null | undefined, none = "-") => (v === null || v === undefined || v === "" ? none : String(v));
const run = (id: string | null, assistant: string | null) => (id ? `run ${id}${assistant ? ` (${assistant})` : ""}` : "no run");
/** How a join is labelled in text: a stored key is named, a guess is called a guess. */
const via = (source: JoinSource) => (source === "inferred" ? "INFERRED" : source === "unrecorded" ? "UNRECORDED" : `via ${source}`);

function routingText(d: RoutingDecisionRef): string {
  if (d.id === null) return `routing: ${via(d.source)} (no decision names this run)`;
  return `routing: decision #${d.id} chose ${or(d.chosenAssistantId)} at ${or(d.at)} [${via(d.source)}]`;
}

function launchText(r: RunProvenance): string {
  const l = r.launch;
  switch (l.kind) {
    case "scheduler": return `launch: scheduler dispatch ${or(l.dispatch?.id)} (origin ${or(l.dispatch?.origin)}, phase ${or(l.dispatch?.phase)}, generation ${or(l.dispatch?.generation)})`;
    case "handoff": return `launch: handoff (trigger ${or(l.handoffTrigger)})`;
    case "parallel": return "launch: compare/race candidate";
    default: return "launch: operator start";
  }
}

function continuationText(c: Continuation | null): string {
  if (!c) return "continues: nothing (fresh start)";
  const refs = [c.checkpointId && `checkpoint ${c.checkpointId}`, c.handoffId && `handoff ${c.handoffId}`, c.envelopeId && `envelope ${c.envelopeId}`].filter(Boolean);
  return `continues: ${run(c.runId, c.assistantId)} [${via(c.source)}]${refs.length ? ` · ${refs.join(" · ")}` : ""}`;
}

function runLines(r: RunProvenance, n: number): string[] {
  const path = r.executionPath === "harness"
    ? `harness (request ${or(r.executionRequestId)}, attempt ${or(r.attempt)})`
    : "legacy (no execution request)";
  return [
    `  ${n}. run ${r.runId} · ${r.assistantId} · ${path}`,
    `     started ${r.startedAt} · ${r.endedAt ? `ended ${r.endedAt}` : "not ended"} · settled by ${or(r.settlementOwner)}`,
    `     ${launchText(r)} · prompt ${or(r.promptSource, "not recorded")}${r.compositionRevisionId ? ` · composition ${r.compositionRevisionId}` : ""}`,
    `     ${routingText(r.routingDecision)}`,
    `     ${continuationText(r.continuedFrom)}`,
  ];
}

function handoffLines(h: HandoffProvenance): string[] {
  const envelope = h.envelope
    ? `envelope ${h.envelope.id} (${h.envelope.state}${h.envelope.claimedByRequestId ? `, claimed by request ${h.envelope.claimedByRequestId}` : ", unclaimed"})`
    : "no envelope";
  return [
    `  ${h.id} · ${h.record === "envelope_only" ? "Harness envelope with no handoff record" : `trigger ${or(h.trigger)}`} · at ${h.at} · ${h.closed ? "closed" : "OPEN: no successor has started"}`,
    `     from ${run(h.from.runId, h.from.assistantId)} [${via(h.from.source)}] -> to ${run(h.to.runId, h.to.assistantId)}`,
    `     checkpoint ${or(h.checkpointId)} · ${envelope}${h.successorRoutingDecisionId !== null ? ` · successor decision #${h.successorRoutingDecisionId}` : ""}`,
  ];
}

/** Text for `aos task provenance`. Pure: the body is printed, never re-derived. */
export function provenanceText(p: TaskProvenance): string {
  const owner = p.owner.kind === "autopilot"
    ? `autopilot attempt ${p.owner.attemptId} (item ${p.owner.itemId}, attempt ${p.owner.attemptNo}, ${p.owner.state})`
    : "operator";
  const lines = [
    `Task ${p.taskId} · mode ${p.mode} · owner ${owner} · run as ${or(p.owner.runAs)}`,
    "",
    p.runs.length ? `Runs (${p.runs.length}):` : "Runs: none (the task has not started)",
    ...p.runs.flatMap((r, i) => runLines(r, i + 1)),
    "",
    p.handoffs.length ? `Handoffs (${p.handoffs.length}):` : "Handoffs: none",
    ...p.handoffs.flatMap(handoffLines),
  ];
  const sources = [
    ...p.runs.flatMap((r) => [r.routingDecision.source, r.continuedFrom?.source]),
    ...p.handoffs.map((h) => h.from.source),
  ];
  if (sources.includes("inferred")) {
    lines.push("", "INFERRED joins have no stored key; the plane followed these rules:");
    for (const [name, rule] of Object.entries(p.inferenceRules)) lines.push(`  ${name}: ${rule}`);
  }
  if (sources.includes("unrecorded")) lines.push("", "UNRECORDED joins: no record names them, and the plane does not guess.");
  return lines.join("\n");
}

const or2 = (v: string | null | undefined) => (v === null || v === undefined || v === "" ? "-" : v);
const json = (value: unknown) => JSON.stringify(value, null, 2);

function table(rows: string[][]): string {
  const widths = rows[0]!.map((_, i) => Math.max(...rows.map((r) => (r[i] ?? "").length)));
  return rows.map((r) => r.map((c, i) => (i === r.length - 1 ? c : c.padEnd(widths[i]!))).join("  ").trimEnd()).join("\n");
}

const oneLine = (text: string, max = 72) => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};
const stageText = (t: { stage?: { value: string; rule: string } }) => (t.stage ? `${t.stage.value} (${t.stage.rule})` : "- (plane predates API 2.9)");
const waitText = (w: TaskSummary["wait"]) => (w ? `${w.kind} ${w.state}${w.notBefore ? ` until ${w.notBefore}` : ""}` : "none");

/** Text for `aos task ls`. */
export function taskListText(tasks: readonly TaskSummary[]): string {
  if (tasks.length === 0) return "No tasks.";
  return table([
    ["ID", "STATE", "STAGE", "UPDATED", "GOAL"],
    ...tasks.map((t) => [t.id, t.state, t.stage?.value ?? "-", t.updatedAt, oneLine(t.goal)]),
  ]);
}

/** Text for `aos task show`: the detail as served, then provenanceText for the same task. */
export function taskShowText(t: TaskDetail, stage: TaskSummary["stage"] | undefined, p: TaskProvenance): string {
  const lines = [
    `Task ${t.id}`,
    `  goal: ${t.goal}`,
    `  state ${t.state}${t.activity_phase ? ` · phase ${t.activity_phase}` : ""} · stage ${stageText({ stage })} · profile ${t.profile}`,
    `  repo ${or2(t.repo_path)}${t.branch ? ` · branch ${t.branch}` : ""} · wait ${waitText(t.wait)}`,
  ];
  const constraints = t.envelope?.constraints ?? [];
  if (constraints.length) lines.push(`  constraints: ${constraints.join("; ")}`);
  lines.push("", t.runs.length ? `Runs (${t.runs.length}):` : "Runs: none");
  for (const r of t.runs) {
    const m = r.modelIdentity;
    const model = m ? `model ${or2(m.resolvedModelId ?? m.requestedSelector)}${m.resolvedModelId ? ` (${m.resolvedSource})` : m.requestedSelector ? " (requested; none reported)" : ""}` : "model -";
    lines.push(`  ${r.id} · ${r.assistant_id} · ${r.state} · started ${r.started_at} · ${r.ended_at ? `ended ${r.ended_at}` : "not ended"} · ${model}`);
  }
  lines.push("", "Provenance:", ...provenanceText(p).split("\n").map((l) => (l ? `  ${l}` : l)));
  return lines.join("\n");
}

/** One event as a text line; live stream events and served rows read the same. */
export function eventLine(e: { ts: string; runId: string; assistantId?: string | null; type: string; summary: string }): string {
  return `${e.ts}  ${e.runId}${e.assistantId ? ` (${e.assistantId})` : ""}  ${e.type}  ${oneLine(e.summary, 120)}`;
}

export interface TaskVerdict {
  taskId: string;
  state: string;
  stage: TaskSummary["stage"] | null;
  /** The last run, or null when the task has none. */
  run: { id: string; assistantId: string; state: string; endedAt: string | null } | null;
  /** Where the verification was read: the Harness session result, or a legacy run's event. */
  source: "session" | "event" | null;
  outcome: string | null;
  verification: VerificationView | null;
  /** The web's `verificationVerdict` of `verification`; null when there is none. */
  verdict: ReturnType<typeof verificationVerdict> | null;
}

/** Text for `aos task verdict`. */
export function verdictText(v: TaskVerdict): string {
  const head = `Task ${v.taskId} · state ${v.state} · stage ${stageText({ stage: v.stage ?? undefined })}`;
  if (!v.run) return `${head}\nNo run yet, so no verdict.`;
  const run = `Run ${v.run.id} (${v.run.assistantId}) · ${v.run.state}${v.source === "session" ? " · Harness session" : v.source === "event" ? " · legacy run" : ""}${v.outcome ? ` · outcome ${v.outcome}` : ""}`;
  if (!v.run.endedAt) return `${head}\n${run}\nThe last run has not ended, so there is no verdict yet.`;
  if (!v.verification || !v.verdict) return `${head}\n${run}\nNo verification recorded for this run.`;
  const extra = [v.verdict.blocked && v.verdict.label !== "blocked" ? `${v.verdict.blocked} blocked` : "", v.verdict.skipped ? `${v.verdict.skipped} skipped` : ""].filter(Boolean).join(", ");
  const checks = v.verification.checks.map((c) => {
    const view = verificationCheckView(c);
    return [`  ${view.label}`, c.name, view.required ? "required" : "not required", oneLine(view.detail, 100)];
  });
  return [head, run, `Verification: ${v.verdict.label.toUpperCase()}${extra ? ` (${extra})` : ""}`, ...(checks.length ? [table(checks)] : ["  no checks"])].join("\n");
}

const TERMINAL = new Set(["COMPLETED", "FAILED", "CANCELLED"]);

/** Runs `aos task <argv…>`. Returns the exit code: 0 ok, 1 failure, 2 usage. */
export async function runTask(argv: string[], deps: TaskDeps): Promise<number> {
  let parsed: ReturnType<typeof parse>;
  try { parsed = parse(argv); } catch (e) { deps.err(`${e instanceof Error ? e.message : String(e)}\n\n${USAGE}`); return 2; }
  const { values, positionals } = parsed;
  const [command, arg, ...extra] = positionals;
  if (values.help || command === "help") { deps.out(USAGE); return 0; }
  if (command === undefined) { deps.err(USAGE); return 2; }
  const usage = (text: string) => { deps.err(`${text}\n\n${USAGE}`); return 2; };
  const needsId = ["show", "events", "verdict", "provenance", "estimate"].includes(command);
  if (!needsId && command !== "ls") return usage(`Unknown command: ${command}`);
  if (needsId && !arg) return usage(`aos task ${command} needs a task id`);
  if (!needsId && arg) return usage(`aos task ${command} takes no argument`);
  if (extra.length) return usage(`Unexpected argument: ${extra[0]}`);
  if (values.follow && command !== "events") return usage("--follow goes with: aos task events <id> --follow");
  if ((values.attention || values.state || values.stage) && command !== "ls") return usage("--attention, --state and --stage go with: aos task ls");
  if ((values.deadline || values["approval-required"] || values.assistant || values.recorded) && command !== "estimate") return usage("--deadline, --approval-required, --assistant and --recorded go with: aos task estimate <id>");
  if (values.recorded && (values.deadline || values["approval-required"] || values.assistant)) return usage("--recorded shows what was stored; it takes no --deadline, --approval-required or --assistant");
  const print = (text: string) => deps.out(redactSecrets(text));
  const opts = { api: values.api, credential: values.credential };
  const id = arg ? encodeURIComponent(arg) : "";
  const missing = (e: unknown, what = "") => {
    if (e instanceof PlaneError && e.status === 404) return new PlaneError(`no task ${arg}${what}`, 404);
    return e;
  };

  try {
    switch (command) {
      case "ls": {
        const body = await deps.connect("tasks.read", opts).request<unknown>("GET", "/api/tasks");
        if (!Array.isArray(body)) throw new PlaneError("GET /api/tasks did not answer with a list");
        let list = body as TaskSummary[];
        if (values.attention) list = list.filter((t) => t.stage?.value === "needs-you");
        if (values.state) list = list.filter((t) => t.state === values.state!.toUpperCase());
        if (values.stage) list = list.filter((t) => t.stage?.value === values.stage);
        print(values.json ? json(list) : taskListText(list));
        return 0;
      }
      case "show": {
        let detail: TaskDetail;
        try { detail = await deps.connect("tasks.read", opts).request<TaskDetail>("GET", `/api/tasks/${id}`); } catch (e) { throw missing(e); }
        let body: unknown;
        try { body = await deps.connect("sessions.read", opts).request<unknown>("GET", `/api/tasks/${id}/provenance`); } catch (e) { throw missing(e, " (or the plane predates API 2.12, which added the provenance read)"); }
        const p = checkProvenance(body, arg!);
        const stage = await stageOf(arg!, deps, opts);
        print(values.json ? json({ ...detail, stage: stage ?? null, provenance: p }) : taskShowText(detail, stage, p));
        return 0;
      }
      case "events": {
        if (!values.follow) {
          let rows: TaskEvent[];
          try { rows = await deps.connect("events.read", opts).request<TaskEvent[]>("GET", `/api/tasks/${id}/events`); } catch (e) { throw missing(e); }
          if (values.json) print(json(rows));
          else if (rows.length === 0) print("No activity recorded.");
          else for (const r of rows) print(eventLine({ ts: r.ts, runId: r.run_id, assistantId: r.assistant_id, type: r.type, summary: r.summary }));
          return 0;
        }
        return await follow(arg!, id, values.json === true, deps, opts, print, missing);
      }
      case "verdict": {
        const v = await readVerdict(arg!, id, deps, opts, missing);
        print(values.json ? json(v) : verdictText(v));
        return 0;
      }
      case "estimate": {
        const client = deps.connect("routing.read", opts);
        if (values.recorded) {
          let body: unknown;
          try { body = await client.request<unknown>("GET", `/api/tasks/${id}/estimates/recorded`); } catch (e) { throw missing(e, " (or the plane predates API 2.16, which added recorded estimates)"); }
          const r = checkRecorded(body, arg!);
          print(values.json ? json(r) : recordedText(r));
          return 0;
        }
        const q = new URLSearchParams();
        if (values.deadline) q.set("deadline", values.deadline);
        if (values["approval-required"]) q.set("approval", "required");
        if (values.assistant) q.set("assistant", values.assistant);
        let body: unknown;
        try { body = await client.request<unknown>("GET", `/api/tasks/${id}/estimate${q.size ? `?${q}` : ""}`); } catch (e) { throw missing(e, " (or the plane predates API 2.15, which added the estimate read)"); }
        const e = checkEstimate(body, arg!);
        print(values.json ? json(e) : estimateText(e));
        return 0;
      }
      case "provenance": {
        let body: unknown;
        try { body = await deps.connect("sessions.read", opts).request<unknown>("GET", `/api/tasks/${id}/provenance`); } catch (e) { throw missing(e, " (or the plane predates API 2.12, which added this read)"); }
        const p = checkProvenance(body, arg!);
        print(values.json ? JSON.stringify(p, null, 2) : provenanceText(p));
        return 0;
      }
    }
    return 2;
  } catch (e) {
    deps.err(redactSecrets(`aos task ${command}: ${e instanceof Error ? e.message : String(e)}`));
    return 1;
  }
}

type Opts = { api?: string; credential?: string };

/**
 * `events --follow`: the stream is opened first and, once the plane has subscribed it (its first
 * frame), the served backlog is read and printed; frames held meanwhile and live ones follow, so
 * nothing that happens between the two reads is lost. A live event already in the backlog (same run and seq) is dropped. The plane sends a state
 * frame on connect, so a task that is already done prints its backlog and exits at once.
 */
async function follow(taskId: string, id: string, asJson: boolean, deps: TaskDeps, opts: Opts, print: (t: string) => void, missing: (e: unknown) => unknown): Promise<number> {
  const streamClient = deps.connect("events.stream", opts);
  const readClient = deps.connect("events.read", opts);
  const seen = new Set<string>();
  const held: unknown[] = [];
  let ready = false;
  let done = false;
  const handle = (frame: unknown): boolean => {
    const f = frame as { kind?: string; event?: { runId: string; seq?: number; ts: string; type: string; summary: string }; state?: { state: string; stage?: { value: string; rule: string }; assistantId?: string }; notice?: { level: string; text: string } };
    if (f.kind === "event" && f.event) {
      const key = `${f.event.runId}:${f.event.seq}`;
      if (seen.has(key)) return false;
      seen.add(key);
      if (asJson) print(JSON.stringify(f));
      else print(eventLine({ ts: f.event.ts, runId: f.event.runId, type: f.event.type, summary: f.event.summary }));
      return false;
    }
    if (asJson) print(JSON.stringify(f));
    else if (f.kind === "state" && f.state) print(`-- state ${f.state.state}${f.state.stage ? ` · stage ${f.state.stage.value} (${f.state.stage.rule})` : ""}`);
    else if (f.kind === "notice" && f.notice) print(`-- ${f.notice.level}: ${f.notice.text}`);
    if (f.kind === "state" && f.state && (f.state.stage?.value === "done" || (!f.state.stage && TERMINAL.has(f.state.state)))) { done = true; return true; }
    return false;
  };
  let streamError: unknown;
  const stop = new AbortController();
  let subscribed: () => void = () => undefined;
  // The plane writes a state frame as soon as it has subscribed this stream to the task's bus.
  const firstFrame = new Promise<void>((r) => { subscribed = r; });
  const streaming = streamClient.stream(`/api/tasks/${id}/events/stream`, (frame) => {
    subscribed();
    if (!ready) { held.push(frame); return false; }
    return handle(frame);
  }, stop.signal).catch((e: unknown) => { streamError = e; return "ended" as const; }).finally(() => subscribed());
  await firstFrame;
  if (streamError) throw missing(streamError);
  let rows: TaskEvent[];
  try { rows = await readClient.request<TaskEvent[]>("GET", `/api/tasks/${id}/events`); } catch (e) { throw missing(e); }
  for (const r of rows) {
    seen.add(`${r.run_id}:${r.seq}`);
    if (asJson) print(JSON.stringify(r));
    else print(eventLine({ ts: r.ts, runId: r.run_id, assistantId: r.assistant_id, type: r.type, summary: r.summary }));
  }
  ready = true;
  // Held frames may already say the task is done; the stream then has nothing left to say.
  for (const frame of held.splice(0)) if (handle(frame)) break;
  if (done) stop.abort();
  await streaming;
  if (streamError && !done) throw missing(streamError);
  if (!done) throw new PlaneError(`the plane ended the stream before task ${taskId} was done`);
  return 0;
}

/** The detail route serves no stage; the list does (task-stage v1, one plane source for both). */
async function stageOf(taskId: string, deps: TaskDeps, opts: Opts): Promise<TaskSummary["stage"] | undefined> {
  const list = await deps.connect("tasks.read", opts).request<TaskSummary[]>("GET", "/api/tasks");
  return Array.isArray(list) ? list.find((t) => t.id === taskId)?.stage : undefined;
}

/** Last run → its verification, read where the web reads it (TaskDetail sessions, Inspector events). */
async function readVerdict(taskId: string, id: string, deps: TaskDeps, opts: Opts, missing: (e: unknown) => unknown): Promise<TaskVerdict> {
  let detail: TaskDetail;
  try { detail = await deps.connect("tasks.read", opts).request<TaskDetail>("GET", `/api/tasks/${id}`); } catch (e) { throw missing(e); }
  const stage = (await stageOf(taskId, deps, opts)) ?? null;
  const last = detail.runs.at(-1);
  const base: TaskVerdict = { taskId, state: detail.state, stage, run: null, source: null, outcome: null, verification: null, verdict: null };
  if (!last) return base;
  const v: TaskVerdict = { ...base, run: { id: last.id, assistantId: last.assistant_id, state: last.state, endedAt: last.ended_at } };
  if (!last.ended_at) return v;
  let session: SessionDetail | undefined;
  try {
    session = await deps.connect("sessions.read", opts).request<SessionDetail>("GET", `/api/sessions/${encodeURIComponent(last.id)}`);
  } catch (e) {
    // 404: a legacy run, which is not a Harness session; its verification is an event.
    if (!(e instanceof PlaneError && e.status === 404)) throw e;
  }
  if (session) {
    v.source = "session";
    v.outcome = session.result?.outcome ?? null;
    v.verification = session.result?.verification ?? null;
  } else {
    v.source = "event";
    const rows = await deps.connect("events.read", opts).request<TaskEvent[]>("GET", `/api/tasks/${id}/events`);
    v.verification = rows.filter((e) => e.run_id === last.id).map(verificationFromEvent).filter((x) => x !== null).at(-1) ?? null;
  }
  v.verdict = v.verification ? verificationVerdict(v.verification) : null;
  return v;
}

function parse(argv: string[]) {
  return parseArgs({
    args: argv,
    allowPositionals: true,
    strict: true,
    options: {
      json: { type: "boolean" },
      follow: { type: "boolean", short: "f" },
      attention: { type: "boolean" },
      state: { type: "string" },
      stage: { type: "string" },
      deadline: { type: "string" },
      "approval-required": { type: "boolean" },
      assistant: { type: "string" },
      recorded: { type: "boolean" },
      api: { type: "string" },
      credential: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
}
