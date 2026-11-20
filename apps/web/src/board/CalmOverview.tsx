import { describeState, nextStep, type FieldPulse } from "../orbital.js";
import { executionRead, missionState, type Mission } from "./execution.js";
import type { Snapshot } from "./useMissionSnapshot.js";

const ATTENTION = ["WAITING_INPUT", "AWAITING_APPROVAL", "LIMIT_PAUSED"];
const MISSIONS_SHOWN = 5;

/**
 * The default Overview: one current mission and one next action. Everything here
 * is read from the same board state the diagnostics use; nothing is recomputed
 * from the kernel and nothing is hidden for good — diagnostics are one click away.
 */
export function CalmOverview({ tasks, current, snapshot, pulse, loading, error, onSelect, onOpen, onNewMission, onShowAll }: {
  tasks: Mission[]; current: Mission | undefined; snapshot: Snapshot | null; pulse: FieldPulse;
  loading: boolean; error: string | null;
  onSelect: (id: string) => void; onOpen: (id: string) => void; onNewMission: () => void; onShowAll: () => void;
}) {
  const unread = loading || (!!error && tasks.length === 0);
  if (!current) {
    return <section className="calm-overview" aria-label="Current mission">
      <span className="eyebrow">{loading ? "Connecting" : "Ready"}</span>
      <h2>{loading ? "Reading your workspace…" : error ? "Mission state unavailable" : tasks.length ? "No matching missions" : "Your first mission starts here."}</h2>
      <p className="calm-reason">{loading ? "Reading missions and provider state from the local plane."
        : error ? "The task read failed. Mission state will appear when the connection recovers."
        : tasks.length ? "Adjust the register filter or search."
        : "Describe a goal. The router previews which assistant it would choose, and why, before anything runs."}</p>
      {!loading && !error && <div className="calm-actions"><button type="button" className="btn btn-primary" onClick={onNewMission}>Describe a goal</button></div>}
    </section>;
  }

  const live = snapshot?.detail.id === current.id ? snapshot : null;
  const state = live ? missionState({ state: live.detail.state, execution: executionRead(live.detail, live.sessions) }) : missionState(current);
  const pauseKind = (live?.detail as { pause_kind?: string | null } | undefined)?.pause_kind;
  const described = describeState(state, pauseKind);
  const needsYou = ATTENTION.includes(state);
  const others = tasks.filter(t => ATTENTION.includes(missionState(t)) && t.id !== current.id);
  const next = live ? nextStep({
    state, wait: live.detail.wait, schedulerEnabled: live.detail.schedulerEnabled !== false,
    assistant: executionRead(live.detail, live.sessions).assistants.join(", ") || undefined,
    pauseKind, resourceWait: live.detail.resourceWait ?? null,
  }) : described.reason;
  const action = needsYou ? "Review and decide" : state === "RUNNING" || state === "ROUTING" ? "Watch this mission" : "Open mission";
  const counts: Array<[number, string]> = [
    [pulse.attention, "need you"], [pulse.running, "running"], [pulse.waiting, "waiting for the scheduler"],
    [pulse.ready, "ready to start"], [pulse.unknown, "runtime unknown"], [pulse.settled, "settled"],
  ];
  const list = tasks.slice(0, MISSIONS_SHOWN);

  return <>
    <section className={`calm-overview calm-${described.tone}`} aria-label="Current mission">
      <div className="calm-top">
        <span className="eyebrow">{needsYou ? "Needs you" : "Current mission"}</span>
        <span className={`badge tone-${described.tone}`}>{described.label}</span>
      </div>
      <h2>{current.goal}</h2>
      <p className="calm-reason">{next}</p>
      <div className="calm-actions">
        <button type="button" className="btn btn-primary" onClick={() => onOpen(current.id)} disabled={unread}>{action}</button>
        {others.length > 0 && <button type="button" className="btn" onClick={() => onSelect(others[0]!.id)}>
          {others.length === 1 ? "1 more mission needs you" : `${others.length} more missions need you`}
        </button>}
      </div>
      {!unread && <p className="calm-counts" aria-label="Mission counts">
        {counts.filter(([n]) => n > 0).map(([n, label]) => <span key={label}><b>{n}</b> {label}</span>)}
        {error && <span>Last successful snapshot</span>}
      </p>}
    </section>
    {tasks.length > 1 && <section className="calm-missions" aria-label="Missions">
      <h2>Missions</h2>
      <ul>
        {list.map(t => {
          const s = describeState(missionState(t));
          return <li key={t.id}><button type="button" aria-pressed={t.id === current.id} onClick={() => onSelect(t.id)}>
            <strong>{t.goal}</strong><span className={`tone-${s.tone}`}>{s.label}</span>
          </button></li>;
        })}
      </ul>
      {tasks.length > MISSIONS_SHOWN && <button type="button" className="calm-link" onClick={onShowAll}>All {tasks.length} in diagnostics</button>}
    </section>}
  </>;
}
