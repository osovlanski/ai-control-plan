import type { SchedulerStatus } from "../api.js";
import { contextPercent, probeFreshness, type ContextView } from "../orbital.js";

/** K3 idle quota probe evidence, read from `/api/scheduler/status`. */
export function QuotaReadout({
  scheduler,
  unavailable,
}: {
  scheduler: SchedulerStatus | null;
  unavailable: boolean;
}) {
  return (
    <div className="inspector-content">
      <div className="section-label">
        Idle quota observation <span>K3 · Optional probe</span>
      </div>
      {unavailable || !scheduler ? (
        <p role="status" className="error">
          Scheduler status is unavailable in this read.
        </p>
      ) : !scheduler.probesEnabled ? (
        <p>
          Idle quota probes are <strong>disabled</strong> for this workspace
          (<code>scheduler.quotaProbe: false</code>). Quota evidence still comes
          from run-stream <code>limit.hit</code> events and, on a K2 quota wait,
          the blocker evidence in the Schedule tab.
        </p>
      ) : scheduler.probes.length === 0 ? (
        <p>Probes are enabled but no attempt has been recorded yet.</p>
      ) : (
        <>
          <p className="fine-print">
            One attempt per assistant per window. A probe is an observation, not
            a wake — it revalidates provider headroom before routing decides.
          </p>
          <ul className="candidate-list">
            {scheduler.probes.map((p) => (
              <li key={p.assistantId}>
                <strong>{p.assistantId}</strong>
                <span
                  className={
                    p.outcome === "ok"
                      ? "tone-complete"
                      : p.outcome === "unsupported"
                        ? "tone-neutral"
                        : "tone-limit"
                  }
                >
                  {p.outcome}
                </span>
                <small>
                  freshness {probeFreshness(p.ageMs)} ·{" "}
                  {Math.round(p.ageMs / 1000)}s ago · attempted{" "}
                  {new Date(p.attemptedAt).toLocaleString()}
                  {p.detail ? ` · ${p.detail}` : ""}
                  {p.outcome === "unsupported"
                    ? " · this provider exposes no verified idle endpoint"
                    : ""}
                </small>
              </li>
            ))}
          </ul>
        </>
      )}
      <p className="fine-print">
        Scoped bucket / account / provenance for an exhausted window surface on
        the task’s K2 quota wait (Schedule tab), tied to the wake revalidation.
      </p>
    </div>
  );
}

/** Narrow presentation seam for K9; no endpoint or context controller is invented here. */
export function ContextReadout({ observation }: { observation: ContextView }) {
  const percentage = contextPercent(observation);
  return (
    <>
      <dl className="identity-grid">
        <div>
          <dt>Occupancy</dt>
          <dd>
            {observation.occupancyTokens === undefined
              ? "Unavailable"
              : `${observation.occupancyTokens.toLocaleString()} tokens`}
          </dd>
        </div>
        <div>
          <dt>Effective window</dt>
          <dd>
            {observation.effectiveWindowTokens === undefined
              ? "Unknown"
              : `${observation.effectiveWindowTokens.toLocaleString()} tokens`}
          </dd>
        </div>
        <div>
          <dt>Source</dt>
          <dd>
            {observation.occupancySource}
            {observation.estimator
              ? ` (${observation.estimator.name} ${observation.estimator.version})`
              : ""}
          </dd>
        </div>
        <div>
          <dt>Freshness</dt>
          <dd>
            {observation.freshness}
            {observation.observedAt
              ? ` · ${new Date(observation.observedAt).toLocaleString()}`
              : ""}
          </dd>
        </div>
      </dl>
      {observation.advertisedMaxTokens !== undefined && (
        <p>
          Advertised maximum: {observation.advertisedMaxTokens.toLocaleString()}{" "}
          tokens
        </p>
      )}
      {percentage !== undefined && (
        <p>
          Context pressure: {percentage}%{" "}
          <meter
            aria-label="Context pressure"
            value={Math.min(percentage, 100)}
            min={0}
            max={100}
          />
        </p>
      )}
    </>
  );
}
