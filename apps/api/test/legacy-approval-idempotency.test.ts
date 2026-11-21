/**
 * Approve-once on the legacy (non-Harness) path (milestone B1). The Harness path is idempotent
 * through its durable approval row; a legacy run keeps its pending approval inside the adapter,
 * so before this fix a repeated identical answer (a double tap, a second tab, a retry after a
 * dropped response) reached the adapter a second time and came back 409. Driven through the real
 * `POST /api/tasks/:id/input` route.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AssistantId } from "@agent-plane/core";
import { loadConfig } from "../src/config.js";
import { openDb, type Db } from "../src/db/index.js";
import { buildServer, type BuiltServer } from "../src/server.js";
import { credentialPath, readCredential } from "../src/auth/credential-file.js";

const A = "fake-a" as AssistantId;
let home: string;
let db: Db;
let built: BuiltServer;

afterEach(async () => {
  await built.orchestrator.shutdown();
  await built.app.close();
  db.close();
  rmSync(home, { recursive: true, force: true });
});

async function bootLegacy() {
  home = mkdtempSync(join(tmpdir(), "legacy-approval-"));
  const config = loadConfig({ AGENT_PLANE_HOME: home });
  config.assistants = { [A]: { provider: "fake" } } as typeof config.assistants;
  config.policy.approvalMode = "prompt-on-escalation";
  expect(config.execution.harnessModes.single).toBeFalsy(); // the legacy path is what is under test
  db = openDb(config.dbPath);
  built = buildServer({ config, db });
  built.registry.init();
  await built.registry.syncAll();
  const headers = { authorization: `Bearer ${readCredential(credentialPath(config.dir)).secrets[0]!.secret}` };
  const created = await built.app.inject({ method: "POST", url: "/api/tasks", headers, payload: { goal: "sign-off [FAKE:APPROVAL]" } });
  const taskId = created.json().taskId as string;
  await built.app.inject({ method: "POST", url: `/api/tasks/${taskId}/start`, headers, payload: { assistantId: A } });
  const runRow = () => db.prepare("SELECT execution_request_id FROM runs WHERE task_id = ?").get(taskId) as { execution_request_id: string | null } | undefined;
  await expect.poll(() => runRow()).toBeTruthy();
  expect(runRow()!.execution_request_id).toBeNull(); // a legacy run, not a Harness session
  const requested = () => (db.prepare(
    "SELECT e.payload FROM events e JOIN runs r ON r.id = e.run_id WHERE r.task_id = ? AND e.type = 'approval.requested'",
  ).get(taskId) as { payload: string } | undefined)?.payload;
  await expect.poll(requested).toBeTruthy();
  const requestId = (JSON.parse(requested()!) as { requestId: string }).requestId;
  const answer = (approved: boolean) =>
    built.app.inject({ method: "POST", url: `/api/tasks/${taskId}/input`, headers, payload: { kind: "approval", requestId, approved } });
  return { taskId, answer };
}

describe("legacy approval answers are idempotent", () => {
  it("delivers concurrent identical answers once and reports success to both", async () => {
    const { taskId, answer } = await bootLegacy();
    const [first, second] = await Promise.all([answer(true), answer(true)]);
    expect([first.statusCode, second.statusCode]).toEqual([200, 200]);
    expect(await built.orchestrator.waitForSettled(taskId)).toBe("COMPLETED");
    const ended = db.prepare(
      "SELECT COUNT(*) AS n FROM events e JOIN runs r ON r.id = e.run_id WHERE r.task_id = ? AND e.type = 'run.ended'",
    ).get(taskId) as { n: number };
    expect(ended.n).toBe(1);
  });

  it("refuses a conflicting answer with a 409 that names the first decision", async () => {
    const { taskId, answer } = await bootLegacy();
    // Sent together, so the second lands while the run is still live: only the ledger can refuse it.
    const [first, conflict] = await Promise.all([answer(true), answer(false)]);
    expect(first.statusCode).toBe(200);
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().error).toMatch(/already approved; a denied answer conflicts/);
    expect(await built.orchestrator.waitForSettled(taskId)).toBe("COMPLETED");
  });
});
