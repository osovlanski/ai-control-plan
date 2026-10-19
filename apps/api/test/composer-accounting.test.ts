/**
 * M2 Composer S6: budget settlement (plans/m2-composer.md §5). A run's settled tokens are
 * max(in-run, late usage records), never the sum; cumulative records take the max, deltas sum,
 * cumulative wins when both exist, and a lower cumulative is kept but flagged `regressed`. A late
 * record that takes a revision past a cap appends one `budget.overrun` event and changes nothing
 * else. `GET /api/tasks/:id/composition/budget` reports all of it. Every value is FAKE.
 */
import { afterEach, describe, expect, it } from "vitest";
import { bootRig, type Rig } from "./helpers/composer-cockpit.js";

let rig: Rig | undefined;

afterEach(async () => {
  await rig?.close();
  rig = undefined;
});

interface Budget {
  provisional: boolean;
  caps: Record<string, number>;
  consumed: { tokens: number; costUsd: number; costMethod: string; sessions: number; recordCount: number; unknownCostSessions: number };
  remaining: Record<string, number>;
  exhausted: string[];
  latestRevision: { compositionRevisionId: string; caps: Record<string, number>; remaining: Record<string, number>; exhausted: string[] } | null;
  runs: Array<{ runId: string; compositionRevisionId: string | null; tokens: number; source: string; inRunTokens: number; recordTokens: number; recordCount: number; regressed: string[]; cost: { method: string; usd?: number } }>;
  overruns: Array<{ runId: string; cap: string; capValue: number; settled: number; amount: number; source: string; method: string; compositionRevisionId: string }>;
}

async function budget(taskId: string): Promise<{ status: number; body: Budget & { reason?: string } }> {
  const res = await rig!.built.app.inject({ method: "GET", url: `/api/tasks/${taskId}/composition/budget`, headers: rig!.auth() });
  return { status: res.statusCode, body: res.json() as Budget & { reason?: string } };
}

/** A composed operator start that completes on the fake: one run bound to CR-1, 1200 in + 450 out. */
async function composedRun(): Promise<{ taskId: string; runId: string }> {
  const taskId = rig!.built.tasks.create({ goal: "Add a typed helper to the parser module", repoPath: rig!.repo }).taskId;
  const res = await rig!.built.app.inject({ method: "POST", url: `/api/tasks/${taskId}/start`, headers: rig!.auth(), payload: {} });
  expect(res.statusCode).toBe(200);
  const body = res.json() as { runId: string; composition: { compositionRevisionId: string } };
  expect(body.composition.compositionRevisionId).toBe(`CR-${taskId}-1`);
  expect(await rig!.built.orchestrator.waitForSettled(taskId)).toBe("COMPLETED");
  return { taskId, runId: body.runId };
}

const overrunEvents = () => rig!.db.prepare("SELECT run_id, seq, summary, payload FROM events WHERE type = 'budget.overrun' ORDER BY id").all() as Array<{ run_id: string; seq: number; summary: string; payload: string }>;

describe("GET /api/tasks/:id/composition/budget", () => {
  it("settles a finished run from its in-run usage and reports the remainder, provisionally", async () => {
    rig = await bootRig({ budget: { maxTokens: 5000, maxCostUsd: 1, maxRuntimeMs: 600_000 } });
    const { taskId, runId } = await composedRun();
    const { status, body } = await budget(taskId);
    expect(status).toBe(200);
    expect(body).toMatchObject({
      provisional: true,
      caps: { max_tokens: 5000, max_cost_usd: 1, max_runtime_ms: 600_000 },
      // No K7 price for the fake model and no record: the cost is unknown, and no number is shown.
      consumed: { tokens: 1650, costUsd: 0, costMethod: "unknown", sessions: 1, recordCount: 0, unknownCostSessions: 1 },
      remaining: { max_tokens: 3350, max_cost_usd: 1, max_runtime_ms: 600_000 },
      exhausted: [],
      latestRevision: { compositionRevisionId: `CR-${taskId}-1`, caps: { max_tokens: 5000, max_cost_usd: 1, max_runtime_ms: 600_000 }, remaining: { max_tokens: 3350 } },
      overruns: [],
    });
    expect(body.runs).toEqual([expect.objectContaining({
      runId, compositionRevisionId: `CR-${taskId}-1`, tokens: 1650, source: "in_run", inRunTokens: 1650, recordTokens: 0, recordCount: 0, regressed: [], cost: { method: "unknown" },
    })]);
    expect((await rig.built.app.inject({ method: "GET", url: "/api/tasks/AG-nope/composition/budget", headers: rig.auth() })).statusCode).toBe(404);
  });

  it("answers 404 composer_disabled with the composer off, and ingestion is unchanged", async () => {
    rig = await bootRig({ enabled: false, budget: { maxTokens: 10 } });
    const taskId = rig.built.tasks.create({ goal: "Add a typed helper", repoPath: rig.repo }).taskId;
    const res = await rig.built.app.inject({ method: "POST", url: `/api/tasks/${taskId}/start`, headers: rig.auth(), payload: {} });
    const runId = (res.json() as { runId: string }).runId;
    expect(await rig.built.orchestrator.waitForSettled(taskId)).toBe("COMPLETED");
    expect(await budget(taskId)).toMatchObject({ status: 404, body: { reason: "composer_disabled" } });
    expect((await rig.postUsage({ eventId: "FAKE-evt-off", runId, accounting: "cumulative", tokensIn: 9_000, tokensOut: 0 })).status).toBe(201);
    expect(overrunEvents()).toEqual([]);
  });
});

describe("late usage records", () => {
  it("cumulative: the max wins, never the sum with in-run; a late overrun is one event; a replay or a regression adds none", async () => {
    rig = await bootRig({ budget: { maxTokens: 5000 } });
    const { taskId, runId } = await composedRun();
    const stateBefore = rig.db.prepare("SELECT state, session_state FROM runs WHERE id = ?").get(runId);

    expect((await rig.postUsage({ eventId: "FAKE-c1", runId, accounting: "cumulative", tokensIn: 3000, tokensOut: 1000 })).status).toBe(201);
    let b = (await budget(taskId)).body;
    // max(1650 in-run, 4000 records) = 4000, not 5650.
    expect(b.runs[0]).toMatchObject({ tokens: 4000, source: "records", inRunTokens: 1650, recordTokens: 4000, recordCount: 1 });
    expect(b.remaining).toEqual({ max_tokens: 1000 });
    expect(overrunEvents()).toEqual([]);

    expect((await rig.postUsage({ eventId: "FAKE-c2", runId, accounting: "cumulative", tokensIn: 5000, tokensOut: 1000 })).status).toBe(201);
    const [event, ...more] = overrunEvents();
    expect(more).toEqual([]);
    expect(event!.run_id).toBe(runId);
    expect(JSON.parse(event!.payload)).toEqual({
      compositionRevisionId: `CR-${taskId}-1`, cap: "max_tokens", capValue: 5000, settled: 6000, amount: 1000, source: "late", method: "tokens",
    });
    expect(event!.summary).toBe(`budget overrun (late): max_tokens 5000 exceeded by 1000 tokens under CR-${taskId}-1`);

    // An identical replay is a 200 and adds nothing.
    const replay = await rig.postUsage({ eventId: "FAKE-c2", runId, accounting: "cumulative", tokensIn: 5000, tokensOut: 1000 });
    expect(replay).toMatchObject({ status: 200, body: { replayed: true } });
    // A lower cumulative is kept, flagged, and ignored for the total.
    expect((await rig.postUsage({ eventId: "FAKE-c3", runId, accounting: "cumulative", tokensIn: 100, tokensOut: 100 })).status).toBe(201);
    expect(overrunEvents()).toHaveLength(1);

    b = (await budget(taskId)).body;
    expect(b.runs[0]).toMatchObject({ tokens: 6000, recordCount: 3, regressed: ["FAKE-c3"] });
    expect(b.remaining).toEqual({ max_tokens: -1000 });
    expect(b.exhausted).toEqual(["max_tokens"]);
    expect(b.overruns).toEqual([expect.objectContaining({ runId, cap: "max_tokens", amount: 1000, source: "late" })]);
    // A further overrun records only what it adds.
    expect((await rig.postUsage({ eventId: "FAKE-c4", runId, accounting: "cumulative", tokensIn: 5500, tokensOut: 1000 })).status).toBe(201);
    expect(overrunEvents().map((e) => (JSON.parse(e.payload) as { amount: number }).amount)).toEqual([1000, 500]);

    // The run itself is untouched: an overrun is accounting, never a state change.
    expect(rig.db.prepare("SELECT state, session_state FROM runs WHERE id = ?").get(runId)).toEqual(stateBefore);
    expect(rig.built.tasks.get(taskId)!.state).toBe("COMPLETED");
  });

  it("delta: records sum, the session settles on the larger source, and a cumulative record subsumes the deltas", async () => {
    rig = await bootRig({ budget: { maxTokens: 50_000 } });
    const { taskId, runId } = await composedRun();
    await rig.postUsage({ eventId: "FAKE-d1", runId, accounting: "delta", tokensIn: 300, tokensOut: 0 });
    await rig.postUsage({ eventId: "FAKE-d2", runId, accounting: "delta", tokensIn: 400, tokensOut: 0 });
    let run = (await budget(taskId)).body.runs[0]!;
    expect(run).toMatchObject({ tokens: 1650, source: "in_run", recordTokens: 700, recordCount: 2 });

    await rig.postUsage({ eventId: "FAKE-d3", runId, accounting: "delta", tokensIn: 1000, tokensOut: 0 });
    run = (await budget(taskId)).body.runs[0]!;
    expect(run).toMatchObject({ tokens: 1700, source: "records", recordTokens: 1700 });

    await rig.postUsage({ eventId: "FAKE-c1", runId, accounting: "cumulative", tokensIn: 2000, tokensOut: 0 });
    run = (await budget(taskId)).body.runs[0]!;
    expect(run).toMatchObject({ tokens: 2000, source: "records", recordTokens: 2000, recordCount: 4 });
  });

  it("measured cost: a provider costUsd past the cost cap is an overrun labelled measured", async () => {
    rig = await bootRig({ budget: { maxCostUsd: 1 } });
    const { taskId, runId } = await composedRun();
    expect((await rig.postUsage({ eventId: "FAKE-m1", runId, accounting: "cumulative", tokensIn: 2000, tokensOut: 500, costUsd: 1.5 })).status).toBe(201);
    const b = (await budget(taskId)).body;
    expect(b.consumed).toMatchObject({ costUsd: 1.5, costMethod: "measured", unknownCostSessions: 0 });
    expect(b.runs[0]!.cost).toEqual({ method: "measured", usd: 1.5 });
    expect(b.remaining).toEqual({ max_cost_usd: -0.5 });
    expect(b.overruns).toEqual([expect.objectContaining({ cap: "max_cost_usd", capValue: 1, settled: 1.5, amount: 0.5, method: "measured", source: "late" })]);
  });

  it("a run with no revision has no caps to overrun", async () => {
    rig = await bootRig({ budget: { maxTokens: 10 } });
    // No repository: the start cannot carry a revision and runs route-only.
    const taskId = rig.built.tasks.create({ goal: "Summarise the release notes" }).taskId;
    const res = await rig.built.app.inject({ method: "POST", url: `/api/tasks/${taskId}/start`, headers: rig.auth(), payload: {} });
    const runId = (res.json() as { runId: string }).runId;
    expect(await rig.built.orchestrator.waitForSettled(taskId)).toBe("COMPLETED");
    expect((await rig.postUsage({ eventId: "FAKE-n1", runId, accounting: "cumulative", tokensIn: 9_000, tokensOut: 0 })).status).toBe(201);
    expect(overrunEvents()).toEqual([]);
    // It still counts toward the task.
    expect((await budget(taskId)).body).toMatchObject({ consumed: { tokens: 9000 }, remaining: { max_tokens: -8990 }, exhausted: ["max_tokens"], latestRevision: null });
  });
});
