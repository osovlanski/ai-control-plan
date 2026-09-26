/**
 * Parity report Q2: the CLI re-sends `allowed_warning` at the start of every
 * session once a window passes its own threshold (0.75 on seven_day), so every
 * fresh run used to raise `limit.approaching` and checkpoint within seconds.
 */
import { describe, expect, it } from "vitest";
import type { AssistantId, NormalizedEvent, RunSpec } from "@agent-plane/core";
import { ClaudeAdapter } from "../src/index.js";
import type { query } from "@anthropic-ai/claude-agent-sdk";

const SPEC: RunSpec = {
  taskId: "AG-1" as never,
  prompt: "do the thing",
  workdir: "/tmp",
  permissionPolicy: { mode: "auto-approve" },
  env: { redactionRules: [], maxRuntimeMs: 10_000 },
};

const rateLimit = (rateLimitType: string, utilization?: number) => ({
  type: "rate_limit_event",
  rate_limit_info: { status: "allowed_warning", resetsAt: 1790654400, rateLimitType, utilization, surpassedThreshold: 0.75 },
  uuid: "u1",
  session_id: "s1",
});

async function eventsFor(rate: unknown): Promise<NormalizedEvent[]> {
  const messages = [
    { type: "system", subtype: "init", session_id: "s1", model: "claude-x", claude_code_version: "1.0", tools: [] },
    rate,
    {
      type: "result", subtype: "success", is_error: false, result: "done", num_turns: 1, duration_ms: 5,
      total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1 }, modelUsage: {},
    },
  ];
  const fake = (() => (async function* () { for (const m of messages) yield m as never; })()) as unknown as typeof query;
  const adapter = new ClaudeAdapter("claude" as AssistantId, fake);
  const handle = await adapter.start(SPEC);
  const seen: NormalizedEvent[] = [];
  for await (const e of adapter.events(handle)) seen.push(e);
  return seen;
}

describe("Claude adapter — rate_limit_event", () => {
  it("a fresh run under a standing seven-day warning (78%) records usage, not an approaching limit", async () => {
    const seen = await eventsFor(rateLimit("seven_day", 0.78));
    expect(seen.some((e) => e.type === "limit.approaching")).toBe(false);
    expect(seen.find((e) => e.type === "usage.updated" && e.payload?.quota)?.payload).toMatchObject({
      quota: [{ window: "seven_day", usedPercent: 78 }],
    });
  });

  it("a genuinely near-limit run (92%) raises limit.approaching", async () => {
    const seen = await eventsFor(rateLimit("five_hour", 0.92));
    expect(seen.find((e) => e.type === "limit.approaching")?.payload).toMatchObject({
      quota: [{ window: "five_hour", usedPercent: 92 }],
    });
  });

  it("a warning with unknown utilization stays a warning", async () => {
    const seen = await eventsFor(rateLimit("seven_day"));
    expect(seen.some((e) => e.type === "limit.approaching")).toBe(true);
  });
});
