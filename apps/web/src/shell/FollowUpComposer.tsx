/**
 * The Shell follow-up composer.
 *
 * Minimal on purpose: it exists to prove the durable session-input contract end
 * to end, not to be a finished conversation experience. Two rules govern it:
 *
 *  1. With the capability off — the default — it is byte-for-byte the disabled
 *     composer that shipped with Shell mode, saying truthfully that
 *     session-addressed delivery is unavailable.
 *  2. With it on, the wording never runs ahead of the plane, and a retry reuses
 *     the SAME client message id, so retrying can never produce a second
 *     message.
 *
 * Delivery state is NOT shown here: it belongs to the transcript above, which
 * reads it from the plane rather than remembering what this browser sent. This
 * component's only view of the ledger is the row for its own client key, and
 * only to say whether pressing send would be a retry.
 */
import { useState } from "react";
import { api, type SessionInput } from "../api.js";
import { canRetry } from "./delivery.js";

const newClientMessageId = (): string =>
  globalThis.crypto?.randomUUID?.() ?? `cmid-${Date.now()}-${Math.random().toString(36).slice(2)}`;

export function FollowUpComposer({ enabled, sessionId, inputs = [], onSent }: {
  enabled: boolean; sessionId?: string; inputs?: readonly SessionInput[]; onSent?: () => void;
}) {
  const [text, setText] = useState("");
  // Generated before the first request and held until the message settles, so a
  // retry after a network blip is the same logical input.
  const [clientMessageId, setClientMessageId] = useState(newClientMessageId);
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

  // The plane's record for THIS draft, if one exists yet. The newest generation
  // wins: an explicit retry of a rejection files a successor under the same key.
  const mine = inputs.filter(row => row.clientMessageId === clientMessageId).at(-1);

  const submit = async () => {
    if (!text.trim() || sending) return;
    setSending(true);
    setError(null);
    try {
      const result = await api.sendSessionInput(sessionId, { clientMessageId, text });
      // Only a settled record releases the key and clears the draft; anything
      // else stays retryable under the identity the plane already knows.
      if (result.state === "delivered" || result.state === "rejected" || result.state === "expired") {
        setText("");
        setClientMessageId(newClientMessageId());
      }
      onSent?.();
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
        {mine && canRetry(mine) ? "Retry this message" : "Send"}
      </button>
      <span className="fine-print">Addressing session {sessionId}. Attachments are a future capability.</span>
    </div>
    {error && <p className="error" role="alert">Send failed: {error}. Nothing about delivery is known; retry to resolve it.</p>}
  </footer>;
}
