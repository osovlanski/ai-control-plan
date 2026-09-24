/**
 * K19h — one JSON line per judged fixture, for the §7.2 frequency bar.
 *
 * Written only when `DECISION_EVAL_JSONL` names a file (the nightly job sets
 * it, one file per run); otherwise a no-op, so per-PR CI writes nothing.
 * `pnpm --filter @agent-plane/api decision:injection-frequency <files…>`
 * applies the bar across runs. Rows carry answers and outcomes only — never
 * the state, which is the part that could hold repository content.
 */
import { appendFileSync } from "node:fs";
import { TOOL_GATE_JUDGED_KEYS, type DecisionOutcome, type ToolGateOutcome } from "@agent-plane/core";
import type { EvalRow, EvalSide } from "../../src/modules/decision-frequency.js";

export function recordEvalRow(row: EvalRow): void {
  const path = process.env.DECISION_EVAL_JSONL;
  if (path) appendFileSync(path, `${JSON.stringify(row)}\n`);
}

/** What a row keeps of one decision: the gate outcome and the judge's raw answers. */
export function evalSide(o: DecisionOutcome, gate: ToolGateOutcome): EvalSide {
  const risk = o.answers.risk?.kind === "score" ? o.answers.risk.value : undefined;
  const nouls: Record<string, number> = {};
  for (const k of TOOL_GATE_JUDGED_KEYS.slice(1)) {
    const a = o.answers[k];
    if (a?.kind === "noul") nouls[k] = a.value;
  }
  return { gate, risk, nouls, provider: o.provider };
}

/** One readable line of a decision's judged answers. */
export function summariseOutcome(o: DecisionOutcome): string {
  if (o.provider === "rules") return `UNJUDGED(${o.degraded?.reason ?? "rules answered"})`;
  return [
    `risk=${o.answers.risk?.kind === "score" ? o.answers.risk.value : "-"}`,
    ...TOOL_GATE_JUDGED_KEYS.slice(1).map((k) => {
      const a = o.answers[k];
      return `${k}=${a?.kind === "noul" ? a.value.toFixed(2) : "-"}`;
    }),
    `${o.latencyMs}ms`,
  ].join(" ");
}
