/** Cockpit imports have no runId and use environment names, not plane assistant ids. */
import { afterEach, describe, expect, it } from "vitest";
import { UsageLedger } from "../src/modules/usage.js";
import { bootRig, type Rig } from "./helpers/composer-cockpit.js";

let rig: Rig | undefined;
afterEach(async () => { await rig?.close(); rig = undefined; });

async function run() {
  const taskId = rig!.built.tasks.create({ goal: "Add a typed helper", repoPath: rig!.repo }).taskId;
  const response = await rig!.built.app.inject({ method: "POST", url: `/api/tasks/${taskId}/start`, headers: rig!.auth(), payload: {} });
  expect(response.statusCode, response.body).toBe(200);
  expect(await rig!.built.orchestrator.waitForSettled(taskId)).toBe("COMPLETED");
  const runId = (response.json() as { runId: string }).runId;
  const row = rig!.db.prepare("SELECT provider_session_ref FROM runs WHERE id = ?").get(runId) as { provider_session_ref: string };
  return { taskId, runId, sessionRef: row.provider_session_ref };
}

function observation(sessionRef: string | null, overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: "1.0", eventId: "FAKE-message-1", runId: null, provider: "fake", sessionRef,
    source: "cockpit-import", assistantId: "claude", model: "fake-model", accounting: "delta",
    tokensIn: 4000, tokensOut: 2000, cachedTokens: 9000, costUsd: null, apiEquivalentUsd: 0.2,
    pricingVersion: "FAKE-prices", observedAt: "2026-10-30T00:00:00.000Z", ...overrides,
  };
}

const post = (body: object) => rig!.built.app.inject({ method: "POST", url: "/api/usage/records", headers: rig!.usageAuth(), payload: body });
async function budget(taskId: string) {
  const res = await rig!.built.app.inject({ method: "GET", url: `/api/tasks/${taskId}/composition/budget`, headers: rig!.auth() });
  expect(res.statusCode).toBe(200);
  return res.json() as {
    consumed: { tokens: number; recordCount: number }; remaining: { max_tokens: number };
    runs: Array<{ tokens: number; source: string; recordCount: number; inRunTokens: number }>;
    overruns: Array<{ amount: number; source: string }>;
  };
}

describe("provider-session attribution of immutable imports", () => {
  it("counts an import once, raises a late overrun, and preserves replay/conflict bodies", async () => {
    rig = await bootRig({ budget: { maxTokens: 5000 } });
    const { taskId, runId, sessionRef } = await run();
    const body = observation(sessionRef);
    const first = await post(body);
    expect(first.statusCode).toBe(201);
    expect(first.json()).toMatchObject({ record: { runId: null, assistantId: "claude" } });
    expect(await budget(taskId)).toMatchObject({
      consumed: { tokens: 6000, recordCount: 1 }, remaining: { max_tokens: -1000 },
      runs: [{ tokens: 6000, source: "records", inRunTokens: 1650, recordCount: 1 }],
      overruns: [{ amount: 1000, source: "late" }],
    });
    const replay = await post(body);
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toEqual({ replayed: true, record: first.json().record });
    expect((await post({ ...body, tokensIn: 4001 })).statusCode).toBe(409);
    expect((await budget(taskId)).overruns).toHaveLength(1);
    expect(rig.db.prepare("SELECT run_id FROM usage_records").get()).toEqual({ run_id: null });
    expect(new UsageLedger(rig.db).runIdFor({ runId: null, provider: "fake", sessionRef })).toBe(runId);
    expect(rig.built.tasks.get(taskId)!.state).toBe("COMPLETED");
  });

  it("keeps the larger in-run total instead of adding an overlapping import", async () => {
    rig = await bootRig({ budget: { maxTokens: 5000 } });
    const { taskId, sessionRef } = await run();
    expect((await post(observation(sessionRef, { tokensIn: 100, tokensOut: 10 }))).statusCode).toBe(201);
    expect(await budget(taskId)).toMatchObject({ consumed: { tokens: 1650, recordCount: 1 }, runs: [{ source: "in_run" }] });
  });

  it("does not infer across providers, missing sessions, or external sessions", async () => {
    rig = await bootRig({ budget: { maxTokens: 5000 } });
    const { taskId, sessionRef } = await run();
    for (const body of [observation(sessionRef, { provider: "anthropic" }), observation(null), observation("FAKE-external")]) {
      expect((await post(body)).statusCode).toBe(201);
    }
    expect(await budget(taskId)).toMatchObject({ consumed: { tokens: 1650, recordCount: 0 }, overruns: [] });
  });

  it("leaves shared provider sessions unattributed, while explicit runIds still work", async () => {
    rig = await bootRig({ budget: { maxTokens: 5000 } });
    const a = await run();
    const b = await run();
    rig.db.prepare("UPDATE runs SET provider_session_ref = ? WHERE id = ?").run(a.sessionRef, b.runId);
    expect((await post(observation(a.sessionRef))).statusCode).toBe(201);
    for (const taskId of [a.taskId, b.taskId]) {
      expect(await budget(taskId)).toMatchObject({ consumed: { tokens: 1650, recordCount: 0 }, overruns: [] });
    }
    expect((await post(observation(a.sessionRef, { eventId: "FAKE-explicit", runId: b.runId }))).statusCode).toBe(201);
    expect(await budget(a.taskId)).toMatchObject({ consumed: { tokens: 1650, recordCount: 0 } });
    expect(await budget(b.taskId)).toMatchObject({ consumed: { tokens: 6000, recordCount: 1 } });
  });

  it("finds an earlier import once provider identity is recorded without rewriting or redelivery", async () => {
    rig = await bootRig({ budget: { maxTokens: 5000 } });
    const body = observation("FAKE-delayed-identity");
    expect((await post(body)).statusCode).toBe(201);
    const { taskId, runId } = await run();
    expect((await budget(taskId)).consumed.recordCount).toBe(0);
    rig.db.prepare("UPDATE runs SET provider_session_ref = ? WHERE id = ?").run(body.sessionRef, runId);
    expect(await budget(taskId)).toMatchObject({ consumed: { tokens: 6000, recordCount: 1 } });
    expect((await post(body)).statusCode).toBe(200);
    expect(rig.db.prepare("SELECT COUNT(*) AS n FROM usage_records").get()).toEqual({ n: 1 });
  });
});
