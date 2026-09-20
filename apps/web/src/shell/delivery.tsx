/**
 * The delivery vocabulary shared by every surface that shows a session-addressed
 * message: the Shell transcript, the Shell composer and the Operator recovery
 * list.
 *
 * One rule governs all of it — the wording never runs ahead of the plane.
 * `queued` is not "sent", an unknown outcome is not "delivered", provider
 * receipt is claimed only where the plane recorded one, and
 * `manual_recovery_required` is named as the distinct thing it is rather than
 * being softened into "could not be confirmed". A message in that state is not
 * merely unconfirmed: the plane has decided it will not resend on its own,
 * which is a fact an operator has to act on.
 */
import { useState } from "react";
import { api, type SessionInput } from "../api.js";

/**
 * The plane refused to reconcile without a human. Set (as the row's `reason`)
 * when an attempt's outcome is unknown and the adapter declares neither receipt
 * lookup nor idempotent send, so a blind resend could deliver twice.
 *
 * Every other unresolved row carries its attempt's own diagnostic as `reason`
 * instead, which is why this is an equality test and not "has a reason".
 */
export function needsManualRecovery(input: SessionInput): boolean {
  return input.deliveryUnknown && input.reason === "manual_recovery_required";
}

/** The only truthful phrasing for each record the plane can return. */
export function deliveryLabel(input: SessionInput): string {
  switch (input.state) {
    case "queued":
      return `Recorded · waiting to send${input.reason ? ` (${input.reason})` : ""}`;
    case "accepted":
      if (needsManualRecovery(input)) return "Delivery unresolved · needs manual recovery";
      return input.deliveryUnknown
        ? `Sent, but delivery could not be confirmed${input.reason ? ` (${input.reason})` : ""}`
        : "Sending · confirmation pending";
    case "delivered":
      return `Provider confirmed receipt${input.providerReceipt ? ` (${input.providerReceipt.ackLevel})` : ""}`;
    case "rejected":
      return `Not delivered · ${input.reason ?? "rejected"}`;
    case "expired":
      return "Expired · not delivered";
  }
}

/** Existing Orbital state tones, reused so uncertainty never reads as success. */
export function deliveryTone(input: SessionInput): string {
  if (input.state === "delivered") return "tone-complete";
  if (input.state === "rejected" || input.state === "expired") return "tone-failed";
  if (needsManualRecovery(input)) return "tone-human";
  if (input.deliveryUnknown) return "tone-limit";
  return input.state === "queued" ? "tone-resource" : "tone-active";
}

/**
 * What an operator can do about it, in the plane's own terms. Only the manual
 * recovery case gets guidance, because it is the only one where doing nothing
 * leaves the record stuck for ever.
 */
export function deliveryGuidance(input: SessionInput): string | null {
  if (!needsManualRecovery(input)) return null;
  return "This provider can neither be asked what it received nor be safely sent the same message twice, " +
    "so the plane will not resend: that could deliver it a second time. Retrying asks the provider again; " +
    "the outcome may stay unresolved. Confirm in the session itself before sending anything new.";
}

/** A settled record needs no retry; an unknown outcome must not be auto-retried. */
export function canRetry(input: SessionInput): boolean {
  return input.state === "accepted" || input.state === "queued";
}

/**
 * The two explicit commands, mirroring the plane's own rules so the UI does not
 * offer a button the plane will refuse. A message with a live attempt offers
 * neither: its outcome is not yet known, and both commands would be a lie.
 */
export function canCommandRetry(input: SessionInput): boolean {
  return input.state === "rejected" || (input.state === "accepted" && input.deliveryUnknown);
}

export function canCommandCancel(input: SessionInput): boolean {
  return input.state === "queued";
}

/**
 * Runs one explicit command and reports whatever the plane now says is true.
 * A 409 carries the record's own reason for the refusal and is shown as-is,
 * never retried: it is a fact about the record, not a blip.
 */
export function useDeliveryCommand(onSettled: () => void) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (command: () => Promise<SessionInput>) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await command();
      onSettled();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, run: (command: () => Promise<SessionInput>) => void run(command) };
}

/** The state line, its tone and its recovery guidance. No layout of its own. */
export function DeliveryStatus({ input }: { input: SessionInput }) {
  const guidance = deliveryGuidance(input);
  return <>
    <p role="status" className={`delivery-state ${deliveryTone(input)}`}>{deliveryLabel(input)}</p>
    {guidance && <p className="delivery-guidance">{guidance}</p>}
  </>;
}

/** Exactly the commands the plane will accept for this record, and no others. */
export function DeliveryCommands({ input, busy, run }: {
  input: SessionInput; busy: boolean; run: (command: () => Promise<SessionInput>) => void;
}) {
  return <>
    {canCommandRetry(input) && <button className="btn" type="button" disabled={busy}
      onClick={() => run(() => api.retrySessionInput(input.id, input.version))}>Retry this delivery</button>}
    {canCommandCancel(input) && <button className="btn" type="button" disabled={busy}
      onClick={() => run(() => api.cancelSessionInput(input.id, input.version))}>Cancel</button>}
  </>;
}
