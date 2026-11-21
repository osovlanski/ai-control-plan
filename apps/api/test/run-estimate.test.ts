/**
 * qcq-01: `GET /api/tasks/:id/estimate` and `GET /api/estimates/accuracy` over real routes, fake
 * assistants and FAKE usage records. Advisory: the estimate routes the task with the router's pure
 * inputs and persists nothing, so a read leaves no routing decision, dispatch or wait behind.
 * The clock runs from Sunday 2026-11-22 10:00 Asia/Jerusalem (working hours).
 */
import { afterEach, describe, expect, it } from "vitest";
import type { AccuracyReport } from "@agent-plane/core";
import type { TaskEstimate } from "../src/modules/run-estimate.js";
import { bootRig, reaches, type Rig } from "./helpers/composer-cockpit.js";

let rig: Rig | undefined;
afterEach(async () => {
  await rig?.close();
  rig = undefined;
});

const SUN_1000 = Date.parse("2026-11-22T08:00:00.000Z");
const ASSISTANTS = { "fake-a": { provider: "fake" }, "fake-b": { provider: "fake" } } as const;

async function boot(configure?: (c: Rig["config"]) => void) {
  const t0 = Date.now();
  rig = await bootRig({ assistants: ASSISTANTS, enabled: false, now: () => new Date(SUN_1000 + (Date.now() - t0)), ...(configure ? { configure } : {}) });
  return rig;
}
const task = (goal: string) => rig!.built.tasks.create({ goal, repoPath: rig!.repo }).taskId;
async function get<T>(url: string, status = 200): Promise<T> {
  const res = await rig!.built.app.inject({ method: "GET", url, headers: rig!.auth() });
  expect(res.statusCode, res.body).toBe(status);
  return res.json() as T;
}
async function completeOne(goal: string, assistantId: string) {
  const id = task(goal);
  const res = await rig!.built.app.inject({ method: "POST", url: `/api/tasks/${id}/start`, headers: rig!.auth(), payload: { assistantId } });
  expect(res.statusCode, res.body).toBe(200);
  expect(await reaches(rig!.built, id, ["COMPLETED", "FAILED", "CANCELLED", "WAITING_INPUT"])).toBe("COMPLETED");
  return { taskId: id, runId: (res.json() as { runId: string }).runId };
}
const writes = () => rig!.db.prepare("SELECT (SELECT COUNT(*) FROM routing_decisions) AS r, (SELECT COUNT(*) FROM dispatches) AS d, (SELECT COUNT(*) FROM wait_conditions) AS w").get();

describe("GET /api/tasks/:id/estimate", () => {
  it("404s an unknown task, needs routing.read, and refuses bad parameters", async () => {
    await boot();
    expect((await rig!.built.app.inject({ method: "GET", url: "/api/tasks/nope/estimate" })).statusCode).toBe(401);
    expect((await rig!.built.app.inject({ method: "GET", url: "/api/tasks/nope/estimate", headers: rig!.usageAuth() })).statusCode).toBe(403);
    await get("/api/tasks/nope/estimate", 404);
    const id = task("Add a typed helper to the parser module");
    await get(`/api/tasks/${id}/estimate?deadline=soon`, 400);
    await get(`/api/tasks/${id}/estimate?approval=maybe`, 400);
    await get(`/api/tasks/${id}/estimate?assistant=nobody`, 400);
    await get(`/api/estimates/accuracy?limit=0`, 400);
  });

  it("missing usage data and no history: unknown confidence, run now, and nothing is written", async () => {
    await boot();
    const id = task("Add a typed helper to the parser module");
    const before = writes();
    const e = await get<TaskEstimate>(`/api/tasks/${id}/estimate`);
    expect(writes()).toEqual(before);
    expect(e).toMatchObject({ taskId: id, advisory: true, policy: { timezone: "Asia/Jerusalem", eveningsAllowed: false, weekendsAllowed: false } });
    expect(e.routing.chosen).toEqual(expect.stringMatching(/^fake-/));
    expect(e.estimate).toMatchObject({ confidence: "unknown", durationMs: { range: null }, tokens: { input: null, output: null }, evidence: { cohort: "none" } });
    expect(e.estimate.spend).toMatchObject({ billing: "none", apiUsd: null, apiEquivalentUsd: null });
    expect(e.recommendation).toMatchObject({ advisory: true, action: "run-now", expectedCompletion: null });
  });

  it("estimates from comparable runs, keeps usage evidence per run, and measures accuracy", async () => {
    await boot();
    const runs = [];
    for (const goal of ["Add a typed helper to the parser", "Add a typed helper to the lexer", "Add a typed helper to the printer"]) runs.push(await completeOne(goal, "fake-a"));
    // FAKE usage for two of the three runs; the third has none beyond what the fake reports in-run.
    for (const [i, r] of runs.slice(0, 2).entries()) {
      const posted = await rig!.postUsage({ eventId: `evt-${i}`, runId: r.runId, accounting: "cumulative", tokensIn: 50_000 + i * 10_000, tokensOut: 5_000, apiEquivalentUsd: 1.5 });
      expect(posted.status).toBe(201);
    }
    const id = task("Add a typed helper to the formatter");
    const e = await get<TaskEstimate>(`/api/tasks/${id}/estimate?assistant=fake-a`);
    expect(e.routing).toMatchObject({ chosen: "fake-a", whatIf: true });
    expect(e.estimate.evidence.sampleSize).toBe(3);
    expect(e.estimate.evidence.runIds.sort()).toEqual(runs.map((r) => r.runId).sort());
    expect(e.estimate.durationMs.range).not.toBeNull();
    expect(e.estimate.tokens.runsWithUsage).toBeGreaterThanOrEqual(2);
    expect(e.estimate.tokens.input!.high).toBeGreaterThanOrEqual(50_000);
    expect(e.estimate.evidence.missing).toContain("effort: not recorded in the execution identity");

    const report = await get<AccuracyReport>("/api/estimates/accuracy");
    expect(report).toMatchObject({ estimatorVersion: "run-estimate/1", runs: 3, noEstimate: 1 });
    expect(report.duration.evaluated).toBe(2);
    expect(report.rows.map((r) => r.runId).sort()).toEqual(runs.map((r) => r.runId).sort());
  });

  it("blocked by a human approval, and due soon, with the workspace's hours", async () => {
    await boot((c) => {
      c.scheduling = { ...c.scheduling!, evening: { ...c.scheduling!.evening, allowed: true } };
    });
    await completeOne("Add a typed helper to the parser", "fake-a");
    const id = task("Add a typed helper to the lexer");
    const blocked = await get<TaskEstimate>(`/api/tasks/${id}/estimate?approval=required`);
    expect(blocked.recommendation).toMatchObject({ action: "wait-for-approval", startAt: null });
    expect(blocked.estimate.approvalWait).toMatchObject({ required: true, pending: 0 });
    const soon = await get<TaskEstimate>(`/api/tasks/${id}/estimate?deadline=2026-11-22T09:00:00Z`);
    expect(soon.recommendation).toMatchObject({ action: "run-now", speedWeight: 1, deadline: "2026-11-22T09:00:00.000Z", meetsDeadline: true });
    expect(soon.recommendation.reasons[0]).toMatch(/^due soon/);
    expect(soon.policy.eveningsAllowed).toBe(true);
  });
});
