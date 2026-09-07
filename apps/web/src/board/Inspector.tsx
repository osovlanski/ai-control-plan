import { useCallback, useEffect, useState } from "react";
import {
  api,
  type Assistant,
  type TaskDetail,
  type TaskEvent,
  type RoutingExplanation,
  type SessionSummary,
  type SchedulerStatus,
} from "../api.js";
import { describeState, nextStep, observedModel, waitKindLabel } from "../orbital.js";
import { QuotaReadout, ContextReadout } from "./readouts.js";
import { executionRead, missionState, type Mission } from "./execution.js";

export type Snapshot = {
  detail: TaskDetail;
  events: TaskEvent[];
  routing: Array<{
    chosen: string | null;
    at: string;
    explanation: RoutingExplanation;
  }>;
  assistants: Assistant[];
  sessions: SessionSummary[];
  scheduler: SchedulerStatus | null;
  unavailable: string[];
};

export function Inspector({
  task,
  onOpen,
  onSnapshot,
}: {
  task: Mission;
  onOpen: () => void;
  /** Lets the field light the assistant that is executing this mission. */
  onSnapshot?: (s: Snapshot) => void;
}) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState("execution");
  const [runId, setRunId] = useState("");
  const [nonce, setNonce] = useState(0);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const reload = useCallback(() => setNonce((n) => n + 1), []);
  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      try {
        const [detail, events, routing, assistants, sessions, scheduler] =
          await Promise.allSettled([
            api.task(task.id),
            api.events(task.id),
            api.routing(task.id),
            api.assistants(),
            api.sessions(task.id),
            api.schedulerStatus(),
          ]);
        if (detail.status === "rejected") throw detail.reason;
        if (!disposed) {
          setSnapshot({
            detail: detail.value,
            events: events.status === "fulfilled" ? events.value : [],
            routing: routing.status === "fulfilled" ? routing.value : [],
            assistants:
              assistants.status === "fulfilled" ? assistants.value : [],
            sessions: sessions.status === "fulfilled" ? sessions.value : [],
            scheduler:
              scheduler.status === "fulfilled" ? scheduler.value : null,
            unavailable: [
              events.status === "rejected" ? "Events" : "",
              routing.status === "rejected" ? "Routing" : "",
              assistants.status === "rejected" ? "Provider discovery" : "",
              sessions.status === "rejected" ? "Sessions" : "",
              scheduler.status === "rejected" ? "Scheduler status" : "",
            ].filter(Boolean),
          });
          setError(null);
        }
      } catch (e) {
        if (!disposed) setError((e as Error).message);
      } finally {
        if (!disposed) timer = setTimeout(() => void load(), 4000);
      }
    };
    void load();
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [task.id, nonce]);
  useEffect(() => {
    if (snapshot) onSnapshot?.(snapshot);
  }, [snapshot, onSnapshot]);
  const run =
    snapshot?.detail.runs.find((r) => r.id === runId) ??
    snapshot?.detail.runs.at(-1);
  const effectiveState = snapshot ? missionState({ state: snapshot.detail.state, execution: executionRead(snapshot.detail, snapshot.sessions) }) : missionState(task);
  const state = describeState(
    effectiveState,
    (snapshot?.detail as { pause_kind?: string | null } | undefined)?.pause_kind,
  );
  const session = snapshot?.sessions.find((s) => s.sessionId === run?.id);
  const assistant = snapshot?.assistants.find(
    (a) => a.id === run?.assistant_id,
  );
  const latestRun = snapshot?.detail.runs.at(-1);
  const currentExecution = snapshot ? executionRead(snapshot.detail, snapshot.sessions) : undefined;
  const routing = snapshot?.routing.at(-1);
  const wait = snapshot?.detail.wait;
  const schedulerEnabled = snapshot?.detail.schedulerEnabled !== false;

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setActionError(null);
    try {
      await fn();
      reload();
    } catch (e) {
      setActionError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="inspector" aria-label="Selected task inspector">
      <div className="inspector-top">
        <span className="eyebrow">Selected mission</span>
        <span className={`badge tone-${state.tone}`}>{state.label}</span>
      </div>
      <h2>{task.goal}</h2>
      <code className="task-id">{task.id}</code>
      <p className="state-reason">{state.reason}</p>
      <dl className="decision-strip" aria-label="Decision summary">
        <div>
          <dt>Decided</dt>
          <dd>
            {latestRun ? (
              <>
                Last run on <span className="mono">{latestRun.assistant_id}</span>
              </>
            ) : routing?.chosen ? (
              <>
                Route to <span className="mono">{routing.chosen}</span>
              </>
            ) : routing ? (
              "No eligible assistant"
            ) : (
              "Not routed yet"
            )}
          </dd>
        </div>
        <div>
          <dt>Because</dt>
          <dd>
            {routing ? (
              <>
                <span className="mono">{routing.explanation.ruleFired}</span>
                {routing.explanation.userOverride ? " · operator override" : ""}
              </>
            ) : wait ? (
              wait.reason
            ) : (
              "No routing decision recorded"
            )}
          </dd>
        </div>
        <div>
          <dt>Next</dt>
          <dd>
            {nextStep({
              state: effectiveState,
              wait,
              schedulerEnabled,
              assistant: currentExecution?.assistants.join(", ") || undefined,
              pauseKind: (snapshot?.detail as { pause_kind?: string | null } | undefined)?.pause_kind,
            })}
          </dd>
        </div>
      </dl>
      <button className="open-task" onClick={onOpen}>
        Open full controls & diagnostics <span>↗</span>
      </button>
      <div className="inspector-tabs" aria-label="Inspector sections">
        {["execution", "decision", "context", "schedule", "quota"].map((t) => (
          <button key={t} aria-pressed={tab === t} onClick={() => setTab(t)}>
            {t[0]!.toUpperCase() + t.slice(1)}
          </button>
        ))}
      </div>
      {error && (
        <p role="alert" className="error">
          Inspector unavailable: {error}.{" "}
          {snapshot ? "Last successful snapshot shown." : ""}
        </p>
      )}
      {!snapshot && !error && <p role="status" className="status-line">Loading mission evidence…</p>}
      {snapshot?.unavailable.length ? (
        <p role="status" className="error">
          Unavailable reads: {snapshot.unavailable.join(", ")}.
        </p>
      ) : null}
      {snapshot && tab === "execution" && (
        <div className="inspector-content">
          {session && (
            <p
              className={
                session.sessionState === "AWAITING_APPROVAL" ? "tone-human" : ""
              }
            >
              Session: <strong>{session.sessionState}</strong>
              {session.sessionState === "AWAITING_APPROVAL"
                ? " · Approval required; open task controls to review."
                : session.sessionState === "VERIFYING"
                  ? " · Verification in progress; task outcome is separate."
                  : ""}
            </p>
          )}
          {snapshot.detail.runs.length > 0 && (
            <label className="run-select">
              Run{" "}
              <select
                value={run?.id}
                onChange={(e) => setRunId(e.target.value)}
              >
                {snapshot.detail.runs.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.assistant_id} · {r.id} · {r.state}
                  </option>
                ))}
              </select>
            </label>
          )}
          <dl className="identity-grid">
            <div>
              <dt>Harness / assistant</dt>
              <dd className="mono">{run?.assistant_id ?? "Not started"}</dd>
            </div>
            <div>
              <dt>Provider adapter</dt>
              <dd>{assistant?.provider ?? "Unknown"}</dd>
            </div>
            <div>
              <dt>Requested model</dt>
              <dd>Not exposed by run API</dd>
            </div>
            <div>
              <dt>Resolved model</dt>
              <dd className="mono">{observedModel(snapshot.events, run?.id)}</dd>
            </div>
          </dl>
          <p className="fine-print">
            Resolved identity uses this run’s provider start evidence only.
            Serving-provider identity awaits K7.
          </p>
          <div className="section-label">
            Recent run activity <span>Recorded events</span>
          </div>
          <ol className="event-list">
            {snapshot.events
              .filter((e) => e.run_id === run?.id)
              .slice(-3)
              .reverse()
              .map((e) => (
                <li key={`${e.run_id}-${e.seq}`}>
                  <time>
                    {new Date(e.ts).toLocaleTimeString([], {
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </time>
                  <div>
                    <strong>{e.type}</strong>
                    <span>{e.summary}</span>
                  </div>
                </li>
              ))}
          </ol>
          {!snapshot.events.some((e) => e.run_id === run?.id) && (
            <p className="fine-print">No recorded events for this run.</p>
          )}
        </div>
      )}
      {snapshot && tab === "decision" && (
        <div className="inspector-content">
          <div className="section-label">
            Recorded task routing <span>Implemented</span>
          </div>
          <p>
            {routing
              ? `The router selected ${routing.chosen ?? "no eligible assistant"} using ${routing.explanation.ruleFired}.`
              : "No routing decision recorded."}
          </p>
          {routing && (
            <>
              <p className="fine-print">
                {new Date(routing.at).toLocaleString()} · Latest task decision;
                not a per-run CompositionDecision.
              </p>
              {routing.explanation.userOverride && (
                <p>User override: {routing.explanation.userOverride}</p>
              )}
              {routing.explanation.tieBreaker && (
                <p>Tie-break: {routing.explanation.tieBreaker}</p>
              )}
              <ul className="candidate-list">
                {routing.explanation.candidates.map((c) => (
                  <li key={c.assistantId}>
                    <strong>{c.assistantId}</strong>
                    <span
                      className={
                        c.passedFilters ? "tone-complete" : "tone-failed"
                      }
                    >
                      {c.passedFilters ? "Eligible" : "Excluded"}
                    </span>
                    <small>
                      {c.filterFailures.join(" · ") ||
                        "Passed recorded hard filters"}
                    </small>
                  </li>
                ))}
              </ul>
            </>
          )}
          <details>
            <summary>
              Composition & model intelligence{" "}
              <span className="planned">Planned</span>
            </summary>
            <p>
              Prompt → intent → harness → model → skills/MCP → context/memory →
              policy → execution.
            </p>
            <p>
              Asset attachment and CompositionDecision await the Composer.
              Ambient tooling is not evidence of attachment.
            </p>
            <p>
              M12 will separate shadow recommendations from active routing, with
              internal/external evidence, confidence and freshness. Public
              benchmarks cannot bypass compatibility, authentication, security
              or quota filters.
            </p>
            <p>
              Current profile: {task.profile}. Model-level
              cost/quality/speed/token/quota preferences and model overrides
              await M12; existing assistant profiles remain available at intake.
            </p>
          </details>
        </div>
      )}
      {tab === "context" && (
        <div className="inspector-content">
          <div className="section-label">
            Context observation <span className="planned">Planned · K9</span>
          </div>
          <ContextReadout
            observation={{
              occupancySource: "unavailable",
              freshness: "unavailable",
            }}
          />
          <p>
            No canonical ContextObservation is exposed by this backend. Usage
            accounting is not context occupancy.
          </p>
          <ul className="capability-list">
            <li>
              <strong>Model intelligence & composition</strong>
              <span className="planned">Planned · M12</span>
            </li>
            <li>
              <strong>Attached skills / MCP / memory</strong>
              <span className="planned">Planned · Composer</span>
            </li>
            <li>
              <strong>Context pressure & intervention</strong>
              <span className="planned">Planned · K9 / M14</span>
            </li>
            <li>
              <strong>Dependency & recurring schedule state</strong>
              <span className="planned">Planned · K4 / K5</span>
            </li>
          </ul>
          <details>
            <summary>Context lifecycle</summary>
            <p>
              Observe → pressure → provider-capable intervention → re-observe →
              continuation.
            </p>
            <p>
              Compaction boundaries, relief and checkpoint-backed clean-session
              continuation await M14. Provider controls vary; no universal
              compaction action is available.
            </p>
          </details>
        </div>
      )}
      {snapshot && tab === "schedule" && (
        <div className="inspector-content">
          <div className="section-label">
            Durable wait condition <span>K1 / K2 · Implemented</span>
          </div>
          {wait ? (
            <>
              <dl className="identity-grid">
                <div>
                  <dt>Wait kind</dt>
                  <dd>{waitKindLabel(wait)}</dd>
                </div>
                <div>
                  <dt>Condition state</dt>
                  <dd>
                    {wait.state} · generation {wait.generation}
                  </dd>
                </div>
                <div>
                  <dt>Next eligible time</dt>
                  <dd>
                    <time dateTime={wait.notBefore}>
                      {new Date(wait.notBefore).toLocaleString()}
                    </time>
                  </dd>
                </div>
                <div>
                  <dt>Automatic wakes used</dt>
                  <dd>{wait.autoWakes ?? 0}</dd>
                </div>
                <div>
                  <dt>Checkpoint anchor</dt>
                  <dd>
                    {wait.checkpointId
                      ? `${wait.checkpointId.slice(0, 12)} — continuation resumes from here`
                      : "None — fresh start on wake"}
                  </dd>
                </div>
                <div>
                  <dt>Quota subjects</dt>
                  <dd>{wait.assistants?.join(", ") || "—"}</dd>
                </div>
              </dl>
              <p className="fine-print">
                Reason: {wait.reason} · Routing happens at wake, not now. The
                map position is an index, not this time.
              </p>
              {!schedulerEnabled && (
                <p role="status" className="error">
                  Automatic scheduling is disabled for this workspace. The task
                  stays waiting until an operator uses Run now.
                </p>
              )}
              {!!wait.blockers?.length && (
                <>
                  <div className="section-label">
                    Quota blocker evidence <span>Provider observations</span>
                  </div>
                  <ul className="candidate-list">
                    {wait.blockers.map((b, i) => (
                      <li key={i}>
                        <strong>{b.assistantId}</strong>
                        <span className="tone-limit">{b.kind}</span>
                        <small>
                          {b.reason} · source {b.source} · provenance{" "}
                          {b.resetProvenance}
                          {b.scope.bucket ? ` · bucket ${b.scope.bucket}` : ""}
                          {b.scope.account
                            ? ` · account ${b.scope.account}`
                            : ""}
                          {b.retryAt
                            ? ` · retry ${new Date(b.retryAt).toLocaleString()}`
                            : ""}{" "}
                          · observed{" "}
                          {new Date(b.observedAt).toLocaleString()}
                        </small>
                      </li>
                    ))}
                  </ul>
                </>
              )}
              {!!wait.history?.length && (
                <>
                  <div className="section-label">
                    Wait history <span>Revalidation & re-park trail</span>
                  </div>
                  <ol className="event-list">
                    {wait.history
                      .slice(-5)
                      .reverse()
                      .map((h, i) => (
                        <li key={i}>
                          <time>{new Date(h.at).toLocaleString()}</time>
                          <div>
                            <strong>
                              {h.actor} · {h.outcome}
                            </strong>
                            {h.reason && <span>{h.reason}</span>}
                          </div>
                        </li>
                      ))}
                  </ol>
                </>
              )}
              {wait.state === "active" && (
                <div role="group" aria-label="Scheduler controls">
                  <div className="controls">
                    <button
                      className="btn btn-primary"
                      disabled={busy}
                      onClick={() =>
                        void act(() => api.runNow(task.id, wait.generation))
                      }
                    >
                      Run now
                    </button>
                    <button
                      className="btn"
                      disabled={busy}
                      onClick={() =>
                        void act(() =>
                          api.attachWait(task.id, {
                            kind: "time",
                            notBefore: new Date(
                              Date.now() + 10 * 60_000,
                            ).toISOString(),
                            reason: "Operator replaced the wait (+10 min)",
                          }),
                        )
                      }
                    >
                      Replace with +10 min time wait
                    </button>
                    <button
                      className="btn btn-danger"
                      disabled={busy}
                      onClick={() => void act(() => api.cancel(task.id))}
                    >
                      Cancel task
                    </button>
                  </div>
                </div>
              )}
              {actionError && (
                <p role="alert" className="error">
                  {actionError}
                </p>
              )}
            </>
          ) : (
            <p>
              No durable wait condition on this task. Create one at intake (Run
              at a future time) or it is attached automatically when K2
              checkpoints a quota-limited run.
            </p>
          )}
          {!!snapshot.detail.schedulerEvents?.length && (
            <>
              <div className="section-label">
                Scheduler events <span>Durable dispatch log</span>
              </div>
              <ol className="event-list">
                {snapshot.detail.schedulerEvents
                  .slice(-6)
                  .reverse()
                  .map((e) => (
                    <li key={e.id}>
                      <time>{new Date(e.at).toLocaleString()}</time>
                      <div>
                        <strong>{e.type}</strong>
                        {typeof e.payload.reason === "string" && (
                          <span>{e.payload.reason}</span>
                        )}
                      </div>
                    </li>
                  ))}
              </ol>
            </>
          )}
          {!!snapshot.detail.dispatches?.length && (
            <p className="fine-print">
              Latest dispatch:{" "}
              {snapshot.detail.dispatches.at(-1)!.phase} · origin{" "}
              {snapshot.detail.dispatches.at(-1)!.origin} · path{" "}
              {snapshot.detail.dispatches.at(-1)!.execution_path}
            </p>
          )}
          <ul className="capability-list">
            <li>
              <strong>Run now (generation-checked override)</strong>
              <span className="tone-complete">Implemented · K1</span>
            </li>
            <li>
              <strong>Run at a future time</strong>
              <span className="tone-complete">Implemented · K1</span>
            </li>
            <li>
              <strong>Wait for quota, checkpoint & resume</strong>
              <span className="tone-complete">Implemented · K2</span>
            </li>
            <li>
              <strong>After dependency</strong>
              <span className="planned">Planned · K4</span>
            </li>
            <li>
              <strong>Recurring schedule</strong>
              <span className="planned">Planned · K5</span>
            </li>
          </ul>
          <details>
            <summary>Later schedule controls</summary>
            <p>
              Dependency waits (K4), recurring schedules and occurrence
              outcomes (K5) and the Cockpit scheduler surface (K6) are not
              implemented. Human approval, verification and comparison
              decisions cannot be deferred around.
            </p>
          </details>
        </div>
      )}
      {snapshot && tab === "quota" && (
        <QuotaReadout
          scheduler={snapshot.scheduler}
          unavailable={snapshot.unavailable.includes("Scheduler status")}
        />
      )}
    </section>
  );
}
