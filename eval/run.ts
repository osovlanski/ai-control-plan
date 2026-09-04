#!/usr/bin/env node
/**
 * Eval entry point (`pnpm eval`, increment 3, plan §4 step 20/24).
 *
 * FAKE scenarios always run (real `buildServer`/Harness path, fake adapter —
 * plumbing coverage, not in CI as a blocking gate). REAL scenarios only run
 * when AGENT_PLANE_EVAL=1 and provider credentials are present; otherwise they
 * are skipped and reported, never faked.
 */
import { adapterErrorMidRun } from "./scenarios/adapter-error-mid-run.js";
import { bootCrashRecovery } from "./scenarios/boot-crash-recovery.js";
import { crossProviderReroute } from "./scenarios/cross-provider-reroute.js";
import { happyPath } from "./scenarios/happy-path.js";
import { hitsTokenCap } from "./scenarios/hits-token-cap.js";
import { needsApproval } from "./scenarios/needs-approval.js";
import { replanNeeded } from "./scenarios/replan-needed.js";
import { buildScorecard, writeScorecard, type ScorecardEntry } from "./scorecard.js";

const REAL_ENABLED = process.env.AGENT_PLANE_EVAL === "1";
const HAS_ANTHROPIC = !!(process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_CODE_OAUTH_TOKEN);
const HAS_OPENAI = !!(process.env.OPENAI_API_KEY || process.env.CODEX_API_KEY);

interface Attempt {
  name: string;
  kind: "real" | "fake";
  status: "ok" | "skipped" | "error";
  detail?: string;
  score?: ScorecardEntry;
}

async function attempt(name: string, kind: "real" | "fake", run: () => Promise<ScorecardEntry>): Promise<Attempt> {
  try {
    const score = await run();
    return { name, kind, status: "ok", score };
  } catch (err) {
    return { name, kind, status: "error", detail: err instanceof Error ? err.message : String(err) };
  }
}

async function main(): Promise<void> {
  const results: Attempt[] = [];

  // FAKE — always run, real buildServer/Harness path, deterministic adapter.
  results.push(await attempt("hits-token-cap", "fake", hitsTokenCap));
  results.push(await attempt("adapter-error-mid-run", "fake", adapterErrorMidRun));
  results.push(await attempt("cross-provider-reroute", "fake", crossProviderReroute));
  results.push(await attempt("boot-crash-recovery", "fake", bootCrashRecovery));
  results.push(await attempt("needs-approval", "fake", needsApproval)); // R8 fallback

  // REAL — only with AGENT_PLANE_EVAL=1 and the relevant provider's creds.
  if (REAL_ENABLED && HAS_ANTHROPIC) {
    results.push(await attempt("happy-path-anthropic", "real", () => happyPath("anthropic")));
    results.push(await attempt("replan-needed", "real", () => replanNeeded("anthropic")));
  } else {
    results.push({ name: "happy-path-anthropic", kind: "real", status: "skipped", detail: "AGENT_PLANE_EVAL!=1 or ANTHROPIC_API_KEY/CLAUDE_CODE_OAUTH_TOKEN not set" });
    results.push({ name: "replan-needed", kind: "real", status: "skipped", detail: "AGENT_PLANE_EVAL!=1 or ANTHROPIC_API_KEY/CLAUDE_CODE_OAUTH_TOKEN not set" });
  }
  if (REAL_ENABLED && HAS_OPENAI) {
    results.push(await attempt("happy-path-openai", "real", () => happyPath("openai")));
  } else {
    results.push({ name: "happy-path-openai", kind: "real", status: "skipped", detail: "AGENT_PLANE_EVAL!=1 or OPENAI_API_KEY/CODEX_API_KEY not set" });
  }

  const scored = results.filter((r): r is Attempt & { score: ScorecardEntry } => !!r.score).map((r) => r.score);
  const card = buildScorecard(scored);
  const outDir = new URL("./out/", import.meta.url).pathname.replace(/\/$/, "");
  const written = writeScorecard(outDir, card);

  console.log(`\nEval run: ${results.filter((r) => r.status === "ok").length}/${results.length} scenarios ok.`);
  for (const r of results) {
    const line = r.status === "ok"
      ? `  ok      ${r.name} (${r.kind}) — terminal=${r.score?.terminalState}`
      : r.status === "skipped"
        ? `  skipped ${r.name} (${r.kind}) — ${r.detail}`
        : `  ERROR   ${r.name} (${r.kind}) — ${r.detail}`;
    console.log(line);
  }
  console.log(`\nWrote ${written.json} and ${written.md}`);

  // Increment-3 completion gate (plan §4 step 22): happy-path on BOTH real
  // providers + replan-needed, each reaching terminal + verification passed +
  // a durable session + a linked plan revision where the fixture forces one,
  // plus a real usage-accounting reading. Never claim it here — just report.
  const gate = results.filter((r) => ["happy-path-anthropic", "happy-path-openai", "replan-needed"].includes(r.name));
  const gateMet = gate.every((r) => r.status === "ok" && r.score?.reachedTerminal && r.score?.usageAccountingPresent);
  console.log(
    gateMet
      ? "\nCompletion gate: MET — a real scorecard exists for happy-path (both providers) and replan-needed."
      : "\nCompletion gate: NOT MET — increment 3 is INCOMPLETE until a real run produces this. No fabricated scorecard was written in its place.",
  );
  if (!gateMet && !REAL_ENABLED) {
    console.log("(AGENT_PLANE_EVAL is not 1 — set it, with provider credentials, to attempt the real gating scenarios.)");
  }
}

void main();
