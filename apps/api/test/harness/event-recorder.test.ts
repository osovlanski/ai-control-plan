/**
 * Phase 2 — EventRecorder: monotonic seq, the one-transaction commit protocol
 * (event insert(s) → optional envelope mutation → session CAS), and the durable
 * redaction view (§4, §9, H-I13/H-I14).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NormalizedEvent, RunId } from "@agent-plane/core";
import { openDb, type Db } from "../../src/db/index.js";
import { EventRecorder } from "../../src/modules/harness/event-recorder.js";
import { SessionCasConflictError, SessionStore } from "../../src/modules/harness/session-store.js";

let dir: string;
let db: Db;
let store: SessionStore;
let sessionId: string;
let token: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "harness-rec-"));
  db = openDb(join(dir, "t.db"));
  db.prepare("INSERT INTO assistants (id, provider) VALUES ('a1', 'fake')").run();
  db.prepare(
    "INSERT INTO tasks (id, goal, envelope, created_at, updated_at) VALUES ('AG-1', 'g', '{}', 't', 't')",
  ).run();
  store = new SessionStore(db);
  store.recordRequest({
    schemaVersion: 1,
    executionRequestId: "erq_1",
    taskId: "AG-1" as never,
    attempt: 1,
    assistantId: "a1" as never,
    routingDecisionRef: "rd",
    runSpec: {
      taskId: "AG-1" as never,
      prompt: "p",
      workdir: "/tmp",
      permissionPolicy: { mode: "auto-approve" },
      env: { redactionRules: [], maxRuntimeMs: 1 },
    },
    policy: {
      budget: { enforcement: "advisory" },
      timeout: { hardMs: 1 },
      approval: { mode: "auto-approve" },
      tools: { mode: "audit" },
      checkpoint: { onSoftLimit: false },
      isolation: { required: "ambient" },
    },
    context: {},
    verification: [],
    origin: { kind: "fresh" },
  });
  sessionId = store.createSession("erq_1").sessionId as string;
  token = store.acquireLease(sessionId)!;
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const ev = (type: NormalizedEvent["type"], summary: string): NormalizedEvent => ({
  runId: sessionId as RunId,
  ts: "2026-01-01T00:00:00.000Z",
  type,
  summary,
});

const eventCount = () =>
  (db.prepare("SELECT COUNT(*) c FROM events WHERE run_id = ?").get(sessionId) as { c: number }).c;
const sessionVersion = () =>
  (db.prepare("SELECT version v FROM runs WHERE id = ?").get(sessionId) as { v: number }).v;

describe("monotonic seq + CAS commit", () => {
  it("assigns per-session seq continuing across batches and bumps the version once per batch", () => {
    const rec = new EventRecorder(db);
    const first = rec.recordBatch({
      sessionId,
      expectedVersion: 0,
      leaseToken: token,
      events: [ev("run.started", "a"), ev("message", "b")],
    });
    expect(first.committed.map((c) => c.seq)).toEqual([1, 2]);
    expect(first.newVersion).toBe(1);

    const second = rec.recordBatch({
      sessionId,
      expectedVersion: 1,
      leaseToken: token,
      events: [ev("message", "c"), ev("message", "d"), ev("run.ended", "e")],
    });
    expect(second.committed.map((c) => c.seq)).toEqual([3, 4, 5]);
    expect(sessionVersion()).toBe(2);
  });

  it("rolls the whole batch back when the session CAS fails (stale version)", () => {
    const rec = new EventRecorder(db);
    expect(() =>
      rec.recordBatch({ sessionId, expectedVersion: 99, leaseToken: token, events: [ev("message", "x")] }),
    ).toThrow(SessionCasConflictError);
    expect(eventCount()).toBe(0); // no partial visibility
  });

  it("rolls back when the fencing lease does not match", () => {
    const rec = new EventRecorder(db);
    expect(() =>
      rec.recordBatch({ sessionId, expectedVersion: 0, leaseToken: "lease_wrong", events: [ev("message", "x")] }),
    ).toThrow(SessionCasConflictError);
    expect(eventCount()).toBe(0);
  });

  it("rolls back when the lease token matches but has expired past its TTL", () => {
    const rec = new EventRecorder(db, undefined, undefined, () => new Date("2099-01-01T00:00:00.000Z"));
    expect(() =>
      rec.recordBatch({ sessionId, expectedVersion: 0, leaseToken: token, events: [ev("message", "x")] }),
    ).toThrow(SessionCasConflictError);
    expect(eventCount()).toBe(0);
  });

  it("rolls back events when the in-transaction hook throws", () => {
    const rec = new EventRecorder(db);
    expect(() =>
      rec.recordBatch({
        sessionId,
        expectedVersion: 0,
        leaseToken: token,
        events: [ev("message", "x")],
        inTransaction: () => {
          throw new Error("envelope mutation failed");
        },
      }),
    ).toThrow("envelope mutation failed");
    expect(eventCount()).toBe(0);
    expect(sessionVersion()).toBe(0);
  });

  it("no-ops on an empty batch", () => {
    const rec = new EventRecorder(db);
    const r = rec.recordBatch({ sessionId, expectedVersion: 0, leaseToken: token, events: [] });
    expect(r.committed).toEqual([]);
    expect(sessionVersion()).toBe(0);
  });
});

describe("durable redaction view (H-I13)", () => {
  it("redacts a secret in a persisted event but keeps routing identifiers intact", () => {
    const rec = new EventRecorder(db);
    const raw = ev("message", "using api_key: sk-ABCDEFGHIJKLMNOP now");
    const durable = rec.toDurableView(raw);
    expect(durable.summary).not.toContain("sk-ABCDEFGHIJKLMNOP");
    expect(durable.runId).toBe(raw.runId);
    expect(durable.type).toBe(raw.type);
    expect(durable.ts).toBe(raw.ts);

    rec.recordBatch({ sessionId, expectedVersion: 0, leaseToken: token, events: [raw] });
    const stored = db
      .prepare("SELECT seq, type, summary FROM events WHERE run_id = ? ORDER BY seq")
      .get(sessionId) as { seq: number; type: string; summary: string };
    expect(stored.seq).toBe(1);
    expect(stored.type).toBe("message");
    expect(stored.summary).not.toContain("sk-ABCDEFGHIJKLMNOP");
  });

  it("calls the post-commit publish hook once, after the row is visible", () => {
    const seen: Array<{ n: number; committed: number }> = [];
    const publish = vi.fn((_id: string, committed: unknown[]) => {
      seen.push({ n: eventCount(), committed: committed.length });
    });
    const rec = new EventRecorder(db, undefined, publish);
    rec.recordBatch({
      sessionId,
      expectedVersion: 0,
      leaseToken: token,
      events: [ev("message", "a"), ev("message", "b")],
    });
    expect(publish).toHaveBeenCalledTimes(1);
    expect(seen[0]).toEqual({ n: 2, committed: 2 }); // rows already durable when published
  });

  it("does not publish when the batch rolls back", () => {
    const publish = vi.fn();
    const rec = new EventRecorder(db, undefined, publish);
    expect(() =>
      rec.recordBatch({ sessionId, expectedVersion: 5, leaseToken: token, events: [ev("message", "a")] }),
    ).toThrow();
    expect(publish).not.toHaveBeenCalled();
  });

  it("swallows a throwing publish — the batch is already durable", () => {
    const onPublishError = vi.fn();
    const rec = new EventRecorder(
      db,
      undefined,
      () => {
        throw new Error("SSE bus down");
      },
      undefined,
      onPublishError,
    );
    const r = rec.recordBatch({ sessionId, expectedVersion: 0, leaseToken: token, events: [ev("message", "a")] });
    expect(r.committed).toHaveLength(1);
    expect(eventCount()).toBe(1); // committed despite the publish failure
    expect(onPublishError).toHaveBeenCalledOnce();
  });

  it("runs the afterInsertInTx constructor hook inside the tx for every batch", () => {
    const calls: Array<{ id: string; seqs: number[]; rowsVisible: number }> = [];
    const rec = new EventRecorder(db, undefined, undefined, undefined, undefined, (id, committed, hookDb) => {
      const rows = (hookDb.prepare("SELECT COUNT(*) c FROM events WHERE run_id = ?").get(id) as { c: number }).c;
      calls.push({ id, seqs: committed.map((c) => c.seq), rowsVisible: rows });
    });
    rec.recordBatch({
      sessionId,
      expectedVersion: 0,
      leaseToken: token,
      events: [ev("message", "a"), ev("message", "b")],
    });
    rec.recordBatch({ sessionId, expectedVersion: 1, leaseToken: token, events: [ev("message", "c")] });
    expect(calls).toEqual([
      { id: sessionId, seqs: [1, 2], rowsVisible: 2 },
      { id: sessionId, seqs: [3], rowsVisible: 3 },
    ]);
  });

  const quotaRowCount = () =>
    (db.prepare("SELECT COUNT(*) c FROM quota_snapshots WHERE assistant_id = 'a1'").get() as { c: number }).c;

  const writeQuotaRow = (hookDb: Db) =>
    hookDb
      .prepare(
        "INSERT INTO quota_snapshots (assistant_id, window, used_percent, resets_at, source, observed_at) VALUES ('a1', '5h', 90, NULL, 'runtime-probe', 't')",
      )
      .run();

  it("rolls a hook-written row back when afterInsertInTx then throws", () => {
    const publish = vi.fn();
    const rec = new EventRecorder(db, undefined, publish, undefined, undefined, (_id, _committed, hookDb) => {
      writeQuotaRow(hookDb);
      throw new Error("quota snapshot follow-up failed");
    });
    expect(() =>
      rec.recordBatch({ sessionId, expectedVersion: 0, leaseToken: token, events: [ev("message", "x")] }),
    ).toThrow("quota snapshot follow-up failed");
    expect(eventCount()).toBe(0);
    expect(quotaRowCount()).toBe(0); // the hook's own write rolled back with the batch
    expect(sessionVersion()).toBe(0);
    expect(publish).not.toHaveBeenCalled();
  });

  it("rolls a hook-written row back when the session CAS fails after the hook ran", () => {
    let hookRan = 0;
    const rec = new EventRecorder(db, undefined, undefined, undefined, undefined, (_id, _committed, hookDb) => {
      hookRan += 1;
      writeQuotaRow(hookDb);
    });
    expect(() =>
      rec.recordBatch({ sessionId, expectedVersion: 99, leaseToken: token, events: [ev("message", "x")] }),
    ).toThrow(SessionCasConflictError);
    expect(hookRan).toBe(1); // hook runs before the CAS
    expect(eventCount()).toBe(0);
    expect(quotaRowCount()).toBe(0); // rolled back by the CAS failure
  });

  it("commits a hook-written row atomically with the batch on success", () => {
    const rec = new EventRecorder(db, undefined, undefined, undefined, undefined, (_id, _committed, hookDb) => {
      writeQuotaRow(hookDb);
    });
    rec.recordBatch({ sessionId, expectedVersion: 0, leaseToken: token, events: [ev("message", "x")] });
    expect(eventCount()).toBe(1);
    expect(quotaRowCount()).toBe(1);
  });

  it("freezes the events handed to the in-transaction hook", () => {
    const rec = new EventRecorder(db);
    let frozen = false;
    rec.recordBatch({
      sessionId,
      expectedVersion: 0,
      leaseToken: token,
      events: [ev("message", "a")],
      inTransaction: (committed) => {
        frozen = Object.isFrozen(committed[0]) && Object.isFrozen(committed[0]!.event);
      },
    });
    expect(frozen).toBe(true);
  });
});
