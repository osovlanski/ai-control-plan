import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SessionInputRejectedError, SessionInputUnresolvedError, type SessionInputAdapter } from "@agent-plane/core";
import { boot, command, newAdapter, seedSession, send, type Workspace } from "./helpers/session-input.js";

const homes: string[] = [];
const workspaces: Workspace[] = [];
function setup(adapter?: SessionInputAdapter, sessionInput = true) {
  const home = mkdtempSync(join(tmpdir(), "input-contract-"));
  homes.push(home);
  const ws = boot(home, { adapter, sessionInput });
  workspaces.push(ws);
  return { ws, ...seedSession(ws.db) };
}
afterEach(async () => {
  for (const ws of workspaces.splice(0)) { await ws.built.app.close(); ws.db.close(); }
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

describe("provider-neutral live-input contract", () => {
  it("probes the exact target on each capability read and preserves in-process adapters", async () => {
    const adapter: SessionInputAdapter = newAdapter();
    const { ws, sessionId } = setup(adapter);
    const read = () => ws.built.app.inject({ url: `/api/sessions/${sessionId}/input-capability`, headers: ws.headers });
    expect((await read()).json()).toMatchObject({ available: true, policy: "dispatch" });
    let alive = true;
    adapter.probeTarget = async (target) => {
      expect(target).toEqual({ sessionId, assistantId: "fake-a", providerSessionRef: `provider-${sessionId}` });
      return { available: alive, reason: alive ? undefined : "provider_unreachable" };
    };
    expect((await read()).json()).toMatchObject({ available: true });
    alive = false;
    expect((await read()).json()).toMatchObject({ available: false, reason: "provider_unreachable" });
    const unsupported = seedSession(ws.db, { assistantId: "codex-a" });
    expect((await ws.built.app.inject({ url: `/api/sessions/${unsupported.sessionId}/input-capability`, headers: ws.headers })).json()).toMatchObject({ available: false, reason: "adapter_input_unsupported" });
    expect((await ws.built.app.inject({ url: "/api/sessions/absent/input-capability", headers: ws.headers })).statusCode).toBe(404);
    expect((await ws.built.app.inject({ url: `/api/sessions/${sessionId}/input-capability` })).statusCode).toBe(401);
  });

  it("does not register capability routes while disabled", async () => {
    const { ws, sessionId } = setup(undefined, false);
    expect((await ws.built.app.inject({ url: `/api/sessions/${sessionId}/input-capability`, headers: ws.headers })).statusCode).toBe(404);
    expect(ws.built.sessionInputs).toBeUndefined();
  });

  it.each([false, true])("does not resend unresolved receipt lookup even with idempotentSend=%s", async (idempotentSend) => {
    const adapter = newAdapter({ idempotentSend });
    adapter.failNext("lost-ack");
    const lookup = adapter.lookupReceipt.bind(adapter);
    adapter.lookupReceipt = async () => { throw new SessionInputUnresolvedError("still_pending"); };
    const { ws, sessionId } = setup(adapter);
    const res = await send(ws, sessionId, { clientMessageId: "once", text: "hello" });
    expect(res.body).toMatchObject({ state: "accepted", deliveryUnknown: true });
    const retried = await command(ws, res.body.id as string, "retry");
    expect(retried.body).toMatchObject({ state: "accepted", deliveryUnknown: true, reason: "manual_recovery_required" });
    expect(ws.built.sessionInputs!.attempts(res.body.id as string)).toHaveLength(1);
    expect(adapter.received(sessionId)).toHaveLength(1);
    adapter.lookupReceipt = lookup;
    expect((await command(ws, res.body.id as string, "retry")).body).toMatchObject({ state: "delivered", deliveryUnknown: false });
  });

  it("settles definitive lookup rejection without violating the unknown-delivery constraint", async () => {
    const adapter = newAdapter({ idempotentSend: false });
    adapter.failNext("transport-error");
    adapter.lookupReceipt = async () => { throw new SessionInputRejectedError("definitely_absent"); };
    const { ws, sessionId } = setup(adapter);
    const res = await send(ws, sessionId, { clientMessageId: "once", text: "hello" });
    expect(res.body).toMatchObject({ deliveryUnknown: true });
    expect((await command(ws, res.body.id as string, "retry")).body).toMatchObject({ state: "rejected", deliveryUnknown: false, reason: "definitely_absent" });
    expect(adapter.received(sessionId)).toHaveLength(0);
    expect(ws.built.sessionInputs!.attempts(res.body.id as string)).toHaveLength(1);
  });
});
