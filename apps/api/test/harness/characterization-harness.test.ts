/**
 * Phase 8d — the flag-ON mirror of characterization.test.ts (PLAN.md 8d).
 *
 * Same task-level contracts (start→COMPLETED, denied approval→FAILED with no
 * failover, hard limit→failover→COMPLETED) driven through the real
 * `SessionRunner` with `execution.harnessModes.single` ON. Run-row assertions read
 * `session_state`. The four byte-frozen safety-net files are untouched.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AssistantId } from "@agent-plane/core";
import { loadConfig, type ResolvedConfig } from "../../src/config.js";
import { openDb, type Db } from "../../src/db/index.js";
import { buildServer, type BuiltServer } from "../../src/server.js";
import type { TaskStreamPayload } from "../../src/modules/sse.js";

let home: string;
let db: Db;
let config: ResolvedConfig;
let built: BuiltServer;

const A = "fake-a" as AssistantId;
const B = "fake-b" as AssistantId;

async function boot(extra = ""): Promise<void> {
  home = mkdtempSync(join(tmpdir(), "agent-plane-charh-"));
  mkdirSync(join(home, "personal"), { recursive: true });
  writeFileSync(
    join(home, "personal", "config.yaml"),
    `assistants:\n  fake-a:\n    provider: fake\n  fake-b:\n    provider: fake\nexecution:\n  harnessModes:\n    single: true\n${extra}`,
  );
  config = loadConfig({ AGENT_PLANE_HOME: home });
  db = openDb(config.dbPath);
  built = buildServer({ config, db });
  built.registry.init();
  await built.registry.syncAll();
}

beforeEach(() => boot());
afterEach(async () => {
  await built.orchestrator.shutdown();
  await built.app.close();
  db.close();
  rmSync(home, { recursive: true, force: true });
});

const run = async (goal: string) => {
  const env = built.tasks.create({ goal });
  built.tasks.transition(env.taskId, "ROUTING");
  const frames: TaskStreamPayload[] = [];
  built.bus.subscribe(env.taskId, (p) => frames.push(p));
  await built.orchestrator.startTask(env.taskId, A);
  return { taskId: env.taskId, frames };
};

const sessionRows = (taskId: string) =>
  db
    .prepare("SELECT assistant_id, session_state FROM runs WHERE task_id = ? ORDER BY started_at, rowid")
    .all(taskId) as Array<{ assistant_id: string; session_state: string }>;

const awaitApprovalId = async (frames: TaskStreamPayload[]) => {
  const start = Date.now();
  for (;;) {
    const f = frames.find((x) => x.kind === "event" && x.event!.type === "approval.requested");
    const id = (f?.event!.payload as { requestId?: string } | undefined)?.requestId;
    if (id) return id;
    if (Date.now() - start > 5000) throw new Error("no approval.requested frame");
    await new Promise((r) => setTimeout(r, 10));
  }
};

describe("characterization (flag ON)", () => {
  it("start → COMPLETED, one COMPLETED session row on A", async () => {
    const { taskId } = await run("do it");
    expect(await built.orchestrator.waitForSettled(taskId)).toBe("COMPLETED");
    expect(sessionRows(taskId)).toEqual([{ assistant_id: A, session_state: "COMPLETED" }]);
  });

  it("denied approval → FAILED, no failover (single session on A)", async () => {
    // auto-approve (the workspace default) never raises approval.requested —
    // this test is specifically about the relay path, so it needs it.
    await built.orchestrator.shutdown();
    await built.app.close();
    db.close();
    rmSync(home, { recursive: true, force: true });
    await boot("policy:\n  approvalMode: prompt-on-escalation\n");
    const { taskId, frames } = await run("sign off [FAKE:APPROVAL]");
    await built.orchestrator.respondApproval(taskId, await awaitApprovalId(frames), false);
    expect(await built.orchestrator.waitForSettled(taskId)).toBe("FAILED");
    expect(sessionRows(taskId)).toEqual([{ assistant_id: A, session_state: "FAILED" }]);
  });

  it("hard limit → failover → COMPLETED, handoffs.trigger='quota', exactly two sessions A then B", async () => {
    const { taskId } = await run("big one [FAKE:LIMIT]");
    expect(await built.orchestrator.waitForSettled(taskId)).toBe("COMPLETED");
    const rows = sessionRows(taskId);
    expect(rows.map((r) => r.assistant_id)).toEqual([A, B]);
    expect(rows[0]!.session_state).toBe("YIELDED");
    expect(rows[1]!.session_state).toBe("COMPLETED");
    expect(db.prepare("SELECT trigger FROM handoffs WHERE task_id = ?").get(taskId)).toMatchObject({
      trigger: "quota",
    });
  });
});
