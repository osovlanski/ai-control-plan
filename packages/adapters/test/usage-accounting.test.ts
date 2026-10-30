/**
 * Slice 1 (2026-10-30): the real adapters report usage the plane counts. Claude's `result` carries
 * the run's totals (cumulative for the run); its quota-only `usage.updated` carries no tokens.
 * Codex's `turn.completed` carries the thread's running total at SDK 0.154, so the adapter emits
 * the run's share. Every id is FAKE.
 */
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { accumulateInRun, type AssistantId, type NormalizedEvent, type RunSpec } from "@agent-plane/core";
import type { query } from "@anthropic-ai/claude-agent-sdk";
import { ClaudeAdapter, CodexAdapter } from "../src/index.js";

const SPEC: RunSpec = {
  taskId: "AG-usage" as never,
  prompt: "do the thing",
  workdir: tmpdir(),
  permissionPolicy: { mode: "auto-approve" },
  env: { redactionRules: [], maxRuntimeMs: 10_000 },
};

const FIXTURE = JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", "claude-result-run.json"), "utf8")) as { messages: unknown[] };

async function claudeEvents(messages: unknown[]): Promise<NormalizedEvent[]> {
  const fake = (() => (async function* () { for (const m of messages) yield m as never; })()) as unknown as typeof query;
  const adapter = new ClaudeAdapter("claude" as AssistantId, fake);
  const handle = await adapter.start(SPEC);
  const seen: NormalizedEvent[] = [];
  for await (const e of adapter.events(handle)) seen.push(e);
  return seen;
}

const usagePayloads = (events: NormalizedEvent[]) =>
  events.filter((e) => e.type === "usage.updated").map((e) => e.payload as { inputTokens?: number; outputTokens?: number });

describe("Claude adapter usage", () => {
  it("declares cumulative accounting and no usageReporting contract, so a token cap stays advisory", async () => {
    const harness = (await new ClaudeAdapter("claude" as AssistantId).describe()).harness;
    expect(harness?.usageAccounting).toBe("cumulative");
    expect(harness?.usageReporting).toBeUndefined();
  });

  it("the recorded result counts uncached input + cache creation + output, and reports cache reads beside it", async () => {
    const events = await claudeEvents(FIXTURE.messages);
    const result = events.filter((e) => e.type === "usage.updated").at(-1)!;
    expect(result.payload).toMatchObject({
      inputTokens: 8 + 12_406, outputTokens: 1_334,
      uncachedInputTokens: 8, cacheCreationInputTokens: 12_406, cacheReadInputTokens: 61_544, costUsd: 0.225,
    });
    expect(result.summary).toBe("Tokens in/out: 12414/1334 (cache reads 61544)");
    expect(accumulateInRun("cumulative", usagePayloads(events))).toEqual({ input: 12_414, output: 1_334 });
  });

  it("a quota-only usage.updated adds 0", async () => {
    const quotaOnly = (await claudeEvents(FIXTURE.messages.slice(0, 2)));
    const payloads = usagePayloads(quotaOnly);
    expect(payloads).toEqual([{ quota: [{ window: "five_hour", usedPercent: 31, resetsAt: expect.any(String) }] }]);
    expect(accumulateInRun("cumulative", payloads)).toEqual({ input: 0, output: 0 });
  });

  it("a result without cache fields counts its input as is", async () => {
    const [init, , result] = FIXTURE.messages as Array<Record<string, unknown>>;
    const events = await claudeEvents([init, { ...result, usage: { input_tokens: 5, output_tokens: 7 } }]);
    expect(events.find((e) => e.type === "usage.updated")?.payload).toMatchObject({
      inputTokens: 5, outputTokens: 7, uncachedInputTokens: 5, cacheCreationInputTokens: 0, cacheReadInputTokens: 0,
    });
  });
});

/** A stand-in `codex` binary that prints one turn's JSONL, the usage being the thread total. */
function fakeCodex(threadId: string, total: { input_tokens: number; cached_input_tokens: number; output_tokens: number; reasoning_output_tokens: number; cache_write_input_tokens?: number }): string {
  const dir = mkdtempSync(join(tmpdir(), "codex-usage-"));
  const bin = join(dir, "codex");
  writeFileSync(bin, `#!/usr/bin/env node
process.stdin.resume();
process.stdin.on("end", () => {
  for (const e of [{ type: "thread.started", thread_id: ${JSON.stringify(threadId)} }, { type: "turn.started" },
    { type: "turn.completed", usage: ${JSON.stringify(total)} }])
    process.stdout.write(JSON.stringify(e) + "\\n");
});
`);
  chmodSync(bin, 0o755);
  return bin;
}

async function drain(adapter: CodexAdapter, start: () => ReturnType<CodexAdapter["start"]>): Promise<NormalizedEvent[]> {
  const handle = await start();
  const events: NormalizedEvent[] = [];
  for await (const e of adapter.events(handle)) events.push(e);
  return events;
}

describe("Codex adapter usage", () => {
  const THREAD = "FAKE-codex-thread-not-real-0001";

  it("the SDK path declares cumulative; the app-server transport, whose figure is the last request's, stays none", async () => {
    expect((await new CodexAdapter("codex" as AssistantId).describe()).harness?.usageAccounting).toBe("cumulative");
    expect((await new CodexAdapter("codex" as AssistantId, { appServerInput: true }).describe()).harness?.usageAccounting).toBe("none");
  });

  it("a fresh thread counts non-cached input + output; cached reads are reported, uncounted", async () => {
    const bin = fakeCodex(THREAD, { input_tokens: 9_000, cached_input_tokens: 6_000, cache_write_input_tokens: 0, output_tokens: 700, reasoning_output_tokens: 300 });
    const adapter = new CodexAdapter("codex" as AssistantId, { codex: { codexPathOverride: bin } });
    const events = await drain(adapter, () => adapter.start(SPEC));
    const usage = events.find((e) => e.type === "usage.updated")!;
    expect(usage.payload).toEqual({
      scope: "run", inputTokens: 3_000, outputTokens: 700, cachedInputTokens: 6_000, cacheWriteInputTokens: 0, reasoningOutputTokens: 300,
      threadTotal: { inputTokens: 9_000, cachedInputTokens: 6_000, outputTokens: 700 },
    });
    expect(accumulateInRun("cumulative", usagePayloads(events))).toEqual({ input: 3_000, output: 700 });
  });

  it("a resume in the same process counts only what the thread added since the last run", async () => {
    const first = fakeCodex(THREAD, { input_tokens: 9_000, cached_input_tokens: 6_000, output_tokens: 700, reasoning_output_tokens: 300 });
    const adapter = new CodexAdapter("codex" as AssistantId, { codex: { codexPathOverride: first } });
    await drain(adapter, () => adapter.start(SPEC));
    // The resumed thread is seeded with its earlier total, so turn.completed reports 9,000 + this run's.
    const second = fakeCodex(THREAD, { input_tokens: 20_000, cached_input_tokens: 15_000, output_tokens: 1_000, reasoning_output_tokens: 400 });
    (adapter as unknown as { codex: unknown }).codex = new (await import("@openai/codex-sdk")).Codex({ codexPathOverride: second });
    const events = await drain(adapter, () => adapter.resume(THREAD as never, SPEC));
    expect(events.find((e) => e.type === "usage.updated")?.payload).toMatchObject({ scope: "run", inputTokens: 2_000, outputTokens: 300, cachedInputTokens: 9_000 });
  });

  it("a resume with no baseline in this process carries the thread total and counts nothing", async () => {
    const bin = fakeCodex(THREAD, { input_tokens: 20_000, cached_input_tokens: 15_000, output_tokens: 1_000, reasoning_output_tokens: 400 });
    const adapter = new CodexAdapter("codex" as AssistantId, { codex: { codexPathOverride: bin } });
    const events = await drain(adapter, () => adapter.resume(THREAD as never, SPEC));
    const usage = events.find((e) => e.type === "usage.updated")!;
    expect(usage.payload).toEqual({ scope: "thread", threadTotal: { inputTokens: 20_000, cachedInputTokens: 15_000, outputTokens: 1_000 } });
    expect(usage.summary).toMatch(/no baseline: not counted/);
    expect(accumulateInRun("cumulative", usagePayloads(events))).toEqual({ input: 0, output: 0 });
  });
});
