import {
  SessionInputRejectedError,
  type SessionInputAdapter,
  type SessionInputTarget,
} from "./session-input.js";

/**
 * Explicit, process-local authorization for adapters that require per-session
 * enablement. Grants bind all three identities; restart revokes every grant.
 * This is additional to the workspace's default-off sessionInput flag.
 * Receipt reads remain possible after revocation: disabling new sends cannot
 * erase evidence or turn an ambiguous earlier send into a definitive failure.
 */
export class SessionInputOptInGate {
  private readonly grants = new Map<string, string>();

  enable(target: SessionInputTarget): void {
    if (!target.providerSessionRef) throw new SessionInputRejectedError("provider_session_unverified");
    this.grants.set(target.sessionId, this.identity(target));
  }

  disable(sessionId: string): void {
    this.grants.delete(sessionId);
  }

  enabled(target: SessionInputTarget): boolean {
    return !!target.providerSessionRef && this.grants.get(target.sessionId) === this.identity(target);
  }

  wrap(adapter: SessionInputAdapter): SessionInputAdapter {
    const probeTarget: NonNullable<SessionInputAdapter["probeTarget"]> = async (target) => {
      if (!this.enabled(target)) return { available: false, reason: "session_input_not_enabled" };
      if (!adapter.probeTarget) return { available: false, reason: "provider_probe_unsupported" };
      const probe = await adapter.probeTarget(target);
      if (!this.enabled(target)) return { available: false, reason: "session_input_not_enabled" };
      return probe;
    };
    return {
      capabilities: () => adapter.capabilities(),
      probeTarget,
      deliver: async (target, message) => {
        const probe = await probeTarget(target);
        if (!probe.available) throw new SessionInputRejectedError(probe.reason ?? "provider_session_unavailable");
        return adapter.deliver(target, message);
      },
      ...(adapter.lookupReceipt ? { lookupReceipt: adapter.lookupReceipt.bind(adapter) } : {}),
    };
  }

  private identity(target: SessionInputTarget): string {
    return JSON.stringify([target.sessionId, target.assistantId, target.providerSessionRef]);
  }
}
