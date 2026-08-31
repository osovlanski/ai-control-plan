/**
 * Phase 4 — HandoffService: envelope derivation from an immutable checkpoint
 * snapshot (H-I5), and the persisted claim protocol
 * (ready → claimed → consumed / released / start_ambiguous) with the
 * one-live-successor guarantee (§7, §12).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { TaskEnvelope } from "@agent-plane/core";
import { openDb, type Db } from "../../src/db/index.js";
import { HandoffClaimError, HandoffService } from "../../src/modules/harness/handoff.js";

let dir: string;
let db: Db;
let handoff: HandoffService;
let clock: Date;

const CHECKPOINT_ID = "ckpt_1";

const snapshot: TaskEnvelope = {
  taskId: "AG-1" as never,
  goal: "Ship the widget",
  constraints: ["no new deps"],
  repository: { path: "/repo", branch: "task/AG-1" },
  status: { state: "RUNNING" },
  completed: ["scaffolded the module"],
  remaining: ["wire the API", "add tests"],
  decisions: [{ text: "use SQLite", madeBy: "user", at: "t0" }],
  artifacts: { changedFiles: ["src/widget.ts"], testResults: [{ at: "t1", passed: 2, failed: 0 }] },
  nextAction: "wire the API",
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "harness-handoff-"));
  db = openDb(join(dir, "t.db"));
  clock = new Date("2026-01-01T00:00:00.000Z");
  handoff = new HandoffService(db, () => clock);

  db.prepare("INSERT INTO assistants (id, provider) VALUES ('a1','fake'), ('a2','fake')").run();
  db.prepare("INSERT INTO tasks (id, goal, envelope, created_at, updated_at) VALUES ('AG-1','g','{}','t','t')").run();
  db.prepare(
    "INSERT INTO runs (id, task_id, assistant_id, state, session_state, started_at) VALUES ('es_src','AG-1','a1','ENDED_ERROR','YIELDED','t')",
  ).run();
  db.prepare(
    `INSERT INTO checkpoints (id, task_id, run_id, session_id, envelope_snapshot, git_ref, diff_stat, reason, at)
     VALUES (?, 'AG-1', 'es_src', 'es_src', ?, 'deadbeef', ' 1 file changed', 'handoff', 't')`,
  ).run(CHECKPOINT_ID, JSON.stringify(snapshot));
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function insertSuccessorReq(id: string, envelopeId: string): (d: Db) => void {
  return (d) =>
    d
      .prepare(
        `INSERT INTO execution_requests
           (id, task_id, attempt, assistant_id, routing_decision_ref, request_fingerprint,
            fingerprint_algorithm, prompt_source, rendered_prompt_digest, policy, verification,
            origin, origin_envelope_id, canonical_projection, created_at)
         VALUES (?, 'AG-1', 2, 'a2', 'rd', ?, 'alg', 'handoff', 'd', '{}', '[]', ?, ?, '{}', 't')`,
      )
      .run(id, `fp_${id}`, JSON.stringify({ kind: "handoff", envelopeId }), envelopeId);
}

function makeReady(): string {
  const { envelope, sourceSessionId } = handoff.deriveEnvelope(CHECKPOINT_ID, {
    reason: "quota exhausted",
    fromAssistantId: "a1",
  });
  db.transaction(() => handoff.insertEnvelope(db, envelope, { sourceSessionId }))();
  return envelope.envelopeId;
}

describe("deriveEnvelope", () => {
  it("maps the checkpoint snapshot into a HandoffEnvelope (H-I5)", () => {
    const { envelope } = handoff.deriveEnvelope(CHECKPOINT_ID, { reason: "quota", fromAssistantId: "a1" });
    expect(envelope).toMatchObject({
      schemaVersion: 1,
      checkpointId: CHECKPOINT_ID,
      objective: "Ship the widget",
      currentSubtask: "wire the API",
      completedActions: ["scaffolded the module"],
      outstanding: ["wire the API", "add tests"],
      decisions: [{ text: "use SQLite", madeBy: "user", at: "t0" }],
      artifacts: { gitRef: "deadbeef", changedFiles: ["src/widget.ts"] },
      workspace: { repoPath: "/repo", branch: "task/AG-1" },
      fromAssistantId: "a1",
      reason: "quota",
    });
  });

  it("reads the immutable snapshot, not the live task envelope", () => {
    db.prepare("UPDATE tasks SET envelope = ? WHERE id = 'AG-1'").run(
      JSON.stringify({ ...snapshot, goal: "MUTATED" }),
    );
    const { envelope } = handoff.deriveEnvelope(CHECKPOINT_ID, { reason: "r", fromAssistantId: "a1" });
    expect(envelope.objective).toBe("Ship the widget");
  });
});

describe("insertEnvelope", () => {
  it("writes a ready envelope row and a handoffs row", () => {
    const id = makeReady();
    const row = handoff.get(id)!;
    expect(row.state).toBe("ready");
    expect(row.fromAssistantId).toBe("a1");
    const ho = db.prepare("SELECT trigger, checkpoint_id FROM handoffs WHERE task_id = 'AG-1'").get() as {
      trigger: string;
      checkpoint_id: string;
    };
    expect(ho).toEqual({ trigger: "harness", checkpoint_id: CHECKPOINT_ID });
  });
});

describe("claim protocol", () => {
  it("claims ready → claimed and blocks a second live successor via the partial index", () => {
    const id = makeReady();
    handoff.claim(id, { requestId: "s1", insertRequest: insertSuccessorReq("s1", id) });
    expect(handoff.get(id)!.state).toBe("claimed");
    expect(handoff.get(id)!.claimedByRequestId).toBe("s1");

    // envelope already claimed → refused
    expect(() =>
      handoff.claim(id, { requestId: "s2", insertRequest: insertSuccessorReq("s2", id) }),
    ).toThrow(HandoffClaimError);
    // and the successor request row was rolled back
    expect(db.prepare("SELECT COUNT(*) c FROM execution_requests WHERE id = 's2'").get()).toMatchObject({ c: 0 });
  });

  it("release returns the envelope to ready, supersedes the failed request, and a corrected successor can claim", () => {
    const id = makeReady();
    handoff.claim(id, { requestId: "s1", insertRequest: insertSuccessorReq("s1", id) });
    handoff.release(id, "s1");
    expect(handoff.get(id)!.state).toBe("ready");
    expect(db.prepare("SELECT superseded FROM execution_requests WHERE id = 's1'").get()).toMatchObject({
      superseded: 1,
    });

    handoff.claim(id, { requestId: "s3", insertRequest: insertSuccessorReq("s3", id) });
    expect(handoff.get(id)!.state).toBe("claimed");
  });

  it("markConsumed moves claimed → consumed", () => {
    const id = makeReady();
    handoff.claim(id, { requestId: "s1", insertRequest: insertSuccessorReq("s1", id) });
    handoff.markConsumed(id);
    expect(handoff.get(id)!.state).toBe("consumed");
  });
});

describe("start_ambiguous", () => {
  it("pins the claim: automatic expiry is prohibited, only recovery may settle", () => {
    const id = makeReady();
    handoff.claim(id, { requestId: "s1", insertRequest: insertSuccessorReq("s1", id) });
    handoff.enterStartAmbiguous(id);
    expect(handoff.get(id)!.state).toBe("start_ambiguous");

    clock = new Date(clock.getTime() + 10 * 60_000);
    expect(handoff.expireClaim(id, 60_000)).toBe(false); // no automatic release from start_ambiguous

    // recovery establishes non-execution → release + supersede
    handoff.settleAmbiguous(id, { executionEstablished: false }, "s1");
    expect(handoff.get(id)!.state).toBe("ready");
    expect(db.prepare("SELECT superseded FROM execution_requests WHERE id = 's1'").get()).toMatchObject({
      superseded: 1,
    });
  });

  it("recovery establishing execution settles to consumed", () => {
    const id = makeReady();
    handoff.claim(id, { requestId: "s1", insertRequest: insertSuccessorReq("s1", id) });
    handoff.enterStartAmbiguous(id);
    handoff.settleAmbiguous(id, { executionEstablished: true }, "s1");
    expect(handoff.get(id)!.state).toBe("consumed");
  });
});

describe("expireClaim (pre-start only)", () => {
  it("supersedes + releases a stale pre-start claim, and is a no-op within the TTL", () => {
    const id = makeReady();
    handoff.claim(id, { requestId: "s1", insertRequest: insertSuccessorReq("s1", id) });

    expect(handoff.expireClaim(id, 60_000)).toBe(false); // fresh
    clock = new Date(clock.getTime() + 61_000);
    expect(handoff.expireClaim(id, 60_000)).toBe(true);
    expect(handoff.get(id)!.state).toBe("ready");
    expect(db.prepare("SELECT superseded FROM execution_requests WHERE id = 's1'").get()).toMatchObject({
      superseded: 1,
    });
  });
});
