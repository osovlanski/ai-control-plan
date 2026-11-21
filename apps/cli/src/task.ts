/**
 * `aos task` (tlm-03): task reads over the plane's own routes. Today one command, `provenance`,
 * the CLI side of tlm-02a's `GET /api/tasks/:id/provenance` (API 2.12).
 *
 * The plane makes every cross-record join (run → routing decision, dispatch, checkpoint, handoff
 * record, Harness envelope) and names the source of each one. This file only prints what it is
 * served: it never joins records itself, and it says "inferred" or "unrecorded" wherever the plane
 * does, so a guessed join never reads as a stored one. The rest of `aos task` (`ls`, `show`,
 * `events`, …) is backlog `p1-3-aos-cli`; `show` can embed this read as its provenance block.
 */
import { parseArgs } from "node:util";
import { redactSecrets } from "@agent-plane/core";
import type {
  Continuation, HandoffProvenance, JoinSource, RoutingDecisionRef, RunProvenance, TaskProvenance,
} from "../../api/src/modules/provenance.js";
import { PlaneError, type PlaneClient } from "./client.js";

export interface TaskDeps {
  /** A client whose credential holds `capability`; resolved lazily so `--help` reads no file. */
  connect(capability: "sessions.read", options: { api?: string; credential?: string }): PlaneClient;
  out(text: string): void;
  err(text: string): void;
}

export const USAGE = `usage: aos task <command> [options]

Read (sessions.read):
  provenance <id>              where each run came from: routing decision, launch (operator,
                               scheduler dispatch, handoff, compare/race), the run it continues,
                               and every handoff, each join labelled with its source
                               (GET /api/tasks/:id/provenance, API 2.12)

Options:
  --json                       print the plane's response body as served
  --api <origin>               plane origin on loopback (default: workspace config, or AOS_API_URL)
  --credential <path>          bearer credential file (default: the workspace's, or AOS_CREDENTIAL_FILE)

Join sources: a stored key (execution_request, dispatch, handoff_record, handoff_envelope,
checkpoint), "inferred" (no key exists, so the plane followed the stated rule printed below the
runs), or "unrecorded" (nothing names it; never back-filled).

Exit codes: 0 ok, 1 failure (including an unknown task), 2 usage.`;

/** The route each command reaches, for `--help` and the parity test. */
export const COMMAND_ROUTES: Readonly<Record<string, readonly string[]>> = Object.freeze({
  provenance: ["GET /api/tasks/:id/provenance"],
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

/** Runs `aos task <argv…>`. Returns the exit code: 0 ok, 1 failure, 2 usage. */
export async function runTask(argv: string[], deps: TaskDeps): Promise<number> {
  let parsed: ReturnType<typeof parse>;
  try { parsed = parse(argv); } catch (e) { deps.err(`${e instanceof Error ? e.message : String(e)}\n\n${USAGE}`); return 2; }
  const { values, positionals } = parsed;
  const [command, arg, ...extra] = positionals;
  if (values.help || command === "help") { deps.out(USAGE); return 0; }
  if (command === undefined) { deps.err(USAGE); return 2; }
  const usage = (text: string) => { deps.err(`${text}\n\n${USAGE}`); return 2; };
  if (command !== "provenance") return usage(`Unknown command: ${command}`);
  if (!arg) return usage("aos task provenance needs a task id");
  if (extra.length) return usage(`Unexpected argument: ${extra[0]}`);
  const print = (text: string) => deps.out(redactSecrets(text));

  try {
    const client = deps.connect("sessions.read", { api: values.api, credential: values.credential });
    let body: unknown;
    try {
      body = await client.request<unknown>("GET", `/api/tasks/${encodeURIComponent(arg)}/provenance`);
    } catch (e) {
      if (e instanceof PlaneError && e.status === 404) throw new PlaneError(`no task ${arg} (or the plane predates API 2.12, which added this read)`, 404);
      throw e;
    }
    const p = checkProvenance(body, arg);
    print(values.json ? JSON.stringify(p, null, 2) : provenanceText(p));
    return 0;
  } catch (e) {
    deps.err(redactSecrets(`aos task ${command}: ${e instanceof Error ? e.message : String(e)}`));
    return 1;
  }
}

function parse(argv: string[]) {
  return parseArgs({
    args: argv,
    allowPositionals: true,
    strict: true,
    options: {
      json: { type: "boolean" },
      api: { type: "string" },
      credential: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
}
