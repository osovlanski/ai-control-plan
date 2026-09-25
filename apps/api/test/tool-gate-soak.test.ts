/**
 * The tool gate's shadow-soak check (§7.1(1), (2), (7)): what counts, from when,
 * and when a reading covers it.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DecisionRequest } from "@agent-plane/core";
import { openDb, type Db } from "../src/db/index.js";
import { insertDecisionRecord, toolGateSoakCheck } from "../src/modules/decision.js";

let dir: string;
let db: Db;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tool-gate-soak-"));
  db = openDb(join(dir, "t.db"));
  db.prepare("INSERT INTO assistants (id, provider) VALUES ('a1','fake')").run();
  db.prepare("INSERT INTO tasks (id, goal, envelope, created_at, updated_at) VALUES ('AG-1','g','{}','t','t')").run();
  db.prepare("INSERT INTO runs (id, task_id, assistant_id, state, started_at) VALUES ('run-1','AG-1','a1','ACTIVE','t')").run();
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const req: DecisionRequest = { site: "tool-gate", state: {}, questions: {}, budgetMs: 50 };
const row = (at: string, outcome: "prompt" | "auto-approve" | "block", reason: string, hook: "pre-exec" | "post-start" = "post-start", mode: "shadow" | "applied" = "shadow") =>
  insertDecisionRecord(
    db,
    req,
    { answers: {}, provider: "rules", latencyMs: 0 },
    { taskId: "AG-1", sessionId: "run-1", mode, gate: { outcome, reason, hook, tier: hook === "pre-exec" ? "preventive" : "audit" } },
    at,
  );

const T0 = "2026-09-25T21:31:57.293Z";
const FLOOR = "floors: [path-outside-worktree] Names a path outside the task's worktree; check the agent should touch it.";

describe("tool-gate soak check", () => {
  it("counts only shadow rows from T0; rules-allowed excludes block; groups prompts by reason", () => {
    row("2026-09-25T10:00:00.000Z", "prompt", FLOOR); // parity run before T0
    row("2026-09-26T00:00:00.000Z", "prompt", FLOOR, "post-start", "applied");
    row("2026-09-26T00:00:01.000Z", "prompt", FLOOR);
    row("2026-09-26T00:00:02.000Z", "auto-approve", "no floor fired; approvalMode decides");
    row("2026-09-26T00:00:03.000Z", "block", "rules deny (final, I-D1)");
    row("2026-09-26T00:00:04.000Z", "prompt", FLOOR, "pre-exec");

    const r = toolGateSoakCheck(db, { since: T0, now: "2026-09-27T00:00:00.000Z" });
    expect(r.volume).toMatchObject({ n: 4, first: "2026-09-26T00:00:01.000Z", pass: false });
    expect(r.disagreements).toEqual({ n: 2, unread: 2, pass: false });
    expect(r.promptRate.byHook).toEqual([
      { hook: "post-start", calls: 2, prompts: 1, rate: 0.5 },
      { hook: "pre-exec", calls: 1, prompts: 1, rate: 1 },
    ]);
    expect(r.promptRate.byReason).toEqual([
      { hook: "post-start", reason: FLOOR, prompts: 1 },
      { hook: "pre-exec", reason: FLOOR, prompts: 1 },
    ]);
  });

  it("(1) passes at 14 days with rows; (2) and (7) pass only once the reading covers every row", () => {
    row("2026-09-26T00:00:00.000Z", "prompt", FLOOR);
    row("2026-10-09T00:00:00.000Z", "auto-approve", "no floor fired; approvalMode decides");
    const at = (now: string, readThrough?: string) => toolGateSoakCheck(db, { since: T0, now, readThrough });

    expect(at("2026-10-09T21:31:57.292Z").volume.pass).toBe(false);
    const day14 = at("2026-10-09T21:31:57.293Z", "2026-09-30T00:00:00.000Z");
    expect(day14.volume.pass).toBe(true);
    expect(day14.disagreements).toEqual({ n: 1, unread: 0, pass: true });
    expect(day14.promptRate.pass).toBe(false); // the last row is after the reading
    expect(at("2026-10-09T21:31:57.293Z", "2026-10-09T00:00:00.000Z").promptRate.pass).toBe(true);
    expect(toolGateSoakCheck(db, { since: "2026-10-10T00:00:00.000Z", now: "2026-11-01T00:00:00.000Z" }).volume.pass).toBe(false);
  });
});
