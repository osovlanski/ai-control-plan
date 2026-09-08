/**
 * M14 K9 — the Claude adapter forwards structured context info it used to drop.
 *
 * Scripted SDK stream (no real provider): asserts `compact_boundary` becomes a
 * normalized `context.compaction.observed`, and `observeContext` returns a
 * provider-reported sample whose effective window (`rawMaxTokens`) is a
 * DIFFERENT fact from the advertised model maximum (`ModelUsage.contextWindow`).
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

/** A scripted `query()` — yields messages, then parks on `gate` so the run
 *  stays live for `observeContext`; `getContextUsage` returns `usage`. */
function scriptedQuery(messages: unknown[], usage: unknown, gate: Promise<void>) {
  async function* gen() {
    for (const m of messages) yield m as never;
    await gate;
  }
  const it = gen() as AsyncGenerator<never, void> & { getContextUsage: () => Promise<unknown> };
  it.getContextUsage = () => (usage ? Promise.resolve(usage) : Promise.reject(new Error("no context usage")));
  return it as unknown as ReturnType<typeof query>;
}

const MESSAGES: unknown[] = [
  { type: "system", subtype: "init", session_id: "s1", model: "claude-x", claude_code_version: "1.0", tools: [] },
  { type: "assistant", message: { content: [{ type: "text", text: "working on it" }] } },
  {
    type: "system",
    subtype: "compact_boundary",
    session_id: "s1",
    uuid: "u1",
    compact_metadata: { trigger: "auto", pre_tokens: 150_000, post_tokens: 60_000 },
  },
  {
    type: "result",
    subtype: "success",
    is_error: false,
    result: "done",
    num_turns: 1,
    duration_ms: 5,
    total_cost_usd: 0.01,
    usage: { input_tokens: 10, output_tokens: 5 },
    // Advertised model maximum — 1M, deliberately unequal to the 200k window.
    modelUsage: { "claude-x": { contextWindow: 1_000_000, inputTokens: 10, outputTokens: 5 } },
  },
];

const USAGE = {
  totalTokens: 120_000,
  rawMaxTokens: 200_000, // resolved autocompaction window
  maxTokens: 200_000,
  percentage: 60,
  categories: [
    { name: "Messages", tokens: 100_000, color: "#000" },
    { name: "System prompt", tokens: 20_000, color: "#111" },
    { name: "MCP tools (deferred)", tokens: 9_999, color: "#222", isDeferred: true },
  ],
};

describe("Claude adapter — K9 context forwarding", () => {
  it("maps compact_boundary to context.compaction.observed and reads a provider context sample", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const adapter = new ClaudeAdapter(
      "claude" as AssistantId,
      ((): ReturnType<typeof query> => scriptedQuery(MESSAGES, USAGE, gate)) as unknown as typeof query,
    );

    const handle = await adapter.start(SPEC);
    const iter = adapter.events(handle)[Symbol.asyncIterator]();
    const seen: NormalizedEvent[] = [];
    // Pull until the run's per-turn end; the stream stays parked on `gate`.
    for (;;) {
      const { value, done } = await iter.next();
      if (done) break;
      seen.push(value);
      if (value.type === "run.ended") break;
    }

    const compaction = seen.find((e) => e.type === "context.compaction.observed");
    expect(compaction).toBeDefined();
    expect(compaction!.payload).toMatchObject({
      trigger: "auto",
      preTokens: 150_000,
      postTokens: 60_000,
      requestedByPlane: false,
    });

    // Live sample while the query is still active.
    const sample = await adapter.observeContext(handle);
    expect(sample).toMatchObject({
      occupancyTokens: 120_000,
      occupancySource: "provider-reported",
      effectiveWindowTokens: 200_000,
      effectiveWindowSource: "provider-reported",
      advertisedMaxTokens: 1_000_000,
    });
    // Effective window and advertised maximum are different facts.
    expect(sample!.effectiveWindowTokens).not.toBe(sample!.advertisedMaxTokens);
    // Deferred categories are excluded from the breakdown.
    expect(sample!.breakdown?.map((b) => b.category)).toEqual(["Messages", "System prompt"]);

    release();
    for (;;) {
      const { done } = await iter.next();
      if (done) break;
    }
  });

  it("returns null (records nothing) when the control request fails", async () => {
    const gate = new Promise<void>(() => {});
    const adapter = new ClaudeAdapter(
      "claude" as AssistantId,
      (() => scriptedQuery(MESSAGES.slice(0, 2), null, gate)) as unknown as typeof query,
    );
    const handle = await adapter.start(SPEC);
    expect(await adapter.observeContext(handle)).toBeNull();
    await adapter.cancel(handle);
  });
});
