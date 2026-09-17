import { useCallback, useEffect, useState } from "react";
import { api, type Assistant } from "./api.js";
import { actualLifecycle, fieldPulse, modelNodes, type ActualExecution } from "./orbital.js";
import { MissionActivity, SystemOverview } from "./board/Overview.js";
import { MissionShell } from "./shell/MissionShell.js";
import { Inspector, type Snapshot } from "./board/Inspector.js";
import { OrbitalField, type Satellite } from "./board/OrbitalField.js";
import { TaskRegister, type Filter } from "./board/TaskRegister.js";
import { executionRead, missionState, type Mission } from "./board/execution.js";

const terminal = new Set(["COMPLETED", "FAILED", "CANCELLED"]);
const MAX_BODIES = 8;
type Cooldown = { assistantId: string; reason: string; until: string };

/** Board data: tasks + the provider constellation, refreshed every 4s. */
function useBoard(revision: number, active: boolean) {
  const [tasks, setTasks] = useState<Mission[]>([]);
  const [unavailable, setUnavailable] = useState<string[]>([]);
  const [assistants, setAssistants] = useState<Assistant[]>([]);
  const [cooldowns, setCooldowns] = useState<Cooldown[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    if (!active) {
      setLoading(true);
      setTasks([]);
      setAssistants([]);
      setCooldowns([]);
      return;
    }
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      const [rows, a, c] = await Promise.allSettled([api.tasks(), api.assistants(), api.cooldowns()]);
      if (disposed) return;
      const missing = [a.status === "rejected" ? "Provider discovery" : "", c.status === "rejected" ? "Cooldowns" : ""].filter(Boolean);
      if (rows.status === "fulfilled") {
        const missions: Mission[] = [...rows.value];
        // Read only RUNNING missions, in bounded batches. This existing endpoint
        // includes effective session states and all parallel runs, not just the last.
        const active = missions.filter(t => t.state === "RUNNING");
        for (let i = 0; i < active.length && !disposed; i += 6) {
          const batch = active.slice(i, i + 6);
          const details = await Promise.allSettled(batch.map(async t => {
            const [detail, sessions] = await Promise.all([api.task(t.id), api.sessions(t.id)]);
            return executionRead(detail, sessions);
          }));
          details.forEach((result, j) => {
            if (result.status === "fulfilled") batch[j]!.execution = result.value;
            else {
              batch[j]!.execution = { awaitingApproval: false, assistants: [], verified: false };
              missing.push(`Execution / approval state for ${batch[j]!.id}`);
            }
          });
        }
        if (disposed) return;
        setTasks(missions);
        setError(null);
      } else setError((rows.reason as Error).message);
      setUnavailable(missing);
      if (a.status === "fulfilled") setAssistants(a.value);
      else setAssistants([]);
      if (c.status === "fulfilled") setCooldowns(c.value);
      else setCooldowns([]);
      setLoading(false);
      timer = setTimeout(() => void load(), 4000);
    };
    void load();
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [revision, active]);
  return { tasks, assistants, cooldowns, error, loading, unavailable };
}

export function OrbitalBoard({
  onOpen,
  active = true,
}: {
  onOpen: (id: string) => void;
  active?: boolean;
}) {
  const [revision, setRevision] = useState(0);
  const { tasks, assistants, cooldowns, error, loading, unavailable } = useBoard(revision, active);
  const [pendingSelection, setPendingSelection] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const onSnapshot = useCallback((s: Snapshot) => {
    setSnapshot(s);
  }, []);

  const visible = tasks.filter(
    (t) =>
      (filter === "all" ||
        (filter === "attention"
          ? ["WAITING_INPUT", "LIMIT_PAUSED", "AWAITING_APPROVAL"].includes(missionState(t))
          : !terminal.has(t.state))) &&
      `${t.goal} ${t.id}`.toLowerCase().includes(query.toLowerCase()),
  ).sort((a, b) => {
    const rank = (t: Mission) => ["WAITING_INPUT", "LIMIT_PAUSED", "AWAITING_APPROVAL"].includes(missionState(t)) ? 0 : terminal.has(t.state) ? 2 : 1;
    return rank(a) - rank(b);
  });
  const current = pendingSelection && !tasks.some(t => t.id === pendingSelection)
    ? undefined : visible.find((t) => t.id === selected) ?? visible[0];
  const bodies = visible.slice(0, MAX_BODIES);
  if (current && !bodies.some((t) => t.id === current.id)) bodies[bodies.length - 1] = current;
  const pulse = fieldPulse(tasks);
  const now = Date.now();
  const executing = current?.state === "RUNNING" && snapshot?.detail.id === current.id
    ? executionRead(snapshot.detail, snapshot.sessions).assistants : [];
  // K13 SHADOW: the model recommendation "would choose" for the selected mission,
  // only while it stays advisory. In `applied` mode the winner is the one
  // executing, so the executing marker already covers it.
  const forCurrent = snapshot?.detail.id === current?.id;
  const recommendation = forCurrent ? snapshot?.routing.at(-1)?.explanation.modelRecommendation : undefined;
  const routedAssistant = forCurrent ? snapshot?.routing.at(-1)?.chosen ?? null : null;
  // What Agentic OS is actually executing / about to execute. The requested
  // model comes ONLY from the persisted decision's execution record; a run that
  // named no model stays `Model: unspecified` — never invented.
  const actual: ActualExecution = {
    assistantId: executing[0] ?? routedAssistant,
    modelSelector: recommendation?.execution.requestedModelSelector ?? null,
    running: !loading && !error && executing.length > 0,
    // Truthful lifecycle from the selected mission's canonical/effective state —
    // never derived from the field's visual state.
    lifecycle: current ? actualLifecycle(missionState(current)) : "routed",
  };
  const models = modelNodes(recommendation, actual);
  const shadowChoice = recommendation && recommendation.mode === "shadow" && recommendation.recommended
    ? recommendation.candidates.find((c) => c.label === recommendation.recommended)?.assistantId
    : undefined;
  // When the selected mission has a model recommendation, the model-candidate
  // nodes ARE the constellation (assistant + selector). The assistant-only
  // satellites would then be redundant and just crowd the field, so drop them.
  const satellites: Satellite[] = models.length
    ? []
    : assistants.map((a) => ({
        assistant: a,
        executing: !loading && !error && executing.includes(a.id),
        cooling: cooldowns.some((c) => c.assistantId === a.id && Date.parse(c.until) > now),
        shadow: a.id === shadowChoice,
      }));

  return (
    <div className="orbital-workspace">
      <div className="board-head">
        <div>
          <span className="eyebrow">Overview</span>
          <h1>
            Command the next wave<em>.</em>
          </h1>
          <p>One place to direct your AI work.</p>
        </div>
      </div>
      <MissionShell active={active} selected={current ?? null} snapshot={forCurrent ? snapshot : null}
        onOpen={() => current && onOpen(current.id)}
        onChanged={() => setRevision(r => r + 1)}
        onStarted={id => { setPendingSelection(id); setFilter("all"); setQuery(""); setSelected(id); setRevision(r => r + 1); }} />
      {error && (
        <p role="alert" className="error">
          Task refresh failed: {error}. {tasks.length ? "Showing the last successful snapshot." : "No task data available."}
        </p>
      )}
      {!!unavailable.length && <p role="status" className="error">Unavailable reads: {unavailable.join(", ")}. Provider and approval visibility may be incomplete.</p>}
      <div className="orbital-layout">
        <SystemOverview pulse={pulse} loading={loading} error={error} hasSnapshot={tasks.length > 0}
          attentionSelected={filter === "attention"} onAttention={() => setFilter(filter === "attention" ? "all" : "attention")} />
        {current ? (
          active && <Inspector key={current.id} task={current} onOpen={() => onOpen(current.id)} onSnapshot={onSnapshot} />
        ) : (
          <section className="inspector empty" aria-label="Selected task inspector">
            <span className="eyebrow">{loading ? "Connecting" : "Execution ready"}</span>
            <h2>
              {loading ? "Reading your workspace…" : error ? "Mission state unavailable" : tasks.length ? "No matching missions" : "Your first mission starts here."}
            </h2>
            <p>
              {error ? "The task read failed. Mission state will appear when the connection recovers." : tasks.length
                ? "Adjust the filter or search."
                : "Describe a goal above. The router previews which assistant it would choose, and why, before anything runs."}
            </p>
          </section>
        )}
        <MissionActivity tasks={tasks} selectedId={current?.id ?? null} snapshot={forCurrent ? snapshot : null}
          loading={loading} error={error} onSelect={(id) => { setFilter("all"); setQuery(""); setSelected(id); }} />
        <section className="orbital-map" aria-label="Task orbital map">
          <OrbitalField
            tasks={bodies}
            totalTasks={visible.length}
            selectedId={current?.id ?? null}
            onSelect={setSelected}
            pulse={pulse}
            satellites={satellites}
            models={models}
            actual={actual}
            readAvailable={!loading && !error}
          />
          <div className="map-caption">
            <span>Ring = state group · angle = index, not a forecast.</span>
            <span>Select a body to inspect.</span>
          </div>
          <div className="map-legend">
            <span className="tone-active">
              <i /> Solid blue: ACTUAL run / route
            </span>
            <span className="model-shadow-key">
              <i /> Dashed amber: K13 SHADOW “would choose” (not running)
            </span>
            <span className="model-excluded-key">
              <i /> Muted node: hard-filtered — a score can’t resurrect it
            </span>
            <span className="tone-human">
              <i /> Beacon: needs you
            </span>
            <span className="tone-resource hollow">
              <i /> Hollow + horizon: scheduler wait
            </span>
            <span className="tone-complete">
              <i /> Outer, faded: settled
            </span>
          </div>
        </section>
      </div>
      <TaskRegister
        tasks={visible}
        selectedId={current?.id ?? null}
        onSelect={setSelected}
        filter={filter}
        onFilter={setFilter}
        query={query}
        onQuery={setQuery}
      />
    </div>
  );
}
