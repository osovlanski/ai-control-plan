import { useEffect, useState } from "react";
import { openTaskEventStream } from "../TaskDetail.js";
import {
  api,
  type Assistant,
  type TaskContext,
  type TaskDetail,
  type TaskEvent,
  type RoutingExplanation,
  type SessionSummary,
  type SchedulerStatus,
} from "../api.js";

export type Snapshot = {
  detail: TaskDetail;
  events: TaskEvent[];
  routing: Array<{
    chosen: string | null;
    at: string;
    explanation: RoutingExplanation;
  }>;
  assistants: Assistant[];
  sessions: SessionSummary[];
  scheduler: SchedulerStatus | null;
  context: TaskContext | null;
  unavailable: string[];
};


export function useMissionSnapshot(taskId: string | null, revision = 0, stream = false) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!taskId) { setSnapshot(null); setError(null); return; }
    let disposed = false;
    let inFlight = false;
    let queued = false;
    let streamTimer: ReturnType<typeof setTimeout> | undefined;
    let timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      if (disposed) return;
      if (inFlight) { queued = true; return; }
      inFlight = true;
      clearTimeout(timer);
      try {
        const [detail, events, routing, assistants, sessions, scheduler, context] =
          await Promise.allSettled([
            api.task(taskId),
            api.events(taskId),
            api.routing(taskId),
            api.assistants(),
            api.sessions(taskId),
            api.schedulerStatus(),
            api.taskContext(taskId),
          ]);
        if (detail.status === "rejected") throw detail.reason;
        if (!disposed) {
          setSnapshot({
            detail: detail.value,
            events: events.status === "fulfilled" ? events.value : [],
            routing: routing.status === "fulfilled" ? routing.value : [],
            assistants:
              assistants.status === "fulfilled" ? assistants.value : [],
            sessions: sessions.status === "fulfilled" ? sessions.value : [],
            scheduler:
              scheduler.status === "fulfilled" ? scheduler.value : null,
            context: context.status === "fulfilled" ? context.value : null,
            unavailable: [
              events.status === "rejected" ? "Events" : "",
              routing.status === "rejected" ? "Routing" : "",
              assistants.status === "rejected" ? "Provider discovery" : "",
              sessions.status === "rejected" ? "Sessions" : "",
              scheduler.status === "rejected" ? "Scheduler status" : "",
              context.status === "rejected" ? "Context observation" : "",
            ].filter(Boolean),
          });
          setError(null);
        }
      } catch (e) {
        if (!disposed) setError((e as Error).message);
      } finally {
        inFlight = false;
        if (!disposed) {
          timer = setTimeout(() => void load(), queued ? 150 : 4000);
          queued = false;
        }
      }
    };
    void load();
    // The stream is only an invalidation hint. Always reconcile durable reads.
    const invalidate = () => {
      if (streamTimer === undefined) streamTimer = setTimeout(() => { streamTimer = undefined; void load(); }, 150);
    };
    const source = stream ? openTaskEventStream(taskId, invalidate) : null;
    if (source) source.onopen = invalidate;
    return () => {
      source?.close();
      clearTimeout(streamTimer);
      disposed = true;
      clearTimeout(timer);
    };
  }, [taskId, revision, stream]);
  return { snapshot: snapshot?.detail.id === taskId ? snapshot : null, error };
}
