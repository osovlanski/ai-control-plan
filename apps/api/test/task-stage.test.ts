/**
 * Task stage v1 (docs/contracts/task-stage-v1.md, API 2.9): `stage` on `GET /api/tasks` and on
 * every SSE `state` frame, derived once by core `deriveStage`. Fake assistants only; no secrets.
 */
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import { afterEach, describe, expect, it } from "vitest";
import type { TaskStage } from "@agent-plane/core";
import { credentialPath, readCredential } from "../src/auth/credential-file.js";
import { loadConfig } from "../src/config.js";
import { openDb, type Db } from "../src/db/index.js";
import { buildServer, type BuiltServer } from "../src/server.js";
import { TaskEventBus } from "../src/modules/sse.js";
import { reaches } from "./helpers/composer-cockpit.js";

const CONTRACT = join(import.meta.dirname, "../../../contracts/task-stage/v1");

let home: string | undefined;
let db: Db | undefined;
let built: BuiltServer | undefined;
afterEach(async () => {
  await built?.orchestrator.shutdown();
  await built?.app.close();
  db?.close();
  if (home) rmSync(home, { recursive: true, force: true });
  home = db = built = undefined;
});

async function boot(harness: boolean): Promise<{ built: BuiltServer; headers: { authorization: string } }> {
  home = mkdtempSync(join(tmpdir(), "agent-plane-stage-"));
  mkdirSync(join(home, "personal"), { recursive: true });
  writeFileSync(
    join(home, "personal", "config.yaml"),
    [
      "assistants:",
      "  fake-a:",
      "    provider: fake",
      "policy:",
      "  approvalMode: prompt-on-escalation",
      "execution:",
      "  harnessModes:",
      `    single: ${harness}`,
      "",
    ].join("\n"),
  );
  const config = loadConfig({ AGENT_PLANE_HOME: home });
  db = openDb(config.dbPath);
  built = buildServer({ config, db });
  built.registry.init();
  await built.registry.syncAll();
  return { built, headers: { authorization: `Bearer ${readCredential(credentialPath(config.dir)).secrets[0]!.secret}` } };
}

const key = (s: TaskStage | undefined) => (s ? `${s.value}/${s.rule}` : "none");

/** Records the stage on every state frame for one task, deduped in order. */
function stagesOn(b: BuiltServer, taskId: string): string[] {
  const seen: string[] = [];
  b.bus.subscribe(taskId, (p) => {
    if (p.kind !== "state") return;
    const k = key(p.state?.stage);
    if (seen.at(-1) !== k) seen.push(k);
  });
  return seen;
}

async function listStage(b: BuiltServer, headers: { authorization: string }, taskId: string): Promise<Record<string, unknown>> {
  const res = await b.app.inject({ method: "GET", url: "/api/tasks", headers });
  expect(res.statusCode).toBe(200);
  return (res.json() as Array<Record<string, unknown>>).find((t) => t.id === taskId)!;
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

describe("task stage v1 contract", () => {
  it("its fixtures pass and fail the schema as named, one valid fixture per rule", () => {
    const ajv = new Ajv2020({ strict: true, allErrors: true });
    const validate = ajv.compile(JSON.parse(readFileSync(join(CONTRACT, "task-stage.schema.json"), "utf8")));
    for (const kind of ["valid", "invalid"] as const) {
      for (const name of readdirSync(join(CONTRACT, "fixtures", kind))) {
        const body = JSON.parse(readFileSync(join(CONTRACT, "fixtures", kind, name), "utf8"));
        expect([name, validate(body)]).toEqual([name, kind === "valid"]);
      }
    }
    expect(readdirSync(join(CONTRACT, "fixtures", "valid"))).toHaveLength(10);
  });
});

describe("stage on the task list and the SSE state frame", () => {
  it("drives a Harness task queued → working → verifying → done, on the list and on the bus", async () => {
    const { built: b, headers } = await boot(true);
    const created = await b.app.inject({ method: "POST", url: "/api/tasks", headers, payload: { goal: "stage drive" } });
    const taskId = (created.json() as { taskId: string }).taskId;
    expect((await listStage(b, headers, taskId)).stage).toEqual({ value: "queued", rule: "no-run" });

    const seen = stagesOn(b, taskId);
    const done = reaches(b, taskId, ["COMPLETED", "FAILED", "WAITING_INPUT"]);
    expect((await b.app.inject({ method: "POST", url: `/api/tasks/${taskId}/start`, headers, payload: { assistantId: "fake-a" } })).statusCode).toBe(200);
    expect(await done).toBe("COMPLETED");
    await until(() => seen.at(-1), (s) => s === "done/terminal");
    expect(seen).toContain("working/live-run");
    expect(seen).toContain("verifying/verification-running");
    expect(seen.indexOf("working/live-run")).toBeLessThan(seen.indexOf("verifying/verification-running"));
    expect((await listStage(b, headers, taskId)).stage).toEqual({ value: "done", rule: "terminal" });
  });

  it("shows needs-you while a Harness session awaits approval, then leaves it once answered", async () => {
    const { built: b, headers } = await boot(true);
    const taskId = b.tasks.create({ goal: "needs sign-off [FAKE:APPROVAL]" }).taskId;
    const seen = stagesOn(b, taskId);
    expect((await b.app.inject({ method: "POST", url: `/api/tasks/${taskId}/start`, headers, payload: { assistantId: "fake-a" } })).statusCode).toBe(200);
    const row = await until(() => listStage(b, headers, taskId), (t) => key(t.stage as TaskStage) === "needs-you/awaiting-approval");
    expect(row.state).toBe("RUNNING"); // the task state is unchanged; only the stage says why it waits
    expect(seen).toContain("needs-you/awaiting-approval");
    const requestId = await until(
      () => (db!.prepare("SELECT a.provider_request_id AS id FROM approvals a JOIN runs r ON r.id = a.session_id WHERE r.task_id = ?").get(taskId) as { id?: string } | undefined)?.id,
      (id) => !!id,
    );
    const done = reaches(b, taskId, ["COMPLETED", "FAILED"]);
    await b.orchestrator.respondApproval(taskId, requestId!, true);
    expect(await done).toBe("COMPLETED");
    await until(() => seen.at(-1), (s) => s === "done/terminal");
    expect(seen.indexOf("needs-you/awaiting-approval")).toBeLessThan(seen.lastIndexOf("working/live-run"));
  });

  it("queues a task behind a wait condition", async () => {
    const { built: b, headers } = await boot(false);
    const res = await b.app.inject({
      method: "POST", url: "/api/tasks", headers,
      payload: { goal: "later", wait: { kind: "time", notBefore: "2099-01-01T00:00:00.000Z" } },
    });
    expect(res.statusCode).toBe(201);
    const t = await listStage(b, headers, (res.json() as { taskId: string }).taskId);
    expect([t.state, t.stage]).toEqual(["WAITING_RESOURCE", { value: "queued", rule: "wait-condition" }]);
  });

  it("is additive: every field a 2.8 client reads is still there, unchanged", async () => {
    const { built: b, headers } = await boot(false);
    const taskId = b.tasks.create({ goal: "old client" }).taskId;
    const t = await listStage(b, headers, taskId);
    expect(Object.keys(t).sort()).toEqual(
      ["createdAt", "goal", "id", "phase", "profile", "repoPath", "schedulerEnabled", "stage", "state", "updatedAt"].sort(),
    );
    const { stage: _stage, ...pre29 } = t;
    expect(pre29).toMatchObject({ id: taskId, goal: "old client", state: "CREATED", phase: null });
  });

  it("stamps the stream's opening state frame", async () => {
    const { built: b, headers } = await boot(false);
    const taskId = b.tasks.create({ goal: "stream" }).taskId;
    await b.app.listen({ port: 0, host: "127.0.0.1" });
    const { port } = b.app.server.address() as AddressInfo;
    const ac = new AbortController();
    const res = await fetch(`http://127.0.0.1:${port}/api/tasks/${taskId}/events/stream`, { headers, signal: ac.signal });
    const reader = res.body!.getReader();
    let text = "";
    while (!text.includes("\n\n")) text += new TextDecoder().decode((await reader.read()).value);
    ac.abort();
    const frame = JSON.parse(text.split("\n").find((l) => l.startsWith("data:"))!.slice(5));
    expect(frame).toMatchObject({ kind: "state", state: { state: "CREATED", stage: { value: "queued", rule: "no-run" } } });
  });
});

describe("TaskEventBus stage stamping", () => {
  it("stamps state frames only, and publishes a stage-only change once", () => {
    const bus = new TaskEventBus();
    let stage: TaskStage = { value: "working", rule: "live-run" };
    bus.setStageSource(() => stage);
    const frames: unknown[] = [];
    bus.subscribe("t", (p) => frames.push(p));
    bus.publish("t", { kind: "notice", notice: { level: "info", text: "x" } });
    bus.publish("t", { kind: "state", state: { state: "RUNNING" } });
    bus.publishIfStageChanged("t", () => ({ state: "RUNNING" })); // unchanged: nothing
    stage = { value: "needs-you", rule: "awaiting-approval" };
    bus.publishIfStageChanged("t", () => ({ state: "RUNNING" }));
    bus.publishIfStageChanged("t", () => ({ state: "RUNNING" })); // already announced
    expect(frames).toEqual([
      { kind: "notice", notice: { level: "info", text: "x" } },
      { kind: "state", state: { state: "RUNNING", stage: { value: "working", rule: "live-run" } } },
      { kind: "state", state: { state: "RUNNING", stage: { value: "needs-you", rule: "awaiting-approval" } } },
    ]);
  });

  it("a throwing stage source never breaks the publisher", () => {
    const bus = new TaskEventBus();
    bus.setStageSource(() => { throw new Error("bad row"); });
    const frames: unknown[] = [];
    bus.subscribe("t", (p) => frames.push(p));
    expect(() => bus.publish("t", { kind: "state", state: { state: "RUNNING" } })).not.toThrow();
    expect(frames).toEqual([{ kind: "state", state: { state: "RUNNING" } }]);
  });
});
