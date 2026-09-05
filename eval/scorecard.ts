/**
 * Scorecard schema (versioned, reproducible — plan §4 step 23, R1-#16). JSON
 * is canonical; the `.md` is a rendered summary of that JSON, never authored
 * independently.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { ScenarioScore } from "./scorer.js";

export const SCORECARD_SCHEMA_VERSION = 1;

export interface ScorecardEntry extends ScenarioScore {
  fixtureDigest?: string;
  model?: string;
}

export interface Scorecard {
  schemaVersion: number;
  generatedAt: string;
  repoCommit: string;
  configDigest: string;
  scenarios: ScorecardEntry[];
}

export function repoCommit(): string {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

/** A cheap, stable digest of what varies the outcome — not a security hash. */
export function configDigest(input: Record<string, unknown>): string {
  const s = JSON.stringify(input, Object.keys(input).sort());
  let h = 0;
  for (let i = 0; i < s.length; i += 1) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return `cd_${(h >>> 0).toString(16)}`;
}

export function buildScorecard(scenarios: ScorecardEntry[]): Scorecard {
  return {
    schemaVersion: SCORECARD_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    repoCommit: repoCommit(),
    configDigest: configDigest({ scenarioCount: scenarios.length, names: scenarios.map((s) => s.scenario) }),
    scenarios,
  };
}

export function renderMarkdown(card: Scorecard): string {
  const lines: string[] = [
    `# Eval scorecard`,
    ``,
    `Generated: ${card.generatedAt}  `,
    `Commit: \`${card.repoCommit}\`  `,
    `Schema: v${card.schemaVersion}  `,
    `Config digest: \`${card.configDigest}\``,
    ``,
    `| scenario | kind | provider | terminal | verification | revisions | tokens | outcome |`,
    `|---|---|---|---|---|---|---|---|`,
  ];
  for (const s of card.scenarios) {
    lines.push(
      `| ${s.scenario} | ${s.kind} | ${s.provider ?? "-"} | ${s.terminalState ?? "-"} | ${
        s.verificationPassed === null ? "-" : s.verificationPassed
      } | ${s.verificationPlanRevisions} | ${s.totalTokens ?? "-"} | ${s.executionResultsOutcome ?? "-"} |`,
    );
  }
  lines.push(
    ``,
    `## Deliberately gated flows`,
    ``,
    `- **compare / race / parallel** — no Execution Harness parity yet (roadmap §3.4); legacy-only until vNext increment 6.`,
    `- **provider-resume / cross-provider handoff claim** — the claim protocol is unwired (standing deferral #7).`,
    `- **bounded cost caps** — no pricing table to derive cost from tokens yet (standing deferral #3).`,
    `- **real-provider approval-gating evidence** (\`needs-approval\`) — this scorecard's run used the documented FakeAdapter fallback (R8); the real-provider assertion is an area-1 flip precondition.`,
    `- **full eval-plan area-1 conformance suite** and **area-2's ≥6/7-over-two-nights bar** — flip preconditions, not increment-3 deliverables (\`docs/harness-rollout.md\`).`,
    ``,
  );
  return lines.join("\n");
}

export function writeScorecard(dir: string, card: Scorecard): { json: string; md: string } {
  mkdirSync(dir, { recursive: true });
  const jsonPath = `${dir}/scorecard.json`;
  const mdPath = `${dir}/scorecard.md`;
  mkdirSync(dirname(jsonPath), { recursive: true });
  writeFileSync(jsonPath, JSON.stringify(card, null, 2) + "\n");
  writeFileSync(mdPath, renderMarkdown(card));
  return { json: jsonPath, md: mdPath };
}
