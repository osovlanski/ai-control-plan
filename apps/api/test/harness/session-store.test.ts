/**
 * Phase 1 — SessionStore: fingerprint dedupe vs conflict, one-session-per-request
 * (H-I8), CAS-under-a-live-fencing-lease writes (H-I12), start-ack markers (§9),
 * durable cancel intent, and atomic terminalize + result (H-I3).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  InvalidSessionTransitionError,
  type AssistantId,
  type ExecutionRequest,
  type ExecutionResult,
  type ProviderSessionRef,
  type TaskId,
  type TerminalSessionState,
} from "@agent-plane/core";
import { openDb, type Db } from "../../src/db/index.js";
import {
  RequestFingerprintConflictError,
  SessionCasConflictError,
  SessionStore,
} from "../../src/modules/harness/session-store.js";

let dir: string;
let db: Db;
let clock: Date;
let store: SessionStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "harness-store-"));
  db = openDb(join(dir, "t.db"));
  db.prepare("INSERT INTO assistants (id, provider) VALUES ('a1', 'fake')").run();
  db.prepare(
    "INSERT INTO tasks (id, goal, envelope, created_at, updated_at) VALUES ('AG-1', 'g', '{}', 't', 't')",
  ).run();
  clock = new Date("2026-01-01T00:00:00.000Z");
  store = new SessionStore(db, () => clock);
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function request(overrides: Partial<ExecutionRequest> = {}): ExecutionRequest {
  return {
    schemaVersion: 1,
    executionRequestId: "erq_1",
    taskId: "AG-1" as TaskId,
    attempt: 1,
    assistantId: "a1" as AssistantId,
    routingDecisionRef: "rd_1",
    runSpec: {
      taskId: "AG-1" as TaskId,
      prompt: "do it",
      workdir: "/tmp/wt",
      permissionPolicy: { mode: "auto-approve" },
      env: { redactionRules: [], maxRuntimeMs: 1000 },
    },
    policy: {
      budget: { enforcement: "advisory" },
      timeout: { hardMs: 1000 },
      approval: { mode: "auto-approve" },
      tools: { mode: "audit" },
      checkpoint: { onSoftLimit: true },
      isolation: { required: "partial" },
    },
    context: {},
    verification: [],
    origin: { kind: "fresh" },
    ...overrides,
  };
}

function completedResult(sessionId: string): ExecutionResult {
  return {
    schemaVersion: 1,
    sessionId: sessionId as ExecutionResult["sessionId"],
    terminalState: "COMPLETED",
    outcome: "completed",
    artifacts: [],
    usage: { accounting: "none" },
    checkpoint: { attempted: true, committed: true },
    enforcement: { tools: "audit", budget: "advisory", isolation: "partial" },
  };
}

/** A PREPARED session plus the fencing lease its runner would hold. */
function preparedWithLease(reqId = "erq_1"): { id: string; token: string } {
  store.recordRequest(request({ executionRequestId: reqId }));
  const id = store.createSession(reqId).sessionId as string;
  const token = store.acquireLease(id)!;
  return { id, token };
}

describe("recordRequest — dedupe vs conflict", () => {
  it("stores once, then dedupes an identical resubmission", () => {
    expect(store.recordRequest(request()).deduped).toBe(false);
    expect(store.recordRequest(request()).deduped).toBe(true);
    expect((db.prepare("SELECT COUNT(*) c FROM execution_requests").get() as { c: number }).c).toBe(1);
  });

  it("rejects the same id resubmitted with a different fingerprint", () => {
    store.recordRequest(request());
    expect(() =>
      store.recordRequest(request({ policy: { ...request().policy, timeout: { hardMs: 9999 } } })),
    ).toThrow(RequestFingerprintConflictError);
  });

  it("falls back to a dedupe compare when the insert loses a PK race", () => {
    // Simulate a racing writer that already inserted the identical row.
    const { fingerprint } = store.recordRequest(request());
    db.prepare("DELETE FROM execution_requests WHERE id = 'erq_1'").run();
    db.prepare(
      `INSERT INTO execution_requests
         (id, task_id, attempt, assistant_id, routing_decision_ref, request_fingerprint,
          fingerprint_algorithm, prompt_source, rendered_prompt_digest, policy, verification,
          origin, canonical_projection, created_at)
       VALUES ('erq_1','AG-1',1,'a1','rd_1',?, 'alg','fresh','d','{}','[]','{"kind":"fresh"}','{}','t')`,
    ).run(fingerprint);
    // A row now exists with the same fingerprint but the store still has no memory of it.
    expect(store.recordRequest(request()).deduped).toBe(true);
  });

  it("records handoff provenance and the origin envelope id", () => {
    store.recordRequest(request({ origin: { kind: "handoff", envelopeId: "env-9" } }));
    const row = db
      .prepare("SELECT prompt_source, prompt_source_ref, origin_envelope_id FROM execution_requests WHERE id = 'erq_1'")
      .get() as { prompt_source: string; prompt_source_ref: string; origin_envelope_id: string };
    expect(row).toEqual({ prompt_source: "handoff", prompt_source_ref: "env-9", origin_envelope_id: "env-9" });
  });
});

describe("createSession — one session per request (H-I8)", () => {
  it("creates a PREPARED session and is idempotent for the same request", () => {
    store.recordRequest(request());
    const first = store.createSession("erq_1");
    expect(first.state).toBe("PREPARED");
    expect(first.version).toBe(0);
    expect(store.legacyState(first)).toBe("STARTING");

    const second = store.createSession("erq_1");
    expect(second.sessionId).toBe(first.sessionId);
    expect(
      (db.prepare("SELECT COUNT(*) c FROM runs WHERE execution_request_id = 'erq_1'").get() as { c: number }).c,
    ).toBe(1);
  });
});

describe("CAS transitions under a live fencing lease (H-I12)", () => {
  it("advances on a matching version + live lease and bumps the version", () => {
    const { id, token } = preparedWithLease();
    const next = store.transition(id, { expectedVersion: 0, from: "PREPARED", to: "STARTING", leaseToken: token });
    expect(next.state).toBe("STARTING");
    expect(next.version).toBe(1);
    expect((db.prepare("SELECT state FROM runs WHERE id = ?").get(id) as { state: string }).state).toBe("STARTING");
  });

  it("rejects a stale expectedVersion", () => {
    const { id, token } = preparedWithLease();
    store.transition(id, { expectedVersion: 0, from: "PREPARED", to: "STARTING", leaseToken: token });
    expect(() =>
      store.transition(id, { expectedVersion: 0, from: "PREPARED", to: "STARTING", leaseToken: token }),
    ).toThrow(SessionCasConflictError);
  });

  it("rejects an illegal transition before touching the row", () => {
    const { id, token } = preparedWithLease();
    expect(() =>
      store.transition(id, { expectedVersion: 0, from: "PREPARED", to: "RUNNING", leaseToken: token }),
    ).toThrow(InvalidSessionTransitionError);
    expect(store.get(id)!.version).toBe(0);
  });

  it("fences a wrong lease token", () => {
    const { id } = preparedWithLease();
    expect(() =>
      store.transition(id, { expectedVersion: 0, from: "PREPARED", to: "STARTING", leaseToken: "lease_wrong" }),
    ).toThrow(SessionCasConflictError);
  });

  it("fences a stalled runner whose lease has expired past its TTL", () => {
    const { id, token } = preparedWithLease();
    clock = new Date(clock.getTime() + 61_000); // lease TTL is 60s
    expect(() =>
      store.transition(id, { expectedVersion: 0, from: "PREPARED", to: "STARTING", leaseToken: token }),
    ).toThrow(SessionCasConflictError);
  });

  it("only one lease holder at a time; renewal needs a live token", () => {
    const { id, token } = preparedWithLease();
    expect(store.acquireLease(id)).toBeUndefined();
    expect(store.renewLease(id, "lease_wrong")).toBe(false);
    expect(store.renewLease(id, token)).toBe(true);
    clock = new Date(clock.getTime() + 61_000);
    expect(store.renewLease(id, token)).toBe(false); // dead lease cannot be renewed
  });

  it("lets a new runner take over an expired lease with a fresh token", () => {
    const { id, token: first } = preparedWithLease();
    clock = new Date(clock.getTime() + 61_000);
    const second = store.acquireLease(id, 60_000);
    expect(second).toBeTruthy();
    expect(second).not.toBe(first);
  });

  it("voidAllLeases clears live leases and leaves terminal rows alone", () => {
    const { id, token } = preparedWithLease();
    const { id: doneId, token: doneToken } = preparedWithLease("erq_done");
    driveToVerifying(doneId, doneToken);
    store.terminalize(doneId, {
      expectedVersion: 3,
      from: "VERIFYING",
      to: "COMPLETED",
      leaseToken: doneToken,
      settlementOwner: "runner-x",
      result: completedResult(doneId),
    });
    // terminal row's lease is already null after terminalize; add a stray one back to prove the filter.
    db.prepare("UPDATE runs SET lease_token = 'stale', lease_expires_at = '2999-01-01' WHERE id = ?").run(doneId);

    expect(store.voidAllLeases()).toBe(1); // only the live session
    expect(store.get(id)!.leaseToken).toBeUndefined();
    expect(store.get(doneId)!.leaseToken).toBe("stale");
    void token;
  });
});

describe("start-intent / start-ack markers (§9)", () => {
  it("records handle acquisition as a fenced version bump, then stream-ack on the RUNNING transition", () => {
    const { id, token } = preparedWithLease();
    store.transition(id, { expectedVersion: 0, from: "PREPARED", to: "STARTING", leaseToken: token });

    expect(() => store.ackHandle(id, "provref" as ProviderSessionRef, { expectedVersion: 1, leaseToken: "wrong" })).toThrow(
      SessionCasConflictError,
    );
    const afterHandle = store.ackHandle(id, "provref" as ProviderSessionRef, { expectedVersion: 1, leaseToken: token });
    expect(afterHandle.providerSessionRef).toBe("provref");
    expect(afterHandle.providerStartAcked).toBe(false);
    expect(afterHandle.version).toBe(2);

    const running = store.transition(id, {
      expectedVersion: 2,
      from: "STARTING",
      to: "RUNNING",
      leaseToken: token,
      patch: { providerStartAcked: true },
    });
    expect(running.providerStartAcked).toBe(true);
  });
});

describe("requestCancel — durable intent, lease-free (§4)", () => {
  it("sets the flag, bumps the version as a wakeup, and is idempotent", () => {
    const { id, token } = preparedWithLease();
    store.transition(id, { expectedVersion: 0, from: "PREPARED", to: "STARTING", leaseToken: token });
    const before = store.get(id)!.version;

    expect(store.requestCancel(id)).toBe(true);
    expect(store.get(id)!.cancelRequested).toBe(true);
    expect(store.get(id)!.version).toBe(before + 1);

    // The owning runner's in-flight CAS now fails on the bumped version.
    expect(() =>
      store.transition(id, { expectedVersion: before, from: "STARTING", to: "RUNNING", leaseToken: token }),
    ).toThrow(SessionCasConflictError);

    expect(store.requestCancel(id)).toBe(false); // idempotent
  });

  it("no-ops on a terminal session", () => {
    const { id, token } = preparedWithLease();
    driveToVerifying(id, token);
    store.terminalize(id, {
      expectedVersion: 3,
      from: "VERIFYING",
      to: "COMPLETED",
      leaseToken: token,
      settlementOwner: "runner-x",
      result: completedResult(id),
    });
    expect(store.requestCancel(id)).toBe(false);
  });
});

describe("terminalize — one terminal state, one result, one settler (H-I3, §9)", () => {
  it("commits the terminal CAS, the settlement claim and the result row together", () => {
    const { id, token } = preparedWithLease();
    driveToVerifying(id, token);
    store.terminalize(id, {
      expectedVersion: 3,
      from: "VERIFYING",
      to: "COMPLETED",
      leaseToken: token,
      settlementOwner: "runner-x",
      result: completedResult(id),
    });
    expect(store.get(id)!.state).toBe("COMPLETED");
    expect(store.get(id)!.settlementOwner).toBe("runner-x");
    expect(store.get(id)!.endedAt).toBeTruthy();
    expect(store.result(id)!.outcome).toBe("completed");
    expect(store.legacyState(store.get(id)!)).toBe("ENDED_OK");
  });

  it("writes nothing when the result contradicts the transition target", () => {
    const { id, token } = preparedWithLease();
    driveToVerifying(id, token);
    const bad = { ...completedResult(id), terminalState: "FAILED" as TerminalSessionState };
    expect(() =>
      store.terminalize(id, {
        expectedVersion: 3,
        from: "VERIFYING",
        to: "COMPLETED",
        leaseToken: token,
        settlementOwner: "runner-x",
        result: bad,
      }),
    ).toThrow();
    expect(store.get(id)!.state).toBe("VERIFYING");
    expect(store.result(id)).toBeUndefined();
  });

  it("rejects a result whose sessionId points at another session", () => {
    const { id, token } = preparedWithLease();
    driveToVerifying(id, token);
    expect(() =>
      store.terminalize(id, {
        expectedVersion: 3,
        from: "VERIFYING",
        to: "COMPLETED",
        leaseToken: token,
        settlementOwner: "runner-x",
        result: completedResult("es_someone_else"),
      }),
    ).toThrow();
  });

  it("a losing settler cannot double-terminalize", () => {
    const { id, token } = preparedWithLease();
    driveToVerifying(id, token);
    store.terminalize(id, {
      expectedVersion: 3,
      from: "VERIFYING",
      to: "COMPLETED",
      leaseToken: token,
      settlementOwner: "runner-x",
      result: completedResult(id),
    });
    expect(() =>
      store.terminalize(id, {
        expectedVersion: 3,
        from: "VERIFYING",
        to: "COMPLETED",
        leaseToken: token,
        settlementOwner: "runner-y",
        result: completedResult(id),
      }),
    ).toThrow(SessionCasConflictError);
  });
});

describe("boot reconcile worklist", () => {
  it("liveSessions returns only non-terminal sessions", () => {
    const { id: live } = preparedWithLease("erq_live");
    const { id: done, token } = preparedWithLease("erq_done");
    driveToVerifying(done, token);
    store.terminalize(done, {
      expectedVersion: 3,
      from: "VERIFYING",
      to: "COMPLETED",
      leaseToken: token,
      settlementOwner: "runner-x",
      result: completedResult(done),
    });
    expect(store.liveSessions().map((s) => s.sessionId)).toEqual([live]);
  });
});

/** PREPARED → STARTING → RUNNING → VERIFYING, all under `token`, leaving version at 3. */
function driveToVerifying(id: string, token: string): void {
  store.transition(id, { expectedVersion: 0, from: "PREPARED", to: "STARTING", leaseToken: token });
  store.transition(id, { expectedVersion: 1, from: "STARTING", to: "RUNNING", leaseToken: token });
  store.transition(id, { expectedVersion: 2, from: "RUNNING", to: "VERIFYING", leaseToken: token });
}
