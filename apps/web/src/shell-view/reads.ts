import { useEffect, useRef, useState } from "react";
import { api, type SessionDetail, type TaskDetail } from "../api.js";
import type { Mission } from "../board/execution.js";
import { approvalTools, processState, restartOfferedIn, type Attention, type ProcessDetail } from "./model.js";

const BATCH = 6;
const MAX_ROWS = 60;

/** Settles a read into its value or `"unavailable"`; `undefined` means the row did not need it. */
const settle = async <T,>(want: boolean, read: () => Promise<T>): Promise<T | "unavailable" | undefined> =>
  want ? read().catch(() => "unavailable" as const) : undefined;

/**
 * Per-row reads for the process list: the task detail (runs, resolved model), the composer's
 * budget read (tokens, cost), the K9 context read for RUNNING rows, the last ended run's session
 * (verification checks) and, for NEEDS-YOU rows, the live sessions (pending approvals, recovery
 * offer). A row is re-read when the plane reports a new `updatedAt` or while it runs; settled rows
 * are read once. Bounded batches, like `useBoard`'s execution reads.
 */
export function useProcessDetails(tasks: Mission[], active: boolean) {
  const [details, setDetails] = useState<Record<string, ProcessDetail>>({});
  const seen = useRef<Record<string, string>>({});
  const composer = useRef<boolean | null>(null);
  // An ended run's settled session and an approval's tool never change, so each is read once.
  const settledSessions = useRef<Record<string, SessionDetail>>({});
  const tools = useRef<Map<string, string | null>>(new Map());
  const busy = useRef(false);
  // An in-flight batch outlives a newer task list (it re-reads on the next poll); only unmount discards it.
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    if (!active || busy.current) return;
    const disposed = () => !mounted.current;
    const stale = tasks.slice(0, MAX_ROWS).filter(t => t.state === "RUNNING" || seen.current[t.id] !== t.updatedAt);
    if (!stale.length) return;
    busy.current = true;
    void (async () => {
      try {
        if (composer.current === null) {
          const w = await api.workspace().catch(() => undefined);
          composer.current = w?.composer?.enabled !== false;
        }
        for (let i = 0; i < stale.length && !disposed(); i += BATCH) {
          const batch = stale.slice(i, i + BATCH);
          const read = await Promise.allSettled(batch.map(async t => {
            const state = processState(t);
            const [detail, budget, context, attention] = await Promise.allSettled([
              api.task(t.id),
              composer.current ? api.compositionBudget(t.id) : Promise.reject(new Error("off")),
              settle(state === "RUNNING", () => api.taskContext(t.id)),
              settle(state === "NEEDS-YOU" && t.state !== "LIMIT_PAUSED", () => readAttention(t, tools.current)),
            ]);
            if (detail.status === "rejected") throw detail.reason;
            const p: ProcessDetail = {
              detail: detail.value,
              budget: budget.status === "fulfilled" ? budget.value : composer.current ? "unavailable" : "off",
              context: context.status === "fulfilled" ? context.value : "unavailable",
              session: await lastSession(detail.value, settledSessions.current),
              attention: attention.status === "fulfilled" ? attention.value : "unavailable",
            };
            return [t, p] as const;
          }));
          if (disposed()) return;
          const next: Record<string, ProcessDetail> = {};
          for (const r of read) if (r.status === "fulfilled") {
            next[r.value[0].id] = r.value[1];
            seen.current[r.value[0].id] = r.value[0].updatedAt;
          }
          setDetails(d => ({ ...d, ...next }));
        }
      } finally {
        busy.current = false;
      }
    })();
  }, [tasks, active]);
  return details;
}

/** The last run's session once it has ended, for CHECKS. A settled result is cached by session id. */
async function lastSession(detail: TaskDetail, cache: Record<string, SessionDetail>): Promise<SessionDetail | "unavailable" | undefined> {
  const last = detail.runs.at(-1);
  if (!last?.ended_at) return undefined;
  const cached = cache[last.id];
  if (cached) return cached;
  try {
    const s = await api.session(last.id);
    if (s.result) cache[last.id] = s;
    return s;
  } catch {
    return "unavailable";
  }
}

/** A NEEDS-YOU row's live sessions: pending approvals with their tool, and the recovery offer. */
async function readAttention(task: Mission, tools: Map<string, string | null>): Promise<Attention> {
  const live = (await api.sessions(task.id)).filter(s => !s.endedAt);
  const sessions = await Promise.all(live.slice(0, BATCH).map(s => api.session(s.sessionId)));
  const pending = sessions.flatMap(s => s.approvals.filter(a => a.state === "pending").map(a => a.providerRequestId));
  if (pending.some(id => !tools.has(id))) {
    // The tool is named on the `approval.requested` event only; read the events once per new request.
    const named = approvalTools(await api.events(task.id).catch(() => []));
    for (const id of pending) if (named.has(id)) tools.set(id, named.get(id) ?? null);
  }
  return {
    approvals: pending.map(requestId => ({ requestId, tool: tools.get(requestId) ?? null })),
    restartOffered: restartOfferedIn(task.id, task.state, sessions),
  };
}

export interface PendingApproval { sessionId: string; requestId: string }

/** The selected task's pending approvals, from its live sessions. Never an arbitrary owner: all are listed. */
export function usePendingApprovals(taskId: string | null, wanted: boolean, revision: number) {
  const [pending, setPending] = useState<PendingApproval[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    setPending([]);
    setError(null);
    setLoading(!!taskId && wanted);
    if (!taskId || !wanted) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      try {
        const live = (await api.sessions(taskId)).filter(s => !s.endedAt);
        const details = await Promise.all(live.slice(0, BATCH).map(s => api.session(s.sessionId)));
        if (disposed) return;
        setPending(details.flatMap(s => s.approvals.filter(a => a.state === "pending")
          .map(a => ({ sessionId: s.sessionId, requestId: a.providerRequestId }))));
        setError(null);
      } catch (e) {
        if (!disposed) setError((e as Error).message);
      } finally {
        if (!disposed) { setLoading(false); timer = setTimeout(() => void load(), 4000); }
      }
    };
    void load();
    return () => { disposed = true; clearTimeout(timer); };
  }, [taskId, wanted, revision]);
  return { pending, error, loading };
}
