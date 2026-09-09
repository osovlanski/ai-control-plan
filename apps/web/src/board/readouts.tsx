import type { ModelRecommendation } from "@agent-plane/core";
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

/** K11 — truthful continuation state. Renders nothing until a context yield happened. */
const CONTINUATION_STOPS: Record<string, string> = {
  continuation_evidence_missing: "Continuation evidence missing",
  continuation_limit_reached: "Continuation limit reached",
  continuation_no_progress: "No progress between continuations",
  successor_immediately_critical: "Successor immediately critical",
};

function ContinuationReadout({ continuation }: { continuation: NonNullable<TaskContext["continuation"]> }) {
  const stop = continuation.waitingReason ? CONTINUATION_STOPS[continuation.waitingReason] : undefined;
  return (
    <dl className="identity-grid">
      <div>
        <dt>Context continuation</dt>
        <dd>
          {continuation.number} of {continuation.limit}
        </dd>
      </div>
      <div>
        <dt>Reason</dt>
        <dd>{continuation.reason}</dd>
      </div>
      {continuation.checkpointId && (
        <div>
          <dt>Checkpoint</dt>
          <dd className="mono">{continuation.checkpointId}</dd>
        </div>
      )}
      {continuation.predecessorSessionId && (
        <div>
          <dt>Predecessor</dt>
          <dd className="mono">{continuation.predecessorSessionId}</dd>
        </div>
      )}
      <div>
        <dt>Successor</dt>
        <dd className={continuation.successorSessionId ? "mono" : "muted"}>
          {continuation.successorSessionId ?? "pending"}
        </dd>
      </div>
      {stop && (
        <div>
          <dt>Waiting for you</dt>
          <dd className="tone-limit">{stop}</dd>
        </div>
      )}
    </dl>
  );
}

export function ContextReadout({ context }: { context: TaskContext | null }) {
  if (!context) {
    return (
      <p role="status" className="error">
        Context observation unavailable in this read.
      </p>
    );
  }

  const continuation = context.continuation ? (
    <ContinuationReadout continuation={context.continuation} />
  ) : null;

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
        {continuation}
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
      {continuation}
    </>
  );
}

/**
 * K13 shadow model recommendation. It must be impossible to read this panel and
 * think the recommendation affected the run: the heading says SHADOW, the
 * execution line states what actually ran, and every number carries the source
 * and sample size it came from.
 */
export function ModelRecommendationReadout({
  recommendation,
}: {
  recommendation: ModelRecommendation | null | undefined;
}) {
  if (!recommendation) {
    return (
      <p className="fine-print">
        No model recommendation was recorded for this decision. Routing never
        waits on model intelligence, so a missing catalog simply leaves this
        empty.
      </p>
    );
  }

  const applied = recommendation.mode === "applied";
  const winner = recommendation.candidates.find((c) => c.label === recommendation.recommended);
  const alternatives = recommendation.candidates.filter((c) => !c.eligible);

  return (
    <>
      <div className="section-label">
        {applied ? "Applied model selection" : "Shadow model recommendation"}{" "}
        <span className={applied ? "tone-complete" : "tone-limit"}>
          {applied ? "APPLIED" : "SHADOW"}
        </span>
      </div>

      <p>
        {recommendation.recommended ? (
          <>
            {applied ? "Chose" : "Would choose"}{" "}
            <span className="mono">{recommendation.recommended}</span>.
          </>
        ) : (
          <>No model is recommended: {recommendation.reason}</>
        )}
      </p>

      {applied ? (
        <p className="fine-print">
          Current execution: <strong>this model</strong>. The decision committed{" "}
          <span className="mono">{recommendation.execution.requestedModelSelector}</span>,
          and {recommendation.execution.authority} carries it into the run — it
          remains the only authority for the requested model.
        </p>
      ) : (
        <p className="fine-print">
          Current execution: <strong>unchanged</strong>. This recommendation did
          not set the requested model
          {recommendation.execution.requestedModelSelector ? (
            <>
              {" "}— the run asked for{" "}
              <span className="mono">
                {recommendation.execution.requestedModelSelector}
              </span>
            </>
          ) : (
            " — the run named no model"
          )}
          , and {recommendation.execution.authority} remains the only authority
          for it. ({recommendation.execution.detail})
        </p>
      )}

      {winner && (
        <>
          <p className="fine-print">Because:</p>
          <ul className="candidate-list">
            {winner.dimensions.map((d) => (
              <li key={d.dimension}>
                <strong>{d.dimension}</strong>
                <span className={d.score === undefined ? "muted" : "tone-complete"}>
                  {d.score === undefined ? "no evidence" : d.score.toFixed(2)}
                </span>
                <small>
                  {d.telemetry
                    ? `Own runs ${d.n} · weight ${Math.round(d.weight * 100)}% (k=${d.k}) · ${d.telemetry.metric}`
                    : `Own runs 0 · weight 0% (k=${d.k})`}
                  {d.prior
                    ? ` · ${d.prior.source} ${d.prior.value.toFixed(2)} · ${d.prior.freshness}${
                        d.prior.benchmarkRelease ? ` · ${d.prior.benchmarkRelease}` : ""
                      } · observed ${new Date(d.prior.observedAt).toLocaleDateString()}${
                        d.prior.benchmarkPublishedAt ? ` · published ${d.prior.benchmarkPublishedAt}` : ""
                      }`
                    : ` · ${d.missing ?? "no prior"}`}
                  {d.excludedPriors.map((e) => ` · excluded ${e.source}: ${e.reason}`).join("")}
                </small>
              </li>
            ))}
          </ul>
          <p className="fine-print">
            Identity: {winner.identity.basis} — {winner.identity.evidence}
          </p>
          {winner.advisories.length > 0 && (
            <p className="fine-print">Advisory: {winner.advisories.join(" · ")}</p>
          )}
        </>
      )}

      {recommendation.tieBreaker && (
        <p className="fine-print">Tie-break: {recommendation.tieBreaker}</p>
      )}
      {recommendation.userOverride && (
        <p className="fine-print">
          Operator override <span className="mono">{recommendation.userOverride.selector}</span>:{" "}
          {recommendation.userOverride.detail}
        </p>
      )}

      {alternatives.length > 0 && (
        <>
          <p className="fine-print">Hard-filtered alternatives:</p>
          <ul className="candidate-list">
            {alternatives.map((c) => (
              <li key={c.label}>
                <strong>{c.label}</strong>
                <span className="tone-failed">Excluded</span>
                <small>{c.filterFailures.join(" · ")}</small>
              </li>
            ))}
          </ul>
          <p className="fine-print">
            A benchmark score never resurrects an excluded candidate — hard
            filters run before any score.
          </p>
        </>
      )}

      {recommendation.missingEvidence.length > 0 && (
        <p className="fine-print">
          Missing evidence: {recommendation.missingEvidence.join(" · ")}
        </p>
      )}

      <details>
        <summary>
          Why this is {applied ? "active" : "shadow"}{" "}
          <span className={applied ? "tone-complete" : "tone-limit"}>
            {recommendation.activation.gates.filter((g) => g.passed).length}/
            {recommendation.activation.gates.length} gates
          </span>
        </summary>
        <ul className="candidate-list">
          {recommendation.activation.gates.map((gate) => (
            <li key={gate.name}>
              <strong>{gate.name}</strong>
              <span className={gate.passed ? "tone-complete" : "tone-failed"}>
                {gate.passed ? "Passed" : "Failed"}
              </span>
              <small>{gate.detail}</small>
            </li>
          ))}
        </ul>
      </details>
    </>
  );
}
