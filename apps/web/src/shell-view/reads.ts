import { useEffect, useRef, useState } from "react";
import { api } from "../api.js";
import type { Mission } from "../board/execution.js";
import type { ProcessDetail } from "./model.js";

const BATCH = 6;
const MAX_ROWS = 60;

/**
 * Per-row reads for the process list: the task detail (runs, resolved model) and the composer's
 * budget read (tokens). A row is re-read when the plane reports a new `updatedAt` or while it runs;
 * settled rows are read once. Bounded batches, like `useBoard`'s execution reads.
 */
export function useProcessDetails(tasks: Mission[], active: boolean) {
  const [details, setDetails] = useState<Record<string, ProcessDetail>>({});
  const seen = useRef<Record<string, string>>({});
  const composer = useRef<boolean | null>(null);
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
            const [detail, budget] = await Promise.allSettled([
              api.task(t.id),
              composer.current ? api.compositionBudget(t.id) : Promise.reject(new Error("off")),
            ]);
            if (detail.status === "rejected") throw detail.reason;
            const p: ProcessDetail = {
              detail: detail.value,
              budget: budget.status === "fulfilled" ? budget.value : composer.current ? "unavailable" : "off",
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
