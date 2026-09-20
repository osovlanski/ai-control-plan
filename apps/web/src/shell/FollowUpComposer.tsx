/**
 * The Shell follow-up composer.
 *
 * Minimal on purpose: it exists to prove the durable session-input contract end
 * to end, not to be a finished conversation experience. Two rules govern it:
 *
 *  1. With the capability off — the default — it is byte-for-byte the disabled
 *     composer that shipped with Shell mode, saying truthfully that
 *     session-addressed delivery is unavailable.
 *  2. With it on, the wording never runs ahead of the plane. `queued` is not
 *     "sent", an unknown outcome is not "delivered", and a retry reuses the
 *     SAME client message id, so retrying can never produce a second message.
 */
import { useState } from "react";
import { api, type SessionInput } from "../api.js";

/** The only truthful phrasing for each record the plane can return. */
export function deliveryLabel(input: SessionInput): string {
  switch (input.state) {
    case "queued":
      return `Recorded · waiting to send${input.reason ? ` (${input.reason})` : ""}`;
    case "accepted":
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

const newClientMessageId = (): string =>
  globalThis.crypto?.randomUUID?.() ?? `cmid-${Date.now()}-${Math.random().toString(36).slice(2)}`;

export function FollowUpComposer({ enabled, sessionId }: { enabled: boolean; sessionId?: string }) {
  const [text, setText] = useState("");
  // Generated before the first request and held until the message settles, so a
  // retry after a network blip is the same logical input.
  const [clientMessageId, setClientMessageId] = useState(newClientMessageId);
  const [record, setRecord] = useState<SessionInput | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);

  if (!enabled || !sessionId) {
    return <footer className="shell-dock shell-followup">
      <label htmlFor="shell-followup">Follow-up to this mission</label>
      <textarea id="shell-followup" disabled rows={2}
        placeholder={enabled ? "No live session to address." : "Session-addressed text delivery is not available yet."} />
      <p className="fine-print">{enabled
        ? "This mission has no live execution session, so there is nothing to address. No text has been sent."
        : "No text has been sent. Attachments are a future capability. Use approvals above or open the existing mission controls."}</p>
      <a className="btn" href="#/shell">Start a new mission</a>
    </footer>;
  }

  /** Runs one explicit command and shows whatever the plane now says is true. */
  const command = async (run: () => Promise<SessionInput>) => {
    if (sending) return;
    setSending(true);
    setError(null);
    try {
      setRecord(await run());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSending(false);
    }
  };

  const submit = async () => {
    if (!text.trim() || sending) return;
    setSending(true);
    setError(null);
    try {
      const result = await api.sendSessionInput(sessionId, { clientMessageId, text });
      setRecord(result);
      // Only a settled record releases the key and clears the draft; anything
      // else stays retryable under the identity the plane already knows.
      if (result.state === "delivered" || result.state === "rejected" || result.state === "expired") {
        setText("");
        setClientMessageId(newClientMessageId());
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSending(false);
    }
  };

  return <footer className="shell-dock shell-followup">
    <label htmlFor="shell-followup">Follow-up to this mission</label>
    <textarea id="shell-followup" rows={2} value={text} disabled={sending}
      placeholder="Send a message to this session." onChange={e => setText(e.currentTarget.value)} />
    <div className="shell-followup-actions">
      <button className="btn" type="button" onClick={() => void submit()} disabled={sending || !text.trim()}>
        {record && canRetry(record) ? "Retry this message" : "Send"}
      </button>
      {record && canCommandRetry(record) && <button className="btn" type="button" disabled={sending}
        onClick={() => void command(() => api.retrySessionInput(record.id, record.version))}>Retry this delivery</button>}
      {record && canCommandCancel(record) && <button className="btn" type="button" disabled={sending}
        onClick={() => void command(() => api.cancelSessionInput(record.id, record.version))}>Cancel</button>}
      <span className="fine-print">Addressing session {sessionId}. Attachments are a future capability.</span>
    </div>
    {error && <p className="error" role="alert">Send failed: {error}. Nothing about delivery is known; retry to resolve it.</p>}
    {record && <p role="status" className="shell-followup-state">{deliveryLabel(record)}</p>}
  </footer>;
}
