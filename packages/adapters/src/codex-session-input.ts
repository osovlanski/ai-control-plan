import {
  SessionInputOptInGate, SessionInputRejectedError, SessionInputUnresolvedError,
  type SessionInputAdapter, type SessionInputCapabilities, type SessionInputTarget,
  type SessionInputMessage, type SessionInputReceipt, type SessionInputAvailability,
} from "@agent-plane/core";
import type { CodexAppServerProtocol } from "./codex-app-server-protocol.js";

/** Only the execution owner may supply this connection; history readers cannot. */
export interface CodexInputConnection {
  threadId: string;
  turnId: string;
  rpc: CodexAppServerProtocol;
}

/** Transport-only. A steer response identifies a turn, never our message ID. */
export class CodexSessionInputAdapter implements SessionInputAdapter {
  private readonly gate = new SessionInputOptInGate();
  private readonly grantVersions = new Map<string, number>();
  private readonly owners = new Map<string, CodexInputConnection>();
  private readonly attempted = new Set<string>();

  constructor(
    private readonly assistantId: string,
    private readonly connection: (providerSessionRef: string) => CodexInputConnection | undefined,
  ) {}

  capabilities(): SessionInputCapabilities {
    return {
      capabilityVersion: "codex-app-server-transport-v1",
      kinds: ["text"], ackLevel: "transport", idempotentSend: false,
      receiptLookup: false, liveDelivery: ["running"],
    };
  }

  async enable(target: SessionInputTarget): Promise<SessionInputAvailability> {
    const owner = target.providerSessionRef ? this.connection(target.providerSessionRef) : undefined;
    const version = this.grantVersions.get(target.sessionId);
    const probe = await this.probeConnection(target);
    if (this.grantVersions.get(target.sessionId) !== version) return { available: false, reason: "session_input_not_enabled" };
    if (probe.available && owner && this.connection(owner.threadId) === owner) {
      this.gate.enable(target);
      this.owners.set(target.sessionId, owner);
    } else return { available: false, reason: "codex_live_session_unavailable" };
    return probe;
  }

  disable(sessionId: string): void {
    this.grantVersions.set(sessionId, (this.grantVersions.get(sessionId) ?? 0) + 1);
    this.gate.disable(sessionId);
    this.owners.delete(sessionId);
  }

  async probeTarget(target: SessionInputTarget): Promise<SessionInputAvailability> {
    if (!this.gate.enabled(target)) return { available: false, reason: "session_input_not_enabled" };
    const owner = this.owners.get(target.sessionId);
    if (!owner || this.connection(owner.threadId) !== owner) return { available: false, reason: "codex_live_session_unavailable" };
    const probe = await this.probeConnection(target);
    return this.gate.enabled(target) && this.owners.get(target.sessionId) === owner && this.connection(owner.threadId) === owner
      ? probe : { available: false, reason: "session_input_not_enabled" };
  }

  private async probeConnection(target: SessionInputTarget): Promise<SessionInputAvailability> {
    const unavailable = { available: false, reason: "codex_live_session_unavailable" };
    if (target.assistantId !== this.assistantId || !target.providerSessionRef) return unavailable;
    const live = this.connection(target.providerSessionRef);
    if (!live?.rpc.connected || live.threadId !== target.providerSessionRef || !live.turnId) return unavailable;
    const turnId = live.turnId;
    try {
      const response = await live.rpc.request("thread/read", { threadId: live.threadId, includeTurns: false });
      const thread = response.result?.thread as { id?: string; status?: { type?: string; activeFlags?: string[] } } | undefined;
      if (response.error || thread?.id !== live.threadId || thread.status?.type !== "active" ||
          thread.status.activeFlags?.length || this.connection(live.threadId) !== live ||
          live.turnId !== turnId || !live.rpc.connected) return unavailable;
      return { available: true, providerSessionRef: live.threadId };
    } catch { return unavailable; }
  }

  async deliver(target: SessionInputTarget, message: SessionInputMessage): Promise<SessionInputReceipt> {
    if (message.kind !== "text") throw new SessionInputRejectedError("input_kind_unsupported");
    const key = JSON.stringify([target.sessionId, target.assistantId, target.providerSessionRef, message.messageId]);
    // A local duplicate guard is NOT provider idempotency and earns no capability.
    if (this.attempted.has(key)) throw new SessionInputUnresolvedError("manual_recovery_required");
    const probe = await this.probeTarget(target);
    if (!probe.available) throw new SessionInputRejectedError(probe.reason ?? "codex_live_session_unavailable");
    const live = this.connection(target.providerSessionRef!);
    if (!this.gate.enabled(target)) throw new SessionInputRejectedError("session_input_not_enabled");
    if (!live?.rpc.connected || !live.turnId || this.owners.get(target.sessionId) !== live) throw new SessionInputRejectedError("codex_live_session_unavailable");
    if (this.attempted.has(key)) throw new SessionInputUnresolvedError("manual_recovery_required");
    this.attempted.add(key);
    const expectedTurnId = live.turnId;
    const response = await live.rpc.request("turn/steer", {
      threadId: live.threadId, expectedTurnId, input: [{ type: "text", text: message.text }],
    });
    // Errors, malformed results and mismatched turns are conservatively unknown.
    // Never use an error string or later history absence as proof of non-delivery.
    if (response.error || response.result?.turnId !== expectedTurnId) {
      throw new SessionInputUnresolvedError("manual_recovery_required");
    }
    return {
      messageId: message.messageId, reference: `codex-steer:${live.threadId}:${expectedTurnId}`,
      ackLevel: "transport", at: new Date().toISOString(),
    };
  }

  // Deliberately no lookupReceipt: receiptLookup=false means the service leaves
  // unknown outcomes requiring manual recovery, including after process restart.
}
