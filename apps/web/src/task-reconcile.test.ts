import { describe, expect, it } from "vitest";
import type { SessionDetail, SessionSummary, TaskEvent } from "./api.js";
import { answerFailure, fromStream, liveSessions, mergeEvents, pendingApproval } from "./task-reconcile.js";

const ev = (run: string, seq: number, type = "message", extra: Partial<TaskEvent> = {}): TaskEvent => ({
  run_id: run, seq, ts: `2026-11-21T10:00:${String(seq).padStart(2, "0")}.000Z`, type, phase: null,
  summary: `${type} ${seq}`, payload: null, assistant_id: "fake-a", ...extra,
});

describe("mergeEvents", () => {
  it("adds missed events once and drops duplicates, in timeline order", () => {
    const shown = [ev("r1", 1), ev("r1", 2)];
    const durable = [ev("r1", 1), ev("r1", 2), ev("r1", 3), ev("r1", 4)];
    const merged = mergeEvents(shown, durable);
    expect(merged.map(e => e.seq)).toEqual([1, 2, 3, 4]);
    // A late stream copy of an event already read durably changes nothing.
    expect(mergeEvents(merged, [{ ...ev("r1", 3), assistant_id: "" }])).toBe(merged);
  });

  it("keeps two runs' events with the same seq apart", () => {
    expect(mergeEvents([ev("r1", 1)], [ev("r2", 1)])).toHaveLength(2);
  });

  it("replaces a stream copy with the durable row that names the assistant", () => {
    const merged = mergeEvents([{ ...ev("r1", 1), assistant_id: "" }], [ev("r1", 1)]);
    expect(merged).toHaveLength(1);
    expect(merged[0]!.assistant_id).toBe("fake-a");
  });
});

describe("fromStream", () => {
  it("maps the stream's runId onto run_id and refuses a frame without a stable id", () => {
    expect(fromStream({ runId: "r1", seq: 3, ts: "t", type: "message", summary: "s" })).toMatchObject({ run_id: "r1", seq: 3 });
    expect(fromStream({ runId: "r1", ts: "t", type: "message", summary: "s" })).toBeNull();
  });
});

const summary = (id: string, endedAt: string | null = null) => ({ sessionId: id, endedAt }) as SessionSummary;
const detail = (approvals: SessionDetail["approvals"]) => ({ approvals }) as SessionDetail;
const asked = (run: string, seq: number, requestId: string) =>
  ev(run, seq, "approval.requested", { summary: "Fake tool wants to run", payload: { requestId } });

describe("pendingApproval", () => {
  it("uses the session approval rows when the task runs on the Harness", () => {
    const events = [ev("s1", 1), asked("s1", 2, "apr_1")];
    expect(pendingApproval({ state: "RUNNING", events, sessions: [summary("s1")],
      sessionDetails: [detail([{ id: "a", providerRequestId: "apr_1", state: "pending", decision: null }])] }))
      .toEqual({ requestId: "apr_1", summary: "Fake tool wants to run" });
    // Answered from another tab: the row moved on, so the stale card goes.
    expect(pendingApproval({ state: "RUNNING", events, sessions: [summary("s1")],
      sessionDetails: [detail([{ id: "a", providerRequestId: "apr_1", state: "answered", decision: "approved" }])] })).toBeNull();
  });

  it("derives a legacy request from the events: pending only while it is the run's last event", () => {
    const waiting = [ev("r1", 1), asked("r1", 2, "apr_1")];
    expect(pendingApproval({ state: "RUNNING", events: waiting, sessions: [], sessionDetails: [] })?.requestId).toBe("apr_1");
    expect(pendingApproval({ state: "RUNNING", events: [...waiting, ev("r1", 3)], sessions: [], sessionDetails: [] })).toBeNull();
    expect(pendingApproval({ state: "CANCELLED", events: waiting, sessions: [], sessionDetails: [] })).toBeNull();
  });

  it("reads details only for sessions that have not ended", () => {
    expect(liveSessions([summary("s1", "t"), summary("s2")]).map(s => s.sessionId)).toEqual(["s2"]);
  });
});

describe("answerFailure", () => {
  it("treats a 409 as already answered and anything else as unknown delivery", () => {
    expect(answerFailure({ status: 409 })).toBe("already-answered");
    expect(answerFailure(new TypeError("Failed to fetch"))).toBe("unknown");
    expect(answerFailure({ status: 500 })).toBe("unknown");
  });
});
