import type { TaskSummary } from "../api.js";
import { describeState } from "../orbital.js";

export const FILTERS = [
  ["all", "All"],
  ["active", "Unfinished"],
  ["attention", "Needs attention"],
] as const;
export type Filter = (typeof FILTERS)[number][0];

export function TaskRegister({
  tasks,
  selectedId,
  onSelect,
  filter,
  onFilter,
  query,
  onQuery,
}: {
  tasks: TaskSummary[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  filter: Filter;
  onFilter: (f: Filter) => void;
  query: string;
  onQuery: (q: string) => void;
}) {
  return (
    <section className="task-register" aria-label="Task register">
      <div className="register-toolbar">
        <h2>
          Mission register <span>{tasks.length}</span>
        </h2>
        <div className="filters" aria-label="Filter tasks">
          {FILTERS.map(([id, label]) => (
            <button key={id} aria-pressed={filter === id} onClick={() => onFilter(id)}>
              {label}
            </button>
          ))}
        </div>
        <input
          className="input"
          aria-label="Search tasks"
          placeholder="Search goal or task ID"
          value={query}
          onChange={(e) => onQuery(e.target.value)}
        />
      </div>
      <div className="task-rows">
        {tasks.map((t, i) => {
          const s = describeState(t.state);
          return (
            <button
              className={`task-row ${selectedId === t.id ? "selected" : ""}`}
              key={t.id}
              aria-pressed={selectedId === t.id}
              onClick={() => onSelect(t.id)}
            >
              <span className="row-index">{String(i + 1).padStart(2, "0")}</span>
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
                {new Date(t.updatedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
              </time>
              <span aria-hidden="true">↗</span>
            </button>
          );
        })}
        {tasks.length === 0 && <p className="empty-register">No missions match this filter.</p>}
      </div>
    </section>
  );
}
