import {
  SessionInputRejectedError,
  type SessionInputAdapter,
  type SessionInputCapabilities,
  type SessionInputCondition,
  type SessionInputMessage,
  type SessionInputReceipt,
  type SessionInputTarget,
} from "@agent-plane/core";

/** A fault scripted onto ONE message id, consumed the first time it fires. */
export type FakeInputFault =
  | "lost-ack" // the provider HAS the message; the acknowledgement never comes back
  | "reject" // a definitive provider refusal — nothing was delivered
  | "transport-error" // the call failed before the provider saw anything
  | "hang" // the provider HAS the message and the call never returns (kill the server here)
  | "hang-before-delivery"; // the call never returns and the provider saw nothing

export interface FakeSessionInputOptions {
  ackLevel?: SessionInputCapabilities["ackLevel"];
  /** Default true: the deterministic adapter deduplicates on message id. */
  idempotentSend?: boolean;
  /** Default true: the deterministic adapter can be asked what it received. */
  receiptLookup?: boolean;
  liveDelivery?: readonly SessionInputCondition[];
  capabilityVersion?: string;
}

interface Delivered {
  messageId: string;
  text: string;
  receipt: SessionInputReceipt;
}

/**
 * Deterministic, fully in-process session-input adapter — the ONLY adapter in
 * this slice. It runs no provider: `received()` is the provider's memory, so a
 * test can assert exactly how many times a message logically arrived.
 *
 * Faults are scripted per message id rather than timed, so the restart and
 * lost-acknowledgement races are reproducible without sleeps or clocks.
 */
export class FakeSessionInputAdapter implements SessionInputAdapter {
  private log = new Map<string, Delivered[]>();
  private faults = new Map<string, FakeInputFault>();
  private nextFault?: FakeInputFault;
  private seq = 0;

  constructor(private options: FakeSessionInputOptions = {}) {}

  capabilities(): SessionInputCapabilities {
    return {
      capabilityVersion: this.options.capabilityVersion ?? "fake-session-input/1",
      kinds: ["text"],
      ackLevel: this.options.ackLevel ?? "provider-accepted",
      idempotentSend: this.options.idempotentSend !== false,
      receiptLookup: this.options.receiptLookup !== false,
      liveDelivery: this.options.liveDelivery ?? ["running", "waiting-input"],
    };
  }

  /** Script a one-shot fault for the next delivery of `messageId`. */
  fail(messageId: string, fault: FakeInputFault): void {
    this.faults.set(messageId, fault);
  }

  /**
   * Script a one-shot fault for the next delivery, whatever its id — the only
   * way to fault a message whose server id the caller cannot know in advance.
   */
  failNext(fault: FakeInputFault): void {
    this.nextFault = fault;
  }

  /** Everything the provider actually holds for a session, in arrival order. */
  received(sessionId: string): ReadonlyArray<Delivered> {
    return this.log.get(sessionId) ?? [];
  }

  async deliver(target: SessionInputTarget, message: SessionInputMessage): Promise<SessionInputReceipt> {
    const fault = this.faults.get(message.messageId) ?? this.nextFault;
    this.faults.delete(message.messageId);
    this.nextFault = undefined;
    if (fault === "reject") throw new SessionInputRejectedError("provider_refused");
    if (fault === "transport-error") throw new Error("fake transport failure before delivery");
    // Nothing reached the provider and nothing ever will return: the caller is
    // killed here in the restart tests.
    if (fault === "hang-before-delivery") return new Promise<SessionInputReceipt>(() => {});

    const entries = this.log.get(target.sessionId) ?? [];
    const prior = entries.find((e) => e.messageId === message.messageId);
    let receipt: SessionInputReceipt;
    if (prior && this.capabilities().idempotentSend) {
      // The whole point of provider idempotency: a repeat is the SAME delivery.
      receipt = prior.receipt;
    } else {
      this.seq += 1;
      receipt = {
        messageId: message.messageId,
        reference: `fake-receipt-${this.seq}`,
        ackLevel: this.capabilities().ackLevel,
        at: new Date().toISOString(),
      };
      entries.push({ messageId: message.messageId, text: message.text, receipt });
      this.log.set(target.sessionId, entries);
    }
    // Recorded FIRST, then the acknowledgement is lost: the caller cannot tell
    // this apart from a delivery that never happened. That is the race.
    if (fault === "lost-ack") throw new Error("fake acknowledgement lost in transport");
    // Same race, but the caller never gets any answer at all — the shape a
    // process kill between send and durable outcome actually has.
    if (fault === "hang") return new Promise<SessionInputReceipt>(() => {});
    return receipt;
  }

  async lookupReceipt(target: SessionInputTarget, messageId: string): Promise<SessionInputReceipt | null> {
    if (!this.capabilities().receiptLookup) {
      throw new Error("receipt lookup called on an adapter that does not declare it");
    }
    return this.received(target.sessionId).find((e) => e.messageId === messageId)?.receipt ?? null;
  }
}
