/**
 * Slice 1 (2026-10-30): a composed run on the real Claude adapter is counted. The OCI dogfood run
 * reported usage.updated with 8 in / 1,334 out and $0.225, yet the budget read showed accounting
 * none and 0 tokens, because the manifest declared `usageAccounting: "none"`. Here the real
 * ClaudeAdapter runs over a stub `query` that replays the redacted fixture (and reports the
 * provisioned plugin the way the CLI's init would), through `POST /api/tasks/:id/start` with the
 * composer on, and `GET /composition/budget` reads the settlement. Every value is FAKE.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AssistantId } from "@agent-plane/core";
import { ClaudeAdapter } from "@agent-plane/adapters";

/** The provisioned plugin's name (adapters `PLUGIN_NAME`, not exported from the package). */
const PLUGIN_NAME = "agent-plane-profile";
import { bootRig, type Rig } from "./helpers/composer-cockpit.js";

/** The Agent SDK `query` the adapter is built with (api does not depend on the SDK directly). */
type Query = NonNullable<ConstructorParameters<typeof ClaudeAdapter>[1]>;

const FIXTURE = JSON.parse(readFileSync(join(import.meta.dirname, "../../../packages/adapters/test/fixtures/claude-result-run.json"), "utf8")) as {
  messages: Array<Record<string, unknown>>;
};

let rig: Rig | undefined;

afterEach(async () => {
  await rig?.close();
  rig = undefined;
  vi.unstubAllEnvs();
});

/** Replays the fixture; init lists the provisioned plugin and its skills, as Claude Code would. */
function replay(model?: string): Query {
  return ((params: { options?: { plugins?: Array<{ path: string }> } }) => (async function* () {
    const pluginDir = params.options?.plugins?.[0]?.path;
    const skills = pluginDir ? readdirSync(join(pluginDir, "skills")).map((s) => `${PLUGIN_NAME}:${s}`) : [];
    for (const m of FIXTURE.messages) {
      if (m.type === "system") {
        yield { ...m, ...(model ? { model } : {}), skills, plugins: pluginDir ? [{ name: PLUGIN_NAME, path: pluginDir }] : [] } as never;
      } else yield m as never;
    }
  })()) as unknown as Query;
}

async function bootClaude(maxTokens: number, model?: string): Promise<Rig> {
  // The manifest's auth comes from the environment; a runner with no Claude login would route nothing.
  vi.stubEnv("ANTHROPIC_API_KEY", "FAKE-anthropic-key-not-real-slice1");
  // The seed's prices apply to an API account; a subscription has no list price to estimate from.
  const r = await bootRig({ assistants: { claude: { provider: "anthropic", accountKind: "api" } }, budget: { maxTokens } });
  (r.built.registry as unknown as { adapters: Map<string, unknown> }).adapters.set("claude", new ClaudeAdapter("claude" as AssistantId, replay(model)));
  await r.built.registry.syncAll();
  // K7 price evidence: the seed is loaded by a refresh (offline sources only in tests).
  await r.built.modelCatalog.refresh();
  return r;
}

async function composedRun(): Promise<{ taskId: string; runId: string }> {
  const taskId = rig!.built.tasks.create({ goal: "Add a typed helper to the parser module", repoPath: rig!.repo }).taskId;
  const res = await rig!.built.app.inject({ method: "POST", url: `/api/tasks/${taskId}/start`, headers: rig!.auth(), payload: {} });
  expect(res.statusCode, res.body).toBe(200);
  expect(await rig!.built.orchestrator.waitForSettled(taskId)).toBe("COMPLETED");
  return { taskId, runId: (res.json() as { runId: string }).runId };
}

async function budget(taskId: string) {
  const res = await rig!.built.app.inject({ method: "GET", url: `/api/tasks/${taskId}/composition/budget`, headers: rig!.auth() });
  expect(res.statusCode).toBe(200);
  return res.json() as {
    consumed: { tokens: number; costMethod: string; costUsd: number };
    remaining: Record<string, number>;
    runs: Array<{ accounting: string; model: string | null; tokens: number; source: string; inRunTokens: number; cost: { method: string; usd?: number } }>;
    overruns: Array<{ cap: string; capValue: number; settled: number; amount: number; source: string }>;
  };
}

// 8 uncached + 12,406 cache creation + 1,334 output; the 61,544 cache reads are not counted.
const COUNTED = 8 + 12_406 + 1_334;

describe("a composed Claude run settles its result usage", () => {
  it("counts the recorded result under cumulative accounting; an unpriced served model leaves the cost unknown", async () => {
    rig = await bootClaude(1_000_000);
    const { taskId, runId } = await composedRun();
    const b = await budget(taskId);
    expect(b.runs).toEqual([expect.objectContaining({ accounting: "cumulative", model: "claude-sonnet-5", tokens: COUNTED, source: "in_run", inRunTokens: COUNTED, cost: { method: "unknown" } })]);
    expect(b.consumed).toMatchObject({ tokens: COUNTED, costMethod: "unknown" });
    expect(b.remaining).toEqual({ max_tokens: 1_000_000 - COUNTED });
    // The terminal result's accounting is the manifest's.
    const result = rig.db.prepare("SELECT json_extract(result, '$.usage') AS u FROM execution_results WHERE session_id = ?").get(runId) as { u: string };
    expect(JSON.parse(result.u)).toEqual({ inputTokens: 8 + 12_406, outputTokens: 1_334, accounting: "cumulative" });
    // The quota-only usage.updated is on the timeline and added nothing.
    const quota = rig.db.prepare("SELECT payload FROM events WHERE run_id = ? AND type = 'usage.updated' ORDER BY seq").all(runId) as Array<{ payload: string }>;
    expect(quota.map((q) => Object.keys(JSON.parse(q.payload) as object).includes("quota"))).toEqual([true, false]);
  });

  it("a served model the catalog prices settles to an estimated cost", async () => {
    rig = await bootClaude(1_000_000, "claude-sonnet-4-5");
    const { taskId } = await composedRun();
    const run = (await budget(taskId)).runs[0]!;
    // 12,414 input at $3/Mtok + 1,334 output at $15/Mtok. Cache creation is priced at the input rate
    // here, and the result's measured $0.225 is not read by settlement: both are findings, not fixed.
    expect(run).toMatchObject({ model: "claude-sonnet-4-5", tokens: COUNTED, cost: { method: "estimated", usd: 0.057252 } });
  });

  it("a run over max_tokens raises one in-run budget.overrun and changes nothing else", async () => {
    rig = await bootClaude(10_000);
    const { taskId } = await composedRun();
    const b = await budget(taskId);
    expect(b.overruns).toEqual([expect.objectContaining({ cap: "max_tokens", capValue: 10_000, settled: COUNTED, amount: COUNTED - 10_000, source: "in_run" })]);
    expect(rig.built.tasks.get(taskId)!.state).toBe("COMPLETED");
  });
});
