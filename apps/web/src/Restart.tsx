import { useEffect, useState } from "react";
import { api, type SessionSummary } from "./api.js";

/** Recovery decisions are session audit facts, never inferred from a pause or approval. */
export function useRestartOffered(taskId: string | null, state: string, sessions: SessionSummary[]) {
  const [offered, setOffered] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    setOffered(null);
    if (!taskId || state !== "WAITING_INPUT") return;
    void Promise.all(sessions.filter(s => !s.endedAt).map(s => api.session(s.sessionId))).then(rows => {
      if (active && rows.some(s => !s.endedAt && s.taskId === taskId && s.audit.some(e =>
        e.type === "recovery.decision" && (e.payload as { action?: string } | null)?.action === "resume_offered"))) setOffered(taskId);
    }).catch(() => undefined);
    return () => { active = false; };
  }, [taskId, state, sessions]);
  return state === "WAITING_INPUT" && offered === taskId;
}

export function Restart({ taskId, busy, onRestart }: { taskId: string; busy: boolean; onRestart: () => void }) {
  const [confirm, setConfirm] = useState(false);
  const style = { font: "inherit", color: "inherit", background: "transparent", border: "1px solid currentColor", borderRadius: 6, padding: "0.35rem 0.6rem", cursor: "pointer" };
  return <span role="group" aria-label="Restart task">
    {confirm ? <>Restart {taskId} from its checkpoint? <button style={style} type="button" disabled={busy} onClick={() => { setConfirm(false); onRestart(); }}>Confirm restart</button> <button style={style} type="button" onClick={() => setConfirm(false)}>Keep waiting</button></>
      : <button style={style} type="button" disabled={busy} onClick={() => setConfirm(true)}>Restart</button>}
  </span>;
}
