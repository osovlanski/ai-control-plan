/**
 * API 2.17: `GET /api/tasks/:id` under `tasks.read` serves `stage`, `pendingApprovals`,
 * `verification` and `webLink`, so the MCP `get_task` projects them instead of guessing.
 * Fake assistants only; secrets are minted by the code under test.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { credentialPath, readCredential, rotateNamedCredential } from "../src/auth/credential-file.js";
import { loadConfig, type ResolvedConfig } from "../src/config.js";
import { openDb, type Db } from "../src/db/index.js";
import { buildServer, type BuiltServer } from "../src/server.js";
import { reaches } from "./helpers/composer-cockpit.js";

const ORIGIN = "https://aos.example-tailnet.ts.net";

let home: string | undefined;
let db: Db | undefined;
let built: BuiltServer | undefined;
let config: ResolvedConfig;
afterEach(async () => {
  await built?.orchestrator.shutdown();
  await built?.app.close();
  db?.close();
  if (home) rmSync(home, { recursive: true, force: true });
  home = db = built = narrowSecret = undefined;
});

async function boot(opts: { harness: boolean; webOrigin?: boolean }): Promise<BuiltServer> {
  home = mkdtempSync(join(tmpdir(), "agent-plane-outcome-"));
  config = loadConfig({ AGENT_PLANE_HOME: home });
  config.assistants = { "fake-a": { provider: "fake" } };
  config.policy.approvalMode = "prompt-on-escalation";
  config.execution.harnessModes.single = opts.harness;
  config.mcp = { repos: {}, ...(opts.webOrigin === false ? {} : { webOrigin: ORIGIN }) };
  db = openDb(config.dbPath);
  built = buildServer({ config, db });
  built.registry.init();
  await built.registry.syncAll();
  await built.app.ready();
  return built;
}

const main = () => ({ authorization: `Bearer ${readCredential(credentialPath(config.dir)).secrets.at(-1)!.secret}` });
/** The narrow MCP credential: tasks.read, tasks.create, tasks.start only. */
let narrowSecret: string | undefined;
const narrow = () => ({ authorization: `Bearer ${(narrowSecret ??= rotateNamedCredential(config.dir, "mcp", 0).secret)}` });

async function detail(taskId: string, headers: Record<string, string>): Promise<Record<string, unknown>> {
  const res = await built!.app.inject({ method: "GET", url: `/api/tasks/${taskId}`, headers });
  expect(res.statusCode).toBe(200);
  return res.json() as Record<string, unknown>;
}

async function until<T>(read: () => Promise<T> | T, ok: (v: T) => boolean, ms = 5_000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = await read();
    if (ok(v)) return v;
    if (Date.now() - start > ms) throw new Error(`timed out; last ${JSON.stringify(v)}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

const start = async (taskId: string) =>
  expect((await built!.app.inject({ method: "POST", url: `/api/tasks/${taskId}/start`, headers: main(), payload: { assistantId: "fake-a" } })).statusCode).toBe(200);

describe("task read, API 2.17", () => {
  it("a new task: stage queued, no approvals, no verification, the Web link", async () => {
    await boot({ harness: true });
    const taskId = built!.tasks.create({ goal: "fresh" }).taskId;
    const t = await detail(taskId, narrow());
    expect(t).toMatchObject({
      stage: { value: "queued", rule: "no-run" },
      pendingApprovals: 0,
      verification: null,
      webLink: `${ORIGIN}/#/missions/${taskId}`,
    });
  });

  it("leaves webLink out when no Web origin is configured", async () => {
    await boot({ harness: true, webOrigin: false });
    const taskId = built!.tasks.create({ goal: "no origin" }).taskId;
    const t = await detail(taskId, main());
    expect(t).not.toHaveProperty("webLink");
    expect(t.pendingApprovals).toBe(0);
  });

  it("a Harness approval counts 1 to the narrow credential while pending, 0 once answered; verification then completes", async () => {
    await boot({ harness: true });
    const taskId = built!.tasks.create({ goal: "needs sign-off [FAKE:APPROVAL]" }).taskId;
    await start(taskId);
    const waiting = await until(() => detail(taskId, narrow()), (t) => t.pendingApprovals === 1);
    expect(waiting.stage).toEqual({ value: "needs-you", rule: "awaiting-approval" });
    const requestId = (db!.prepare("SELECT a.provider_request_id AS id FROM approvals a JOIN runs r ON r.id = a.session_id WHERE r.task_id = ?").get(taskId) as { id: string }).id;
    const done = reaches(built!, taskId, ["COMPLETED", "FAILED"]);
    await built!.orchestrator.respondApproval(taskId, requestId, true);
    expect(await done).toBe("COMPLETED");
    const t = await until(() => detail(taskId, narrow()), (x) => (x.stage as { value: string }).value === "done");
    expect(t.pendingApprovals).toBe(0);
    const session = db!.prepare("SELECT id FROM runs WHERE task_id = ? AND execution_request_id IS NOT NULL").get(taskId) as { id: string };
    const stored = db!.prepare("SELECT id, state, evaluation FROM verification_runs WHERE session_id = ?").get(session.id) as { id: string; state: string; evaluation: string };
    const evaluation = JSON.parse(stored.evaluation) as { passed: boolean; checks: unknown[] };
    expect(t.verification).toEqual({
      sessionId: session.id, verificationRunId: stored.id, runState: "completed", passed: evaluation.passed,
      checks: { passed: evaluation.checks.length, failed: 0, skipped: 0, blocked: 0 },
    });
  });

  it("a legacy run waiting on approval counts 1 and has no verification", async () => {
    await boot({ harness: false });
    const taskId = built!.tasks.create({ goal: "legacy sign-off [FAKE:APPROVAL]" }).taskId;
    await start(taskId);
    const t = await until(() => detail(taskId, narrow()), (x) => x.pendingApprovals === 1);
    expect(t.stage).toEqual({ value: "needs-you", rule: "awaiting-approval" });
    expect(t.verification).toBeNull();
    const run = db!.prepare("SELECT id FROM runs WHERE task_id = ?").get(taskId) as { id: string };
    const requestId = (JSON.parse((db!.prepare("SELECT payload FROM events WHERE run_id = ? AND type = 'approval.requested'").get(run.id) as { payload: string }).payload) as { requestId: string }).requestId;
    const done = reaches(built!, taskId, ["COMPLETED", "FAILED"]);
    await built!.orchestrator.respondApproval(taskId, requestId, true);
    expect(await done).toBe("COMPLETED");
    expect((await detail(taskId, narrow())).pendingApprovals).toBe(0);
  });

  it("counts checks by status, keeps the stored verdict, and reads a malformed evaluation as zero counts", async () => {
    await boot({ harness: true });
    const taskId = built!.tasks.create({ goal: "verify me" }).taskId;
    const done = reaches(built!, taskId, ["COMPLETED", "FAILED"]);
    await start(taskId);
    await done;
    await until(() => detail(taskId, main()), (x) => (x.verification as { runState?: string } | null)?.runState === "completed");
    const evaluation = {
      passed: false,
      checks: [
        { name: "a", kind: "test", required: true, summary: "ok", status: "passed", passed: true },
        { name: "b", kind: "test", required: true, summary: "no", status: "failed", passed: false },
        { name: "c", kind: "lint", required: false, summary: "skip", status: "skipped", passed: false },
        { name: "d", kind: "build", required: true, summary: "deps", status: "blocked", passed: false },
        { name: "e", kind: "test", required: true, summary: "legacy", passed: true },
      ],
    };
    db!.prepare("UPDATE verification_runs SET evaluation = ? WHERE session_id IN (SELECT id FROM runs WHERE task_id = ?)").run(JSON.stringify(evaluation), taskId);
    expect((await detail(taskId, narrow())).verification).toMatchObject({
      runState: "completed", passed: false, checks: { passed: 2, failed: 1, skipped: 1, blocked: 1 },
    });
    db!.prepare("UPDATE verification_runs SET evaluation = '{\"unexpected\":true}' WHERE session_id IN (SELECT id FROM runs WHERE task_id = ?)").run(taskId);
    expect((await detail(taskId, narrow())).verification).toMatchObject({
      runState: "completed", passed: null, checks: { passed: 0, failed: 0, skipped: 0, blocked: 0 },
    });
  });

  it("is additive: every pre-2.17 field is still served", async () => {
    await boot({ harness: false });
    const taskId = built!.tasks.create({ goal: "old client" }).taskId;
    const t = await detail(taskId, main());
    for (const k of ["id", "goal", "state", "envelope", "runs", "active", "resourceWait", "resourceClaim", "dispatches", "schedulerEvents", "schedulerEnabled", "intent"]) {
      expect(t).toHaveProperty(k);
    }
  });
});
