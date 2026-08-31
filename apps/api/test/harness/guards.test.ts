/**
 * Phase 3 — guards as pure functions against synthetic snapshots/events (§4, §12 layer 1).
 */
import { describe, expect, it } from "vitest";
import type { ExecutionPolicy, NormalizedEvent, RunId } from "@agent-plane/core";
import {
  accumulateTokens,
  budgetGuard,
  evaluateGuards,
  quotaGuard,
  timeoutGuard,
  toolPolicyGuard,
  type GuardSnapshot,
} from "../../src/modules/harness/guards.js";

const policy = (over: Partial<ExecutionPolicy> = {}): ExecutionPolicy => ({
  budget: { enforcement: "advisory" },
  timeout: { hardMs: 60_000 },
  approval: { mode: "auto-approve" },
  tools: { mode: "audit" },
  checkpoint: { onSoftLimit: true },
  isolation: { required: "partial" },
  ...over,
});

const snap = (over: Partial<GuardSnapshot> = {}): GuardSnapshot => ({
  policy: policy(),
  startedAtMs: 1_000,
  lastEventAtMs: 1_000,
  tokensSoFar: 0,
  softCheckpointed: false,
  accountingMode: "delta",
  softThresholdPct: 80,
  ...over,
});

const ev = (type: NormalizedEvent["type"], payload?: Record<string, unknown>): NormalizedEvent => ({
  runId: "r" as RunId,
  ts: "2026-01-01T00:00:00.000Z",
  type,
  summary: type,
  payload,
});

describe("budgetGuard", () => {
  it("continues when no cap is set", () => {
    expect(budgetGuard(snap(), { kind: "event", event: ev("usage.updated"), atMs: 2_000 }).action).toBe("continue");
  });

  it("checkpoints once at the soft threshold (either enforcement mode)", () => {
    const s = snap({ policy: policy({ budget: { enforcement: "advisory", maxTokens: 100 } }), tokensSoFar: 85 });
    expect(budgetGuard(s, { kind: "event", event: ev("usage.updated"), atMs: 2_000 }).action).toBe("checkpoint");
    expect(budgetGuard({ ...s, softCheckpointed: true }, { kind: "event", event: ev("usage.updated"), atMs: 2_000 }).action).toBe("continue");
  });

  it("cancels a bounded cap on observed excess, and never cancels an advisory one", () => {
    const bounded = snap({ policy: policy({ budget: { enforcement: "bounded", maxTokens: 100 } }), tokensSoFar: 130 });
    const d = budgetGuard(bounded, { kind: "event", event: ev("usage.updated"), atMs: 2_000 });
    expect(d).toMatchObject({ action: "cancel", failure: { kind: "budget_exceeded", retryable: false } });

    const advisory = snap({ policy: policy({ budget: { enforcement: "advisory", maxTokens: 100 } }), tokensSoFar: 130, softCheckpointed: true });
    expect(budgetGuard(advisory, { kind: "event", event: ev("usage.updated"), atMs: 2_000 }).action).toBe("continue");
  });
});

describe("timeoutGuard", () => {
  it("cancels on the hard deadline", () => {
    const d = timeoutGuard(snap({ policy: policy({ timeout: { hardMs: 500 } }) }), { kind: "tick", atMs: 1_600 });
    expect(d).toMatchObject({ action: "cancel", failure: { kind: "timeout", retryable: true } });
  });

  it("cancels on the idle deadline", () => {
    const s = snap({ policy: policy({ timeout: { hardMs: 10_000, idleMs: 300 } }), lastEventAtMs: 1_000 });
    expect(timeoutGuard(s, { kind: "tick", atMs: 1_400 }).action).toBe("cancel");
  });

  it("continues inside both budgets", () => {
    expect(timeoutGuard(snap(), { kind: "tick", atMs: 1_100 }).action).toBe("continue");
  });
});

describe("toolPolicyGuard", () => {
  it("cancels a denied tool with tool_denied", () => {
    const s = snap({ policy: policy({ tools: { mode: "audit", deny: ["rm"] } }) });
    const d = toolPolicyGuard(s, { kind: "event", event: ev("tool.started", { tool: "rm -rf /" }), atMs: 2_000 });
    expect(d).toMatchObject({ action: "cancel", failure: { kind: "tool_denied" } });
  });

  it("cancels a tool absent from a non-empty allow list", () => {
    const s = snap({ policy: policy({ tools: { mode: "preventive", allow: ["read"] } }) });
    expect(toolPolicyGuard(s, { kind: "event", event: ev("tool.started", { tool: "write" }), atMs: 2_000 }).action).toBe("cancel");
  });

  it("ignores non-tool events", () => {
    expect(toolPolicyGuard(snap(), { kind: "event", event: ev("message"), atMs: 2_000 }).action).toBe("continue");
  });
});

describe("quotaGuard", () => {
  it("checkpoints on limit.approaching and yields limit on limit.hit", () => {
    expect(quotaGuard(snap(), { kind: "event", event: ev("limit.approaching"), atMs: 2_000 }).action).toBe("checkpoint");
    const d = quotaGuard(snap(), { kind: "event", event: ev("limit.hit"), atMs: 2_000 });
    expect(d).toMatchObject({ action: "yield", yieldKind: "limit" });
  });
});

describe("evaluateGuards — arbitration", () => {
  it("a cancel beats a checkpoint when two guards fire", () => {
    const s = snap({
      policy: policy({ budget: { enforcement: "advisory", maxTokens: 100 }, timeout: { hardMs: 100 } }),
      tokensSoFar: 90,
    });
    const d = evaluateGuards(s, { kind: "event", event: ev("usage.updated"), atMs: 5_000 });
    expect(d.action).toBe("cancel"); // timeout, not the budget checkpoint
    expect(d.guard).toBe("timeout");
  });
});

describe("accumulateTokens", () => {
  it("adds deltas and takes the max for cumulative", () => {
    expect(accumulateTokens(10, { inputTokens: 5 }, "delta")).toBe(15);
    expect(accumulateTokens(10, { inputTokens: 5 }, "cumulative")).toBe(10);
    expect(accumulateTokens(10, { inputTokens: 25 }, "cumulative")).toBe(25);
    expect(accumulateTokens(10, { inputTokens: 5 }, "none")).toBe(10);
  });
});
