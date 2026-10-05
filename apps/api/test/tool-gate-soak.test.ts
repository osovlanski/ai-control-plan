/**
 * The tool gate's shadow-soak check (§7.1(1), (2), (7)): what counts, from when,
 * for which adapter/mode pair, and when a reading covers it.
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

/** A harness session of `provider` under `mode`, as the runner records one. */
const session = (id: string, provider: string, mode: string) => {
  db.prepare("INSERT OR IGNORE INTO assistants (id, provider) VALUES (?, ?)").run(`a-${provider}`, provider);
  db.prepare(
    `INSERT INTO execution_requests
       (id, task_id, attempt, assistant_id, routing_decision_ref, request_fingerprint,
        fingerprint_algorithm, prompt_source, rendered_prompt_digest, policy, verification,
        origin, canonical_projection, created_at)
     VALUES (?, 'AG-1', ?, ?, 'rd', 'fp', 'alg', 'fresh', 'd', ?, '[]', '{"kind":"fresh"}', '{}', 't')`,
  ).run(`erq-${id}`, Number(id.replace(/\D/g, "")) || 1, `a-${provider}`, JSON.stringify({ approval: { mode } }));
  db.prepare("INSERT INTO runs (id, task_id, assistant_id, state, execution_request_id, started_at) VALUES (?, 'AG-1', ?, 'ACTIVE', ?, 't')").run(
    id,
    `a-${provider}`,
    `erq-${id}`,
  );
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tool-gate-soak-"));
  db = openDb(join(dir, "t.db"));
  db.prepare("INSERT INTO tasks (id, goal, envelope, created_at, updated_at) VALUES ('AG-1','g','{}','t','t')").run();
  session("es-1", "anthropic", "prompt-on-escalation");
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const req: DecisionRequest = { site: "tool-gate", state: {}, questions: {}, budgetMs: 50 };
const row = (
  at: string,
  outcome: "prompt" | "auto-approve" | "block",
  reason: string,
  hook: "pre-exec" | "post-start" = "post-start",
  mode: "shadow" | "applied" = "shadow",
  sessionId = "es-1",
) =>
  insertDecisionRecord(
    db,
    req,
    { answers: {}, provider: "rules", latencyMs: 0 },
    { taskId: "AG-1", sessionId, mode, gate: { outcome, reason, hook, tier: hook === "pre-exec" ? "preventive" : "audit" } },
    at,
  );

const T0 = "2026-09-25T21:31:57.293Z";
const DAY14 = "2026-10-09T21:31:57.293Z";
const PAIR = { adapter: "anthropic", approvalMode: "prompt-on-escalation" };
const ALLOW = "no floor fired; approvalMode decides";
const FLOOR = "floors: [path-outside-worktree] Names a path outside the task's worktree; check the agent should touch it.";
const check = (over: { now?: string; readThrough?: string; minPreExecCalls?: number; adapter?: string; approvalMode?: string } = {}) =>
  toolGateSoakCheck(db, { since: T0, now: DAY14, ...PAIR, ...over });

describe("tool-gate soak check", () => {
  it("counts calls, not rows: a pre-exec row is the same call as the post-start row before it", () => {
    // The operator's shape since T0: an auto-allowed ToolSearch (post-start only),
    // then a permission-requiring MCP call, which writes post-start then pre-exec.
    row("2026-09-26T16:41:56.400Z", "auto-approve", ALLOW);
    row("2026-09-26T16:41:59.654Z", "auto-approve", ALLOW);
    row("2026-09-26T16:41:59.707Z", "auto-approve", ALLOW, "pre-exec");
    const v = check({ minPreExecCalls: 1 }).volume;
    expect(v).toMatchObject({ rows: 3, calls: 2, preExecCalls: 1 });
  });

  it("two calls emitted together still count as two, each prompting call is one disagreement", () => {
    row("2026-09-26T00:00:01.000Z", "prompt", FLOOR); // A
    row("2026-09-26T00:00:02.000Z", "prompt", FLOOR); // B
    row("2026-09-26T00:00:03.000Z", "prompt", FLOOR, "pre-exec"); // A or B
    row("2026-09-26T00:00:04.000Z", "prompt", FLOOR, "pre-exec");
    const r = check({ minPreExecCalls: 2 });
    expect(r.volume).toMatchObject({ rows: 4, calls: 2, preExecCalls: 2, verdict: "PASS" });
    expect(r.disagreements).toMatchObject({ n: 2, unread: 2 });
    expect(r.promptRate.byReason).toEqual([{ hook: "pre-exec", reason: FLOOR, prompts: 2 }]);
  });

  it("never pairs across sessions, and a pre-exec row with no post-start is its own call", () => {
    session("es-2", "anthropic", "prompt-on-escalation");
    row("2026-09-26T00:00:01.000Z", "auto-approve", ALLOW, "post-start", "shadow", "es-1");
    row("2026-09-26T00:00:02.000Z", "auto-approve", ALLOW, "pre-exec", "shadow", "es-2");
    expect(check().volume).toMatchObject({ rows: 2, calls: 2, preExecCalls: 1 });
  });

  it("counts only the pair being judged: other adapters and other approval modes are excluded", () => {
    session("es-3", "anthropic", "auto-approve");
    session("es-4", "fake", "prompt-on-escalation");
    row("2026-09-26T00:00:01.000Z", "auto-approve", ALLOW, "pre-exec", "shadow", "es-3");
    row("2026-09-26T00:00:02.000Z", "auto-approve", ALLOW, "pre-exec", "shadow", "es-4");
    row("2026-09-26T00:00:03.000Z", "auto-approve", ALLOW, "pre-exec");
    expect(check().volume.preExecCalls).toBe(1);
    expect(check({ adapter: "fake" }).volume.preExecCalls).toBe(1);
    expect(check({ approvalMode: "auto-approve" }).volume.preExecCalls).toBe(1);
  });

  it("with no owner minimum the verdict is INSUFFICIENT, never PASS, at any age and any count", () => {
    for (let i = 0; i < 600; i++) row(`2026-09-26T00:${String(Math.floor(i / 60)).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}.000Z`, "auto-approve", ALLOW, "pre-exec");
    const r = check({ now: "2027-01-01T00:00:00.000Z", readThrough: "2027-01-01T00:00:00.000Z" });
    expect(r.volume).toMatchObject({ preExecCalls: 600, minPreExecCalls: null, verdict: "INSUFFICIENT", pass: false });
    expect(r.disagreements.verdict).toBe("INSUFFICIENT");
    expect(r.promptRate.verdict).toBe("INSUFFICIENT");
  });

  it("at 14 days, passes only once distinct pre-exec calls reach the minimum; post-start calls never count", () => {
    for (let i = 0; i < 5; i++) row(`2026-09-26T00:00:0${i}.000Z`, "auto-approve", ALLOW); // audit only
    row("2026-09-26T00:01:00.000Z", "auto-approve", ALLOW, "pre-exec");
    expect(check({ minPreExecCalls: 2 }).volume).toMatchObject({ calls: 5, preExecCalls: 1, verdict: "INSUFFICIENT" });
    row("2026-09-26T00:02:00.000Z", "auto-approve", ALLOW, "pre-exec");
    expect(check({ minPreExecCalls: 2, now: "2026-10-09T21:31:57.292Z" }).volume.verdict).toBe("INSUFFICIENT");
    expect(check({ minPreExecCalls: 2 }).volume.verdict).toBe("PASS");
  });

  it("counts only shadow rows from T0; (2) and (7) pass only once the reading covers every call", () => {
    row("2026-09-25T10:00:00.000Z", "prompt", FLOOR, "pre-exec"); // parity run before T0
    row("2026-09-26T00:00:00.000Z", "prompt", FLOOR, "pre-exec", "applied");
    row("2026-09-26T00:00:01.000Z", "prompt", FLOOR, "pre-exec");
    row("2026-10-09T00:00:00.000Z", "auto-approve", ALLOW, "pre-exec");
    const at = (readThrough?: string) => check({ minPreExecCalls: 2, ...(readThrough ? { readThrough } : {}) });
    expect(at().volume).toMatchObject({ preExecCalls: 2, first: "2026-09-26T00:00:01.000Z", verdict: "PASS" });
    expect(at().disagreements).toMatchObject({ n: 1, unread: 1, verdict: "FAIL" });
    const read = at("2026-09-30T00:00:00.000Z");
    expect(read.disagreements).toMatchObject({ n: 1, unread: 0, verdict: "PASS" });
    expect(read.promptRate.verdict).toBe("FAIL"); // the last row is after the reading
    expect(read.promptRate.byHook).toEqual([{ hook: "pre-exec", calls: 2, prompts: 1, rate: 0.5 }]);
    expect(at("2026-10-09T00:00:00.000Z").promptRate.verdict).toBe("PASS");
  });
});
