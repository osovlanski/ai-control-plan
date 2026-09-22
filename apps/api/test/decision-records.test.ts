/**
 * M16 K18 — `decision_records` write/read path (plan
 * `plans/jev-decision-service-plan.md` §5, K18).
 *
 * The invariant under test throughout: a record holds the question-set HASH
 * and the ANSWERS, never `DecisionRequest.state`.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DecisionRequest } from "@agent-plane/core";
import { openDb, type Db } from "../src/db/index.js";
import { DecisionService, insertDecisionRecord, listDecisions } from "../src/modules/decision.js";

let dir: string;
let db: Db;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "decision-records-"));
  db = openDb(join(dir, "t.db"));
  db.prepare("INSERT INTO assistants (id, provider) VALUES ('a1','fake')").run();
  db.prepare("INSERT INTO tasks (id, goal, envelope, created_at, updated_at) VALUES ('AG-1','g','{}','t','t')").run();
  db.prepare(
    "INSERT INTO runs (id, task_id, assistant_id, state, started_at) VALUES ('run-1','AG-1','a1','ACTIVE','t')",
  ).run();
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const toolGateReq = (over: Partial<DecisionRequest> = {}): DecisionRequest => ({
  site: "tool-gate",
  state: { toolName: "shell", toolsAllow: undefined, toolsDeny: ["rm -rf"] },
  questions: { denied: { kind: "noul", instructions: "Is this tool call denied by policy?" } },
  budgetMs: 50,
  ...over,
});

describe("insertDecisionRecord / listDecisions", () => {
  it("round-trips a record without ever storing DecisionRequest.state", () => {
    const req = toolGateReq();
    insertDecisionRecord(
      db,
      req,
      { answers: { denied: { kind: "noul", value: 0 } }, provider: "rules", latencyMs: 1 },
      { taskId: "AG-1", sessionId: "run-1", mode: "shadow" },
      "2026-09-22T00:00:00.000Z",
    );

    const rows = listDecisions(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      taskId: "AG-1",
      sessionId: "run-1",
      site: "tool-gate",
      provider: "rules",
      modelReported: null,
      answers: { denied: { kind: "noul", value: 0 } },
      latencyMs: 1,
      inputTokens: null,
      mode: "shadow",
      degradedReason: null,
      stateTruncated: false,
      createdAt: "2026-09-22T00:00:00.000Z",
    });
    expect(typeof rows[0]!.questionSetHash).toBe("string");
    expect(rows[0]!.questionSetHash.length).toBeGreaterThan(0);

    // The raw row never carries a state/toolsDeny/toolName column — the table
    // itself has no such column, so this is a structural guarantee, not a
    // per-row check. Confirm the column set directly.
    const columns = (db.prepare("PRAGMA table_info(decision_records)").all() as Array<{ name: string }>).map(
      (c) => c.name,
    );
    expect(columns).not.toContain("state");
    expect(columns).not.toContain("state_json");
  });

  it("records the degraded reason and truncation flag honestly", () => {
    insertDecisionRecord(
      db,
      toolGateReq(),
      {
        answers: { denied: { kind: "noul", value: 1 } },
        provider: "rules",
        latencyMs: 3,
        degraded: { from: "typesafe", reason: "401 bad key" },
      },
      { sessionId: "run-1", mode: "shadow" },
      "2026-09-22T00:00:01.000Z",
    );
    const [row] = listDecisions(db);
    expect(row!.degradedReason).toBe("401 bad key");
    expect(row!.taskId).toBeNull();
    expect(row!.stateTruncated).toBe(false); // §4.4 truncation isn't built until a real bounded state exists
  });

  it("filters by site and respects limit", () => {
    insertDecisionRecord(db, toolGateReq(), { answers: {}, provider: "rules", latencyMs: 1 }, { sessionId: "run-1", mode: "shadow" }, "t1");
    insertDecisionRecord(
      db,
      { ...toolGateReq(), site: "task-classifier", questions: { kind: { kind: "choice", instructions: "x", criteria: { coding: null } } } },
      { answers: {}, provider: "rules", latencyMs: 1 },
      { sessionId: "run-1", mode: "shadow" },
      "t2",
    );
    expect(listDecisions(db, { site: "tool-gate" })).toHaveLength(1);
    expect(listDecisions(db)).toHaveLength(2);
    expect(listDecisions(db, { limit: 1 })).toHaveLength(1);
  });
});

describe("DecisionService.decide() — record write at the decide() boundary", () => {
  it("writes one row per caller, even when single-flight collapses the underlying work", async () => {
    const svc = new DecisionService({ provider: "rules" }, [], undefined, db);
    const req = toolGateReq();
    const [a, b] = await Promise.all([
      svc.decide(req, { sessionId: "run-1", mode: "shadow" }),
      svc.decide(req, { sessionId: "run-1", mode: "shadow" }),
    ]);
    expect(a).toEqual(b); // the work really was deduped
    expect(listDecisions(db)).toHaveLength(2); // but each caller still gets its own row
  });

  it("writes nothing when the caller omits the record context", async () => {
    const svc = new DecisionService({ provider: "rules" }, [], undefined, db);
    await svc.decide(toolGateReq());
    expect(listDecisions(db)).toHaveLength(0);
  });

  it("writes nothing when no db is wired (every K17 unit test's shape)", async () => {
    const svc = new DecisionService({ provider: "rules" });
    const out = await svc.decide(toolGateReq(), { sessionId: "run-1", mode: "shadow" });
    expect(out.provider).toBe("rules"); // still answers — just doesn't (can't) record
  });
});
