import { useEffect, useRef, useState } from "react";
import { api, type SessionDetail } from "../api.js";
import { NewTask } from "../NewTask.js";
import type { Snapshot } from "../board/Inspector.js";
import { missionState, type Mission } from "../board/execution.js";
import { describeState } from "../orbital.js";

/** One persistent interaction layer, with an explicit target for every command. */
export function MissionShell({ active, selected, snapshot, onStarted, onChanged, onOpen }: {
  active: boolean; selected: Mission | null; snapshot: Snapshot | null;
  onStarted: (id: string) => void; onChanged: () => void; onOpen: () => void;
}) {
  const [mode, setMode] = useState<"new" | "mission">("new");
  const target = useRef<HTMLButtonElement>(null);
  const focusAfterStart = useRef(false);
  useEffect(() => {
    if (focusAfterStart.current && mode === "mission" && selected) {
      target.current?.focus();
      focusAfterStart.current = false;
    }
  }, [mode, selected?.id]);
  return <section className="mission-shell command-surface" aria-label="Mission shell">
    <div className="shell-modes" aria-label="Command target">
      <button type="button" aria-pressed={mode === "new"} onClick={() => setMode("new")}>New mission</button>
      <button ref={target} type="button" aria-pressed={mode === "mission"} disabled={!selected}
        onClick={() => setMode("mission")}>Selected mission</button>
      <span>Intent → route → execution</span>
    </div>
    <div hidden={mode !== "new"}>
      <NewTask onPreviewed={onChanged} onStarted={id => {
        focusAfterStart.current = true;
        onStarted(id); setMode("mission");
      }} />
    </div>
    {mode === "mission" && !selected && <p className="mission-conversation" role="status">Reading selected mission…</p>}
    {active && mode === "mission" && selected && <MissionConversation key={selected.id} task={selected}
      snapshot={snapshot} onChanged={onChanged} onOpen={onOpen} />}
  </section>;
}

export function MissionConversation({ task, snapshot, onChanged, onOpen, expanded = false }: {
  task: Mission; snapshot: Snapshot | null; onChanged: () => void; onOpen: () => void; expanded?: boolean;
}) {
  const [sessions, setSessions] = useState<SessionDetail[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [revision, setRevision] = useState(0);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      try {
        const list = await api.sessions(task.id);
        const live = list.filter(s => !s.endedAt);
        const details: SessionDetail[] = [];
        // Bounded reads for parallel runs. Never pick an arbitrary approval owner.
        for (let i = 0; i < live.length && !disposed; i += 6) {
          details.push(...await Promise.all(live.slice(i, i + 6).map(s => api.session(s.sessionId))));
        }
        if (!disposed) { setSessions(details); setError(null); }
      } catch (e) {
        if (!disposed) { setSessions([]); setError(e instanceof Error ? e.message : String(e)); }
      } finally {
        if (!disposed) { setLoading(false); timer = setTimeout(() => void load(), 4000); }
      }
    };
    void load();
    return () => { disposed = true; clearTimeout(timer); };
  }, [task.id, revision]);
  const state = describeState(missionState(task));
  const Heading = expanded ? "h1" : "h2";
  const events = snapshot?.events.filter(e => expanded || ["message", "approval.requested", "completed", "error"].includes(e.type)).slice(expanded ? -100 : -3) ?? [];
  const pending = sessions.flatMap(s => s.approvals.filter(a => a.state === "pending").map(a => ({ ...a, sessionId: s.sessionId })));
  const respond = async (requestId: string, approved: boolean) => {
    setBusy(true); setNotice("");
    try {
      await api.approve(task.id, requestId, approved);
      setSessions(rows => rows.map(s => ({ ...s, approvals: s.approvals.filter(a => a.providerRequestId !== requestId) })));
      setNotice(`${approved ? "Approval" : "Denial"} recorded. Checking execution state…`);
      setRevision(r => r + 1); onChanged();
    } catch (e) { setNotice(`Decision failed: ${e instanceof Error ? e.message : String(e)}`); }
    finally { setBusy(false); }
  };
  return <div className="mission-conversation">
    <div className="shell-conversation-head"><Heading>{task.goal}</Heading><span className={`badge tone-${state.tone}`}>{state.label}</span></div>
    <p className="fine-print">{task.id} · {state.reason}</p>
    {expanded && <div className="shell-user-goal"><strong>You · goal recorded in the kernel</strong><p>{task.goal}</p><small>Provider delivery is not confirmed by this record.</small></div>}
    <div className="shell-messages" aria-label={expanded ? "Mission transcript" : "Recent mission messages"}>
      {!snapshot ? <p>Reading mission messages…</p> : snapshot.unavailable.includes("Events") ? <p>Mission messages unavailable.</p>
        : events.length ? events.map(e => <p key={`${e.run_id}:${e.seq}`}><span>{e.type === "message" ? "Agent" : e.type.replaceAll(".", " · ").replaceAll("_", " ")}</span>{e.summary}{expanded && <small>{e.assistant_id} · session {e.run_id} · <time dateTime={e.ts}>{new Date(e.ts).toLocaleTimeString()}</time></small>}</p>)
        : <p>No agent messages recorded yet.</p>}
    </div>
    {expanded && (snapshot?.events.length ?? 0) > 100 && <p className="fine-print">Showing the latest 100 events. Open mission controls for the full trace.</p>}
    {loading && <p role="status">Reading approval state…</p>}
    {error && <p role="alert" className="error">Approval state unavailable: {error}</p>}
    {pending.map(a => {
      const event = snapshot?.events.find(e => e.type === "approval.requested" &&
        (e.payload as { requestId?: string } | null)?.requestId === a.providerRequestId);
      return <div key={a.id} className="shell-approval" role="group" aria-label="Mission approval">
        <div><strong>{event?.summary ?? "Approval requested"}</strong><p className="fine-print">Session {a.sessionId} · request {a.providerRequestId}</p></div>
        <button className="btn btn-primary" disabled={busy} onClick={() => void respond(a.providerRequestId, true)}>Approve</button>
        <button className="btn btn-danger" disabled={busy} onClick={() => void respond(a.providerRequestId, false)}>Deny</button>
      </div>;
    })}
    <p className="shell-notice" role="status">{notice}</p>
    <div className="shell-conversation-actions"><button className="btn" onClick={onOpen}>Open mission controls</button>
      <span className="fine-print">Free-text follow-ups are not supported by the task API yet. Approvals and mission controls are available here.</span></div>
  </div>;
}
