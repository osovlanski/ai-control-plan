/**
 * Reconnect reconciliation for the mission view (milestone B1, decision D-E).
 *
 * A phone that locks, backgrounds the tab or changes network loses SSE frames. The plane has no
 * per-task journal or Last-Event-ID yet, so the view recovers from durable reads instead: the
 * `/events` list, the task detail and the sessions' approval rows. These helpers are the pure part
 * of that: one stable key per event, a merge that keeps every event once, and the pending approval
 * the server says is current. Nothing here talks to the network.
 */
import type { SessionDetail, SessionSummary, TaskEvent } from "./api.js";

/** An SSE `event` frame: the normalized event plus its per-run `seq`; `runId` instead of `run_id`. */
export interface StreamEvent {
  runId?: string;
  run_id?: string;
  seq?: number;
  ts: string;
  type: string;
  phase?: string | null;
  summary: string;
  payload?: Record<string, unknown> | null;
  assistant_id?: string;
}

export interface PendingApproval {
  requestId: string;
  summary: string;
}

/** `(run, seq)` is unique in the `events` table and is what both the stream and `/events` carry. */
export function eventKey(event: Pick<TaskEvent, "run_id" | "seq">): string {
  return `${event.run_id}:${event.seq}`;
}

/** The stream names the run `runId`; the durable read names it `run_id`. One shape for the view. */
export function fromStream(event: StreamEvent): TaskEvent | null {
  const runId = event.run_id ?? event.runId;
  if (!runId || typeof event.seq !== "number") return null;
  return {
    run_id: runId,
    seq: event.seq,
    ts: event.ts,
    type: event.type,
    phase: event.phase ?? null,
    summary: event.summary,
    payload: event.payload ?? null,
    assistant_id: event.assistant_id ?? "",
  };
}

/**
 * Every event once, in timeline order. A key already shown keeps its first copy, except that a
 * durable row replaces a stream copy (it carries `assistant_id`, the stream frame does not).
 * Order is the server's `ORDER BY ts, seq`, with the run id as the last tie-break.
 */
export function mergeEvents(current: readonly TaskEvent[], incoming: readonly TaskEvent[]): TaskEvent[] {
  const byKey = new Map<string, TaskEvent>();
  for (const event of current) if (!byKey.has(eventKey(event))) byKey.set(eventKey(event), event);
  let changed = false;
  for (const event of incoming) {
    const key = eventKey(event);
    const seen = byKey.get(key);
    if (!seen) { byKey.set(key, event); changed = true; }
    else if (!seen.assistant_id && event.assistant_id) { byKey.set(key, event); changed = true; }
  }
  if (!changed && byKey.size === current.length) return current as TaskEvent[];
  return [...byKey.values()].sort((a, b) =>
    a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : a.seq !== b.seq ? a.seq - b.seq : a.run_id < b.run_id ? -1 : a.run_id > b.run_id ? 1 : 0);
}

const requestIdOf = (event: TaskEvent): string | undefined => {
  const id = (event.payload as { requestId?: unknown } | null)?.requestId;
  return typeof id === "string" ? id : undefined;
};

const TERMINAL = new Set(["COMPLETED", "FAILED", "CANCELLED"]);

/**
 * The approval the server says is pending now, or null.
 *
 * Harness tasks: the sessions' durable `approvals` rows are the truth; a row is pending only while
 * its state is `pending`. The summary comes from the matching `approval.requested` event.
 *
 * Legacy (non-Harness) runs keep no approval row. There the request is pending while it is the last
 * event of a run that has not ended and the task is not terminal: the fake and real legacy adapters
 * block on the answer, so any later event of that run means it was answered.
 */
export function pendingApproval(input: {
  state: string;
  events: readonly TaskEvent[];
  sessions: readonly SessionSummary[];
  sessionDetails: readonly SessionDetail[];
}): PendingApproval | null {
  const summaryFor = (requestId: string) =>
    input.events.find(e => e.type === "approval.requested" && requestIdOf(e) === requestId)?.summary ?? "The assistant is waiting for your approval.";
  if (input.sessions.length > 0) {
    for (const session of input.sessionDetails) {
      const pending = session.approvals.find(a => a.state === "pending");
      if (pending) return { requestId: pending.providerRequestId, summary: summaryFor(pending.providerRequestId) };
    }
    return null;
  }
  if (TERMINAL.has(input.state)) return null;
  const lastOfRun = new Map<string, TaskEvent>();
  for (const event of input.events) {
    const last = lastOfRun.get(event.run_id);
    if (!last || event.seq > last.seq) lastOfRun.set(event.run_id, event);
  }
  for (const event of lastOfRun.values()) {
    const requestId = event.type === "approval.requested" ? requestIdOf(event) : undefined;
    if (requestId) return { requestId, summary: event.summary };
  }
  return null;
}

/** Sessions that can still hold a pending approval: not ended. Only these need a detail read. */
export function liveSessions(sessions: readonly SessionSummary[]): SessionSummary[] {
  return sessions.filter(s => !s.endedAt);
}

/**
 * What an answer's failure means for the card. A 409 is the plane saying this request is no longer
 * answerable as sent (answered from another tab or device, a conflicting decision, or the run
 * moved on): show it as already answered and take the server's state. Anything else (network,
 * 5xx) is unknown delivery: never re-send on our own, re-read and let the owner decide.
 */
export function answerFailure(error: unknown): "already-answered" | "unknown" {
  const status = (error as { status?: unknown } | null)?.status;
  return status === 409 ? "already-answered" : "unknown";
}
