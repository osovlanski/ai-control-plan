/**
 * The operator's view of undelivered conversation: every session-addressed
 * message this workspace cannot account for, across every session.
 *
 * Until now that state had no operator affordance at all — an ambiguous
 * delivery was visible only to whoever happened to have the right Shell mission
 * open. This closes that gap and nothing more: it renders the plane's own
 * unresolved set, and its only actions are the retry and cancel commands the
 * plane already accepts.
 *
 * It is rendered only while `sessionInput.enabled` is true. With the capability
 * off — the default — the Traces workspace is exactly what it was.
 */
import { useEffect, useState } from "react";
import { api, type SessionInput } from "../api.js";
import { DeliveryCommands, DeliveryStatus, needsManualRecovery, useDeliveryCommand } from "./delivery.js";

/** The bounded reason the last attempt ended as it did — the cause, not the verdict. */
function lastDiagnostic(input: SessionInput): string | null {
  return input.attempts?.at(-1)?.diagnostic ?? null;
}

export function DeliveryRecovery() {
  const [inputs, setInputs] = useState<SessionInput[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const { busy, error: commandError, run } = useDeliveryCommand(() => setRevision(n => n + 1));
  useEffect(() => {
    let disposed = false;
    void api.unresolvedInputs()
      .then(page => { if (!disposed) { setInputs(page.inputs); setError(null); } })
      .catch((e: unknown) => { if (!disposed) setError(e instanceof Error ? e.message : String(e)); });
    return () => { disposed = true; };
  }, [revision]);

  const stuck = inputs?.filter(needsManualRecovery).length ?? 0;
  return <section className="delivery-recovery" aria-label="Delivery recovery">
    <h2>Delivery recovery</h2>
    <p>Messages addressed to a session whose delivery this plane cannot confirm. An unresolved message was
      neither delivered nor refused: an attempt was taken and its outcome is unknown. Nothing here is resent
      automatically unless the provider can prove what it received.</p>
    {error && <p className="error" role="alert">Delivery recovery unavailable: {error}. Any affected message is still recorded.</p>}
    {!error && inputs === null && <p role="status">Reading unresolved deliveries…</p>}
    {!error && inputs?.length === 0 && <p role="status">Every addressed message is accounted for.</p>}
    {!!stuck && <p className="delivery-recovery-count tone-human" role="status">
      {stuck} {stuck === 1 ? "message needs" : "messages need"} manual recovery.</p>}
    {inputs?.map(input => <article key={input.id} className="delivery-recovery-row">
      <p className="delivery-recovery-text">{input.text}</p>
      <p className="fine-print">Mission {input.taskId} · session {input.sessionId} ·
        sent <time dateTime={input.createdAt}>{new Date(input.createdAt).toLocaleString()}</time></p>
      <DeliveryStatus input={input} />
      {lastDiagnostic(input) && <p className="fine-print">Last attempt: {lastDiagnostic(input)}</p>}
      <div className="delivery-recovery-actions">
        <DeliveryCommands input={input} busy={busy} run={run} />
        <a className="btn" href={`#/shell/${encodeURIComponent(input.taskId)}`}>Open the conversation</a>
        <a className="btn" href={`#/missions/${encodeURIComponent(input.taskId)}`}>Mission & traces</a>
      </div>
    </article>)}
    {commandError && <p className="error" role="alert">Command refused: {commandError}. The record is unchanged.</p>}
  </section>;
}
