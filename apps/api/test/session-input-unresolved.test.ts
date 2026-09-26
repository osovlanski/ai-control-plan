/**
 * The cross-session operator read.
 *
 * `/api/inputs/unresolved` exists because the per-session listing cannot answer
 * the only question an operator actually has after an ambiguous delivery: which
 * messages, anywhere in this workspace, is the plane unable to account for? It
 * adds no fact and no state — it is the same rows, findable without already
 * knowing which session to look in.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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

async function unresolved(ws: Workspace, query = ""): Promise<{ statusCode: number; inputs: Array<Record<string, unknown>> }> {
  const res = await ws.built.app.inject({ method: "GET", url: `/api/inputs/unresolved${query}`, headers: ws.headers });
  return { statusCode: res.statusCode, inputs: res.statusCode === 200 ? res.json().inputs : [] };
}

/** Drives one message into `accepted` + unknown with no way to reconcile it. */
async function strand(ws: Workspace, adapter: ReturnType<typeof newAdapter>, sessionId: string, key: string): Promise<string> {
  adapter.failNext("lost-ack");
  const first = await send(ws, sessionId, { clientMessageId: key, text: "did you get this?" });
  expect(first.body).toMatchObject({ state: "accepted", deliveryUnknown: true });
  const again = await send(ws, sessionId, { clientMessageId: key, text: "did you get this?" });
  expect(again.body).toMatchObject({ state: "accepted", deliveryUnknown: true, reason: "manual_recovery_required" });
  return String(again.body.id);
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "agent-plane-input-unresolved-"));
});

afterEach(async () => {
  for (const s of servers.splice(0)) await s.app.close();
  for (const db of open.splice(0)) db.close();
  rmSync(home, { recursive: true, force: true });
});

describe("session input — the unresolved read", () => {
  it("is empty while every message is accounted for", async () => {
    const ws = track(boot(home, { adapter: newAdapter() }));
    const { sessionId } = seedSession(ws.db);
    expect((await send(ws, sessionId, { clientMessageId: "c1", text: "hi" })).body.state).toBe("delivered");
    expect(await unresolved(ws)).toMatchObject({ statusCode: 200, inputs: [] });
  });

  it("reports messages needing a human across every session, with the reason on the row", async () => {
    // Neither guarantee, so a blind resend is forbidden and the plane must ask.
    const adapter = newAdapter({ receiptLookup: false, idempotentSend: false });
    const ws = track(boot(home, { adapter }));
    const one = seedSession(ws.db);
    const two = seedSession(ws.db);
    const first = await strand(ws, adapter, one.sessionId, "c1");
    const second = await strand(ws, adapter, two.sessionId, "c2");

    const { inputs } = await unresolved(ws);
    expect(inputs.map((row) => row.id).sort()).toEqual([first, second].sort());
    for (const row of inputs) {
      expect(row).toMatchObject({ state: "accepted", deliveryUnknown: true, reason: "manual_recovery_required" });
      // The attempt evidence travels with the row: an operator deciding what to
      // do next needs the diagnostic, not just the verdict.
      expect(row.attempts).toHaveLength(1);
    }
    expect(new Set(inputs.map((row) => row.sessionId))).toEqual(new Set([one.sessionId, two.sessionId]));
  });

  it("includes an unresolved message that reconciliation may still settle", async () => {
    // `manual_recovery_required` is the worst half of the unresolved set, not
    // the whole of it; an operator must see both.
    const adapter = newAdapter();
    const ws = track(boot(home, { adapter }));
    const { sessionId } = seedSession(ws.db);
    adapter.failNext("lost-ack");
    const sent = await send(ws, sessionId, { clientMessageId: "c1", text: "hi" });
    // Its reason is the attempt's own diagnostic, not the recovery verdict:
    // this one can still be settled by asking the adapter again.
    expect(sent.body).toMatchObject({ state: "accepted", deliveryUnknown: true });
    expect(sent.body.reason).not.toBe("manual_recovery_required");

    const { inputs } = await unresolved(ws);
    expect(inputs).toHaveLength(1);
    expect(inputs[0]).toMatchObject({ id: sent.body.id, deliveryUnknown: true });
    expect(inputs[0]!.reason).not.toBe("manual_recovery_required");
  });

  it("never shows another workspace's records", async () => {
    const ws = track(boot(home, { workspace: "personal", adapter: newAdapter() }));
    const { sessionId, taskId } = seedSession(ws.db);
    const at = "2026-09-20T09:00:00.000Z";
    ws.db
      .prepare(
        `INSERT INTO session_inputs (id, workspace, session_id, task_id, client_message_id, payload_fingerprint,
           kind, text, actor, state, reason, delivery_unknown, version, created_at, updated_at)
         VALUES ('msg_foreign', 'work', ?, ?, 'cx', 'fp', 'text', 'planted', 'planted', 'accepted',
                 'manual_recovery_required', 1, 1, ?, ?)`,
      )
      .run(sessionId, taskId, at, at);
    expect((await unresolved(ws)).inputs).toEqual([]);
  });

  it("is a route, never a message id", async () => {
    const ws = track(boot(home, { adapter: newAdapter() }));
    // `/api/inputs/:id` must not swallow it — otherwise the operator read
    // silently becomes a 404 for a message called "unresolved".
    expect((await unresolved(ws)).statusCode).toBe(200);
    expect((await unresolved(ws, "?limit=1")).statusCode).toBe(200);
  });

  it("does not exist while the capability is off", async () => {
    const ws = track(boot(home, { sessionInput: false }));
    expect((await unresolved(ws)).statusCode).toBe(404);
  });
});
