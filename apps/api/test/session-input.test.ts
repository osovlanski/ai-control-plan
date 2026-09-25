/**
 * Durable session-addressed conversational input — contract behaviour.
 *
 * Restart and ambiguous-delivery correctness live in
 * `session-input-recovery.test.ts`; this file pins the flag boundary, the state
 * machine, addressing/authorization, idempotency, the per-lifecycle policy and
 * the normalized traces.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  MAX_SESSION_INPUT_TEXT_BYTES,
  SESSION_INPUT_CONDITIONS,
  canClaimDelivered,
  canInputTransition,
  canReconcileUnknown,
  inputPolicy,
  type SessionInputCapabilities,
} from "@agent-plane/core";
import { loadConfig } from "../src/config.js";
import { openDb, type Db } from "../src/db/index.js";
import { buildServer, type BuiltServer } from "../src/server.js";
import { credentialPath, readCredential } from "../src/auth/credential-file.js";
import { boot, newAdapter, seedSession, send, type Workspace } from "./helpers/session-input.js";

let home: string;
const open: Db[] = [];
const servers: BuiltServer[] = [];

function track(ws: Workspace): Workspace {
  open.push(ws.db);
  servers.push(ws.built);
  return ws;
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "agent-plane-input-"));
});

afterEach(async () => {
  for (const s of servers.splice(0)) await s.app.close();
  for (const db of open.splice(0)) db.close();
  rmSync(home, { recursive: true, force: true });
});

const caps = (over: Partial<SessionInputCapabilities> = {}): SessionInputCapabilities => ({
  capabilityVersion: "t/1",
  kinds: ["text"],
  ackLevel: "provider-accepted",
  idempotentSend: true,
  receiptLookup: true,
  liveDelivery: ["running", "waiting-input"],
  ...over,
});

describe("session input — the feature flag", () => {
  it("defaults to OFF, so the capability does not exist in a fresh workspace", () => {
    const config = loadConfig({ AGENT_PLANE_HOME: home });
    expect(config.sessionInput.enabled).toBe(false);
  });

  it("registers no input route and writes no ledger row while it is off", async () => {
    const ws = track(boot(home, { sessionInput: false }));
    const { sessionId } = seedSession(ws.db);

    const post = await send(ws, sessionId, { clientMessageId: "c1", text: "hello" });
    expect(post.statusCode).toBe(404);
    const list = await ws.built.app.inject({
      method: "GET", url: `/api/sessions/${sessionId}/inputs`, headers: ws.headers,
    });
    expect(list.statusCode).toBe(404);
    expect(ws.built.sessionInputs).toBeUndefined();
    expect(ws.db.prepare("SELECT COUNT(*) AS n FROM session_inputs").get()).toEqual({ n: 0 });
  });

  it("keeps the existing approval input route unchanged while it is off", async () => {
    const ws = track(boot(home, { sessionInput: false }));
    const { taskId } = seedSession(ws.db);
    const res = await ws.built.app.inject({
      method: "POST", url: `/api/tasks/${taskId}/input`, headers: ws.headers,
      payload: { kind: "message", text: "hi" },
    });
    // Exactly the pre-slice behaviour: arbitrary message input is a 400.
    expect(res.statusCode).toBe(400);
  });

  it("advertises the capability state so a client never has to probe a route", async () => {
    const off = track(boot(home, { sessionInput: false }));
    const offBody = (await off.built.app.inject({ method: "GET", url: "/api/workspace", headers: off.headers })).json();
    expect(offBody.sessionInput).toEqual({ enabled: false });

    const on = track(boot(home, { workspace: "work", sessionInput: true }));
    const onBody = (await on.built.app.inject({ method: "GET", url: "/api/workspace", headers: on.headers })).json();
    expect(onBody.sessionInput).toEqual({ enabled: true });
  });

  it("rejects a non-boolean flag rather than guessing", () => {
    mkdirSync(join(home, "bad"), { recursive: true });
    writeFileSync(join(home, "bad", "config.yaml"), "workspace: bad\nsessionInput:\n  enabled: yes-please\n");
    expect(() => loadConfig({ AGENT_PLANE_HOME: home, AGENT_PLANE_WORKSPACE: "bad" })).toThrow(
      /sessionInput.enabled must be a boolean/,
    );
  });
});

describe("session input — state machine", () => {
  it("allows only the contract's edges", () => {
    expect(canInputTransition("queued", "accepted")).toBe(true);
    expect(canInputTransition("queued", "rejected")).toBe(true);
    expect(canInputTransition("queued", "expired")).toBe(true);
    expect(canInputTransition("accepted", "delivered")).toBe(true);
    expect(canInputTransition("accepted", "rejected")).toBe(true);
  });

  it("never expires a message that was already dispatched", () => {
    // Uncertainty must not be turned into a terminal "not delivered".
    expect(canInputTransition("accepted", "expired")).toBe(false);
  });

  it("makes every terminal state final", () => {
    for (const from of ["delivered", "rejected", "expired"] as const) {
      for (const to of ["queued", "accepted", "delivered", "rejected", "expired"] as const) {
        expect(canInputTransition(from, to)).toBe(false);
      }
    }
  });

  it("lets only a provider-level acknowledgement claim delivery", () => {
    expect(canClaimDelivered(caps({ ackLevel: "transport" }))).toBe(false);
    expect(canClaimDelivered(caps({ ackLevel: "provider-accepted" }))).toBe(true);
    expect(canClaimDelivered(caps({ ackLevel: "provider-consumed" }))).toBe(true);
  });

  it("reconciles an unknown outcome only with receipt lookup or declared idempotency", () => {
    expect(canReconcileUnknown(caps({ receiptLookup: false, idempotentSend: false }))).toBe(false);
    expect(canReconcileUnknown(caps({ receiptLookup: true, idempotentSend: false }))).toBe(true);
    expect(canReconcileUnknown(caps({ receiptLookup: false, idempotentSend: true }))).toBe(true);
  });
});

describe("session input — policy for every session condition", () => {
  it("defines an explicit decision for all eight conditions", () => {
    for (const condition of SESSION_INPUT_CONDITIONS) {
      expect(inputPolicy(condition, caps()).decision).toBeTruthy();
    }
  });

  it("dispatches live text only where the adapter declares it", () => {
    expect(inputPolicy("running", caps()).decision).toBe("dispatch");
    expect(inputPolicy("waiting-input", caps()).decision).toBe("dispatch");
    expect(inputPolicy("running", caps({ liveDelivery: [] }))).toEqual({
      decision: "queue", reason: "adapter_no_live_delivery",
    });
  });

  it("queues without bypassing an approval, a quota pause or a context barrier", () => {
    expect(inputPolicy("approval-blocked", caps())).toEqual({ decision: "queue", reason: "approval_pending" });
    expect(inputPolicy("quota-paused", caps())).toEqual({ decision: "queue", reason: "quota_paused" });
    // `compacting` has no kernel record yet (K10 unimplemented) — the policy is
    // defined and tested here so the arm is ready when the record exists.
    expect(inputPolicy("compacting", caps())).toEqual({ decision: "queue", reason: "context_barrier" });
  });

  it("refuses to restart finished work by sending text", () => {
    expect(inputPolicy("completed", caps())).toEqual({ decision: "reject", reason: "session_completed" });
    expect(inputPolicy("failed", caps())).toEqual({ decision: "reject", reason: "session_failed" });
    expect(inputPolicy("cancelled", caps())).toEqual({ decision: "reject", reason: "session_cancelled" });
    // Terminality outranks capability: no adapter can make this dispatchable.
    expect(inputPolicy("completed", undefined)).toEqual({ decision: "reject", reason: "session_completed" });
  });

  it("rejects an unsupported adapter or input kind before any dispatch", () => {
    expect(inputPolicy("running", undefined)).toEqual({ decision: "reject", reason: "adapter_input_unsupported" });
    expect(inputPolicy("running", caps(), "audio")).toEqual({ decision: "reject", reason: "input_kind_unsupported" });
  });
});

describe("session input — addressing and authorization", () => {
  it("delivers a message addressed to a running session", async () => {
    const adapter = newAdapter();
    const ws = track(boot(home, { adapter }));
    const { sessionId, taskId } = seedSession(ws.db);

    const res = await send(ws, sessionId, { clientMessageId: "c1", text: "please rerun the tests" });
    expect(res.statusCode).toBe(202);
    expect(res.body).toMatchObject({ state: "delivered", deliveryUnknown: false, sessionId, taskId });
    expect(res.body.providerReceipt).toMatchObject({ ackLevel: "provider-accepted" });
    expect(adapter.received(sessionId).map((e) => e.text)).toEqual(["please rerun the tests"]);
  });

  it("returns 404 for an unknown session without revealing anything", async () => {
    const ws = track(boot(home, { adapter: newAdapter() }));
    const res = await send(ws, "run_does_not_exist", { clientMessageId: "c1", text: "hi" });
    expect(res.statusCode).toBe(404);
  });

  it("cannot address a session that belongs to another workspace", async () => {
    const personal = track(boot(home, { workspace: "personal", adapter: newAdapter() }));
    const work = track(boot(home, { workspace: "work", adapter: newAdapter() }));
    const { sessionId } = seedSession(personal.db);

    // Separate database per workspace: the id simply does not resolve.
    expect((await send(work, sessionId, { clientMessageId: "c1", text: "hi" })).statusCode).toBe(404);

    // And a row planted with a foreign workspace stamp stays invisible even
    // when the session id does resolve in this database.
    const other = seedSession(personal.db);
    personal.db
      .prepare(
        `INSERT INTO session_inputs (id, workspace, session_id, task_id, client_message_id, payload_fingerprint,
           kind, text, actor, state, delivery_unknown, version, created_at, updated_at)
         VALUES ('msg_foreign', 'work', ?, ?, 'cx', 'fp', 'text', 'planted', 'planted', 'queued', 0, 1, ?, ?)`,
      )
      .run(other.sessionId, other.taskId, "2026-09-20T09:00:00.000Z", "2026-09-20T09:00:00.000Z");
    expect((await send(personal, other.sessionId, { clientMessageId: "c1", text: "hi" })).statusCode).toBe(404);
    const read = await personal.built.app.inject({
      method: "GET", url: "/api/inputs/msg_foreign", headers: personal.headers,
    });
    expect(read.statusCode).toBe(404);
  });

  it("requires a credential", async () => {
    const ws = track(boot(home, { adapter: newAdapter() }));
    const { sessionId } = seedSession(ws.db);
    const res = await ws.built.app.inject({
      method: "POST", url: `/api/sessions/${sessionId}/inputs`, payload: { clientMessageId: "c1", text: "hi" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("bounds the payload at the trust boundary", async () => {
    const ws = track(boot(home, { adapter: newAdapter() }));
    const { sessionId } = seedSession(ws.db);
    for (const body of [
      { clientMessageId: "c1", text: "   " },
      { clientMessageId: "", text: "hi" },
      { clientMessageId: "c".repeat(200), text: "hi" },
      { clientMessageId: "c1", text: "x".repeat(MAX_SESSION_INPUT_TEXT_BYTES + 1) },
      { clientMessageId: "c1", text: "hi", kind: "audio" },
      { clientMessageId: "c1", text: "hi", expiresAt: "not-a-date" },
    ]) {
      expect((await send(ws, sessionId, body)).statusCode).toBe(400);
    }
    expect(ws.db.prepare("SELECT COUNT(*) AS n FROM session_inputs").get()).toEqual({ n: 0 });
  });
});

describe("session input — idempotency", () => {
  it("makes a retried submit the same logical message and the same delivery", async () => {
    const adapter = newAdapter();
    const ws = track(boot(home, { adapter }));
    const { sessionId } = seedSession(ws.db);
    const body = { clientMessageId: "client-key-1", text: "same text" };

    const first = await send(ws, sessionId, body);
    const second = await send(ws, sessionId, body);

    expect(first.body.id).toBe(second.body.id);
    expect(second.body.state).toBe("delivered");
    expect(ws.db.prepare("SELECT COUNT(*) AS n FROM session_inputs").get()).toEqual({ n: 1 });
    expect(ws.built.sessionInputs!.attempts(String(first.body.id))).toHaveLength(1);
    expect(adapter.received(sessionId)).toHaveLength(1);
  });

  it("rejects the same key with a different payload as a conflict, not a retry", async () => {
    const ws = track(boot(home, { adapter: newAdapter() }));
    const { sessionId } = seedSession(ws.db);
    await send(ws, sessionId, { clientMessageId: "k", text: "first" });
    const res = await send(ws, sessionId, { clientMessageId: "k", text: "second" });
    expect(res.statusCode).toBe(409);
    expect(ws.db.prepare("SELECT COUNT(*) AS n FROM session_inputs").get()).toEqual({ n: 1 });
  });

  it("keeps distinct keys as distinct messages", async () => {
    const adapter = newAdapter();
    const ws = track(boot(home, { adapter }));
    const { sessionId } = seedSession(ws.db);
    await send(ws, sessionId, { clientMessageId: "a", text: "one" });
    await send(ws, sessionId, { clientMessageId: "b", text: "two" });
    expect(adapter.received(sessionId)).toHaveLength(2);
  });

  it("resolves a lost response through the canonical reads", async () => {
    const ws = track(boot(home, { adapter: newAdapter() }));
    const { sessionId } = seedSession(ws.db);
    const first = await send(ws, sessionId, { clientMessageId: "k", text: "hi" });

    const list = await ws.built.app.inject({
      method: "GET", url: `/api/sessions/${sessionId}/inputs`, headers: ws.headers,
    });
    expect(list.json().inputs.map((i: { clientMessageId: string }) => i.clientMessageId)).toEqual(["k"]);
    const one = await ws.built.app.inject({
      method: "GET", url: `/api/inputs/${first.body.id}`, headers: ws.headers,
    });
    expect(one.json()).toMatchObject({ id: first.body.id, state: "delivered" });
  });
});

describe("session input — behaviour in each kernel lifecycle condition", () => {
  const cases: Array<[string, Parameters<typeof seedSession>[1], { status: number; state: string; reason: string | null }]> = [
    ["running", { taskState: "RUNNING", sessionState: "RUNNING" }, { status: 202, state: "delivered", reason: null }],
    ["waiting for input", { taskState: "WAITING_INPUT", sessionState: "PAUSED" }, { status: 202, state: "delivered", reason: null }],
    ["approval-blocked (session)", { sessionState: "AWAITING_APPROVAL" }, { status: 202, state: "queued", reason: "approval_pending" }],
    ["approval-blocked (pending row)", { approvalPending: true }, { status: 202, state: "queued", reason: "approval_pending" }],
    ["quota-paused", { taskState: "LIMIT_PAUSED", sessionState: "PAUSED" }, { status: 202, state: "queued", reason: "quota_paused" }],
    ["completed", { taskState: "COMPLETED", sessionState: "COMPLETED" }, { status: 422, state: "rejected", reason: "session_completed:COMPLETED" }],
    ["failed", { taskState: "FAILED", sessionState: "FAILED" }, { status: 422, state: "rejected", reason: "session_failed:FAILED" }],
    ["cancelled", { taskState: "CANCELLED", sessionState: "CANCELLED" }, { status: 422, state: "rejected", reason: "session_cancelled:CANCELLED" }],
  ];

  for (const [name, seed, expected] of cases) {
    it(`handles a ${name} session explicitly`, async () => {
      const adapter = newAdapter();
      const ws = track(boot(home, { adapter }));
      const { sessionId } = seedSession(ws.db, seed);
      const res = await send(ws, sessionId, { clientMessageId: "c1", text: "follow up" });
      expect(res.statusCode).toBe(expected.status);
      expect(res.body).toMatchObject({ state: expected.state, reason: expected.reason });
      // Nothing but an explicit dispatch ever reaches the provider.
      expect(adapter.received(sessionId)).toHaveLength(expected.state === "delivered" ? 1 : 0);
    });
  }

  it("rejects input for an assistant whose adapter declares no input capability", async () => {
    const ws = track(boot(home));
    const { sessionId } = seedSession(ws.db, { assistantId: "real-a" });
    const res = await send(ws, sessionId, { clientMessageId: "c1", text: "hi" });
    expect(res.statusCode).toBe(422);
    expect(res.body).toMatchObject({ state: "rejected", reason: "adapter_input_unsupported" });
  });

  it("expires a message whose deadline passed while it was definitely undispatched", async () => {
    const adapter = newAdapter();
    const ws = track(boot(home, { adapter }));
    const { sessionId } = seedSession(ws.db);
    const res = await send(ws, sessionId, {
      clientMessageId: "c1", text: "too late", expiresAt: "2020-01-01T00:00:00.000Z",
    });
    expect(res.statusCode).toBe(422);
    expect(res.body).toMatchObject({ state: "expired", reason: "deadline_passed_undispatched" });
    expect(adapter.received(sessionId)).toHaveLength(0);
  });

  it("never claims delivery from a transport-only acknowledgement", async () => {
    const adapter = newAdapter({ ackLevel: "transport" });
    const ws = track(boot(home, { adapter }));
    const { sessionId } = seedSession(ws.db);
    const res = await send(ws, sessionId, { clientMessageId: "c1", text: "hi" });
    expect(res.body).toMatchObject({ state: "accepted", deliveryUnknown: true, reason: "transport_ack_only" });
    expect(String(res.body.state)).not.toBe("delivered");
  });
});

describe("session input — normalized traces", () => {
  it("emits one event per state change, carrying the full identity", async () => {
    const ws = track(boot(home, { adapter: newAdapter() }));
    const { sessionId, taskId } = seedSession(ws.db);
    const res = await send(ws, sessionId, { clientMessageId: "c1", text: "hi" });

    const events = ws.built.sessionInputs!.events(String(res.body.id));
    expect(events.map((e) => e.type)).toEqual(["input.queued", "input.accepted", "input.delivered"]);
    for (const event of events) {
      expect(event).toMatchObject({ messageId: res.body.id, sessionId, taskId, workspace: "personal" });
      expect(event.actor).toMatch(/^bearer:/);
    }
    // Accepted and delivered are attributable to the attempt that produced them.
    expect(events[0]!.attemptId).toBeNull();
    expect(events[1]!.attemptId).toBe(events[2]!.attemptId);
  });

  it("traces a rejection without inventing an attempt", async () => {
    const ws = track(boot(home, { adapter: newAdapter() }));
    const { sessionId } = seedSession(ws.db, { taskState: "COMPLETED", sessionState: "COMPLETED" });
    const res = await send(ws, sessionId, { clientMessageId: "c1", text: "hi" });
    const events = ws.built.sessionInputs!.events(String(res.body.id));
    expect(events.map((e) => e.type)).toEqual(["input.queued", "input.rejected"]);
    expect(ws.built.sessionInputs!.attempts(String(res.body.id))).toHaveLength(0);
  });

  it("records the capability version an attempt was made under", async () => {
    const adapter = newAdapter({ capabilityVersion: "fake-session-input/7" });
    const ws = track(boot(home, { adapter }));
    const { sessionId } = seedSession(ws.db);
    const res = await send(ws, sessionId, { clientMessageId: "c1", text: "hi" });
    expect(ws.built.sessionInputs!.attempts(String(res.body.id))[0]).toMatchObject({
      ordinal: 1, outcome: "delivered", capabilityVersion: "fake-session-input/7", adapter: "fake-a",
    });
  });
});

describe("session input — the migration is unconditional", () => {
  it("creates the ledger even in a workspace with the capability off", () => {
    const config = loadConfig({ AGENT_PLANE_HOME: home });
    const db = openDb(config.dbPath);
    open.push(db);
    const built = buildServer({ config, db });
    servers.push(built);
    expect(
      db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'session_input%'").all(),
    ).toHaveLength(3);
    expect(readCredential(credentialPath(config.dir)).secrets.length).toBeGreaterThan(0);
  });
});
