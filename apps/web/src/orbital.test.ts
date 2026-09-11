import { describe, it, expect } from "vitest";
import {
  actualLifecycle,
  actualStatusLine,
  actualStatusShort,
  arcPath,
  bodiesCollide,
  contextPercent,
  describeState,
  fieldPulse,
  layoutBodies,
  modelNodes,
  nextStep,
  modelIdentityView,
  observedModel,
  pointAt,
  probeFreshness,
  ringOf,
  ringPath,
  shortFilterReason,
  resourceNextStep,
  waitKindLabel,
  type ActualExecution,
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
    expect(waitKindLabel({ kind: "resource" })).toBe("Resource wait · K4b");
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
    // K4b: a resource wait reports the pool, not a wake time it does not control.
    const resourceWait = { resource: "gpu", units: 1, capacity: 2, claimedUnits: 2, availableUnits: 0, queuePosition: 1, queueLength: 3, blockedBy: "capacity", waitKind: "resource" } as const;
    expect(nextStep({ state: "WAITING_RESOURCE", wait: { ...wait, kind: "resource" }, resourceWait })).toMatch(/0 of 2 free/);
    expect(nextStep({ state: "WAITING_RESOURCE", wait: { ...wait, kind: "resource" } })).toMatch(/not available/);
    expect(resourceNextStep({ ...resourceWait, blockedBy: "queue", queuePosition: 2 })).toMatch(/2 of 3 in the pool queue/);
    expect(resourceNextStep({ ...resourceWait, blockedBy: "unsatisfiable" })).toMatch(/above the pool capacity/);
    expect(resourceNextStep({ ...resourceWait, blockedBy: "undeclared", capacity: undefined })).toMatch(/not declared/);
    expect(resourceNextStep({ ...resourceWait, blockedBy: "eligible", availableUnits: 2 })).toMatch(/claims the slot/);
    // K4b fairness: the requirement is carried independently of the wait kind, so
    // a pool prerequisite is reported even when the task waits on something else.
    expect(nextStep({ state: "WAITING_RESOURCE", wait: { ...wait, kind: "dependency" },
      resourceWait: { ...resourceWait, blockedBy: "condition", queuePosition: 0, waitKind: "dependency" } }))
      .toBe("Waiting for dependency; the resource requirement remains gpu/1 and is re-evaluated after the dependency clears.");
    expect(nextStep({ state: "WAITING_RESOURCE", wait: { ...wait, kind: "quota" },
      resourceWait: { ...resourceWait, blockedBy: "condition", queuePosition: 0, waitKind: "quota" } }))
      .toBe("Quota retry must clear first; then the task must reacquire gpu/1 before routing.");
    // Not due yet is never "eligible", whatever the pool has free.
    expect(resourceNextStep({ ...resourceWait, blockedBy: "condition", queuePosition: 0, availableUnits: 2, waitKind: "time" }))
      .toMatch(/Not due yet; the resource requirement remains gpu\/1/);
    // Ready for the pool, but the wake still re-checks the wait's own kind.
    expect(resourceNextStep({ ...resourceWait, waitKind: "quota" })).toMatch(/Quota evidence is revalidated at that same wake/);
    // A FAILED dependency never "clears": the next wake applies the policy, and
    // the operator needs to read the action, not a wait that will never end.
    const depFailed = { ...resourceWait, waitKind: "dependency", blockedBy: "condition", queuePosition: 0 } as const;
    expect(resourceNextStep({ ...depFailed, dependencyFailure: { failed: ["AG-1"], policy: "cancel" } }))
      .toBe("Dependency failed; the next wake cancels this task. The resource requirement is not competing for a slot.");
    expect(resourceNextStep({ ...depFailed, dependencyFailure: { failed: ["AG-1"], policy: "wait-input" } }))
      .toBe("Dependency failed; the next wake moves this task to operator input. The resource requirement is not competing for a slot.");
    // wake-anyway under a not-yet-due re-check is not the failure wording: the
    // requirement is competing, so the ordinary "condition" message applies.
    expect(resourceNextStep({ ...depFailed, waitKind: "time", dependencyFailure: { failed: ["AG-1"], policy: "wake-anyway" } }))
      .toMatch(/Not due yet; the resource requirement remains gpu\/1/);
    // wake-anyway continues, so the requirement IS competing for the slot.
    expect(resourceNextStep({ ...resourceWait, waitKind: "dependency", dependencyFailure: { failed: ["AG-1"], policy: "wake-anyway" } }))
      .toMatch(/failed dependency policy allows continuation, so the resource requirement is competing for the slot/);
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

describe("model-candidate projection (K13 SHADOW)", () => {
  const cand = (assistantId: string, selector: string, over: Record<string, unknown> = {}) =>
    ({ assistantId, selector, label: `${assistantId}/${selector}`, eligible: true, filterFailures: [], total: 0.8, ...over });
  // Only the fields `modelNodes` reads are needed; a full CandidateScore is not.
  const build = (over: Record<string, unknown>) =>
    ({ mode: "shadow", recommended: "fake-a/premium-max", candidates: [], ...over }) as Parameters<typeof modelNodes>[0];
  const act = (over: Partial<ActualExecution>): ActualExecution =>
    ({ assistantId: null, modelSelector: null, running: false, lifecycle: "routed", ...over });

  const rec = build({
    candidates: [
      cand("fake-a", "premium-max"),
      cand("fake-a", "swift-mini"),
      cand("fake-b", "swift-mini", { total: 0.55 }),
      cand("fake-c", "nightly", { total: undefined }),
    ],
  });

  it("gives the SHADOW winner its own state and never leaks it to a sibling model", () => {
    const nodes = modelNodes(rec, act({ assistantId: "fake-a" }));
    expect(nodes.find((n) => n.label === "fake-a/premium-max")!.shadow).toBe(true);
    // Same assistant, different selector — must NOT inherit the shadow style.
    expect(nodes.find((n) => n.label === "fake-a/swift-mini")!.shadow).toBe(false);
    expect(nodes.filter((n) => n.shadow)).toHaveLength(1);
  });

  it("shows ACTUAL and SHADOW together, and never invents a model for ACTUAL", () => {
    const nodes = modelNodes(rec, act({ assistantId: "fake-a" }));
    // No selector was requested: every fake-a model is a truthful "actual, model unspecified".
    expect(nodes.filter((n) => n.actual).map((n) => n.label).sort()).toEqual(["fake-a/premium-max", "fake-a/swift-mini"]);
    expect(nodes.find((n) => n.assistantId === "fake-b")!.actual).toBe(false);
    // A concrete requested selector pins ACTUAL to exactly one node.
    const pinned = modelNodes(rec, act({ assistantId: "fake-a", modelSelector: "swift-mini", running: true, lifecycle: "running" }));
    expect(pinned.filter((n) => n.actual).map((n) => n.label)).toEqual(["fake-a/swift-mini"]);
  });

  it("carries BOTH relationships on one node when ACTUAL and SHADOW share a destination (P1-1)", () => {
    // actual model selector == shadow recommended selector == fake-a/premium-max.
    const nodes = modelNodes(rec, act({ assistantId: "fake-a", modelSelector: "premium-max", lifecycle: "routed" }));
    const winner = nodes.filter((n) => n.label === "fake-a/premium-max");
    // One candidate identity — not duplicated into two fake nodes.
    expect(winner).toHaveLength(1);
    // Both facts survive, independently inspectable.
    expect(winner[0]!.actual).toBe(true);
    expect(winner[0]!.shadow).toBe(true);
    // The sibling selector is neither.
    const sibling = nodes.find((n) => n.label === "fake-a/swift-mini")!;
    expect(sibling.shadow).toBe(false);
    expect(sibling.actual).toBe(false);
  });

  it("keeps a hard-filtered candidate excluded — a score can never resurrect it as the shadow winner", () => {
    const filtered = build({
      recommended: "fake-a/premium-max", // even if K13 somehow named it
      candidates: [cand("fake-a", "premium-max", { eligible: false, filterFailures: ["quota exhausted"], total: undefined })],
    });
    const [node] = modelNodes(filtered, act({ assistantId: "fake-b" }));
    expect(node!.eligible).toBe(false);
    expect(node!.shadow).toBe(false);
    expect(node!.filterFailures).toContain("quota exhausted");
  });

  it("marks an eligible candidate with no prior/metric as priorMissing, not excluded", () => {
    const nodes = modelNodes(rec, act({ assistantId: "fake-a" }));
    const alias = nodes.find((n) => n.label === "fake-c/nightly")!;
    expect(alias).toMatchObject({ eligible: true, priorMissing: true, shadow: false });
    expect(alias.score).toBeUndefined();
  });

  it("is empty without a persisted recommendation", () => {
    expect(modelNodes(undefined, act({}))).toEqual([]);
  });
});

describe("ACTUAL lifecycle truthfulness (P1-2)", () => {
  it("maps canonical / effective task state to a lifecycle bucket", () => {
    expect(actualLifecycle("RUNNING")).toBe("running");
    expect(actualLifecycle("CREATED")).toBe("routed");
    expect(actualLifecycle("ROUTING")).toBe("routed");
    expect(actualLifecycle("WAITING_RESOURCE")).toBe("held-resource");
    expect(actualLifecycle("LIMIT_PAUSED")).toBe("held-resource");
    expect(actualLifecycle("WAITING_INPUT")).toBe("held-input");
    expect(actualLifecycle("AWAITING_APPROVAL")).toBe("held-input");
    expect(actualLifecycle("COMPLETED")).toBe("completed");
    expect(actualLifecycle("FAILED")).toBe("failed");
    expect(actualLifecycle("CANCELLED")).toBe("cancelled");
    expect(actualLifecycle("RUNTIME_UNKNOWN")).toBe("unknown");
  });

  it("never implies future execution for a terminal task", () => {
    for (const lc of ["completed", "failed", "cancelled"] as const) {
      expect(actualStatusLine(lc)).not.toMatch(/will execute/);
    }
    expect(actualStatusLine("cancelled")).toBe("Cancelled · will not execute");
    expect(actualStatusLine("completed")).toBe("Completed");
    expect(actualStatusLine("failed")).toBe("Failed");
  });

  it("states a truthful held / awaiting phrase for every non-terminal state", () => {
    expect(actualStatusLine("running")).toBe("Executing");
    expect(actualStatusLine("routed")).toBe("Routed · awaiting execution");
    expect(actualStatusLine("held-resource")).toBe("Paused · waiting for resource");
    expect(actualStatusLine("held-input")).toBe("Held · waiting on a person");
    expect(actualStatusShort("running")).toBe("executing");
    expect(actualStatusShort("cancelled")).toBe("cancelled");
  });
});

describe("hard-filter reason legibility (P1-4)", () => {
  it("maps a technical filter string to a short semantic reason for the hero", () => {
    expect(shortFilterReason(["quota exhausted"])).toBe("Quota exhausted");
    expect(shortFilterReason(["quota blocked: quota until 2026-... (5h window)"])).toBe("Quota blocked");
    expect(shortFilterReason(["auth expired"])).toBe("Authentication unavailable");
    expect(shortFilterReason(["disabled in workspace config"])).toBe("Disabled");
    expect(shortFilterReason(["context window 8000 is below the task's declared minimum of 32000 tokens"])).toBe(
      "Context window too small",
    );
    expect(shortFilterReason(["excluded by the operator's explicit model override (premium-max)"])).toBe("Operator override");
    expect(shortFilterReason(["the operator named a model no configured assistant advertises"])).toBe("Unknown model");
  });

  it("falls back to the raw reason rather than inventing one", () => {
    expect(shortFilterReason(["some novel routing failure"])).toBe("some novel routing failure");
    expect(shortFilterReason([])).toBe("Hard filter");
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
