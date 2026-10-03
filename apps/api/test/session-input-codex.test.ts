import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CodexAdapter, CodexSessionInputAdapter } from "@agent-plane/adapters";
import { CodexAppServerProtocol } from "../../../packages/adapters/src/codex-app-server-protocol.js";
import { boot, command, seedSession, send, type Workspace } from "./helpers/session-input.js";
import type { SessionInputTarget } from "@agent-plane/core";

const homes: string[] = [], workspaces: Workspace[] = [], protocols: CodexAppServerProtocol[] = [];
afterEach(async () => {
  for (const p of protocols.splice(0)) p.disconnect();
  for (const ws of workspaces.splice(0)) { await ws.built.app.close(); ws.db.close(); }
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});
function setup(enabled = true, drop = false, defaultResolver = false, historyReader?: (threadId: string) => Promise<unknown>) {
  const input = new PassThrough(), output = new PassThrough();
  const rpc = new CodexAppServerProtocol(input, output, undefined, 20); protocols.push(rpc);
  const live = { threadId: "provider-codex-session", turnId: "turn", rpc };
  let sends = 0;
  input.on("data", chunk => {
    const req = JSON.parse(String(chunk));
    if (req.method === "turn/steer") { sends++; if (drop) return; }
    output.write(JSON.stringify({ id: req.id, result: req.method === "thread/read" ? { thread: { id: live.threadId, status: { type: "active", activeFlags: [] } } } : { turnId: "turn", ackLevel: "provider-consumed" } }) + "\n");
  });
  const adapter = new CodexSessionInputAdapter("codex-a", ref => ref === live.threadId ? live : undefined, historyReader ?? (async () => ({ id: live.threadId, turns: [] })));
  const home = mkdtempSync(join(tmpdir(), "codex-ledger-")); homes.push(home);
  const ws = boot(home, { sessionInput: enabled, adapters: defaultResolver ? undefined : id => id === "codex-a" ? adapter : undefined }); workspaces.push(ws);
  const { sessionId } = seedSession(ws.db, { sessionId: "codex-session", assistantId: "codex-a" });
  const target: SessionInputTarget = { sessionId, assistantId: "codex-a", providerSessionRef: live.threadId };
  return { ws, home, adapter, target, sends: () => sends };
}

describe("Codex input durable contract", () => {
  it("wires the default resolver to the execution owner and enables only the addressed session", async () => {
    const { ws, adapter, target, sends } = setup(true, false, true);
    class Owner extends CodexAdapter { override get sessionInput() { return adapter; } }
    const owner = new Owner("codex-a" as never);
    const original = ws.built.registry.adapter.bind(ws.built.registry);
    vi.spyOn(ws.built.registry, "adapter").mockImplementation(id => id === "codex-a" ? owner : original(id));
    const url = `/api/sessions/${target.sessionId}/input-enablement`;
    const enable = await ws.built.app.inject({ method: "POST", url, headers: ws.headers, payload: { enabled: true } });
    expect(enable.statusCode).toBe(200);
    expect(enable.json()).toMatchObject({ available: true, ackLevel: "provider-accepted", receiptLookup: true });
    const other = seedSession(ws.db, { assistantId: "codex-a" });
    expect((await ws.built.sessionInputs!.capability(other.sessionId)).available).toBe(false);
    expect((await send(ws, target.sessionId, { clientMessageId: "live", text: "hello" })).body).toMatchObject({ state: "accepted", deliveryUnknown: true });
    expect(sends()).toBe(1);
    const disable = await ws.built.app.inject({ method: "POST", url, headers: ws.headers, payload: { enabled: false } });
    expect(disable.json()).toMatchObject({ available: false, reason: "session_input_not_enabled" });
    expect((await send(ws, target.sessionId, { clientMessageId: "revoked", text: "hello" })).body).toMatchObject({ state: "rejected" });
    expect(sends()).toBe(1);
  });

  it.each([false, true])("keeps unrecorded transport outcomes unknown without replay through retries and restart (lost response=%s)", async drop => {
    const { ws, home, adapter, target, sends } = setup(true, drop);
    await adapter.enable(target);
    const sent = await send(ws, target.sessionId, { clientMessageId: "once", text: "hello" });
    expect(sent.statusCode).toBe(202);
    expect(sent.body).toMatchObject({ state: "accepted", deliveryUnknown: true });
    const id = sent.body.id as string;
    for (let i = 0; i < 2; i++) expect((await command(ws, id, "retry")).body).toMatchObject({ state: "accepted", deliveryUnknown: true, reason: "manual_recovery_required" });
    await ws.built.app.close(); ws.db.close();
    workspaces.splice(workspaces.indexOf(ws), 1);
    const restarted = new CodexSessionInputAdapter("codex-a", () => undefined, async () => ({ id: target.providerSessionRef, turns: [] }));
    const reboot = boot(home, { adapters: id => id === "codex-a" ? restarted : undefined });
    workspaces.push(reboot);
    expect(await restarted.probeTarget(target)).toMatchObject({ available: false, reason: "session_input_not_enabled" });
    expect((await command(reboot, id, "retry")).body).toMatchObject({ state: "accepted", deliveryUnknown: true, reason: "manual_recovery_required" });
    expect(reboot.built.sessionInputs!.attempts(id)).toHaveLength(1);
    expect(reboot.built.sessionInputs!.events(id).some(e => e.type === "input.delivered")).toBe(false);
    expect(sends()).toBe(1);
  });

  it("reconciles the exact durable message after plane/provider restart without a grant or another send", async () => {
    const providerHome = mkdtempSync(join(tmpdir(), "codex-history-test-")); homes.push(providerHome);
    const historyFile = join(providerHome, "provider-history.json");
    const empty = { id: "provider-codex-session", turns: [{ id: "turn", items: [] as unknown[] }] };
    writeFileSync(historyFile, JSON.stringify(empty));
    // Every invocation reopens the provider-authored storage double. Live
    // process durability is separately established by the real-provider matrix.
    let reads = 0;
    const reader = async () => { reads++; return JSON.parse(readFileSync(historyFile, "utf8")) as unknown; };
    const { ws, home, adapter, target, sends } = setup(true, true, false, reader);
    await adapter.enable(target);
    const first = await send(ws, target.sessionId, { clientMessageId: "first", text: "identical text" });
    const second = await send(ws, target.sessionId, { clientMessageId: "second", text: "identical text" });
    const firstId = first.body.id as string, secondId = second.body.id as string;
    expect(first.body).toMatchObject({ state: "accepted", deliveryUnknown: true });
    expect(second.body).toMatchObject({ state: "accepted", deliveryUnknown: true });
    expect(sends()).toBe(2);
    await ws.built.app.close(); ws.db.close(); workspaces.splice(workspaces.indexOf(ws), 1);
    // The provider folds only the first logical message while the plane is down.
    empty.turns[0]!.items.push({ type: "userMessage", id: "provider-first", clientId: firstId, content: [{ type: "text", text: "identical text" }] });
    writeFileSync(historyFile, JSON.stringify(empty));
    const restarted = new CodexSessionInputAdapter("codex-a", () => undefined, reader);
    const deliver = vi.spyOn(restarted, "deliver");
    const reboot = boot(home, { adapters: id => id === "codex-a" ? restarted : undefined }); workspaces.push(reboot);
    expect(await restarted.probeTarget(target)).toMatchObject({ available: false, reason: "session_input_not_enabled" });
    expect((await command(reboot, firstId, "retry")).body).toMatchObject({ state: "delivered", deliveryUnknown: false, providerReceipt: { messageId: firstId, ackLevel: "provider-accepted", reference: "codex-user:provider-codex-session:provider-first" } });
    // Same text in the same thread is not evidence for the other caller ID.
    for (let i = 0; i < 2; i++) expect((await command(reboot, secondId, "retry")).body).toMatchObject({ state: "accepted", deliveryUnknown: true, reason: "manual_recovery_required" });
    expect(reboot.built.sessionInputs!.attempts(firstId)).toHaveLength(1);
    expect(reboot.built.sessionInputs!.attempts(secondId)).toHaveLength(1);
    expect(reboot.built.sessionInputs!.events(firstId).filter(e => e.type === "input.delivered")).toHaveLength(1);
    expect(reboot.built.sessionInputs!.events(secondId).some(e => e.type === "input.delivered")).toBe(false);
    expect(deliver).not.toHaveBeenCalled(); expect(sends()).toBe(2); expect(reads).toBeGreaterThanOrEqual(3);
  });

  it("rejects sends until per-session opt-in and never exposes disabled routes", async () => {
    const { ws, target, sends } = setup();
    expect((await send(ws, target.sessionId, { clientMessageId: "off", text: "hello" })).body).toMatchObject({ state: "rejected", reason: "session_input_not_enabled" });
    expect(sends()).toBe(0);
    const off = setup(false);
    for (const suffix of ["inputs", "input-enablement"]) expect((await off.ws.built.app.inject({ method: "POST", url: `/api/sessions/${off.target.sessionId}/${suffix}`, headers: off.ws.headers, payload: { enabled: true } })).statusCode).toBe(404);
  });

  it("requires both workspace and assistant transport opt-in; session route validates auth and liveness", async () => {
    const { ws, target } = setup();
    ws.config.assistants["codex-a"]!.options = { appServerInput: true };
    ws.config.sessionInput.enabled = false; ws.built.registry.init();
    expect((ws.built.registry.adapter("codex-a") as CodexAdapter).sessionInput).toBeUndefined();
    ws.config.sessionInput.enabled = true; ws.built.registry.init();
    expect((ws.built.registry.adapter("codex-a") as CodexAdapter).sessionInput).toBeDefined();
    const url = `/api/sessions/${target.sessionId}/input-enablement`;
    expect((await ws.built.app.inject({ method: "POST", url, payload: { enabled: true } })).statusCode).toBe(401);
    expect((await ws.built.app.inject({ method: "POST", url, headers: ws.headers, payload: { enabled: "yes" } })).statusCode).toBe(400);
    const absent = await ws.built.app.inject({ method: "POST", url, headers: ws.headers, payload: { enabled: true } });
    expect(absent.statusCode).toBe(409); expect(absent.json()).toMatchObject({ available: false });
    expect((await ws.built.app.inject({ method: "POST", url: "/api/sessions/missing/input-enablement", headers: ws.headers, payload: { enabled: true } })).statusCode).toBe(404);
    expect(ws.built.registry.adapter("real-a")).not.toBeInstanceOf(CodexAdapter);
  });
});
