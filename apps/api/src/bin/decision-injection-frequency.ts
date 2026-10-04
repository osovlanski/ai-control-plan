/**
 * `pnpm --filter @agent-plane/api decision:injection-frequency <run1.jsonl> …`
 *
 * Applies the §7.2 frequency bar (`decision-frequency.ts`) to the rows the
 * injection suites wrote, one file per run (`DECISION_EVAL_JSONL`). Prints the
 * K19h survey distribution, every fixture that is not PASS, and the verdict.
 * Exits 0 only on PASS: INCOMPLETE (too few judged runs, or no rows at all)
 * is not a pass.
 */
import { readFileSync } from "node:fs";
import { FREQUENCY_BAR, injectionFrequency, type EvalRow, type EvalSide } from "../modules/decision-frequency.js";

const files = process.argv.slice(2);
const runs: EvalRow[][] = files.map((f) =>
  readFileSync(f, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as EvalRow),
);

const survey = new Map<string, { prompt: number; judged: number; risks: string[] }>();
for (const rows of runs) {
  for (const r of rows) {
    if (r.suite !== "survey" || r.baseline.provider === "rules") continue;
    const s = survey.get(r.fixture) ?? { prompt: 0, judged: 0, risks: [] };
    s.judged += 1;
    if (r.baseline.gate === "prompt") s.prompt += 1;
    s.risks.push(r.baseline.risk ?? "-");
    survey.set(r.fixture, s);
  }
}
if (survey.size) {
  console.log(`K19h survey — judge-only prompts per action (${runs.length} runs):`);
  for (const [id, s] of [...survey].sort((a, b) => a[1].prompt / a[1].judged - b[1].prompt / b[1].judged)) {
    console.log(`  ${id.padEnd(18)} prompt ${s.prompt}/${s.judged}  risk ${s.risks.join(",")}`);
  }
  const judgeOnly = [...survey.values()].filter((s) => s.prompt > 0).length;
  console.log(`  ${judgeOnly} of ${survey.size} rules-allowed, unfloored actions prompted only because the judge did.`);
}

// Reported beside the bar, never part of it: flips per carrier, and the judge's
// own latency and token accounting, so two judges' runs can be read side by side.
const carriers = new Map<string, { judged: number; basePrompted: number; flips: number }>();
const decisions: EvalSide[] = [];
for (const rows of runs) {
  for (const r of rows) {
    // A second-lock baseline is repeated on each of its carrier rows, so it is not counted as a decision here.
    if (r.suite === "survey" && r.baseline.provider !== "rules") decisions.push(r.baseline);
    if (r.injected && r.injected.provider !== "rules") decisions.push(r.injected);
    if (r.suite !== "second-lock" || !r.injected || r.baseline.provider === "rules" || r.injected.provider === "rules") continue;
    const vector = r.fixture.split(" × ")[1] ?? r.fixture;
    const c = carriers.get(vector) ?? { judged: 0, basePrompted: 0, flips: 0 };
    c.judged += 1;
    if (r.baseline.gate === "prompt") {
      c.basePrompted += 1;
      if (r.injected.gate !== "prompt") c.flips += 1;
    }
    carriers.set(vector, c);
  }
}
if (carriers.size) {
  console.log(`\nSecond-lock flips per carrier (${runs.length} runs; a flip needs a baseline prompt):`);
  for (const [vector, c] of carriers) {
    console.log(`  ${vector.padEnd(24)} ${c.flips}/${c.judged} judged pairs (${c.flips}/${c.basePrompted} where the baseline prompted)`);
  }
}
if (decisions.length) {
  const ms = decisions.flatMap((d) => (d.latencyMs === undefined ? [] : [d.latencyMs])).sort((a, b) => a - b);
  const pct = (p: number) => ms[Math.min(ms.length - 1, Math.ceil((p / 100) * ms.length) - 1)];
  const metered = decisions.filter((d) => d.usage);
  const mean = (f: (u: { inputTokens: number; outputTokens: number }) => number) =>
    metered.length ? Math.round(metered.reduce((s, d) => s + f(d.usage!), 0) / metered.length) : "-";
  console.log(
    `\n${decisions.length} judged decisions (survey + injected; models ${[...new Set(decisions.map((d) => d.model ?? "unreported"))].join(", ")}): ` +
      `latency p50 ${pct(50) ?? "-"} ms, p95 ${pct(95) ?? "-"} ms; per decision ${mean((u) => u.inputTokens)} input / ` +
      `${mean((u) => u.outputTokens)} output tokens over ${metered.length} metered`,
  );
}

const { verdict, fixtures } = injectionFrequency(runs);
const failed = fixtures.filter((f) => f.verdict === "FAIL");
const incomplete = fixtures.filter((f) => f.verdict === "INCOMPLETE");
console.log(
  `\n§7.2 frequency bar — flip or risk cross in ≥ ${FREQUENCY_BAR.minFailing} of ${FREQUENCY_BAR.runs} judged runs fails:`,
);
for (const f of failed.sort((a, b) => b.flips - a.flips || b.riskCrosses - a.riskCrosses)) {
  console.log(
    `  ${f.verdict.padEnd(10)} [${f.suite}] ${f.fixture}: flips ${f.flips}/${f.judgedRuns}, risk crosses ${f.riskCrosses}/${f.judgedRuns}` +
      (f.nouls.length ? `  (explanation: ${f.nouls.join("; ")})` : ""),
  );
}
// Incomplete fixtures are counted, not listed: an unjudged run usually takes out every fixture at once.
const runsJudged = [...new Set(incomplete.map((f) => f.judgedRuns))].sort().join(", ");
console.log(
  `\n${fixtures.length} fixtures: ${failed.length} FAIL, ${incomplete.length} INCOMPLETE` +
    (incomplete.length ? ` (judged runs: ${runsJudged} of ${FREQUENCY_BAR.runs})` : "") +
    `. VERDICT: ${verdict}`,
);
process.exitCode = verdict === "PASS" ? 0 : 1;
