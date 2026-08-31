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
      sessionState: "COMPLETED",
      state: "ENDED_OK",
      verification: { passed: false, checks: [] },
      enforcement: { tools: "audit", budget: "advisory", isolation: "partial" },
      audit: [{ seq: 2, ts: "t", type: "guard.decision", summary: "budget", payload: {} }],
    };
    const fetchMock = vi.fn().mockImplementation(
      async () =>
        new Response(JSON.stringify(detail), { status: 200, headers: { "content-type": "application/json" } }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(api.session("es_1")).resolves.toMatchObject({
      sessionState: "COMPLETED",
      state: "ENDED_OK",
      enforcement: { isolation: "partial" },
    });
    expect(fetchMock).toHaveBeenCalledWith("/api/sessions/es_1", expect.any(Object));

    await api.sessions("AG-1");
    expect(fetchMock).toHaveBeenLastCalledWith("/api/tasks/AG-1/sessions", expect.any(Object));
  });

  it("surfaces the API error message for failed workflows", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: "No eligible assistant" }), {
      status: 422,
      headers: { "content-type": "application/json" },
    })));

    await expect(api.start("task-1")).rejects.toThrow("No eligible assistant");
  });
});
