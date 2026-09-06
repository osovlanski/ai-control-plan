import { useCallback, useEffect, useState, type CSSProperties } from "react";
import {
  api,
  type Assistant,
  type TaskSummary,
  type TaskDetail,
  type TaskEvent,
  type RoutingExplanation,
  type SessionSummary,
  type SchedulerStatus,
} from "./api.js";
import {
  describeState,
  observedModel,
  contextPercent,
  probeFreshness,
  waitKindLabel,
  type ContextView,
} from "./orbital.js";

const terminal = new Set(["COMPLETED", "FAILED", "CANCELLED"]);
const positions = [
  [70, 25],
  [83, 53],
  [66, 80],
  [30, 79],
  [16, 50],
  [32, 23],
];
type Snapshot = {
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

export function OrbitalBoard({
  onOpen,
  onNew,
}: {
  onOpen: (id: string) => void;
  onNew: () => void;
}) {
  const [tasks, setTasks] = useState<TaskSummary[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [filter, setFilter] = useState("all");
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      try {
        const rows = await api.tasks();
        if (!disposed) {
          setTasks(rows);
          setError(null);
        }
      } catch (e) {
        if (!disposed) setError((e as Error).message);
      } finally {
        if (!disposed) {
          setLoading(false);
          timer = setTimeout(() => void load(), 4000);
        }
      }
    };
    void load();
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, []);
  const visible = tasks.filter(
    (t) =>
      (filter === "all" ||
        (filter === "attention"
          ? t.state === "WAITING_INPUT" || t.state === "LIMIT_PAUSED"
          : !terminal.has(t.state))) &&
      `${t.goal} ${t.id}`.toLowerCase().includes(query.toLowerCase()),
  );
  const current = visible.find((t) => t.id === selected) ?? visible[0];
  const bodies = visible.slice(0, 6);
  if (current && !bodies.some((t) => t.id === current.id))
    bodies[bodies.length - 1] = current;
  return (
    <div className="orbital-workspace">
      <div className="workspace-heading">
        <div>
          <span className="eyebrow">Operator workspace</span>
          <h1>
            Work in orbit<span>.</span>
          </h1>
          <p>Follow execution. Understand decisions. Take control.</p>
        </div>
        <button className="primary" onClick={onNew}>
          + New task
        </button>
      </div>
      <div className="workspace-status">
        <span>{tasks.filter((t) => t.state === "RUNNING").length} running</span>
        <span>
          {tasks.filter((t) => t.state === "WAITING_INPUT").length} need input
        </span>
        <span>
          {tasks.filter((t) => t.state === "WAITING_RESOURCE").length} scheduler
          waits
        </span>
        <span className="read-status">
          {loading
            ? "Connecting"
            : error
              ? "Read unavailable"
              : "API snapshot · refreshes every 4s"}
        </span>
      </div>
      {error && (
        <p role="alert" className="error">
          Task refresh failed: {error}.{" "}
          {tasks.length
            ? "Showing the last successful snapshot."
            : "No task data available."}
        </p>
      )}
      <div className="orbital-layout">
        <section className="orbital-map" aria-label="Task orbital map">
          <div className="map-heading">
            <strong>Execution field</strong>
            <span>
              {bodies.length} of {visible.length} tasks shown
            </span>
          </div>
          <div className="sphere-scene">
            <svg
              className="sphere-grid"
              viewBox="0 0 600 600"
              aria-hidden="true"
            >
              <defs>
                <radialGradient id="sphere-light" cx="34%" cy="25%">
                  <stop offset="0" stopColor="#173944" />
                  <stop offset=".7" stopColor="#0b1d26" />
                  <stop offset="1" stopColor="#080f17" />
                </radialGradient>
              </defs>
              <circle
                cx="300"
                cy="300"
                r="210"
                fill="url(#sphere-light)"
                stroke="#34525b"
              />
              {[55, 110, 165].map((r) => (
                <ellipse
                  key={r}
                  cx="300"
                  cy="300"
                  rx={r}
                  ry="210"
                  fill="none"
                  stroke="#28424d"
                />
              ))}
              {[100, 155, 210].map((r) => (
                <ellipse
                  key={r}
                  cx="300"
                  cy="300"
                  rx="210"
                  ry={r / 3}
                  fill="none"
                  stroke="#28424d"
                  transform={`rotate(-22 300 300)`}
                />
              ))}
              <ellipse
                cx="300"
                cy="300"
                rx="270"
                ry="145"
                fill="none"
                stroke="#42636e"
                transform="rotate(-32 300 300)"
              />
              <ellipse
                cx="300"
                cy="300"
                rx="245"
                ry="190"
                fill="none"
                stroke="#29414b"
                strokeDasharray="3 7"
                transform="rotate(40 300 300)"
              />
            </svg>
            <div className="sphere-core">
              <span>Task field</span>
              <strong>{visible.length.toString().padStart(2, "0")}</strong>
              <span>
                {filter === "all" ? "in this workspace" : "matching filter"}
              </span>
            </div>
            {bodies.map((t, i) => {
              const state = describeState(t.state);
              return (
                <button
                  key={t.id}
                  className={`orbital-body tone-${state.tone} ${current?.id === t.id ? "selected" : ""}`}
                  style={
                    {
                      left: `${positions[i]![0]}%`,
                      top: `${positions[i]![1]}%`,
                    } as CSSProperties
                  }
                  aria-label={`Select task: ${t.goal}`}
                  aria-pressed={current?.id === t.id}
                  onClick={() => setSelected(t.id)}
                >
                  <span className="body-number">
                    {String(visible.indexOf(t) + 1).padStart(2, "0")}
                  </span>
                  <span className="body-label">
                    <strong>{t.goal}</strong>
                    <small>{state.label}</small>
                  </span>
                </button>
              );
            })}
          </div>
          <div className="map-caption">
            <span>Each body is a task. Select to inspect.</span>
            <span>Position is an index, not a forecast.</span>
          </div>
          <div className="map-legend">
            <span className="tone-active">● Execution</span>
            <span className="tone-human">◆ Human input</span>
            <span className="tone-resource">◌ Scheduler</span>
            <span className="tone-limit">Ⅱ Limit paused</span>
          </div>
        </section>
        {current ? (
          <Inspector
            key={current.id}
            task={current}
            onOpen={() => onOpen(current.id)}
          />
        ) : (
          <section className="inspector empty">
            <span className="eyebrow">
              {loading ? "Connecting" : "Execution ready"}
            </span>
            <h2>
              {loading
                ? "Reading your workspace…"
                : tasks.length
                  ? "No matching tasks"
                  : "Your next task starts here."}
            </h2>
            <p>
              {tasks.length
                ? "Adjust the task filter or search."
                : "Give the router a goal. Review its choice before starting execution."}
            </p>
            {!tasks.length && !loading && (
              <button className="primary" onClick={onNew}>
                Create a task
              </button>
            )}
          </section>
        )}
      </div>
      <section className="task-register" aria-label="Task register">
        <div className="register-toolbar">
          <h2>
            Task register <span>{visible.length}</span>
          </h2>
          <div className="filters" aria-label="Filter tasks">
            {[
              ["all", "All tasks"],
              ["active", "Unfinished"],
              ["attention", "Needs attention"],
            ].map(([id, label]) => (
              <button
                key={id}
                aria-pressed={filter === id}
                onClick={() => setFilter(id!)}
              >
                {label}
              </button>
            ))}
          </div>
          <input
            aria-label="Search tasks"
            placeholder="Search goal or task ID"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <div className="task-rows">
          {visible.map((t, i) => {
            const s = describeState(t.state);
            return (
              <button
                className={`task-row ${current?.id === t.id ? "selected" : ""}`}
                key={t.id}
                aria-pressed={current?.id === t.id}
                onClick={() => setSelected(t.id)}
              >
                <span className="row-index">
                  {String(i + 1).padStart(2, "0")}
                </span>
                <span className="row-goal">
                  <strong>{t.goal}</strong>
                  <small>
                    {t.id} · {t.profile}
                  </small>
                </span>
                <span className={`state-text tone-${s.tone}`}>
                  {s.label}
                  <small>{t.state}</small>
                </span>
                <time dateTime={t.updatedAt}>
                  {new Date(t.updatedAt).toLocaleTimeString([], {
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                </time>
                <span aria-hidden="true">↗</span>
              </button>
            );
          })}
        </div>
      </section>
    </div>
  );
}

function Inspector({
  task,
  onOpen,
}: {
  task: TaskSummary;
  onOpen: () => void;
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
  const run =
    snapshot?.detail.runs.find((r) => r.id === runId) ??
    snapshot?.detail.runs.at(-1);
  const state = describeState(
    snapshot?.detail.state ?? task.state,
    (snapshot?.detail as { pause_kind?: string | null } | undefined)?.pause_kind,
  );
  const session = snapshot?.sessions.find((s) => s.sessionId === run?.id);
  const assistant = snapshot?.assistants.find(
    (a) => a.id === run?.assistant_id,
  );
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
        <span className="eyebrow">Selected task</span>
        <span className={`state-text tone-${state.tone}`}>{state.label}</span>
      </div>
      <h2>{task.goal}</h2>
      <code className="task-id">{task.id}</code>
      <p className="state-reason">{state.reason}</p>
      <button className="open-task" onClick={onOpen}>
        Open task controls & diagnostics <span>↗</span>
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
      {!snapshot && !error && <p role="status">Loading task evidence…</p>}
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
              <dd>{run?.assistant_id ?? "Not started"}</dd>
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
              <dd>{observedModel(snapshot.events, run?.id)}</dd>
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
                <div className="capability-list" role="group" aria-label="Scheduler controls">
                  <div style={{ display: "flex", gap: 10, flexWrap: "wrap", padding: "12px 0" }}>
                    <button
                      className="primary"
                      disabled={busy}
                      onClick={() =>
                        void act(() => api.runNow(task.id, wait.generation))
                      }
                    >
                      Run now
                    </button>
                    <button
                      className="open-task"
                      style={{ width: "auto" }}
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
                      className="open-task"
                      style={{ width: "auto", color: "#f49b9b" }}
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

/** K3 idle quota probe evidence, read from `/api/scheduler/status`. */
function QuotaReadout({
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
