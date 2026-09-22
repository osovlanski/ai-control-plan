/**
 * M16 K17 — `RulesDecisionProvider` (plan `plans/jev-decision-service-plan.md` §5).
 *
 * Pure unit coverage of the three site mappings, isolated from the real
 * `classifyGoal` / `toolPolicyGuard` / `evaluateContextGuard` functions
 * (apps/api can't be imported from packages/core). The exact-reproduction
 * claim against the real functions is proven separately in
 * apps/api/test/decision-parity.test.ts, which imports both sides.
 */
import { describe, expect, it } from "vitest";
import { buildContextObservation, DEFAULT_CONTEXT_POLICY, type ContextCapability } from "../src/context.js";
import { RulesDecisionProvider, type DecisionRequest } from "../src/decision.js";

const provider = new RulesDecisionProvider();

const NOW = 1_700_000_000_000;
const CAPABILITY: ContextCapability = {
  occupancy: "provider-reported",
  effectiveWindow: "provider-reported",
  compact: "none",
  autoManagement: "none",
  observesAutoCompaction: true,
};

function atPressure(pressure: number) {
  return buildContextObservation(
    { occupancyTokens: Math.round(pressure * 200_000), occupancySource: "provider-reported", effectiveWindowTokens: 200_000 },
    { sessionId: "es_1", sequence: 1, now: new Date(NOW).toISOString() },
  );
}

describe("RulesDecisionProvider", () => {
  it("never makes a network call — describes itself as local and reachable", () => {
    expect(provider.describe()).toEqual({ reachable: true, egress: "local" });
  });

  it("answers task-classifier with a Choice matching classifyGoal's precedence", async () => {
    const req = (goal: string): DecisionRequest => ({
      site: "task-classifier",
      state: { goal },
      questions: { kind: { kind: "choice", instructions: "x", criteria: { coding: null, review: null, research: null, general: null } } },
      budgetMs: 100,
    });
    expect((await provider.decide(req("please fix the bug"))).answers.kind).toMatchObject({ kind: "choice", value: "coding" });
    expect((await provider.decide(req("review this diff"))).answers.kind).toMatchObject({ kind: "choice", value: "review" });
    expect((await provider.decide(req("investigate why this fails"))).answers.kind).toMatchObject({ kind: "choice", value: "research" });
    expect((await provider.decide(req("say hello"))).answers.kind).toMatchObject({ kind: "choice", value: "general" });
    // review wins over fix when both match — same precedence as classifyGoal.
    expect((await provider.decide(req("review and fix"))).answers.kind).toMatchObject({ kind: "choice", value: "review" });
  });

  it("answers tool-gate with a Noul matching the allow/deny substring match", async () => {
    const req = (state: Record<string, unknown>): DecisionRequest => ({
      site: "tool-gate",
      state,
      questions: { denied: { kind: "noul", instructions: "x" } },
      budgetMs: 100,
    });
    expect((await provider.decide(req({ toolName: "bash rm -rf", toolsDeny: ["rm"] }))).answers.denied).toEqual({ kind: "noul", value: 1 });
    expect((await provider.decide(req({ toolName: "read file", toolsDeny: ["rm"] }))).answers.denied).toEqual({ kind: "noul", value: 0 });
    expect((await provider.decide(req({ toolName: "read file", toolsAllow: ["write"] }))).answers.denied).toEqual({ kind: "noul", value: 1 });
    expect((await provider.decide(req({ toolName: "write file", toolsAllow: ["write"] }))).answers.denied).toEqual({ kind: "noul", value: 0 });
  });

  it("answers context-breakpoint with a Score matching evaluateContextGuard's thresholds", async () => {
    const req = (state: Record<string, unknown>): DecisionRequest => ({
      site: "context-breakpoint",
      state,
      questions: { action: { kind: "score", instructions: "x", criteria: ["continue", "warn", "yield"] } },
      budgetMs: 100,
    });
    const base = { policy: DEFAULT_CONTEXT_POLICY, capability: CAPABILITY, nowMs: NOW, observedAtMs: NOW };
    expect((await provider.decide(req({ ...base, observation: atPressure(0.4) }))).answers.action).toMatchObject({ kind: "score", value: "continue" });
    expect((await provider.decide(req({ ...base, observation: atPressure(0.85) }))).answers.action).toMatchObject({ kind: "score", value: "warn" });
    expect((await provider.decide(req({ ...base, observation: atPressure(0.97) }))).answers.action).toMatchObject({ kind: "score", value: "yield" });
    // No fresh observation at all → continue, never a fabricated yield.
    expect((await provider.decide(req({ ...base, observation: undefined }))).answers.action).toMatchObject({ value: "continue" });
  });

  it("fails loud rather than answering with the wrong question kind", async () => {
    const req: DecisionRequest = {
      site: "tool-gate",
      state: { toolName: "x" },
      questions: { wrong: { kind: "score", instructions: "x", criteria: ["a", "b"] } },
      budgetMs: 100,
    };
    await expect(provider.decide(req)).rejects.toThrow(/answers with a "noul" question/);
  });
});
