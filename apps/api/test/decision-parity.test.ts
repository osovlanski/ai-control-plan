/**
 * M16 K17 — proves `RulesDecisionProvider` reproduces today's behaviour
 * EXACTLY, by calling the real source functions side by side with the
 * provider on the same inputs (plan `plans/jev-decision-service-plan.md`
 * §5 K17 done-when). This is the one file allowed to see both sides:
 * `@agent-plane/core`'s decision types and apps/api's real classifier/guards.
 */
import { describe, expect, it } from "vitest";
import { buildContextObservation, DEFAULT_CONTEXT_POLICY, RulesDecisionProvider, type ContextCapability, type DecisionRequest } from "@agent-plane/core";
import { classifyGoal } from "../src/modules/telemetry.js";
import { toolPolicyGuard, type GuardSnapshot } from "../src/modules/harness/guards.js";
import { evaluateContextGuard } from "../src/modules/harness/context-guard.js";

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

describe("RulesDecisionProvider parity — classifyGoal()", () => {
  const goals = [
    "fix the login bug",
    "implement a new endpoint",
    "please review this diff",
    "audit the security posture",
    "research why the build is slow",
    "investigate the flaky test",
    "say hello",
    "REVIEW then fix it", // precedence: review checked before coding
    "compare these two approaches",
  ];

  for (const goal of goals) {
    it(`matches classifyGoal for ${JSON.stringify(goal)}`, async () => {
      const expected = classifyGoal(goal);
      const req: DecisionRequest = {
        site: "task-classifier",
        state: { goal },
        questions: { kind: { kind: "choice", instructions: "x", criteria: { coding: null, review: null, research: null, general: null } } },
        budgetMs: 100,
      };
      const outcome = await provider.decide(req);
      expect(outcome.answers.kind).toMatchObject({ kind: "choice", value: expected });
    });
  }
});

describe("RulesDecisionProvider parity — toolPolicyGuard()'s allow/deny match", () => {
  const cases: Array<{ name: string; allow?: string[]; deny?: string[] }> = [
    { name: "bash rm -rf /", deny: ["rm"] },
    { name: "read file.txt", deny: ["rm"] },
    { name: "read file.txt", allow: ["write"] },
    { name: "write file.txt", allow: ["write"] },
    { name: "write file.txt", allow: ["write"], deny: ["write"] }, // deny wins
    { name: "anything" }, // no allow/deny configured — never denied
  ];

  const policy = (tools: { allow?: string[]; deny?: string[] }) => ({
    budget: { enforcement: "advisory" as const },
    timeout: { hardMs: 60_000 },
    approval: { mode: "auto-approve" as const },
    tools: { mode: "audit" as const, allow: tools.allow, deny: tools.deny },
    checkpoint: { onSoftLimit: true },
    isolation: { required: "partial" as const },
  });

  const snap = (tools: { allow?: string[]; deny?: string[] }): GuardSnapshot => ({
    policy: policy(tools),
    startedAtMs: 0,
    lastEventAtMs: 0,
    tokensSoFar: 0,
    softCheckpointed: false,
    accountingMode: "delta",
    softThresholdPct: 80,
  });

  for (const c of cases) {
    it(`matches toolPolicyGuard for ${JSON.stringify(c)}`, async () => {
      const directive = toolPolicyGuard(snap(c), {
        kind: "event",
        atMs: 0,
        event: { runId: "r" as never, ts: "2026-01-01T00:00:00.000Z", type: "tool.started", summary: c.name, payload: { tool: c.name } },
      });
      const expectedDenied = directive.action === "cancel";

      const req: DecisionRequest = {
        site: "tool-gate",
        state: { toolName: c.name, toolsAllow: c.allow, toolsDeny: c.deny },
        questions: { denied: { kind: "noul", instructions: "x" } },
        budgetMs: 100,
      };
      const outcome = await provider.decide(req);
      expect(outcome.answers.denied).toEqual({ kind: "noul", value: expectedDenied ? 1 : 0 });
    });
  }
});

describe("RulesDecisionProvider parity — evaluateContextGuard()'s pressure threshold", () => {
  const pressures = [0, 0.4, 0.7, DEFAULT_CONTEXT_POLICY.actRatio, 0.9, 0.92, 0.97, 1.05];

  for (const pressure of pressures) {
    it(`matches evaluateContextGuard at pressure ${pressure}`, async () => {
      const observation = atPressure(pressure);
      const expected = evaluateContextGuard({
        policy: DEFAULT_CONTEXT_POLICY,
        capability: CAPABILITY,
        observation,
        observedAtMs: NOW,
        nowMs: NOW,
      });

      const req: DecisionRequest = {
        site: "context-breakpoint",
        state: { policy: DEFAULT_CONTEXT_POLICY, capability: CAPABILITY, observation, observedAtMs: NOW, nowMs: NOW },
        questions: { action: { kind: "score", instructions: "x", criteria: ["continue", "warn", "yield"] } },
        budgetMs: 100,
      };
      const outcome = await provider.decide(req);
      expect(outcome.answers.action).toMatchObject({ kind: "score", value: expected.action });
    });
  }

  it("matches evaluateContextGuard when there is no observation yet", async () => {
    const expected = evaluateContextGuard({ policy: DEFAULT_CONTEXT_POLICY, capability: CAPABILITY, nowMs: NOW });
    const req: DecisionRequest = {
      site: "context-breakpoint",
      state: { policy: DEFAULT_CONTEXT_POLICY, capability: CAPABILITY, nowMs: NOW },
      questions: { action: { kind: "score", instructions: "x", criteria: ["continue", "warn", "yield"] } },
      budgetMs: 100,
    };
    const outcome = await provider.decide(req);
    expect(outcome.answers.action).toMatchObject({ value: expected.action });
  });

  it("matches evaluateContextGuard on a stale observation (never authorizes)", async () => {
    const observation = atPressure(0.99);
    const observedAtMs = NOW - 60_000; // beyond CONTEXT_STALE_MS
    const expected = evaluateContextGuard({ policy: DEFAULT_CONTEXT_POLICY, capability: CAPABILITY, observation, observedAtMs, nowMs: NOW });
    const req: DecisionRequest = {
      site: "context-breakpoint",
      state: { policy: DEFAULT_CONTEXT_POLICY, capability: CAPABILITY, observation, observedAtMs, nowMs: NOW },
      questions: { action: { kind: "score", instructions: "x", criteria: ["continue", "warn", "yield"] } },
      budgetMs: 100,
    };
    const outcome = await provider.decide(req);
    expect(outcome.answers.action).toMatchObject({ value: expected.action });
    expect(expected.action).toBe("continue");
  });
});
