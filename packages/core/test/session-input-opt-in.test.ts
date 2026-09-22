import { describe, expect, it, vi } from "vitest";
import { SessionInputOptInGate, type SessionInputAdapter } from "../src/index.js";

const target = { sessionId: "run-a", assistantId: "provider-a", providerSessionRef: "thread-a" };
const message = { messageId: "msg-a", kind: "text", text: "follow up" };
function fixture() {
  const adapter: SessionInputAdapter = {
    capabilities: () => ({ capabilityVersion: "test/1", kinds: ["text"], ackLevel: "transport", idempotentSend: false, receiptLookup: true, liveDelivery: ["running"] }),
    probeTarget: vi.fn(async () => ({ available: true })),
    deliver: vi.fn(async () => ({ messageId: message.messageId, reference: "test-receipt", ackLevel: "transport" as const, at: "2026-09-22T00:00:00Z" })),
    lookupReceipt: vi.fn(async () => null),
  };
  const gate = new SessionInputOptInGate();
  return { adapter, gate, wrapped: gate.wrap(adapter) };
}

describe("explicit per-session input opt-in", () => {
  it("defaults off, binds all identities, and revokes on restart", async () => {
    const { adapter, gate, wrapped } = fixture();
    await expect(wrapped.deliver(target, message)).rejects.toThrow("session_input_not_enabled");
    expect(adapter.deliver).not.toHaveBeenCalled();
    expect(() => gate.enable({ ...target, providerSessionRef: undefined })).toThrow("provider_session_unverified");
    gate.enable(target);
    for (const other of [{ ...target, sessionId: "run-b" }, { ...target, assistantId: "provider-b" }, { ...target, providerSessionRef: "thread-b" }]) {
      await expect(wrapped.probeTarget!(other)).resolves.toMatchObject({ available: false });
      await expect(wrapped.deliver(other, message)).rejects.toThrow("session_input_not_enabled");
    }
    await expect(wrapped.deliver(target, message)).resolves.toMatchObject({ ackLevel: "transport" });
    expect(wrapped.capabilities()).toEqual(adapter.capabilities());
    await expect(new SessionInputOptInGate().wrap(adapter).deliver(target, message)).rejects.toThrow("session_input_not_enabled");
    gate.disable(target.sessionId);
    await expect(wrapped.deliver(target, message)).rejects.toThrow("session_input_not_enabled");
    await expect(wrapped.lookupReceipt!(target, message.messageId)).resolves.toBeNull();
    expect(adapter.deliver).toHaveBeenCalledTimes(1);
  });

  it("requires a successful probe even with explicit enablement", async () => {
    const { adapter, gate, wrapped } = fixture();
    gate.enable(target);
    adapter.probeTarget = undefined;
    await expect(wrapped.deliver(target, message)).rejects.toThrow("provider_probe_unsupported");
    adapter.probeTarget = async () => ({ available: false, reason: "provider_session_unavailable" });
    await expect(wrapped.deliver(target, message)).rejects.toThrow("provider_session_unavailable");
    adapter.probeTarget = async () => { gate.disable(target.sessionId); return { available: true }; };
    await expect(wrapped.deliver(target, message)).rejects.toThrow("session_input_not_enabled");
    expect(adapter.deliver).not.toHaveBeenCalled();
  });
});
