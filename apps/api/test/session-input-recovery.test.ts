/**
 * The two correctness cases this slice exists for.
 *
 * RESTART: the server dies between `deliver()` and the durable record of its
 * outcome. A new incarnation must fence the dead owner's attempt, call the
 * outcome unknown rather than sent or failed, and converge on the SAME logical
 * message when the client resubmits its original idempotency key.
 *
 * AMBIGUOUS DELIVERY: the adapter accepted the message but the acknowledgement
 * never reached the caller. A retry must not deliver a second time. This is the
 * hardest case in the slice, so every reconciliation capability combination is
 * covered, including the one where reconciliation is impossible and the only
 * correct behaviour is to refuse to send again.
 *
 * The restart is simulated deterministically in-process — the server instance
 * and its database handle are closed and a new server is built over the same
 * SQLite file with a new lease epoch, while the provider double survives, as a
 * real provider would. No child process is forked.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FakeSessionInputAdapter } from "@agent-plane/adapters";
import type { Db } from "../src/db/index.js";
import type { BuiltServer } from "../src/server.js";
import { boot, newAdapter, seedSession, send, type Workspace } from "./helpers/session-input.js";

let home: string;
const open: Db[] = [];
const servers: BuiltServer[] = [];

function track(ws: Workspace): Workspace {
  open.push(ws.db);
  servers.push(ws.built);
  return ws;
}

/** Closes this incarnation the way a kill does: nothing is settled on the way out. */
async function kill(ws: Workspace): Promise<void> {
  await ws.built.app.close();
  ws.db.close();
  servers.splice(servers.indexOf(ws.built), 1);
  open.splice(open.indexOf(ws.db), 1);
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "agent-plane-input-rec-"));
});

afterEach(async () => {
  for (const s of servers.splice(0)) await s.app.close();
  for (const db of open.splice(0)) db.close();
  rmSync(home, { recursive: true, force: true });
});

/** Submits directly and abandons the delivery mid-flight, as a kill would. */
function submitAndStall(ws: Workspace, sessionId: string, clientMessageId: string): string {
  const { row } = ws.built.sessionInputs!.submit({
    sessionId, clientMessageId, text: "reconcile me", actor: "bearer:test",
  });
  void ws.built.sessionInputs!.dispatch(row.id);
  return row.id;
}

describe("restart correctness", () => {
  it("converges on one delivered message when the server dies after the provider got it", async () => {
    const adapter = newAdapter();
    const first = track(boot(home, { adapter }));
    const { sessionId } = seedSession(first.db);

    adapter.failNext("hang");
    const messageId = submitAndStall(first, sessionId, "client-key");

    // Durable evidence exists before the crash: an attempt was taken.
    expect(first.built.sessionInputs!.attempts(messageId)[0]).toMatchObject({ ordinal: 1, outcome: "in_flight" });
    expect(adapter.received(sessionId)).toHaveLength(1);
    const deadEpoch = first.built.sessionInputs!.leaseEpoch;
    await kill(first);

    // New incarnation, new lease epoch: the dead owner's attempt is fenced.
    const second = track(boot(home, { adapter }));
    expect(second.built.sessionInputs!.leaseEpoch).not.toBe(deadEpoch);
    const afterBoot = second.built.sessionInputs!.get(messageId)!;
    expect(afterBoot).toMatchObject({ state: "accepted", deliveryUnknown: true });
    expect(second.built.sessionInputs!.attempts(messageId)[0]).toMatchObject({
      outcome: "unknown", diagnostic: "owner_lease_expired",
    });
    expect(second.built.sessionInputs!.events(messageId).map((e) => e.type)).toEqual([
      "input.queued", "input.accepted", "input.delivery_unknown",
    ]);

    // The client retries with the ORIGINAL key and converges — no second row,
    // no second attempt, and above all no second delivery.
    const retry = await send(second, sessionId, { clientMessageId: "client-key", text: "reconcile me" });
    expect(retry.statusCode).toBe(202);
    expect(retry.body).toMatchObject({ id: messageId, state: "delivered", deliveryUnknown: false });
    expect(adapter.received(sessionId)).toHaveLength(1);
    expect(second.db.prepare("SELECT COUNT(*) AS n FROM session_inputs").get()).toEqual({ n: 1 });
    expect(second.built.sessionInputs!.attempts(messageId)).toHaveLength(1);
  });

  it("re-delivers exactly once when the server died before the provider saw anything", async () => {
    const adapter = newAdapter();
    const first = track(boot(home, { adapter }));
    const { sessionId } = seedSession(first.db);

    adapter.failNext("hang-before-delivery");
    const messageId = submitAndStall(first, sessionId, "client-key");
    expect(adapter.received(sessionId)).toHaveLength(0);
    await kill(first);

    const second = track(boot(home, { adapter }));
    expect(second.built.sessionInputs!.get(messageId)).toMatchObject({ state: "accepted", deliveryUnknown: true });

    const retry = await send(second, sessionId, { clientMessageId: "client-key", text: "reconcile me" });
    expect(retry.body).toMatchObject({ id: messageId, state: "delivered" });
    // The provider is authoritative that it never arrived, so a fresh attempt
    // cannot duplicate anything — and it produced exactly one delivery.
    expect(adapter.received(sessionId)).toHaveLength(1);
    expect(second.built.sessionInputs!.attempts(messageId).map((a) => a.outcome)).toEqual(["unknown", "delivered"]);
  });

  it("refuses to resend after a restart when the adapter cannot be reconciled", async () => {
    const adapter = newAdapter({ receiptLookup: false, idempotentSend: false });
    const first = track(boot(home, { adapter }));
    const { sessionId } = seedSession(first.db);

    adapter.failNext("hang");
    const messageId = submitAndStall(first, sessionId, "client-key");
    expect(adapter.received(sessionId)).toHaveLength(1);
    await kill(first);

    const second = track(boot(home, { adapter }));
    const retry = await send(second, sessionId, { clientMessageId: "client-key", text: "reconcile me" });
    expect(retry.body).toMatchObject({
      id: messageId, state: "accepted", deliveryUnknown: true, reason: "manual_recovery_required",
    });
    // Neither receipt lookup nor declared idempotency: a blind retry is exactly
    // how a double-delivery happens, so nothing is sent.
    expect(adapter.received(sessionId)).toHaveLength(1);
    expect(second.built.sessionInputs!.attempts(messageId)).toHaveLength(1);
  });

  it("leaves a settled message alone across a restart", async () => {
    const adapter = newAdapter();
    const first = track(boot(home, { adapter }));
    const { sessionId } = seedSession(first.db);
    const sent = await send(first, sessionId, { clientMessageId: "client-key", text: "hi" });
    expect(sent.body.state).toBe("delivered");
    await kill(first);

    const second = track(boot(home, { adapter }));
    expect(second.built.sessionInputs!.get(String(sent.body.id))).toMatchObject({
      state: "delivered", deliveryUnknown: false,
    });
    const retry = await send(second, sessionId, { clientMessageId: "client-key", text: "hi" });
    expect(retry.body).toMatchObject({ id: sent.body.id, state: "delivered" });
    expect(adapter.received(sessionId)).toHaveLength(1);
  });
});

describe("ambiguous delivery — the acknowledgement is lost", () => {
  async function lose(adapter: FakeSessionInputAdapter): Promise<{ ws: Workspace; sessionId: string; id: string }> {
    const ws = track(boot(home, { adapter }));
    const { sessionId } = seedSession(ws.db);
    adapter.failNext("lost-ack");
    const res = await send(ws, sessionId, { clientMessageId: "client-key", text: "did you get this?" });
    // The provider HAS it; the caller cannot know that.
    expect(adapter.received(sessionId)).toHaveLength(1);
    expect(res.statusCode).toBe(202);
    expect(res.body).toMatchObject({ state: "accepted", deliveryUnknown: true });
    expect(String(res.body.state)).not.toBe("rejected");
    expect(String(res.body.state)).not.toBe("delivered");
    return { ws, sessionId, id: String(res.body.id) };
  }

  it("never turns a lost acknowledgement into delivered, rejected or expired", async () => {
    const adapter = newAdapter();
    const { ws, id } = await lose(adapter);
    expect(ws.built.sessionInputs!.attempts(id)[0]).toMatchObject({ outcome: "unknown" });
    expect(ws.built.sessionInputs!.events(id).map((e) => e.type)).toEqual([
      "input.queued", "input.accepted", "input.delivery_unknown",
    ]);
  });

  it("reconciles by receipt lookup without a second delivery", async () => {
    const adapter = newAdapter({ receiptLookup: true, idempotentSend: false });
    const { ws, sessionId, id } = await lose(adapter);

    const retry = await send(ws, sessionId, { clientMessageId: "client-key", text: "did you get this?" });
    expect(retry.body).toMatchObject({ id, state: "delivered", deliveryUnknown: false });
    expect(retry.body.providerReceipt).toMatchObject({ messageId: id });
    // The receipt was looked up, not re-sent: one delivery, one attempt.
    expect(adapter.received(sessionId)).toHaveLength(1);
    expect(ws.built.sessionInputs!.attempts(id)).toHaveLength(1);
  });

  it("re-sends the same id to a declared-idempotent adapter without duplicating", async () => {
    const adapter = newAdapter({ receiptLookup: false, idempotentSend: true });
    const { ws, sessionId, id } = await lose(adapter);

    const retry = await send(ws, sessionId, { clientMessageId: "client-key", text: "did you get this?" });
    expect(retry.body).toMatchObject({ id, state: "delivered" });
    // A second attempt was taken, and the provider still holds exactly one
    // logical message — that is what declared idempotency buys.
    expect(ws.built.sessionInputs!.attempts(id)).toHaveLength(2);
    expect(adapter.received(sessionId)).toHaveLength(1);
  });

  it("stops and asks for a human when the adapter offers neither guarantee", async () => {
    const adapter = newAdapter({ receiptLookup: false, idempotentSend: false });
    const { ws, sessionId, id } = await lose(adapter);

    const retry = await send(ws, sessionId, { clientMessageId: "client-key", text: "did you get this?" });
    expect(retry.body).toMatchObject({ id, state: "accepted", deliveryUnknown: true, reason: "manual_recovery_required" });
    expect(adapter.received(sessionId)).toHaveLength(1);
    expect(ws.built.sessionInputs!.attempts(id)).toHaveLength(1);
  });

  it("retries after a failure that definitely delivered nothing", async () => {
    const adapter = newAdapter();
    const ws = track(boot(home, { adapter }));
    const { sessionId } = seedSession(ws.db);

    adapter.failNext("transport-error");
    const first = await send(ws, sessionId, { clientMessageId: "client-key", text: "hi" });
    expect(first.body).toMatchObject({ state: "accepted", deliveryUnknown: true });
    expect(adapter.received(sessionId)).toHaveLength(0);

    const retry = await send(ws, sessionId, { clientMessageId: "client-key", text: "hi" });
    expect(retry.body).toMatchObject({ id: first.body.id, state: "delivered" });
    expect(adapter.received(sessionId)).toHaveLength(1);
  });

  it("settles a definitive provider refusal as rejected, not unknown", async () => {
    const adapter = newAdapter();
    const ws = track(boot(home, { adapter }));
    const { sessionId } = seedSession(ws.db);

    adapter.failNext("reject");
    const res = await send(ws, sessionId, { clientMessageId: "client-key", text: "hi" });
    expect(res.statusCode).toBe(422);
    expect(res.body).toMatchObject({ state: "rejected", reason: "provider_refused", deliveryUnknown: false });
    expect(adapter.received(sessionId)).toHaveLength(0);

    // A settled message is never re-dispatched by a retry of the same key.
    const retry = await send(ws, sessionId, { clientMessageId: "client-key", text: "hi" });
    expect(retry.body).toMatchObject({ id: res.body.id, state: "rejected" });
    expect(ws.built.sessionInputs!.attempts(String(res.body.id))).toHaveLength(1);
    expect(adapter.received(sessionId)).toHaveLength(0);
  });
});
