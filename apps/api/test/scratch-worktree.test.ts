/**
 * M16 K19k — a task with no repository runs in a kernel-owned scratch
 * directory, and the tool gate treats that directory as its worktree. The
 * path-outside floor itself is unchanged: anything outside scratch still hits it.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AssistantId } from "@agent-plane/core";
import { loadConfig, type ResolvedConfig } from "../src/config.js";
import { openDb, type Db } from "../src/db/index.js";
import { buildServer, type BuiltServer } from "../src/server.js";

const A = "fake-a" as AssistantId;
let home: string;
let config: ResolvedConfig;
let db: Db;
let built: BuiltServer;

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), "k19k-"));
  config = loadConfig({ AGENT_PLANE_HOME: home });
  config.assistants = { [A]: { provider: "fake" } };
  config.execution.harnessModes.single = true;
  db = openDb(config.dbPath);
  built = buildServer({ config, db });
  built.registry.init();
  await built.registry.syncAll();
});

afterEach(async () => {
  await built.app.close();
  db.close();
  rmSync(home, { recursive: true, force: true });
});

function settled(id: string): Promise<string> {
  const done = ["COMPLETED", "FAILED", "CANCELLED", "WAITING_INPUT"];
  return new Promise((resolve) => {
    const current = built.tasks.get(id)?.state;
    if (current && done.includes(current)) return resolve(current);
    const off = built.bus.subscribe(id, (p) => {
      if (p.kind === "state" && done.includes(p.state!.state)) {
        off();
        resolve(p.state!.state);
      }
    });
  });
}

async function run(goal: string): Promise<string> {
  const { taskId } = built.tasks.create({ goal, overrides: { assistantId: A } });
  built.tasks.transition(taskId, "ROUTING");
  await built.orchestrator.startTask(taskId, A);
  expect(await settled(taskId)).toBe("COMPLETED");
  await new Promise((r) => setImmediate(r)); // the terminal hook runs on a microtask
  return taskId;
}

const scratchOf = (taskId: string) => join(config.dir, "scratch", taskId);

describe("K19k — scratch directory for a task with no repository", () => {
  it("runs in its own scratch directory, which the gate treats as the worktree, and removes it when terminal", async () => {
    const outside = join(homedir(), "notes.md");
    const taskId = await run(`look [FAKE:READ:{cwd}/notes.md] [FAKE:READ:${outside}] [FAKE:READ:{cwd}/../../agent-plane.db]`);

    // The fake expands `{cwd}` from the workdir it was launched in.
    const reads = db.prepare("SELECT summary FROM events WHERE type = 'tool.started' AND summary LIKE 'Read %' ORDER BY id").all() as Array<{ summary: string }>;
    expect(reads[0]!.summary).toBe(`Read ${scratchOf(taskId)}/notes.md`);

    const rows = db
      .prepare("SELECT gate_outcome, gate_reason FROM decision_records WHERE task_id = ? AND site = 'tool-gate' AND mode = 'shadow' ORDER BY id")
      .all(taskId) as Array<{ gate_outcome: string; gate_reason: string }>;
    // Default script's `ls src`, then the three reads, one post-start row each.
    expect(rows.map((r) => r.gate_outcome)).toEqual(["auto-approve", "auto-approve", "prompt", "prompt"]);
    expect(rows[2]!.gate_reason).toMatch(/path-outside-worktree/);
    expect(rows[3]!.gate_reason).toMatch(/path-outside-worktree/); // `..` out to the DB still prompts

    expect(existsSync(scratchOf(taskId))).toBe(false);
  });

  it("creates the scratch directory owner-only", async () => {
    const { taskId } = built.tasks.create({ goal: "g", overrides: { assistantId: A } });
    built.tasks.transition(taskId, "ROUTING");
    await built.orchestrator.startTask(taskId, A);
    expect(statSync(scratchOf(taskId)).mode & 0o777).toBe(0o700);
    await settled(taskId);
  });

  it("boot sweeps scratch left by terminal or unknown tasks and keeps a live task's", async () => {
    const live = built.tasks.create({ goal: "live" }).taskId;
    const done = built.tasks.create({ goal: "done" }).taskId;
    built.tasks.transition(done, "CANCELLED");
    await new Promise((r) => setImmediate(r));
    for (const id of [live, done, "AG-gone"]) mkdirSync(scratchOf(id), { recursive: true });

    await built.orchestrator.reconcileOnBoot();

    expect(existsSync(scratchOf(live))).toBe(true);
    expect(existsSync(scratchOf(done))).toBe(false);
    expect(existsSync(scratchOf("AG-gone"))).toBe(false);
  });
});
