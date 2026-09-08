import type { SchedulerStatus, TaskContext } from "../api.js";
import { contextPercent, probeFreshness } from "../orbital.js";

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

const kTok = (n: number) => (n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));

/**
 * K9 context gauge. Two truthful outcomes: KNOWN (occupancy + effective window +
 * source + freshness) or UNAVAILABLE. A percentage renders ONLY on a fresh
 * observation with a known effective window — never from an accounting total or
 * the advertised maximum. Provider auto-compaction shows as "Observed", never as
 * an Agentic OS action.
 */
export function ContextReadout({ context }: { context: TaskContext | null }) {
  if (!context) {
    return (
      <p role="status" className="error">
        Context observation unavailable in this read.
      </p>
    );
  }

  const auto = context.autoCompaction?.observed ? (
    <p className="fine-print">
      Provider auto-compaction: <span className="tone-complete">Observed</span>
      {context.autoCompaction.count > 1 ? ` ×${context.autoCompaction.count}` : ""}
      {context.autoCompaction.lastAt
        ? ` · ${new Date(context.autoCompaction.lastAt).toLocaleTimeString()}`
        : ""}
      . This is the provider compacting its own transcript — not an Agentic OS action.
    </p>
  ) : null;

  if (context.status === "unavailable" || !context.observation) {
    const legacy = context.reason === "legacy execution path";
    return (
      <>
        <dl className="identity-grid">
          <div>
            <dt>Context</dt>
            <dd className="muted">Occupancy unavailable</dd>
          </div>
        </dl>
        <p>
          {legacy
            ? "Context observation unavailable — legacy execution path."
            : context.reason
              ? context.reason[0]!.toUpperCase() + context.reason.slice(1) + "."
              : "No canonical ContextObservation is available. Usage accounting is not context occupancy."}
        </p>
        {context.capability?.autoManagement === "provider" && context.capability.autoManagementDetail && (
          <p className="fine-print">{context.capability.autoManagementDetail}</p>
        )}
        {auto}
      </>
    );
  }

  const o = context.observation;
  const percentage = contextPercent({
    occupancyTokens: o.occupancyTokens,
    effectiveWindowTokens: o.effectiveWindowTokens,
    occupancySource: o.occupancySource,
    freshness: o.freshness === "stale" ? "stale" : "live",
  });
  const sourceChip =
    o.occupancySource === "provider-reported"
      ? "Provider-reported"
      : o.occupancySource === "estimated"
        ? `Estimated${o.estimator ? ` (${o.estimator.name} ${o.estimator.version})` : ""}`
        : "Unavailable";

  return (
    <>
      <dl className="identity-grid">
        <div>
          <dt>Occupancy</dt>
          <dd>
            {o.occupancyTokens === undefined
              ? "Unavailable"
              : o.effectiveWindowTokens !== undefined
                ? `${kTok(o.occupancyTokens)} / ${kTok(o.effectiveWindowTokens)} tokens`
                : `${kTok(o.occupancyTokens)} tokens`}
          </dd>
        </div>
        <div>
          <dt>Effective window</dt>
          <dd className={o.effectiveWindowTokens === undefined ? "muted" : undefined}>
            {o.effectiveWindowTokens === undefined
              ? "Unknown"
              : `${o.effectiveWindowTokens.toLocaleString()} tokens · ${o.effectiveWindowSource}`}
          </dd>
        </div>
        <div>
          <dt>Method</dt>
          <dd>
            <span className="badge tone-neutral">{sourceChip}</span>
          </dd>
        </div>
        <div>
          <dt>Freshness</dt>
          <dd className={o.freshness === "stale" ? "tone-limit" : "tone-complete"}>
            {o.freshness === "stale" ? "Stale" : "Live"}
            {o.observedAt ? ` · ${new Date(o.observedAt).toLocaleTimeString()}` : ""}
          </dd>
        </div>
      </dl>
      {percentage !== undefined ? (
        <p>
          Context pressure: <strong>{percentage}%</strong>{" "}
          <meter aria-label="Context pressure" value={Math.min(percentage, 100)} min={0} max={100} />
        </p>
      ) : (
        <p className="fine-print">
          {o.freshness === "stale"
            ? "Observation is stale — pressure is not shown."
            : "Effective window unknown — occupancy tokens only, no percentage."}
        </p>
      )}
      {o.advertisedMaxTokens !== undefined && (
        <p className="fine-print">
          Advertised model maximum: {o.advertisedMaxTokens.toLocaleString()} tokens (separate from the
          provider-managed effective window).
        </p>
      )}
      {auto}
    </>
  );
}
