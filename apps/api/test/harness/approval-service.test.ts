/**
 * Phase 3 — ApprovalService: the durable answer lifecycle, idempotency vs
 * conflict, and delivery-state transitions (§4).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb, type Db } from "../../src/db/index.js";
import { ApprovalConflictError, ApprovalService } from "../../src/modules/harness/approval-service.js";

let dir: string;
let db: Db;
let approvals: ApprovalService;
const S = "es_1";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "harness-apr-"));
  db = openDb(join(dir, "t.db"));
  db.prepare("INSERT INTO assistants (id, provider) VALUES ('a1','fake')").run();
  db.prepare("INSERT INTO tasks (id, goal, envelope, created_at, updated_at) VALUES ('AG-1','g','{}','t','t')").run();
  db.prepare(
    "INSERT INTO runs (id, task_id, assistant_id, state, session_state, started_at) VALUES (?, 'AG-1','a1','ACTIVE','RUNNING','t')",
  ).run(S);
  approvals = new ApprovalService(db);
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("request", () => {
  it("inserts a pending row and is idempotent on (session, provider_request_id)", () => {
    const a = approvals.request(S, "prq-1", "apr-1");
    expect(a.state).toBe("pending");
    const b = approvals.request(S, "prq-1", "apr-2");
    expect(b.id).toBe("apr-1"); // same row
    expect(approvals.pending(S)).toHaveLength(1);
  });
});

describe("answer", () => {
  beforeEach(() => approvals.request(S, "prq-1", "apr-1"));

  it("records the decision durably before any relay", () => {
    const r = approvals.answer(S, "prq-1", "approved", "user:alice");
    expect(r.status).toBe("answered");
    expect(r.row).toMatchObject({ state: "answered", decision: "approved", answeredBy: "user:alice" });
  });

  it("treats an identical re-answer as a no-op", () => {
    approvals.answer(S, "prq-1", "denied", "user:alice");
    const again = approvals.answer(S, "prq-1", "denied", "user:bob");
    expect(again.status).toBe("idempotent");
    expect(again.row.answeredBy).toBe("user:alice"); // original stands
  });

  it("rejects a conflicting flip", () => {
    approvals.answer(S, "prq-1", "approved", "user:alice");
    expect(() => approvals.answer(S, "prq-1", "denied", "user:bob")).toThrow(ApprovalConflictError);
  });

  it("refuses to answer an expired approval", () => {
    approvals.expire(S, "prq-1");
    expect(() => approvals.answer(S, "prq-1", "approved", "user")).toThrow(/expired/);
  });
});

describe("delivery lifecycle", () => {
  beforeEach(() => {
    approvals.request(S, "prq-1", "apr-1");
    approvals.answer(S, "prq-1", "approved", "user");
  });

  it("answered → delivering → delivered", () => {
    approvals.markDelivering(S, "prq-1");
    expect(approvals.get(S, "prq-1")!.state).toBe("delivering");
    approvals.markDelivered(S, "prq-1");
    expect(approvals.get(S, "prq-1")!.state).toBe("delivered");
  });

  it("delivering → delivery_unknown, then a retry can still reach delivered", () => {
    approvals.markDelivering(S, "prq-1");
    approvals.markDeliveryUnknown(S, "prq-1", "unknown");
    const row = approvals.get(S, "prq-1")!;
    expect(row.state).toBe("delivery_unknown");
    expect(row.deliveryNote).toBe("unknown");
    approvals.markDelivering(S, "prq-1"); // recovery re-delivery
    approvals.markDelivered(S, "prq-1");
    expect(approvals.get(S, "prq-1")!.state).toBe("delivered");
  });

  it("unsettled() surfaces pending and answered-undelivered rows for recovery", () => {
    approvals.request(S, "prq-2", "apr-2"); // still pending
    const ids = approvals.unsettled(S).map((r) => r.providerRequestId).sort();
    expect(ids).toEqual(["prq-1", "prq-2"]);
  });
});

describe("expire", () => {
  it("moves a pending row to expired", () => {
    approvals.request(S, "prq-1", "apr-1");
    approvals.expire(S, "prq-1");
    expect(approvals.get(S, "prq-1")!.state).toBe("expired");
    expect(approvals.pending(S)).toHaveLength(0);
  });
});
