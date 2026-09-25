/**
 * Durable session-addressed conversational input — the provider-independent
 * contract (`docs/contracts/session-input.md`).
 *
 * This module owns the vocabulary and the decisions that must be identical for
 * every provider: the message state machine, the per-session-condition dispatch
 * policy, the capability declaration an adapter must make before `delivered`
 * may ever be claimed, and the normalized trace-event names. It holds no
 * persistence and no transport, so both are testable without a database.
 *
 * Nothing here is enabled by default. The API surface that uses it is gated on
 * `config.sessionInput.enabled`, which is FALSE unless a workspace opts in.
 */

/**
 * Message lifecycle. `accepted` is deliberately weaker than "sent": it means a
 * dispatcher took the attempt, NOT that the provider has the text.
 */
export const SESSION_INPUT_STATES = ["queued", "accepted", "delivered", "rejected", "expired"] as const;

export type SessionInputState = (typeof SESSION_INPUT_STATES)[number];

export const SESSION_INPUT_TERMINAL_STATES = ["delivered", "rejected", "expired"] as const satisfies readonly SessionInputState[];

/**
 * Legal edges.
 *
 * `accepted -> expired` is absent on purpose: `expired` means the deadline
 * passed while the message was *definitely undispatched*. Once an attempt has
 * been taken the outcome may be unknown, and the contract forbids turning
 * uncertainty into a terminal "not delivered". Such a message stays `accepted`
 * and carries explicit unknown-delivery metadata instead.
 */
const TRANSITIONS: Record<SessionInputState, readonly SessionInputState[]> = {
  queued: ["accepted", "rejected", "expired"],
  accepted: ["delivered", "rejected"],
  delivered: [],
  rejected: [],
  expired: [],
};

export function canInputTransition(from: SessionInputState, to: SessionInputState): boolean {
  return TRANSITIONS[from].includes(to);
}

export function isInputTerminal(state: SessionInputState): boolean {
  return (SESSION_INPUT_TERMINAL_STATES as readonly SessionInputState[]).includes(state);
}

export class InvalidInputTransitionError extends Error {
  constructor(
    readonly from: SessionInputState,
    readonly to: SessionInputState,
  ) {
    super(`Invalid session-input transition: ${from} -> ${to}`);
    this.name = "InvalidInputTransitionError";
  }
}

export function assertInputTransition(from: SessionInputState, to: SessionInputState): SessionInputState {
  if (!canInputTransition(from, to)) throw new InvalidInputTransitionError(from, to);
  return to;
}

/**
 * Explicit operator commands over a message id.
 *
 * Neither command adds an edge to the state machine above: `rejected` stays
 * terminal, so a retry of a rejected message is a NEW row in the same retry
 * chain (same client key, next generation), not a resurrection of a settled
 * record. That keeps the terminal ledger immutable and auditable, which is the
 * whole point of recording a rejection in the first place.
 */
export type SessionInputCommandCheck = { allowed: true } | { allowed: false; reason: string };

/**
 * Retry eligibility.
 *
 * `rejected` — nothing was delivered by definition, so a fresh attempt cannot
 * duplicate anything.
 * `accepted` + unknown delivery — retry means RECONCILE (receipt lookup or a
 * declared-idempotent replay of the same id), never a blind second send.
 * `accepted` with a live attempt — refused. This is exactly the ambiguous
 * delivery the restart tests prove: the outcome is not yet known, and sending
 * again on top of an unresolved attempt is how a double-delivery happens.
 */
export function canRetryInput(state: SessionInputState, deliveryUnknown: boolean): SessionInputCommandCheck {
  if (state === "rejected") return { allowed: true };
  if (state === "accepted") {
    return deliveryUnknown ? { allowed: true } : { allowed: false, reason: "delivery_in_flight" };
  }
  if (state === "queued") return { allowed: false, reason: "not_dispatched" };
  return { allowed: false, reason: "already_settled" };
}

/**
 * Cancel eligibility. Only a message that was never dispatched can be cancelled:
 * once an attempt was taken the provider may already hold the text, and a
 * silent no-op would claim a recall the plane cannot perform. The caller is told
 * so explicitly instead.
 */
export function canCancelInput(state: SessionInputState): SessionInputCommandCheck {
  if (state === "queued") return { allowed: true };
  if (state === "accepted") return { allowed: false, reason: "already_dispatched" };
  return { allowed: false, reason: "already_settled" };
}

/** Normalized trace events, one per state change plus the unknown-delivery witness. */
export const SESSION_INPUT_EVENT_TYPES = [
  "input.queued",
  "input.accepted",
  "input.delivered",
  "input.rejected",
  "input.expired",
  "input.delivery_unknown",
  // The two explicit operator commands. They are deliberately NOT state events:
  // a retry or a cancel is an intent, recorded even when it changes nothing, and
  // any state change it causes still emits its own `input.*` event afterwards.
  "input.retry_requested",
  "input.cancelled",
] as const;

export type SessionInputEventType = (typeof SESSION_INPUT_EVENT_TYPES)[number];

const EVENT_FOR_STATE: Record<SessionInputState, SessionInputEventType> = {
  queued: "input.queued",
  accepted: "input.accepted",
  delivered: "input.delivered",
  rejected: "input.rejected",
  expired: "input.expired",
};

export function inputEventFor(state: SessionInputState): SessionInputEventType {
  return EVENT_FOR_STATE[state];
}

/** One dispatch attempt's outcome. `unknown` is the send-before-ack case. */
export const SESSION_INPUT_ATTEMPT_OUTCOMES = ["in_flight", "delivered", "rejected", "unknown"] as const;

export type SessionInputAttemptOutcome = (typeof SESSION_INPUT_ATTEMPT_OUTCOMES)[number];

/**
 * What an acknowledgement proves. A transport-level ack (the write returned)
 * is NOT evidence the provider has the message, so a transport-only adapter can
 * never move a message to `delivered`.
 */
export type SessionInputAckLevel = "transport" | "provider-accepted" | "provider-consumed";

/** The condition of the target session, as the input policy sees it. */
export const SESSION_INPUT_CONDITIONS = [
  "running",
  "waiting-input",
  "approval-blocked",
  "quota-paused",
  "compacting",
  "completed",
  "failed",
  "cancelled",
] as const;

export type SessionInputCondition = (typeof SESSION_INPUT_CONDITIONS)[number];

/**
 * An adapter's declared input capability. Persisted per attempt (as
 * `capabilityVersion`) so a later capability change cannot silently rewrite
 * what an old attempt was allowed to claim.
 */
export interface SessionInputCapabilities {
  capabilityVersion: string;
  /** Input kinds this adapter accepts. Only `text` exists in this slice. */
  kinds: readonly string[];
  ackLevel: SessionInputAckLevel;
  /** The adapter deduplicates a repeated delivery of the same message id itself. */
  idempotentSend: boolean;
  /** The adapter can be asked after the fact whether a message id was received. */
  receiptLookup: boolean;
  /** Conditions in which this adapter accepts a live delivery. */
  liveDelivery: readonly SessionInputCondition[];
}

/** `delivered` requires a provider-level receipt; transport-only adapters cannot claim it. */
export function canClaimDelivered(capabilities: SessionInputCapabilities): boolean {
  return capabilities.ackLevel !== "transport";
}

/**
 * Whether an unknown-outcome attempt may be reconciled without a human. Without
 * either capability the contract requires explicit recovery: a blind re-send
 * could double-deliver, and inventing a rejection would be a false audit.
 */
export function canReconcileUnknown(capabilities: SessionInputCapabilities): boolean {
  return capabilities.receiptLookup || capabilities.idempotentSend;
}

export type SessionInputPolicy =
  | { decision: "dispatch" }
  | { decision: "queue"; reason: string }
  | { decision: "reject"; reason: string };

/**
 * The per-condition policy from the contract's session-state table. Pure: the
 * caller derives the condition from kernel records and supplies the adapter's
 * declared capability (`undefined` when the adapter declares none).
 *
 * "Queue" never means the text reached the provider, and a rejection is always
 * definitive — nothing here silently accepts input a session cannot use.
 */
export function inputPolicy(
  condition: SessionInputCondition,
  capabilities: SessionInputCapabilities | undefined,
  kind = "text",
): SessionInputPolicy {
  // A terminal session is answered before capability: restarting work by
  // sending text is never in scope, whatever the adapter supports.
  switch (condition) {
    case "completed":
      return { decision: "reject", reason: "session_completed" };
    case "failed":
      return { decision: "reject", reason: "session_failed" };
    case "cancelled":
      return { decision: "reject", reason: "session_cancelled" };
  }
  if (!capabilities) return { decision: "reject", reason: "adapter_input_unsupported" };
  if (!capabilities.kinds.includes(kind)) return { decision: "reject", reason: "input_kind_unsupported" };
  switch (condition) {
    // Queued, not delivered: answering an approval uses the approval contract,
    // and text must not jump that gate.
    case "approval-blocked":
      return { decision: "queue", reason: "approval_pending" };
    // The scheduler owns quota recovery; no local timer may launch a provider.
    case "quota-paused":
      return { decision: "queue", reason: "quota_paused" };
    // Context policy decides before dispatch; the adapter never compacts on our behalf.
    case "compacting":
      return { decision: "queue", reason: "context_barrier" };
    case "running":
    case "waiting-input":
      return capabilities.liveDelivery.includes(condition)
        ? { decision: "dispatch" }
        : { decision: "queue", reason: "adapter_no_live_delivery" };
  }
}

/** Target identity handed to an adapter. Never carries workspace authority. */
export interface SessionInputTarget {
  sessionId: string;
  assistantId: string;
  providerSessionRef?: string;
}

/** The logical message. `messageId` is the server identity, stable across retries. */
export interface SessionInputMessage {
  messageId: string;
  kind: string;
  text: string;
}

/**
 * Provider-side evidence that a message arrived. `reference` is normalized by
 * the adapter; raw provider responses and credentials never appear here.
 */
export interface SessionInputReceipt {
  messageId: string;
  reference: string;
  ackLevel: SessionInputAckLevel;
  at: string;
}

/**
 * The delivery seam every provider will implement. Deliberately NOT
 * `AgentAdapter.send`: that method has no idempotency, receipt or
 * acknowledgement contract, and a typed `send` is not acceptance evidence.
 */
export interface SessionInputAdapter {
  capabilities(): SessionInputCapabilities;
  /**
   * Whether THIS target can be delivered to right now. Optional: an adapter
   * that omits it is available wherever its capabilities say it is, which is
   * true of a fully in-process adapter. A real provider must implement it,
   * because "this assistant has an adapter" and "this session has a live
   * provider process" are different facts and a manifest that conflates them
   * is a false claim.
   */
  probeTarget?(target: SessionInputTarget): Promise<SessionInputAvailability>;
  /**
   * Deliver once. Implementations MUST be idempotent on `message.messageId`
   * when they declare `idempotentSend`, and MUST throw rather than invent a
   * receipt when delivery did not happen.
   */
  deliver(target: SessionInputTarget, message: SessionInputMessage): Promise<SessionInputReceipt>;
  /** Present only when `receiptLookup` is declared. Null means "no such delivery". */
  lookupReceipt?(target: SessionInputTarget, messageId: string): Promise<SessionInputReceipt | null>;
}

/** Answer to `probeTarget`. `reason` is a stable machine code, never prose for display only. */
export interface SessionInputAvailability {
  available: boolean;
  reason?: string;
  /** Normalized provider session identity, when the adapter can see one. */
  providerSessionRef?: string;
}

/**
 * The adapter cannot say whether a message arrived — distinct from `null`,
 * which asserts it definitely did not. Raised by `lookupReceipt` when the
 * provider still might consume an earlier send, so re-sending could double
 * deliver. The service treats it exactly like having no lookup capability at
 * all: the message stays unknown and waits for an operator.
 */
export class SessionInputUnresolvedError extends Error {
  constructor(readonly reason: string) {
    super(`session input delivery unresolved: ${reason}`);
    this.name = "SessionInputUnresolvedError";
  }
}

/** A definitive provider/policy refusal. Anything else is treated as an unknown outcome. */
export class SessionInputRejectedError extends Error {
  constructor(readonly reason: string) {
    super(`session input rejected: ${reason}`);
    this.name = "SessionInputRejectedError";
  }
}

/** Bounds enforced at the trust boundary before anything is persisted. */
export const MAX_SESSION_INPUT_TEXT_BYTES = 16_384;
export const MAX_CLIENT_MESSAGE_ID_LENGTH = 128;
