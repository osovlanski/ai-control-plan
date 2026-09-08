import { describe, it, expect } from "vitest";
import {
  arcPath,
  bodiesCollide,
  contextPercent,
  describeState,
  fieldPulse,
  layoutBodies,
  nextStep,
  modelIdentityView,
  observedModel,
  pointAt,
  probeFreshness,
  ringOf,
  ringPath,
  waitKindLabel,
} from "./orbital.js";
import type { TaskEvent } from "./api.js";

describe("operator presentation boundaries", () => {
  it("keeps scheduler, human, and limit waits distinct", () => {
    expect(
      new Set(
        ["WAITING_RESOURCE", "WAITING_INPUT", "LIMIT_PAUSED"].map(
          (s) => describeState(s).label,
        ),
      ).size,
    ).toBe(3);
    expect(describeState("WAITING_INPUT", "approval_pending").label).toBe(
      "Approval required",
    );
    expect(describeState("WAITING_INPUT", "verification_failed").label).toBe(
      "Verification decision",
    );
    expect(describeState("FUTURE_STATE").label).toBe("FUTURE_STATE");
  });

  it("describes WAITING_RESOURCE and LIMIT_PAUSED as real K1/K2 scheduler behaviour", () => {
    // The Orbital branch predated K1/K2 and called these 'unavailable in this API'.
    expect(describeState("WAITING_RESOURCE").reason).toMatch(/K1\/K2/);
    expect(describeState("WAITING_RESOURCE").reason).not.toMatch(/unavailable/i);
    expect(describeState("LIMIT_PAUSED").reason).toMatch(/K2 checkpoints/);
    expect(describeState("WAITING_INPUT", "intervention_required").label).toBe(
      "Intervention required",
    );
  });

  it("labels a durable wait by kind", () => {
    expect(waitKindLabel({ kind: "time" })).toBe("Time wait · K1");
    expect(waitKindLabel({ kind: "quota" })).toBe("Quota wait · K2");
    expect(waitKindLabel({ kind: "dependency" })).toBe("Dependency wait · K4");
  });

  it("buckets idle-probe attempt age into freshness", () => {
    expect(probeFreshness(0)).toBe("live");
    expect(probeFreshness(10 * 60_000)).toBe("recent");
    expect(probeFreshness(60 * 60_000)).toBe("stale");
  });

  it("does not resolve model identity across runs or from usage", () => {
    const events = [
      {
        run_id: "a",
        type: "run.started",
        payload: { model: "reported-model" },
      },
      {
        run_id: "b",
        type: "usage.updated",
        payload: { model: "accounting-model" },
      },
    ].map((e) => ({
      ...e,
      seq: 1,
      ts: "2026-09-05T00:00:00Z",
      phase: null,
      summary: "",
      assistant_id: "test",
    })) satisfies TaskEvent[];
    expect(observedModel(events, "a")).toBe("reported-model");
    expect(observedModel(events, "b")).toBe("Unknown");
    expect(observedModel(events, undefined)).toBe("Unknown");
  });

  it("requires fresh occupancy and effective capacity for a percentage", () => {
    const base = {
      occupancyTokens: 800,
      effectiveWindowTokens: 1000,
      occupancySource: "provider-reported" as const,
      freshness: "live" as const,
    };
    expect(contextPercent(base)).toBe(80);
    expect(contextPercent({ ...base, freshness: "stale" })).toBeUndefined();
    expect(
      contextPercent({
        ...base,
        effectiveWindowTokens: undefined,
        advertisedMaxTokens: 1000,
      }),
    ).toBeUndefined();
    expect(
      contextPercent({ ...base, occupancySource: "unavailable" }),
    ).toBeUndefined();
    expect(contextPercent({ ...base, occupancyTokens: NaN })).toBeUndefined();
  });
});

describe("orbital field geometry", () => {
  const mk = (state: string, n: number) =>
    Array.from({ length: n }, (_, i) => ({ id: `${state}-${i}`, state }));

  it("groups bodies onto rings by state, never by time", () => {
    expect(ringOf("RUNNING")).toBe(0);
    expect(ringOf("WAITING_RESOURCE")).toBe(1);
    expect(ringOf("WAITING_INPUT")).toBe(1);
    expect(ringOf("COMPLETED")).toBe(2);
    expect(ringOf("SOMETHING_NEW")).toBe(0);
  });

  it("maps arc-length fractions onto the same closed path the SVG draws", () => {
    const start = pointAt(1, 0);
    const wrap = pointAt(1, 1);
    expect(Math.hypot(start.x - wrap.x, start.y - wrap.y)).toBeLessThan(1);
    expect(ringPath(1)).toMatch(/^M .* A .* A .*$/);
    expect(arcPath(1, 0.1, 0.1).split("L")).toHaveLength(25);
  });

  it("keeps a full workspace's labels from overlapping", () => {
    const bodies = layoutBodies([
      ...mk("RUNNING", 3),
      ...mk("WAITING_RESOURCE", 2),
      ...mk("WAITING_INPUT", 1),
      ...mk("COMPLETED", 1),
      ...mk("FAILED", 1),
    ]);
    for (let i = 0; i < bodies.length; i++)
      for (let j = i + 1; j < bodies.length; j++)
        expect(bodiesCollide(bodies[i]!, bodies[j]!)).toBe(false);
    // deterministic: same input, same layout
    expect(layoutBodies(mk("RUNNING", 2))).toEqual(layoutBodies(mk("RUNNING", 2)));
  });

  it("summarises the workload the way the core ring and status row show it", () => {
    expect(
      fieldPulse([
        { state: "RUNNING" },
        { state: "ROUTING" },
        { state: "WAITING_INPUT" },
        { state: "LIMIT_PAUSED" },
        { state: "WAITING_RESOURCE" },
        { state: "COMPLETED" },
        { state: "CANCELLED" },
      ]),
    ).toEqual({ running: 2, attention: 2, waiting: 1, ready: 0, unknown: 0, settled: 2, total: 7 });
  });

  it("derives 'what happens next' only from persisted K1-K3 truth", () => {
    const wait = { kind: "time" as const, notBefore: "2026-09-06T13:00:00.000Z" };
    expect(nextStep({ state: "WAITING_RESOURCE", wait })).toMatch(/Scheduler wakes it at .* and dispatches once/);
    expect(nextStep({ state: "WAITING_RESOURCE", wait: { ...wait, kind: "quota" } })).toMatch(/revalidates quota evidence/);
    expect(nextStep({ state: "WAITING_RESOURCE", wait, schedulerEnabled: false })).toMatch(/disabled/);
    expect(nextStep({ state: "WAITING_INPUT" })).toMatch(/will not wake it/);
    expect(nextStep({ state: "RUNNING", assistant: "fake-a" })).toMatch(/fake-a/);
    expect(nextStep({ state: "MYSTERY" })).toMatch(/Unknown state/);
  });
});

describe("execution evidence", () => {
  it("counts an approval-paused session as attention and an unstarted draft as ready", () => {
    const tasks = [
      { id: "approval", state: "RUNNING", execution: { awaitingApproval: true, assistants: [] } },
      { id: "draft", state: "CREATED" },
    ];
    expect(fieldPulse(tasks)).toEqual({ running: 0, attention: 1, waiting: 0, ready: 1, unknown: 0, settled: 0, total: 2 });
    expect(layoutBodies(tasks).every(body => body.ring === 1)).toBe(true);
    expect(nextStep({ state: "LIMIT_PAUSED" })).not.toMatch(/budget exhausted/i);
  });
});

describe("model identity (K7)", () => {
  it("separates requested from served and renders an unknown provider identity honestly", () => {
    const served = modelIdentityView(
      { requestedSelector: "opus", resolvedModelId: "claude-opus-4-1-20991231", servingProvider: "anthropic" },
      "Unknown",
    );
    expect(served).toMatchObject({ requested: "opus", served: "claude-opus-4-1-20991231", servedKnown: true });

    const unknown = modelIdentityView({ requestedSelector: "gpt-5-codex", resolvedModelId: null, servingProvider: "openai" }, "Unknown");
    expect(unknown.requested).toBe("gpt-5-codex");
    expect(unknown.served).toMatch(/^Unknown — provider did not report model identity$/);
    // Honest unknown, not an error: the Inspector styles it muted on this flag.
    expect(unknown.servedKnown).toBe(false);

    const unrequested = modelIdentityView(undefined, "Unknown");
    expect(unrequested.requested).toBe("Unspecified — no model was requested");
    expect(unrequested.servedKnown).toBe(false);

    // Pre-K7 rows fall back to this run's own start event, never to the request.
    const legacy = modelIdentityView(undefined, "claude-opus-4-1-20991231");
    expect(legacy.served).toBe("claude-opus-4-1-20991231");
    expect(legacy.servedKnown).toBe(true);
  });
});
