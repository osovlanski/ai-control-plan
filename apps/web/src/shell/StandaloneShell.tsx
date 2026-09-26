import { useEffect, useState } from "react";
import { NewTask } from "../NewTask.js";
import { useBoard } from "../board/useBoard.js";
import { useMissionSnapshot } from "../board/useMissionSnapshot.js";
import { executionRead, missionState, type Mission } from "../board/execution.js";
import { ContextReadout, QuotaReadout } from "../board/readouts.js";
import { OrbitalField } from "../board/OrbitalField.js";
import { actualLifecycle, contextPercent, describeState, fieldPulse, modelIdentityView, observedModel } from "../orbital.js";
import { MissionConversation } from "./MissionShell.js";
import { FollowUpComposer } from "./FollowUpComposer.js";
import { DeliveryCommands, DeliveryStatus, useDeliveryCommand } from "./delivery.js";
import { api, type SessionInput } from "../api.js";

const destination = (id: string) => `#/shell/${encodeURIComponent(id)}`;

/** A second presentation of kernel records, not a second conversation store. */
export function StandaloneShell({ active, taskId }: { active: boolean; taskId?: string }) {
  const [revision, setRevision] = useState(0);
  const { tasks, error, loading } = useBoard(revision, active);
  const refresh = () => setRevision(n => n + 1);
  // Capability discovery, not a guess: a plane with the session-input contract
  // disabled (the default) leaves the composer exactly as it shipped.
  const [sessionInput, setSessionInput] = useState(false);
  useEffect(() => {
    if (!active) return;
    let disposed = false;
    void api.workspace()
      .then(w => { if (!disposed) setSessionInput(w.sessionInput?.enabled === true); })
      .catch(() => { if (!disposed) setSessionInput(false); });
    return () => { disposed = true; };
  }, [active]);
  return <div className="standalone-shell">
    <aside className="shell-history" aria-label="Mission history">
      <div className="shell-history-heading"><h2>History</h2><a className="btn" href="#/shell">New mission</a></div>
      {loading ? <p role="status">Reading history…</p> : error ? <p role="alert">History unavailable: {error}. Any listed missions are from the last successful read.</p>
        : !tasks.length && <p>No missions recorded yet.</p>}
      <nav aria-label="Mission history">
        {tasks.map(task => <a key={task.id} href={destination(task.id)} aria-current={task.id === taskId ? "page" : undefined}>
          <strong>{task.goal}</strong><span>{error ? "State unavailable" : describeState(missionState(task)).label} · {task.id}</span>
        </a>)}
      </nav>
    </aside>
    <section className="shell-workspace" aria-label="Shell workspace">
      <div hidden={!!taskId} className="shell-new-mission">
        <div className="shell-welcome"><span className="eyebrow">Agentic OS · Shell</span><h1>What are we working on?</h1>
          <p>Set a goal. Inspect the route. Follow the work here.</p></div>
        <div className="shell-dock"><NewTask onPreviewed={refresh} onStarted={id => { refresh(); window.location.hash = destination(id); }} /></div>
      </div>
      {active && taskId && <ShellMission key={taskId} taskId={taskId} revision={revision} onChanged={refresh} sessionInput={sessionInput} />}
    </section>
  </div>;
}

function ShellMission({ taskId, revision, onChanged, sessionInput }: { taskId: string; revision: number; onChanged: () => void; sessionInput: boolean }) {
  const { snapshot, error } = useMissionSnapshot(taskId, revision, true);
  const [orbit, setOrbit] = useState(false);
  const controls = `#/missions/${encodeURIComponent(taskId)}`;
  if (error) return <div className="shell-mission-unavailable"><h1>Mission unavailable</h1><p role="alert">{error}. Execution and delivery state cannot be confirmed.</p>
    <button className="btn" onClick={onChanged}>Refresh mission</button><a className="btn" href="#/shell">New mission</a></div>;
  if (!snapshot) return <p role="status">Reading mission…</p>;
  const { detail } = snapshot;
  const execution = executionRead(detail, snapshot.sessions);
  const task: Mission = { id: detail.id, goal: detail.goal, state: detail.state, phase: detail.activity_phase,
    profile: detail.profile, repoPath: detail.repo_path, createdAt: "", updatedAt: "", execution };
  const runs = detail.runs.filter(r => !r.ended_at);
  const identities = runs.length ? runs : detail.runs.slice(-1);
  const route = snapshot.routing.at(-1);
  const context = snapshot.context;
  const occupancy = context?.status === "known" && context.observation?.effectiveWindowSource !== "unavailable" && context.observation
    ? contextPercent(context.observation) : undefined;
  return <>
    <header className="shell-mission-bar"><span className="eyebrow">Mission conversation</span>
      <nav aria-label="Mission evidence"><a href={controls}>Mission, routing & traces</a><a href="#/memory">Memory</a></nav></header>
    {!!snapshot.unavailable.length && <p className="error" role="status">Unavailable reads: {snapshot.unavailable.join(", ")}.</p>}
    <div className="shell-execution-summary">
      {identities.length ? identities.map(run => {
        const identity = modelIdentityView(run.modelIdentity, observedModel(snapshot.events, run.id));
        return <p key={run.id}><strong>{run.ended_at ? "Last assistant" : "Session assistant"}: {run.assistant_id}</strong>
          <span>Session {run.id} · {run.state}</span><span>Observed model: {identity.served}</span><span>Requested model: {identity.requested}</span></p>;
      }) : <p>No execution session recorded.</p>}
      <p>Route: {route ? `${route.chosen ?? "No eligible assistant"} · ${route.explanation.ruleFired}` : "No routing decision recorded."}</p>
      {occupancy !== undefined && occupancy >= 80 && <p className="tone-human" role="status">Context pressure: {occupancy}% of the observed effective window. Inspect context evidence before continuing.</p>}
      {detail.wait && <p className="tone-resource" role="status">Waiting: {detail.wait.reason}</p>}
      {detail.state === "LIMIT_PAUSED" && <p className="tone-limit" role="status">Quota pause recorded. Review recovery evidence in mission controls.</p>}
    </div>
    <MissionConversation task={task} snapshot={snapshot} expanded onChanged={onChanged}
      followUps={sessionInput && !!runs.length} onOpen={() => { window.location.hash = controls; }} />
    <details className="shell-observations"><summary>Context & quota evidence</summary>
      <ContextReadout context={context} /><QuotaReadout scheduler={snapshot.scheduler} unavailable={snapshot.unavailable.includes("Scheduler status")} />
    </details>
    <details className="shell-orbit" onToggle={e => setOrbit(e.currentTarget.open)}><summary>Orbit · this mission</summary>
      {orbit && <OrbitalField tasks={[task]} totalTasks={1} selectedId={task.id} onSelect={() => undefined}
        pulse={fieldPulse([task])} satellites={snapshot.assistants.filter(a => execution.assistants.includes(a.id)).map(assistant => ({ assistant, executing: true, cooling: false }))}
        models={[]} actual={{ assistantId: execution.assistants[0] ?? route?.chosen ?? null, modelSelector: null,
          running: execution.assistants.length > 0, lifecycle: actualLifecycle(missionState(task)) }}
        readAvailable={!snapshot.unavailable.includes("Sessions")} registerHref={controls} registerLabel="Mission details" />}
    </details>
    <SessionInputs enabled={sessionInput} sessionId={runs[0]?.id} />
  </>;
}

/**
 * The follow-ups you addressed to this session, read back from the plane's own
 * ledger rather than remembered by this browser — so a reload, a second tab and
 * a scheduler-owned redelivery all show the same truth.
 *
 * With the capability off (the default) nothing is read and nothing is rendered
 * but the disabled composer that shipped with Shell mode.
 */
function SessionInputs({ enabled, sessionId }: { enabled: boolean; sessionId?: string }) {
  const [inputs, setInputs] = useState<SessionInput[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const reload = () => setRevision(n => n + 1);
  useEffect(() => {
    if (!enabled || !sessionId) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    // Polled, because delivery state also changes without this browser acting:
    // the scheduler redelivers a queued message when its condition clears.
    const load = async () => {
      try {
        const page = await api.sessionInputs(sessionId);
        if (!disposed) { setInputs(page.inputs); setError(null); }
      } catch (e) {
        if (!disposed) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!disposed) timer = setTimeout(() => void load(), 4000);
      }
    };
    void load();
    return () => { disposed = true; clearTimeout(timer); };
  }, [enabled, sessionId, revision]);
  return <>
    {enabled && sessionId && <SessionInputTranscript inputs={inputs} error={error} onChanged={reload} />}
    <FollowUpComposer enabled={enabled} sessionId={sessionId} inputs={inputs} onSent={reload} />
  </>;
}

function SessionInputTranscript({ inputs, error, onChanged }: {
  inputs: SessionInput[]; error: string | null; onChanged: () => void;
}) {
  const { busy, error: commandError, run } = useDeliveryCommand(onChanged);
  if (error) return <p className="error" role="alert">Delivery state unavailable: {error}. Any follow-up you sent is still recorded.</p>;
  if (!inputs.length) return null;
  return <section className="shell-inputs" aria-label="Your follow-up messages">
    {inputs.map(input => <article key={input.id} className="shell-input">
      <strong>You · <time dateTime={input.createdAt}>{new Date(input.createdAt).toLocaleTimeString()}</time>
        {(input.generation ?? 1) > 1 && ` · retry ${input.generation}`}</strong>
      <p>{input.text}</p>
      <DeliveryStatus input={input} />
      <div className="shell-input-actions"><DeliveryCommands input={input} busy={busy} run={run} /></div>
    </article>)}
    {commandError && <p className="error" role="alert">Command refused: {commandError}. The record is unchanged.</p>}
  </section>;
}
