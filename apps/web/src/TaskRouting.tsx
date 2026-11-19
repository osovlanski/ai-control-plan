import type { api, TaskDetail } from "./api.js";
import { AssistantEligibility, DecisionSummary, ModelRecommendationReadout } from "./board/readouts.js";
import { modelIdentityView } from "./orbital.js";

type RoutingRecord = Awaited<ReturnType<typeof api.routing>>[number];

const originLabels: Record<string, string> = {
  intake: "Intake",
  wake: "Scheduler wake",
  "run-now": "Run now",
  failover: "Failover",
  "context-yield": "Context continuation",
};

function RecordedDecision({ decision }: { decision: RoutingRecord }) {
  const { explanation, chosen } = decision;
  const { modelRecommendation, origin } = explanation;
  return (
    <>
      <p className="fine-print">
        <time dateTime={decision.at}>{new Date(decision.at).toLocaleString()}</time>
        {origin && ` · ${originLabels[origin] ?? origin}`}
        {" · "}{explanation.ruleFired}
      </p>
      {modelRecommendation ? (
        <DecisionSummary recommendation={modelRecommendation} actual={{ assistantId: chosen, recorded: true }} />
      ) : (
        <>
          <p>Selected assistant: <strong className="mono">{chosen ?? "None selected"}</strong></p>
          <ModelRecommendationReadout recommendation={undefined} />
        </>
      )}
      {explanation.userOverride && <p className="fine-print">Assistant override: {explanation.userOverride}</p>}
      <details className="decision-evidence">
        <summary>Routing and model evidence</summary>
        <div className="section-label">Assistant eligibility</div>
        {explanation.tieBreaker && <p className="fine-print">Tie-break: {explanation.tieBreaker}</p>}
        <AssistantEligibility candidates={explanation.candidates} />
        {modelRecommendation && <ModelRecommendationReadout recommendation={modelRecommendation} summaryShown />}
      </details>
    </>
  );
}

export function TaskRouting({ routing, unavailable, runs }: {
  routing: RoutingRecord[];
  unavailable: boolean;
  runs: TaskDetail["runs"] | null;
}) {
  // The API orders by decision id, oldest first. Timestamps can tie during a
  // continuation; preserve that order instead of guessing from run timestamps.
  const latest = routing.at(-1);
  const latestRun = runs?.at(-1);
  const identity = latestRun?.modelIdentity && modelIdentityView(latestRun.modelIdentity, "Unknown");
  return (
    <section className="task-routing" aria-label="Task routing">
      {unavailable ? (
        <p role="status" className="error">Routing evidence unavailable in this read.</p>
      ) : latest ? (
        <>
          <section aria-label="Latest routing decision">
            <h3>Latest recorded decision</h3>
            <RecordedDecision decision={latest} />
          </section>
          {routing.length > 1 && (
            <details>
              <summary>Earlier routing decisions ({routing.length - 1})</summary>
              {routing.slice(0, -1).reverse().map((decision, index) => {
                const position = routing.length - index - 1;
                return (
                  <section key={position} aria-label={`Earlier decision ${position}`}>
                    <RecordedDecision decision={decision} />
                  </section>
                );
              })}
            </details>
          )}
        </>
      ) : <p role="status">No routing decisions recorded.</p>}

      <section aria-label="Latest run model identity">
        <h3>Latest run model identity</h3>
        {runs === null ? <p role="status" className="error">Run model identity unavailable in this read.</p> : latestRun ? (
          <>
            <p className="fine-print">
              Run <span className="mono">{latestRun.id}</span> · {latestRun.assistant_id} · {latestRun.state}
            </p>
            {identity ? (
              <dl className="identity-grid">
                <div><dt>Requested model</dt><dd className="mono">{identity.requested}</dd></div>
                <div><dt>Provider-reported resolved model</dt><dd className="mono">{identity.served}</dd></div>
              </dl>
            ) : <p className="fine-print">No model identity was recorded for this run.</p>}
          </>
        ) : <p className="fine-print">No run recorded.</p>}
      </section>
    </section>
  );
}
