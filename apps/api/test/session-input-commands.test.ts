/**
 * Explicit retry and cancel over a message id.
 *
 * The rules this file pins are the ones that keep the two commands from undoing
 * what PR #44 proved: a retry never sends on top of an unresolved attempt, a
 * retry of a rejection never reopens the terminal record, and a cancel never
 * claims a recall the plane cannot perform.
 *
 * Restart and ambiguous-delivery correctness itself lives in
 * `session-input-recovery.test.ts` and is not repeated here.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { canCancelInput, canRetryInput } from "@agent-plane/core";
import type { Db } from "../src/db/index.js";
import type { BuiltServer } from "../src/server.js";
import { boot, command, newAdapter, seedSession, send, type Workspace } from "./helpers/session-input.js";

let home: string;
const open: Db[] = [];
const servers: BuiltServer[] = [];

function track(ws: Workspace): Workspace {
  open.push(ws.db);
  servers.push(ws.built);
  return ws;
}

/** Lets an in-flight dispatch reach the adapter without waiting for it to finish. */
const settleMicrotasks = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "agent-plane-input-cmd-"));
});

afterEach(async () => {
  for (const s of servers.splice(0)) await s.app.close();
  for (const db of open.splice(0)) db.close();
  rmSync(home, { recursive: true, force: true });
});

describe("session input — the command rules", () => {
  it("allows a retry only from a rejection or a resolved-unknown outcome", () => {
    expect(canRetryInput("rejected", false)).toEqual({ allowed: true });
    expect(canRetryInput("accepted", true)).toEqual({ allowed: true });
    // The ambiguous-delivery case: an attempt is live and its outcome is not
    // known yet. Retrying through it is exactly the double-delivery bug.
    expect(canRetryInput("accepted", false)).toEqual({ allowed: false, reason: "delivery_in_flight" });
    expect(canRetryInput("queued", false)).toEqual({ allowed: false, reason: "not_dispatched" });
    expect(canRetryInput("delivered", false)).toEqual({ allowed: false, reason: "already_settled" });
    expect(canRetryInput("expired", false)).toEqual({ allowed: false, reason: "already_settled" });
  });

  it("allows a cancel only before anything was dispatched", () => {
    expect(canCancelInput("queued")).toEqual({ allowed: true });
    expect(canCancelInput("accepted")).toEqual({ allowed: false, reason: "already_dispatched" });
    for (const state of ["delivered", "rejected", "expired"] as const) {
      expect(canCancelInput(state)).toEqual({ allowed: false, reason: "already_settled" });
    }
  });

  it("registers no command route while the capability is off", async () => {
    const ws = track(boot(home, { sessionInput: false }));
    for (const action of ["retry", "cancel"] as const) {
      const res = await ws.built.app.inject({
        method: "POST", url: `/api/inputs/msg_1/${action}`, headers: ws.headers, payload: {},
      });
      expect(res.statusCode).toBe(404);
    }
  });
});

describe("session input — explicit retry", () => {
  it("retries a rejected message as the next generation of the same client key", async () => {
    const adapter = newAdapter();
    const ws = track(boot(home, { adapter }));
    const { sessionId } = seedSession(ws.db);

    adapter.failNext("reject");
    const first = await send(ws, sessionId, { clientMessageId: "c1", text: "please look again" });
    expect(first.statusCode).toBe(422);
    expect(first.body).toMatchObject({ state: "rejected", reason: "provider_refused", generation: 1 });
    const original = first.body.id as string;

    const retried = await command(ws, original, "retry");
    expect(retried.statusCode).toBe(200);
    // Same logical message: same client key, same text, same payload — a new
    // incarnation of it, not a new send the client has to invent a key for.
    expect(retried.body).toMatchObject({
      clientMessageId: "c1", text: "please look again", generation: 2, retryOf: original, state: "delivered",
    });
    expect(retried.body.id).not.toBe(original);
    // Inherited by construction, not recomputed: the fingerprint is identical.
    const [a, b] = ws.db
      .prepare("SELECT payload_fingerprint AS f FROM session_inputs ORDER BY generation")
      .all() as Array<{ f: string }>;
    expect(a!.f).toBe(b!.f);

    // The rejection stays settled and auditable; nothing rewrote it.
    expect(ws.built.sessionInputs!.get(original)).toMatchObject({ state: "rejected", generation: 1 });
    expect(adapter.received(sessionId)).toHaveLength(1);
  });

  it("is idempotent: two retries of one rejection produce one successor", async () => {
    const adapter = newAdapter();
    const ws = track(boot(home, { adapter }));
    const { sessionId } = seedSession(ws.db, { taskState: "COMPLETED" });

    const first = await send(ws, sessionId, { clientMessageId: "c1", text: "too late" });
    expect(first.body).toMatchObject({ state: "rejected" });
    const original = first.body.id as string;

    // The session is still completed, so each retry settles the same way — and
    // the generation key means the second retry adopts the first's successor.
    const one = await command(ws, original, "retry");
    const two = await command(ws, original, "retry");
    expect(one.body.id).toBe(two.body.id);
    expect(ws.db.prepare("SELECT COUNT(*) AS n FROM session_inputs").get()).toEqual({ n: 2 });
    expect(adapter.received(sessionId)).toHaveLength(0);
  });

  it("reconciles an unknown outcome instead of delivering a second time", async () => {
    const adapter = newAdapter();
    const ws = track(boot(home, { adapter }));
    const { sessionId } = seedSession(ws.db);

    adapter.failNext("lost-ack");
    const sent = await send(ws, sessionId, { clientMessageId: "c1", text: "did you get this" });
    const messageId = sent.body.id as string;
    expect(sent.body).toMatchObject({ state: "accepted", deliveryUnknown: true });

    const retried = await command(ws, messageId, "retry");
    expect(retried.statusCode).toBe(200);
    // Reconciled by receipt lookup: the SAME row, resolved — not a successor,
    // and above all not a second delivery.
    expect(retried.body).toMatchObject({ id: messageId, state: "delivered", deliveryUnknown: false, generation: 1 });
    expect(adapter.received(sessionId)).toHaveLength(1);
    expect(ws.db.prepare("SELECT COUNT(*) AS n FROM session_inputs").get()).toEqual({ n: 1 });
  });

  it("refuses a retry the record's own state forbids", async () => {
    const adapter = newAdapter();
    const ws = track(boot(home, { adapter }));
    const queued = seedSession(ws.db, { approvalPending: true });
    const live = seedSession(ws.db);

    const waiting = await send(ws, queued.sessionId, { clientMessageId: "c1", text: "hold" });
    expect(waiting.body).toMatchObject({ state: "queued", reason: "approval_pending" });
    const stillQueued = await command(ws, waiting.body.id as string, "retry");
    expect(stillQueued.statusCode).toBe(409);
    expect(stillQueued.body.reason).toBe("not_dispatched");

    const done = await send(ws, live.sessionId, { clientMessageId: "c2", text: "arrived" });
    expect(done.body).toMatchObject({ state: "delivered" });
    const settled = await command(ws, done.body.id as string, "retry");
    expect(settled.statusCode).toBe(409);
    expect(settled.body.reason).toBe("already_settled");
    expect(adapter.received(live.sessionId)).toHaveLength(1);
  });

  it("refuses a command that names a version the record no longer has", async () => {
    const adapter = newAdapter();
    const ws = track(boot(home, { adapter }));
    const { sessionId } = seedSession(ws.db, { approvalPending: true });

    const queued = await send(ws, sessionId, { clientMessageId: "c1", text: "hold" });
    const stale = await command(ws, queued.body.id as string, "cancel", { expectedVersion: 99 });
    expect(stale.statusCode).toBe(409);
    expect(stale.body.reason).toBe("version_conflict");
    expect(ws.built.sessionInputs!.get(queued.body.id as string)).toMatchObject({ state: "queued" });
  });

  it("traces the command itself, distinctly from the original send", async () => {
    const adapter = newAdapter();
    const ws = track(boot(home, { adapter }));
    const { sessionId } = seedSession(ws.db);

    adapter.failNext("reject");
    const first = await send(ws, sessionId, { clientMessageId: "c1", text: "again" });
    const original = first.body.id as string;
    await command(ws, original, "retry");

    expect(ws.built.sessionInputs!.events(original).map((e) => e.type)).toEqual([
      "input.queued", "input.accepted", "input.rejected", "input.retry_requested",
    ]);
    const retryEvent = ws.built.sessionInputs!.events(original).at(-1)!;
    expect(retryEvent).toMatchObject({ reason: "from_rejected", sessionId, attemptId: null });
  });
});

describe("session input — explicit cancel", () => {
  it("cancels a queued message and records it as not delivered", async () => {
    const adapter = newAdapter();
    const ws = track(boot(home, { adapter }));
    const { sessionId } = seedSession(ws.db, { approvalPending: true });

    const queued = await send(ws, sessionId, { clientMessageId: "c1", text: "never mind" });
    const messageId = queued.body.id as string;

    const cancelled = await command(ws, messageId, "cancel", { expectedVersion: queued.body.version });
    expect(cancelled.statusCode).toBe(200);
    expect(cancelled.body).toMatchObject({ state: "rejected", reason: "cancelled_by_actor" });
    // The command intent is traced before the state change it causes.
    expect(ws.built.sessionInputs!.events(messageId).map((e) => e.type)).toEqual([
      "input.queued", "input.cancelled", "input.rejected",
    ]);
    expect(ws.built.sessionInputs!.attempts(messageId)).toHaveLength(0);
    expect(adapter.received(sessionId)).toHaveLength(0);
  });

  it("refuses to cancel a dispatched message rather than silently doing nothing", async () => {
    const adapter = newAdapter();
    const ws = track(boot(home, { adapter }));
    const { sessionId } = seedSession(ws.db);

    // Parked inside the adapter: an attempt is live and its outcome unknown.
    adapter.failNext("hang");
    const { row } = ws.built.sessionInputs!.submit({
      sessionId, clientMessageId: "c1", text: "recall me", actor: "bearer:test",
    });
    void ws.built.sessionInputs!.dispatch(row.id);
    await settleMicrotasks();

    const refused = await command(ws, row.id, "cancel");
    expect(refused.statusCode).toBe(409);
    expect(refused.body.reason).toBe("already_dispatched");
    // The provider has it; claiming a recall would be a lie.
    expect(adapter.received(sessionId)).toHaveLength(1);
    expect(ws.built.sessionInputs!.get(row.id)).toMatchObject({ state: "accepted" });
  });

  it("refuses to cancel or retry a message that is not this workspace's", async () => {
    const personal = track(boot(home, { workspace: "personal", adapter: newAdapter() }));
    const { sessionId, taskId } = seedSession(personal.db);
    const at = "2026-09-20T09:00:00.000Z";
    personal.db
      .prepare(
        `INSERT INTO session_inputs (id, workspace, session_id, task_id, client_message_id, payload_fingerprint,
           kind, text, actor, state, delivery_unknown, version, created_at, updated_at)
         VALUES ('msg_foreign', 'work', ?, ?, 'cx', 'fp', 'text', 'planted', 'planted', 'rejected', 0, 1, ?, ?)`,
      )
      .run(sessionId, taskId, at, at);

    for (const action of ["retry", "cancel"] as const) {
      // Invisible, not forbidden: the answer must not confirm it exists.
      expect((await command(personal, "msg_foreign", action)).statusCode).toBe(404);
      expect((await command(personal, "msg_missing", action)).statusCode).toBe(404);
    }
    expect(personal.db.prepare("SELECT state FROM session_inputs WHERE id = 'msg_foreign'").get())
      .toEqual({ state: "rejected" });
  });
});
