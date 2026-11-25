/**
 * `aos task estimate`: the CLI side of qcq-01's `GET /api/tasks/:id/estimate` and qcq-02's
 * `GET /api/tasks/:id/estimates/recorded` (API 2.16). Read-only and ADVISORY.
 *
 * The plane computes the estimate, the recommendation and their evidence; this file only prints
 * what it is served and never recomputes a range, a confidence or a window. API spend, the
 * API-equivalent of subscription tokens and the subscription quota are printed on separate,
 * labelled lines so none of them reads as another: API-equivalent dollars are never spend.
 */
import type { EstimateRange, RunEstimate, ScheduleRecommendation } from "@agent-plane/core";
import type { RecordedEstimate, TaskEstimate, TaskRecordedEstimates } from "../../api/src/modules/run-estimate.js";
import { PlaneError } from "./client.js";

const ACTIONS = new Set(["run-now", "run-in-window", "wait-for-approval", "wait-for-quota-reset"]);

/** A shape check, not a contract validator: a plane older than API 2.15, or another body, is refused. */
export function checkEstimate(body: unknown, taskId: string): TaskEstimate {
  const fail = (why: string): never => { throw new PlaneError(`The plane's estimate for ${taskId} is not the run-estimate v1 shape, so nothing is shown: ${why}`); };
  if (typeof body !== "object" || body === null || Array.isArray(body)) return fail("not an object");
  const e = body as Partial<TaskEstimate>;
  if (e.taskId !== taskId) fail(`taskId is ${JSON.stringify(e.taskId)}`);
  if (e.advisory !== true) fail("advisory is not true");
  if (typeof e.estimate !== "object" || e.estimate === null || typeof e.estimate.estimatorVersion !== "string") fail("estimate is missing");
  if (typeof e.recommendation !== "object" || e.recommendation === null || !ACTIONS.has(e.recommendation.action)) fail("recommendation is missing");
  if (typeof e.estimate!.spend !== "object" || e.estimate!.spend === null) fail("spend is missing");
  return body as TaskEstimate;
}

export function checkRecorded(body: unknown, taskId: string): TaskRecordedEstimates {
  const fail = (why: string): never => { throw new PlaneError(`The plane's recorded estimates for ${taskId} are not the API 2.16 shape, so nothing is shown: ${why}`); };
  if (typeof body !== "object" || body === null || Array.isArray(body)) return fail("not an object");
  const r = body as Partial<TaskRecordedEstimates>;
  if (r.taskId !== taskId) fail(`taskId is ${JSON.stringify(r.taskId)}`);
  if (!Array.isArray(r.records)) fail("records is not a list");
  return body as TaskRecordedEstimates;
}

const or = (v: string | number | null | undefined, none = "-") => (v === null || v === undefined || v === "" ? none : String(v));
const minutes = (ms: number) => (ms < 60_000 ? `${Math.round(ms / 1000)}s` : `${Math.round(ms / 60_000)} min`);
const count = (n: number) => (n >= 10_000 ? `${Math.round(n / 1000)}k` : String(Math.round(n)));
const usd = (n: number) => `$${n.toFixed(n < 1 ? 4 : 2)}`;
/** A served range as "low / typical / high", or the plane's own "unknown" when it served none. */
const range = (r: EstimateRange | null, f: (n: number) => string) => (r ? `${f(r.low)} / ${f(r.typical)} / ${f(r.high)}` : "unknown");

/** The spend block: three separately labelled lines, each "n/a" when the billing kind has none. */
export function spendLines(spend: RunEstimate["spend"]): string[] {
  const q = spend.subscriptionQuota;
  return [
    `  billing:            ${spend.billing} (${spend.billingBasis})`,
    `  API spend:          ${spend.billing === "api" ? range(spend.apiUsd, usd) : "n/a (not API-billed)"}`,
    `  API-equivalent:     ${spend.billing === "subscription" ? `${range(spend.apiEquivalentUsd, usd)} (what the tokens would cost on the API; not spend)` : "n/a (not subscription-billed)"}`,
    `  subscription quota: ${q ? `${or(q.bucket, "bucket")} at ${q.usedPercent}% (observed ${q.observedAt}${q.resetsAt ? `, resets ${q.resetsAt}` : ""}); per-run share ${q.perRunShare}` : "no fresh observation"}`,
  ];
}

function recommendationLines(r: ScheduleRecommendation): string[] {
  const lines = [
    `Recommendation (advisory): ${r.action}${r.startAt ? ` at ${r.startAt}` : ""} · speed weight ${r.speedWeight}`,
  ];
  if (r.window) lines.push(`  window: ${r.window.kind} ${r.window.localStart} to ${r.window.localEnd}`);
  if (r.expectedCompletion) lines.push(`  expected completion: ${r.expectedCompletion.low} / ${r.expectedCompletion.typical} / ${r.expectedCompletion.high}`);
  if (r.deadline) lines.push(`  deadline ${r.deadline}: ${r.meetsDeadline === null ? "fit unknown" : r.meetsDeadline ? "met" : "MISSED"}`);
  for (const reason of r.reasons) lines.push(`  - ${reason}`);
  lines.push(`  unchanged: ${r.unchanged.join(", ")}`);
  return lines;
}

function approvalText(a: RunEstimate["approvalWait"]): string {
  const share = a.historicalShare === null ? "" : Math.round(a.historicalShare * 100) === 0
    ? "; no comparable run waited"
    : `; ${Math.round(a.historicalShare * 100)}% of comparable runs waited, ${range(a.historicalMs, minutes)}`;
  return `${a.pending} pending${a.required ? ", one required before start" : ""}${share}`;
}

function estimateLines(e: RunEstimate): string[] {
  const s = e.subject;
  return [
    `Runtime: ${or(s.assistantId, "no eligible assistant")} · provider ${or(s.provider)} · model ${or(s.model, "assistant default")} (${s.modelSource})`,
    `Effort: ${or(s.effort, "unknown")} (${s.effortSource}) · task kind ${or(s.taskKind)}`,
    `Confidence: ${e.confidence} · cohort ${e.evidence.cohort}, ${e.evidence.sampleSize} run(s) · ${e.estimatorVersion} as of ${e.asOf}`,
    "Ranges are low / typical / high (p25 / p50 / p75):",
    `  duration:           ${range(e.durationMs.range, minutes)} (${e.durationMs.confidence})`,
    `  tokens in:          ${range(e.tokens.input, count)}`,
    `  tokens out:         ${range(e.tokens.output, count)} (${e.tokens.confidence}; ${e.tokens.runsWithUsage} with usage, ${e.tokens.runsMissingUsage} without)`,
    `  wait until start:   ${range(e.waitUntilStartMs.range, minutes)}${e.waitUntilStartMs.reasons.length ? ` (${e.waitUntilStartMs.reasons.join("; ")})` : ""}`,
    `  approval wait:      ${approvalText(e.approvalWait)}`,
    "Spend:",
    ...spendLines(e.spend),
    ...(e.evidence.missing.length ? ["Missing:", ...e.evidence.missing.map((m) => `  - ${m}`)] : []),
  ];
}

/** Text for `aos task estimate <id>`. Pure: the body is printed, never re-derived. */
export function estimateText(t: TaskEstimate): string {
  return [
    `Task ${t.taskId} · ADVISORY estimate${t.routing.whatIf ? " (what-if: assistant pinned by --assistant)" : ""} · routing ${or(t.routing.chosen, "none")} (${t.routing.ruleFired})`,
    `Hours: ${t.policy.timezone} · evenings ${t.policy.eveningsAllowed ? "allowed" : "not allowed"} · weekends ${t.policy.weekendsAllowed ? "allowed" : "not allowed"}`,
    "",
    ...estimateLines(t.estimate),
    "",
    ...recommendationLines(t.recommendation),
  ].join("\n");
}

function recordedLines(r: RecordedEstimate, n: number): string[] {
  const e = r.estimate;
  const a = r.actual;
  return [
    `  ${n}. run ${r.runId} · ${r.assistantId} · recorded ${r.recordedAt} (${r.estimatorVersion}) · confidence ${e.confidence}, ${e.evidence.sampleSize} run(s)`,
    `     shown: duration ${range(e.durationMs.range, minutes)} · tokens in ${range(e.tokens.input, count)} · out ${range(e.tokens.output, count)} · ${r.recommendation.action}`,
    a
      ? `     actual: ${a.state} · duration ${minutes(a.durationMs)} · tokens ${a.tokens ? `in ${count(a.tokens.input)} · out ${count(a.tokens.output)}` : "not recorded"}${a.costUsd !== null ? ` · cost ${usd(a.costUsd)} (${a.costMethod})` : ""}`
      : "     actual: not ended yet",
  ];
}

/** Text for `aos task estimate <id> --recorded`: what was shown at each start, beside what happened. */
export function recordedText(t: TaskRecordedEstimates): string {
  if (t.records.length === 0) return `Task ${t.taskId}: no estimate recorded (no run has started since the plane began recording, API 2.16).`;
  return [`Task ${t.taskId} · estimates recorded at start (${t.records.length}), ADVISORY:`, ...t.records.flatMap((r, i) => recordedLines(r, i + 1))].join("\n");
}
