/**
 * Scheduler-owned redelivery: a message queued behind a quota pause or a
 * pending approval resumes on its own when the condition clears, driven by the
 * kernel's own task-state announcement rather than by a timer in this module.
 *
 * The last test is the hard case this slice adds — an automatic redelivery and
 * a client-initiated retry contending for the SAME message. Exactly one attempt
 * may exist, the provider may hold the text exactly once, and the loser must be
 * told why it lost rather than quietly doing nothing.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../src/db/index.js";
import type { BuiltServer } from "../src/server.js";
import { announceState, boot, command, newAdapter, seedSession, send, type Workspace } from "./helpers/session-input.js";

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

/** Lets an in-flight dispatch reach the adapter without waiting for it to finish. */
const settleMicrotasks = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "agent-plane-input-redeliver-"));
});

afterEach(async () => {
  for (const s of servers.splice(0)) await s.app.close();
  for (const db of open.splice(0)) db.close();
  rmSync(home, { recursive: true, force: true });
});

describe("session input — scheduler-owned redelivery", () => {
  it("redelivers a message queued behind a quota pause when the pause clears", async () => {
    const adapter = newAdapter();
    const ws = track(boot(home, { adapter }));
    const { sessionId, taskId } = seedSession(ws.db, { taskState: "LIMIT_PAUSED" });

    const queued = await send(ws, sessionId, { clientMessageId: "c1", text: "resume me" });
    expect(queued.body).toMatchObject({ state: "queued", reason: "quota_paused" });
    expect(adapter.received(sessionId)).toHaveLength(0);

    // The scheduler releases the quota wait and the kernel announces it. No
    // client action follows; the plane owns the recovery.
    ws.db.prepare("UPDATE tasks SET state = 'RUNNING' WHERE id = ?").run(taskId);
    await announceState(ws, taskId, "RUNNING");

    expect(ws.built.sessionInputs!.get(queued.body.id as string)).toMatchObject({ state: "delivered" });
    expect(adapter.received(sessionId)).toHaveLength(1);
    expect(ws.built.sessionInputs!.events(queued.body.id as string).map((e) => e.type)).toEqual([
      "input.queued", "input.accepted", "input.delivered",
    ]);
  });

  it("redelivers a message queued behind an approval when the approval clears", async () => {
    const adapter = newAdapter();
    const ws = track(boot(home, { adapter }));
    const { sessionId, taskId } = seedSession(ws.db, { approvalPending: true });

    const queued = await send(ws, sessionId, { clientMessageId: "c1", text: "after you decide" });
    expect(queued.body).toMatchObject({ state: "queued", reason: "approval_pending" });

    ws.db.prepare("UPDATE approvals SET state = 'answered' WHERE session_id = ?").run(sessionId);
    await announceState(ws, taskId, "RUNNING");

    expect(ws.built.sessionInputs!.get(queued.body.id as string)).toMatchObject({ state: "delivered" });
    expect(adapter.received(sessionId)).toHaveLength(1);
  });

  it("does not redeliver while the blocking condition still holds", async () => {
    const adapter = newAdapter();
    const ws = track(boot(home, { adapter }));
    const { sessionId, taskId } = seedSession(ws.db, { taskState: "LIMIT_PAUSED" });

    const queued = await send(ws, sessionId, { clientMessageId: "c1", text: "still blocked" });
    await announceState(ws, taskId, "LIMIT_PAUSED");

    expect(ws.built.sessionInputs!.get(queued.body.id as string)).toMatchObject({
      state: "queued", reason: "quota_paused",
    });
    expect(ws.built.sessionInputs!.attempts(queued.body.id as string)).toHaveLength(0);
    expect(adapter.received(sessionId)).toHaveLength(0);
  });

  it("leaves messages queued for any other reason alone", async () => {
    // Redelivery is scoped to the two conditions the kernel can clear today.
    // A context barrier is deliberately NOT one of them: compaction is
    // policy-only until the kernel has a compaction record (K10).
    const adapter = newAdapter({ liveDelivery: [] });
    const ws = track(boot(home, { adapter }));
    const { sessionId, taskId } = seedSession(ws.db);

    const queued = await send(ws, sessionId, { clientMessageId: "c1", text: "no live delivery" });
    expect(queued.body).toMatchObject({ state: "queued", reason: "adapter_no_live_delivery" });

    await announceState(ws, taskId, "RUNNING");

    expect(ws.built.sessionInputs!.get(queued.body.id as string)).toMatchObject({ state: "queued" });
    expect(adapter.received(sessionId)).toHaveLength(0);
  });

  it("ignores every frame that is not a task-state announcement", async () => {
    const adapter = newAdapter();
    const ws = track(boot(home, { adapter }));
    const { sessionId, taskId } = seedSession(ws.db, { taskState: "LIMIT_PAUSED" });
    const queued = await send(ws, sessionId, { clientMessageId: "c1", text: "resume me" });

    ws.db.prepare("UPDATE tasks SET state = 'RUNNING' WHERE id = ?").run(taskId);
    ws.built.bus.publish(taskId, { kind: "notice", notice: { level: "info", text: "unrelated" } });
    await ws.built.sessionInputRedelivery!();

    expect(ws.built.sessionInputs!.get(queued.body.id as string)).toMatchObject({ state: "queued" });
    expect(adapter.received(sessionId)).toHaveLength(0);
  });

  /**
   * THE hard case of this slice.
   *
   * An automatic redelivery is in flight — the pump took the message, wrote its
   * attempt under this incarnation's lease epoch, and is parked inside the
   * adapter with the provider already holding the text. A client-initiated
   * retry arrives for the same message at exactly that moment.
   *
   * The automatic attempt is not privileged and the client retry is not
   * privileged: the record's state is. The retry is refused with
   * `delivery_in_flight` — the same answer the ambiguous-delivery rules give
   * any caller who tries to send on top of an unresolved attempt — so no second
   * attempt and no second delivery can exist. Only after a restart fences the
   * dead owner's attempt into a known-unknown does a retry become legal, and
   * then it reconciles rather than re-sends.
   */
  it("fences an automatic redelivery against a concurrent client retry", async () => {
    const adapter = newAdapter();
    const first = track(boot(home, { adapter }));
    const { sessionId, taskId } = seedSession(first.db, { taskState: "LIMIT_PAUSED" });

    const queued = await send(first, sessionId, { clientMessageId: "c1", text: "exactly once" });
    const messageId = queued.body.id as string;
    expect(queued.body).toMatchObject({ state: "queued", reason: "quota_paused" });

    // The pause clears; the automatic redelivery parks inside the adapter with
    // the provider already holding the message and no acknowledgement returned.
    first.db.prepare("UPDATE tasks SET state = 'RUNNING' WHERE id = ?").run(taskId);
    adapter.fail(messageId, "hang");
    first.built.bus.publish(taskId, { kind: "state", state: { state: "RUNNING" } });
    await settleMicrotasks();

    const deadEpoch = first.built.sessionInputs!.leaseEpoch;
    expect(first.built.sessionInputs!.attempts(messageId)).toMatchObject([
      { ordinal: 1, outcome: "in_flight", leaseEpoch: deadEpoch },
    ]);
    expect(adapter.received(sessionId)).toHaveLength(1);

    // The client retries into the middle of it and is refused, loudly.
    const contended = await command(first, messageId, "retry");
    expect(contended.statusCode).toBe(409);
    expect(contended.body.reason).toBe("delivery_in_flight");
    expect(first.built.sessionInputs!.attempts(messageId)).toHaveLength(1);
    expect(adapter.received(sessionId)).toHaveLength(1);
    expect(first.built.sessionInputs!.get(messageId)).toMatchObject({
      state: "accepted", deliveryUnknown: false,
    });

    // The owner dies mid-attempt. The new incarnation fences it by lease epoch
    // and calls the outcome unknown — never sent, never failed.
    await kill(first);
    const second = track(boot(home, { adapter }));
    expect(second.built.sessionInputs!.leaseEpoch).not.toBe(deadEpoch);
    expect(second.built.sessionInputs!.get(messageId)).toMatchObject({
      state: "accepted", deliveryUnknown: true,
    });
    expect(second.built.sessionInputs!.attempts(messageId)).toMatchObject([
      { outcome: "unknown", diagnostic: "owner_lease_expired" },
    ]);

    // NOW the retry is legal, and it reconciles by receipt rather than sending.
    const resolved = await command(second, messageId, "retry");
    expect(resolved.statusCode).toBe(200);
    expect(resolved.body).toMatchObject({
      id: messageId, state: "delivered", deliveryUnknown: false, generation: 1, retryOf: null,
    });
    expect(adapter.received(sessionId)).toHaveLength(1);
    expect(second.built.sessionInputs!.attempts(messageId)).toHaveLength(1);
    expect(second.db.prepare("SELECT COUNT(*) AS n FROM session_inputs").get()).toEqual({ n: 1 });
  });
});
