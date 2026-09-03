import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../src/api.js";

afterEach(() => vi.unstubAllGlobals());

describe("web API client", () => {
  it("returns workspace data from the versioned local API", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ workspace: "personal" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(api.workspace()).resolves.toMatchObject({ workspace: "personal" });
    expect(fetchMock).toHaveBeenCalledWith("/api/workspace", expect.any(Object));
  });

  it("reads Execution Harness session drill-down from the durable endpoints", async () => {
    const detail = {
      sessionId: "es_1",
      taskId: "AG-1",
      sessionState: "COMPLETED", // primary vocabulary
      state: "ENDED_OK", // legacy, still served
      correlation: { parentTaskId: "AG-0", groupId: "g1" },
      request: { promptSource: "fresh", requestFingerprint: "fp", superseded: false },
      result: {
        outcome: "completed",
        verification: { passed: false, checks: [] },
        enforcement: { tools: "audit", budget: "advisory", isolation: "partial" },
      },
      checkpoints: [{ id: "ck", reason: "completion", gitRef: null, diffStat: null, at: "t" }],
      handoffEnvelopes: [],
      approvals: [],
      audit: [{ seq: 2, ts: "t", type: "guard.decision", summary: "budget", payload: {} }],
    };
    const fetchMock = vi.fn().mockImplementation(
      async () =>
        new Response(JSON.stringify(detail), { status: 200, headers: { "content-type": "application/json" } }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const got = await api.session("es_1");
    expect(got.sessionState).toBe("COMPLETED");
    expect(got.state).toBe("ENDED_OK"); // dual-field window
    expect(got.correlation).toEqual({ parentTaskId: "AG-0", groupId: "g1" });
    expect(got.result?.outcome).toBe("completed");
    expect(got.result?.enforcement?.isolation).toBe("partial");
    expect(got.result?.verification?.passed).toBe(false);
    expect(got.checkpoints[0]!.gitRef).toBeNull();
    expect(got.audit[0]!.type).toBe("guard.decision");
    expect(fetchMock).toHaveBeenCalledWith("/api/sessions/es_1", expect.any(Object));

    await api.sessions("AG-1");
    expect(fetchMock).toHaveBeenLastCalledWith("/api/tasks/AG-1/sessions", expect.any(Object));
    await api.sessionsByGroup("g1");
    expect(fetchMock).toHaveBeenLastCalledWith("/api/sessions?groupId=g1", expect.any(Object));
    await api.verification("es_1");
    expect(fetchMock).toHaveBeenLastCalledWith("/api/sessions/es_1/verification", expect.any(Object));
  });

  it("surfaces the API error message for failed workflows", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: "No eligible assistant" }), {
      status: 422,
      headers: { "content-type": "application/json" },
    })));

    await expect(api.start("task-1")).rejects.toThrow("No eligible assistant");
  });
});
