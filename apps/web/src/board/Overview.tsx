import type { FieldPulse } from "../orbital.js";
import { describeState } from "../orbital.js";
import { missionState, type Mission } from "./execution.js";
import type { Snapshot } from "./Inspector.js";

/** The same partition as the sphere, with absent and stale reads explicit. */
export function SystemOverview({ pulse, loading, error, hasSnapshot, attentionSelected, onAttention }: {
  pulse: FieldPulse; loading: boolean; error: string | null; hasSnapshot: boolean;
  attentionSelected: boolean; onAttention: () => void;
}) {
  const count = (value: number) => loading || (error && !hasSnapshot) ? "—" : value;
  return <section className="system-overview" aria-label="System overview">
    <div className="overview-heading"><h2>System overview</h2><span className="read-status">{loading ? "Connecting" : error ? "Read unavailable" : "Kernel snapshot · every 4s"}</span></div>
    <div className="workspace-status">
      <span className="stat tone-active"><b>{count(pulse.running)}</b><span><i /> running</span></span>
      <button className="stat stat-action tone-human" onClick={onAttention} aria-pressed={attentionSelected}><b>{count(pulse.attention)}</b><span><i /> need you</span></button>
      <span className="stat tone-resource"><b>{count(pulse.waiting)}</b><span><i /> waiting for the scheduler</span></span>
    <div className="overview-rest"><span><b>{count(pulse.ready)}</b> ready to start</span><span><b>{count(pulse.settled)}</b> settled</span>{pulse.unknown > 0 && <span><b>{count(pulse.unknown)}</b> runtime unknown</span>}</div>
    </div>
    {error && hasSnapshot && <p className="fine-print">Last successful task snapshot.</p>}
  </section>;
}

/** Existing selected-task events only. Never pretends to be workspace-wide. */
export function MissionActivity({ tasks, selectedId, snapshot, loading, error, onSelect }: {
  tasks: Mission[]; selectedId: string | null; snapshot: Snapshot | null;
  loading: boolean; error: string | null; onSelect: (id: string) => void;
}) {
  const attention = tasks.filter(t => ["WAITING_INPUT", "AWAITING_APPROVAL", "LIMIT_PAUSED"].includes(missionState(t)));
  const uncertain = tasks.some(t => missionState(t) === "RUNTIME_UNKNOWN");
  const events = snapshot?.events.slice().sort((a, b) => b.ts.localeCompare(a.ts) || b.seq - a.seq).slice(0, 3) ?? [];
  return <div className="overview-feeds">
    <section className="overview-feed" aria-label="Selected mission activity">
      <h2>Recent activity</h2><p className="feed-scope">Selected mission only</p>
      {!snapshot ? <p className="feed-empty">{selectedId ? "Reading mission events…" : "Select a mission to see its events."}</p>
        : snapshot.unavailable.includes("Events") ? <p className="feed-empty">Event read unavailable.</p>
        : events.length === 0 ? <p className="feed-empty">No provider events recorded.</p>
        : <ol>{events.map(e => <li key={`${e.run_id}:${e.seq}`}><strong>{e.type}</strong><span>{e.summary}</span><time dateTime={e.ts}>{new Date(e.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time></li>)}</ol>}
    </section>
    <section className="overview-feed" aria-label="Missions needing attention">
      <h2>Needs attention</h2><p className="feed-scope">Approval, input or limit</p>
      {loading ? <p className="feed-empty">Reading task state…</p> : error ? <p className="feed-empty">Task read unavailable. Check the register snapshot below.</p>
        : attention.length === 0 ? <p className="feed-empty">{uncertain ? "No confirmed attention states. Some runtime and approval reads are unavailable." : "No missions in an attention state."}</p>
        : <ul>{attention.slice(0, 3).map(t => <li key={t.id}><button onClick={() => onSelect(t.id)} aria-pressed={selectedId === t.id}><strong>{t.goal}</strong><span className={`tone-${describeState(missionState(t)).tone}`}>{describeState(missionState(t)).label}</span></button></li>)}</ul>}
      {attention.length > 3 && <a href="#mission-register">All {attention.length} in the register ↓</a>}
    </section>
  </div>;
}
