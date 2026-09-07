import { describe, expect, it } from "vitest";
import type { SessionSummary, TaskDetail } from "../api.js";
import { executionRead } from "./execution.js";

describe("selected mission execution", () => {
  it("lights every running competitor, excluding ended and approval-paused runs", () => {
    const detail = { state: "RUNNING", runs: [
      { id: "claude-run", assistant_id: "claude", state: "RUNNING", ended_at: null },
      { id: "codex-run", assistant_id: "codex", state: "RUNNING", ended_at: null },
      { id: "cursor-run", assistant_id: "cursor", state: "AWAITING_APPROVAL", ended_at: null },
      { assistant_id: "old", state: "COMPLETED", ended_at: "2026-09-06" },
    ] } as TaskDetail;
    const sessions = detail.runs.filter(r => !r.ended_at).map(r => ({ sessionId: r.id })) as SessionSummary[];
    expect(executionRead(detail, sessions)).toEqual({ verified: true, awaitingApproval: true, assistants: ["claude", "codex"] });
    expect(executionRead({ ...detail, state: "CANCELLED" }, sessions)).toEqual({ verified: true, awaitingApproval: false, assistants: [] });
  });
});
