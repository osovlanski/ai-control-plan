import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { canClaimDelivered } from "@agent-plane/core";
import { CodexSessionInputAdapter } from "../src/codex-session-input.js";
import { CodexAppServerProtocol } from "../src/codex-app-server-protocol.js";

const target = { sessionId: "session", assistantId: "codex", providerSessionRef: "thread" };
const message = { messageId: "message", kind: "text", text: "follow up" };
function fixture() {
  const input = new PassThrough(), output = new PassThrough();
  const rpc = new CodexAppServerProtocol(input, output, undefined, 20);
  let live = { threadId: "thread", turnId: "turn", rpc };
  let reachable = true, status = "active", steer: Record<string, unknown> = { turnId: "turn" };
  let drop = false;
  let history: unknown = { id: "thread", turns: [] };
  const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
  input.on("data", chunk => {
    const request = JSON.parse(String(chunk)); requests.push(request);
    if (request.method === "turn/steer" && drop) return;
    output.write(JSON.stringify({ id: request.id, result: request.method === "thread/read" ? { thread: { id: "thread", status: { type: status, activeFlags: [] } } } : steer }) + "\n");
  });
  const adapter = new CodexSessionInputAdapter("codex", ref => reachable && ref === "thread" ? live : undefined, async () => { if (history instanceof Error) throw history; return history; });
  return { rpc, adapter, requests, live, setHistory: (v: unknown) => { history = v; }, replaceOwner: () => { live = { ...live }; }, setReachable: (v: boolean) => { reachable = v; }, setStatus: (v: string) => { status = v; }, setSteer: (v: Record<string, unknown>) => { steer = v; }, drop: () => { drop = true; } };
}

describe("CodexSessionInputAdapter durable receipt ceiling", () => {
  it("revocation wins while enablement or delivery is probing", async () => {
    const f = fixture();
    const enable = f.adapter.enable(target); f.adapter.disable(target.sessionId);
    expect(await enable).toMatchObject({ available: false });
    await f.adapter.enable(target);
    const delivery = f.adapter.deliver(target, message); f.adapter.disable(target.sessionId);
    await expect(delivery).rejects.toThrow("session_input_not_enabled");
    expect(f.requests.some(r => r.method === "turn/steer")).toBe(false);
    f.rpc.disconnect();
  });

  it("does not transfer an old session grant to a new owner of the same thread", async () => {
    const f = fixture(); await f.adapter.enable(target); f.replaceOwner();
    expect(await f.adapter.probeTarget(target)).toMatchObject({ available: false });
    await expect(f.adapter.deliver(target, message)).rejects.toThrow("codex_live_session_unavailable");
    expect(f.requests.some(r => r.method === "turn/steer")).toBe(false);
    f.rpc.disconnect();
  });

  it("requires identity-bound opt-in and a live owner, not history availability", async () => {
    const f = fixture();
    expect(await f.adapter.probeTarget(target)).toMatchObject({ available: false, reason: "session_input_not_enabled" });
    await expect(f.adapter.deliver(target, message)).rejects.toThrow("session_input_not_enabled");
    expect(f.requests).toHaveLength(0);
    expect(await f.adapter.enable(target)).toMatchObject({ available: true });
    for (const changed of [{ ...target, sessionId: "other" }, { ...target, assistantId: "other" }, { ...target, providerSessionRef: "other" }]) expect(await f.adapter.probeTarget(changed)).toMatchObject({ available: false });
    f.setStatus("notLoaded"); expect(await f.adapter.probeTarget(target)).toMatchObject({ available: false });
    f.setStatus("active"); f.setReachable(false); expect(await f.adapter.probeTarget(target)).toMatchObject({ available: false });
    f.rpc.disconnect();
  });

  it.each(["provider-accepted", "provider-consumed", "delivered"])("cannot promote a response claiming %s", async ackLevel => {
    const f = fixture(); await f.adapter.enable(target);
    f.setSteer({ turnId: "turn", ackLevel, delivered: true, messageId: "message" });
    const capabilities = f.adapter.capabilities();
    expect(capabilities).toMatchObject({ ackLevel: "provider-accepted", idempotentSend: false, receiptLookup: true });
    expect(canClaimDelivered(capabilities)).toBe(true);
    await expect(f.adapter.deliver(target, message)).rejects.toThrow("transport_ack_only");
    await expect(f.adapter.lookupReceipt(target, message.messageId)).rejects.toThrow("codex_receipt_unresolved");
    expect(f.requests.find(r => r.method === "turn/steer")?.params).toEqual({ threadId: "thread", expectedTurnId: "turn", clientUserMessageId: "message", input: [{ type: "text", text: "follow up" }] });
    // Mutating a returned declaration must not change future claims.
    capabilities.ackLevel = "provider-consumed";
    expect(f.adapter.capabilities().ackLevel).toBe("provider-accepted");
    f.rpc.disconnect();
  });

  it("never resends after response loss or concurrent duplicate calls", async () => {
    const f = fixture(); await f.adapter.enable(target); f.drop();
    const results = await Promise.allSettled([f.adapter.deliver(target, message), f.adapter.deliver(target, message)]);
    expect(results.every(r => r.status === "rejected")).toBe(true);
    await expect(f.adapter.deliver(target, message)).rejects.toThrow("manual_recovery_required");
    expect(f.requests.filter(r => r.method === "turn/steer")).toHaveLength(1);
    f.rpc.disconnect();
  });

  it("rejects new sends after disable, disconnect or restart without inventing receipts", async () => {
    const f = fixture(); await f.adapter.enable(target); f.adapter.disable(target.sessionId);
    await expect(f.adapter.deliver(target, message)).rejects.toThrow("session_input_not_enabled");
    await f.adapter.enable(target); f.rpc.disconnect();
    expect(await f.adapter.probeTarget(target)).toMatchObject({ available: false });
    const restarted = new CodexSessionInputAdapter("codex", () => f.live);
    expect(await restarted.probeTarget(target)).toMatchObject({ available: false, reason: "session_input_not_enabled" });
  });

  it("treats a mismatched turn response as unknown without replay", async () => {
    const f = fixture(); await f.adapter.enable(target); f.setSteer({ turnId: "other" });
    await expect(f.adapter.deliver(target, message)).rejects.toThrow("manual_recovery_required");
    await expect(f.adapter.deliver(target, message)).rejects.toThrow("manual_recovery_required");
    expect(f.requests.filter(r => r.method === "turn/steer")).toHaveLength(1);
    f.rpc.disconnect();
  });
});


describe("Codex exact durable message correlation", () => {
  const user = (id: string, clientId?: string) => ({ type: "userMessage", id, clientId, content: [{ type: "text", text: "same text" }] });
  const history = (items: unknown[]) => ({ id: "thread", turns: [{ id: "turn", items }] });

  it("distinguishes identical text by clientId and survives fresh adapter construction without grants", async () => {
    const records = history([user("provider-a", "message-a"), user("provider-b", "message-b")]);
    const first = new CodexSessionInputAdapter("codex", () => undefined, async () => records);
    const second = new CodexSessionInputAdapter("codex", () => undefined, async () => records);
    first.disable(target.sessionId);
    expect(await first.lookupReceipt(target, "message-a")).toMatchObject({ messageId: "message-a", reference: "codex-user:thread:provider-a", ackLevel: "provider-accepted" });
    expect(await second.lookupReceipt(target, "message-b")).toMatchObject({ messageId: "message-b", reference: "codex-user:thread:provider-b", ackLevel: "provider-accepted" });
    expect(await second.probeTarget(target)).toMatchObject({ available: false, reason: "session_input_not_enabled" });
    await expect(second.lookupReceipt(target, "absent")).rejects.toThrow("codex_receipt_unresolved");
  });

  it.each([
    history([user("message")]), // Provider id alone is not caller correlation.
    history([user("provider", "other-message")]),
    history([{ type: "agentMessage", id: "provider", clientId: "message", text: "same text" }]),
    history([{ type: "userMessage", clientId: "message" }]),
    { id: "other-thread", turns: [{ items: [user("provider", "message")] }] },
    { id: "thread", turns: null }, null,
    new Error("private provider detail"),
  ])("keeps absent, uncorrelated, malformed and failed reads unresolved: %#", async records => {
    const f = fixture(); f.setHistory(records);
    await expect(f.adapter.lookupReceipt(target, "message")).rejects.toThrow("codex_receipt_unresolved");
    expect(f.requests).toHaveLength(0);
    f.rpc.disconnect();
  });

  it("repeated or late receipt reads never send and do not claim consumption or deduplication", async () => {
    const f = fixture();
    await expect(f.adapter.lookupReceipt(target, "message")).rejects.toThrow("codex_receipt_unresolved");
    f.setHistory(history([user("provider-a", "message"), user("provider-b", "message")]));
    for (let i = 0; i < 2; i++) expect(await f.adapter.lookupReceipt(target, "message")).toMatchObject({ ackLevel: "provider-accepted" });
    expect(f.adapter.capabilities().idempotentSend).toBe(false);
    expect(f.requests).toHaveLength(0); f.rpc.disconnect();
  });

  it("refuses mismatched assistant identity before any history read", async () => {
    let reads = 0;
    const adapter = new CodexSessionInputAdapter("codex", () => undefined, async () => { reads++; return history([user("provider", "message")]); });
    await expect(adapter.lookupReceipt({ ...target, assistantId: "other" }, "message")).rejects.toThrow("codex_receipt_unresolved");
    expect(reads).toBe(0);
  });
});
