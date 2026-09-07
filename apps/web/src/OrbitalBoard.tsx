import { useCallback, useEffect, useState } from "react";
import { api, type Assistant, type TaskSummary } from "./api.js";
import { fieldPulse } from "./orbital.js";
import { CommandBar } from "./board/CommandBar.js";
import { Inspector, type Snapshot } from "./board/Inspector.js";
import { OrbitalField, type Satellite } from "./board/OrbitalField.js";
import { TaskRegister, type Filter } from "./board/TaskRegister.js";

const terminal = new Set(["COMPLETED", "FAILED", "CANCELLED"]);
const MAX_BODIES = 8;
type Cooldown = { assistantId: string; reason: string; until: string };

/** Board data: tasks + the provider constellation, refreshed every 4s. */
function useBoard() {
  const [tasks, setTasks] = useState<TaskSummary[]>([]);
  const [assistants, setAssistants] = useState<Assistant[]>([]);
  const [cooldowns, setCooldowns] = useState<Cooldown[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      const [rows, a, c] = await Promise.allSettled([api.tasks(), api.assistants(), api.cooldowns()]);
      if (disposed) return;
      if (rows.status === "fulfilled") {
        setTasks(rows.value);
        setError(null);
      } else setError((rows.reason as Error).message);
      if (a.status === "fulfilled") setAssistants(a.value);
      if (c.status === "fulfilled") setCooldowns(c.value);
      setLoading(false);
      timer = setTimeout(() => void load(), 4000);
    };
    void load();
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, []);
  return { tasks, assistants, cooldowns, error, loading };
}

export function OrbitalBoard({
  onOpen,
  onNew,
}: {
  onOpen: (id: string) => void;
  onNew: (goal?: string) => void;
}) {
  const { tasks, assistants, cooldowns, error, loading } = useBoard();
  const [selected, setSelected] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");
  const [executing, setExecuting] = useState<string | null>(null);
  const onSnapshot = useCallback((s: Snapshot) => {
    const run = s.detail.runs.at(-1);
    setExecuting(run && s.detail.state === "RUNNING" ? run.assistant_id : null);
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
  const bodies = visible.slice(0, MAX_BODIES);
  if (current && !bodies.some((t) => t.id === current.id)) bodies[bodies.length - 1] = current;
  const pulse = fieldPulse(tasks);
  const now = Date.now();
  const satellites: Satellite[] = assistants.map((a) => ({
    assistant: a,
    executing: executing === a.id,
    cooling: cooldowns.some((c) => c.assistantId === a.id && Date.parse(c.until) > now),
  }));

  return (
    <div className="orbital-workspace">
      <div className="board-head">
        <div>
          <span className="eyebrow">Orbital · operator console</span>
          <h1>
            Missions in orbit<em>.</em>
          </h1>
          <p>Every body is a mission the kernel owns. Motion is execution; stillness is a wait.</p>
        </div>
        <button className="btn" onClick={() => onNew()}>
          Detailed intake
        </button>
      </div>
      <CommandBar onSubmit={(goal) => onNew(goal)} />
      <div className="workspace-status">
        <span className="stat tone-active">
          <i /> <b>{pulse.running}</b> running
        </span>
        <span className="stat tone-human">
          <i /> <b>{pulse.attention}</b> need you
        </span>
        <span className="stat tone-resource">
          <i /> <b>{pulse.waiting}</b> waiting for the scheduler
        </span>
        <span className="stat tone-neutral">
          <i /> <b>{pulse.settled}</b> settled
        </span>
        <span className="read-status">
          {loading ? "Connecting" : error ? "Read unavailable" : "Live from the kernel · refreshes every 4s"}
        </span>
      </div>
      {error && (
        <p role="alert" className="error">
          Task refresh failed: {error}. {tasks.length ? "Showing the last successful snapshot." : "No task data available."}
        </p>
      )}
      <div className="orbital-layout">
        <section className="orbital-map" aria-label="Task orbital map">
          <div className="map-heading">
            <strong>Execution field</strong>
            <span>
              {bodies.length} of {visible.length} shown
            </span>
          </div>
          <OrbitalField
            tasks={bodies}
            selectedId={current?.id ?? null}
            onSelect={setSelected}
            pulse={pulse}
            satellites={satellites}
          />
          <div className="map-caption">
            <span>Ring = state group · angle = index, not a forecast.</span>
            <span>Select a body to inspect.</span>
          </div>
          <div className="map-legend">
            <span className="tone-active">
              <i /> In motion: executing
            </span>
            <span className="tone-human">
              <i /> Beacon: needs you
            </span>
            <span className="tone-resource hollow">
              <i /> Hollow + horizon: scheduler wait
            </span>
            <span className="tone-limit dashed">
              <i /> Broken arc: limit / quota blocker
            </span>
            <span className="tone-complete">
              <i /> Outer, faded: settled
            </span>
          </div>
        </section>
        {current ? (
          <Inspector key={current.id} task={current} onOpen={() => onOpen(current.id)} onSnapshot={onSnapshot} />
        ) : (
          <section className="inspector empty" aria-label="Selected task inspector">
            <span className="eyebrow">{loading ? "Connecting" : "Execution ready"}</span>
            <h2>
              {loading ? "Reading your workspace…" : tasks.length ? "No matching missions" : "Your first mission starts here."}
            </h2>
            <p>
              {tasks.length
                ? "Adjust the filter or search."
                : "Describe a goal above. The router previews which assistant it would choose, and why, before anything runs."}
            </p>
          </section>
        )}
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
