import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, api } from "../src/api.js";
import { AuthExpiredError, onAuthExpired } from "../src/auth.js";
import { openTaskEventStream } from "../src/TaskDetail.jsx";
import { composeFor } from "../src/NewTask.js";

afterEach(() => vi.unstubAllGlobals());

describe("web API client", () => {
  it("skips composition requests when the workspace advertises composer disabled", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ composer: { enabled: false, requireRevision: false } })));
    vi.stubGlobal("fetch", fetchMock);

    await expect(composeFor("AG-1")).resolves.toEqual({ state: "off" });
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(["/api/workspace"]);
  });

  it.each([
    { composer: { enabled: true, requireRevision: false } },
    {},
  ])("keeps the legacy composer_disabled fallback for workspace %j", async (workspace) => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(workspace)))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: "Composer is off", reason: "composer_disabled" }), { status: 404 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(composeFor("AG-1")).resolves.toEqual({ state: "off" });
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(["/api/workspace", "/api/tasks/AG-1/compose"]);
  });

  it("still probes composition when the workspace read fails", async () => {
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new Error("Workspace unavailable"))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: "Composition unavailable" }), { status: 503 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(composeFor("AG-1")).resolves.toMatchObject({ state: "error" });
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(["/api/workspace", "/api/tasks/AG-1/compose"]);
  });

  it("returns workspace data from the versioned local API", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ workspace: "personal" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(api.workspace()).resolves.toMatchObject({ workspace: "personal" });
    expect(fetchMock).toHaveBeenCalledWith("/api/workspace", expect.any(Object));
    expect(fetchMock).toHaveBeenCalledWith("/api/workspace", expect.objectContaining({ credentials: "include" }));
  });

  it("signals global expiry and throws AuthExpiredError on 401",async()=>{let fired=0;const off=onAuthExpired(()=>fired++);vi.stubGlobal("fetch",vi.fn().mockResolvedValue(new Response("{}",{status:401})));await expect(api.workspace()).rejects.toBeInstanceOf(AuthExpiredError);expect(fired).toBe(1);off();});

  it("probes exactly once when a closed EventSource reports repeated errors", async () => {
    class FakeEventSource {
      static readonly CLOSED = 2;
      readonly readyState = FakeEventSource.CLOSED;
      onerror: (() => void) | null = null;
      onmessage: ((message: MessageEvent<string>) => void) | null = null;
      constructor(public readonly url: string, public readonly options: EventSourceInit) {}
      close() {}
    }
    vi.stubGlobal("EventSource", FakeEventSource);
    const fetchMock = vi.fn().mockResolvedValue(new Response("{}", { status: 401 }));
    vi.stubGlobal("fetch", fetchMock);
    let expired = 0;
    const off = onAuthExpired(() => expired++);
    const source = openTaskEventStream("AG-1", () => undefined) as unknown as FakeEventSource;
    source.onerror?.();
    source.onerror?.();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchMock).toHaveBeenCalledWith("/api/workspace", expect.objectContaining({ credentials: "include" }));
    expect(expired).toBe(1);
    off();
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

describe("composer reads (API 2.6)", () => {
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  it("keeps the plane's reason on a refusal so a disabled composer is told apart from a failure", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json(404, { error: "the composer is disabled (composer.enabled is false)", reason: "composer_disabled" })));
    const err = await api.compose("AG-1").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 404, reason: "composer_disabled", message: "the composer is disabled (composer.enabled is false)" });
  });

  it("carries the new preview of a 409 composition_drift", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json(409, { error: "the composition changed since it was previewed", reason: "composition_drift", preview: { compositionDigest: "sha256:new" } })));
    const err = await api.start("AG-1", undefined, `sha256:${"0".repeat(64)}`).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).reason).toBe("composition_drift");
    expect(((err as ApiError).body as { preview: { compositionDigest: string } }).preview.compositionDigest).toBe("sha256:new");
  });

  it("sends the confirmed digest on start, and the assistant override as a stage-2 override on compose", async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(json(200, {})));
    vi.stubGlobal("fetch", fetchMock);
    const digest = `sha256:${"a".repeat(64)}`;
    await api.start("AG-1", "fake-b", digest);
    await api.start("AG-2");
    await api.compose("AG-1", "fake-b");
    await api.compose("AG-1");
    const bodies = fetchMock.mock.calls.map(([, init]) => JSON.parse((init as RequestInit).body as string) as unknown);
    expect(bodies).toEqual([
      { assistantId: "fake-b", compositionDigest: digest },
      {},
      { overrides: { harness_model: { assistantId: "fake-b" } } },
      {},
    ]);
  });

  it("reads history and budget from the composition routes", async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(json(200, {})));
    vi.stubGlobal("fetch", fetchMock);
    await api.composition("AG-1");
    await api.compositionBudget("AG-1");
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(["/api/tasks/AG-1/composition", "/api/tasks/AG-1/composition/budget"]);
  });
});
