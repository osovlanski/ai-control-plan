import { describe, expect, it } from "vitest";
import type { AssistantId, CapabilityManifest } from "@agent-plane/core";
import { route, type RouteCandidate, type RouteRequest } from "../src/modules/router.js";
import type { AssistantScore } from "../src/modules/telemetry.js";

function manifest(overrides: {
  auth?: "ok" | "missing";
  usedPercent?: number;
  reportsLimits?: boolean;
}): CapabilityManifest {
  return {
    assistantId: "a" as AssistantId,
    provider: "test",
    core: {
      models: [],
      canResume: true,
      canMcp: true,
      supportsMidRunInput: true,
      reportsUsage: true,
      reportsLimits: overrides.reportsLimits ?? true,
      execution: { shell: true, filesystem: true, web: "unknown" },
      auth: { state: overrides.auth ?? "ok" },
      limits:
        overrides.usedPercent !== undefined
          ? [{ window: "5h", usedPercent: overrides.usedPercent, source: "runtime-probe", observedAt: "t" }]
          : undefined,
    },
    providerDetail: {},
    evidence: { source: "runtime-probe", observedAt: "t" },
  };
}

const baseReq = (over: Partial<RouteRequest> = {}): RouteRequest => ({
  taskId: "AG-1",
  profile: "auto",
  needsRepo: false,
  repoPathAllowed: true,
  cooldowns: new Map(),
  ...over,
});

const candidate = (id: string, m: CapabilityManifest | null, enabled = true): RouteCandidate => ({
  id: id as AssistantId,
  enabled,
  manifest: m,
});

describe("router", () => {
  it("hard-filters unauthenticated, disabled, and unsynced assistants with reasons", () => {
    const result = route(baseReq(), [
      candidate("claude", manifest({ auth: "missing" })),
      candidate("codex", manifest({}), false),
      candidate("ghost", null),
    ]);
    expect(result.chosen).toBeUndefined();
    expect(result.ruleFired).toBe("no-eligible-candidate");
    const failures = Object.fromEntries(result.candidates.map((c) => [c.assistantId, c.filterFailures]));
    expect(failures.claude).toContain("auth missing");
    expect(failures.codex).toContain("disabled in workspace config");
    expect(failures.ghost?.[0]).toMatch(/no capability manifest/);
  });

  it("filters exhausted quota and repo-disallowed candidates", () => {
    const exhausted = route(baseReq(), [candidate("claude", manifest({ usedPercent: 100 }))]);
    expect(exhausted.candidates[0]!.filterFailures).toContain("quota exhausted");

    const noRepo = route(baseReq({ needsRepo: true, repoPathAllowed: false }), [
      candidate("claude", manifest({})),
    ]);
    expect(noRepo.candidates[0]!.filterFailures).toContain("repository path not in workspace allowlist");
  });

  it("preserve-quota picks the most headroom and explains the tie-break", () => {
    const result = route(baseReq({ profile: "preserve-quota" }), [
      candidate("claude", manifest({ usedPercent: 80 })),
      candidate("codex", manifest({ usedPercent: 20 })),
    ]);
    expect(result.chosen).toBe("codex");
    expect(result.ruleFired).toMatch(/preserve-quota/);
    expect(result.tieBreaker).toBe("over claude");
  });

  it("treats unknown quota as 50% under preserve-quota (honest uncertainty)", () => {
    const result = route(baseReq({ profile: "preserve-quota" }), [
      candidate("claude", manifest({ usedPercent: 80 })),
      candidate("codex", manifest({ reportsLimits: false })),
    ]);
    expect(result.chosen).toBe("codex");
  });

  it("honours a valid user override and records it", () => {
    const result = route(baseReq({ userOverride: "claude" as AssistantId }), [
      candidate("claude", manifest({ usedPercent: 99 })),
      candidate("codex", manifest({ usedPercent: 1 })),
    ]);
    expect(result.chosen).toBe("claude");
    expect(result.ruleFired).toBe("user-override");
    expect(result.userOverride).toBe("claude");
  });

  it("refuses an override that fails hard filters", () => {
    const result = route(baseReq({ userOverride: "claude" as AssistantId }), [
      candidate("claude", manifest({ auth: "missing" })),
      candidate("codex", manifest({})),
    ]);
    expect(result.chosen).toBeUndefined();
    expect(result.tieBreaker).toMatch(/failed hard filters/);
  });

  it("applies cooldowns as hard filters", () => {
    const result = route(
      baseReq({ cooldowns: new Map([["claude", "rate limited until 14:00"]]) }),
      [candidate("claude", manifest({})), candidate("codex", manifest({}))],
    );
    expect(result.chosen).toBe("codex");
    expect(result.candidates.find((c) => c.assistantId === "claude")!.filterFailures[0]).toMatch(/cooldown/);
  });

  it("returns no-eligible-candidate when every candidate is in cooldown", () => {
    const result = route(
      baseReq({ cooldowns: new Map([["claude", "rate limited"], ["codex", "failed twice"]]) }),
      [candidate("claude", manifest({})), candidate("codex", manifest({}))],
    );
    expect(result.chosen).toBeUndefined();
    expect(result.ruleFired).toBe("no-eligible-candidate");
  });

  it("auto follows config (candidate) order and breaks ties on quota headroom", () => {
    const byOrder = route(baseReq({ profile: "auto" }), [
      candidate("claude", manifest({})),
      candidate("codex", manifest({})),
      candidate("ox", manifest({})),
    ]);
    expect(byOrder.chosen).toBe("claude");
    expect(byOrder.ruleFired).toMatch(/config preference order/);

    const byHeadroom = route(baseReq({ profile: "auto" }), [
      candidate("claude", manifest({ usedPercent: 90 })),
      candidate("codex", manifest({ usedPercent: 10 })),
    ]);
    expect(byHeadroom.chosen).toBe("codex");
  });
});

describe("telemetry-fed profiles", () => {
  const score = (over: Partial<AssistantScore>): AssistantScore => ({
    assistantId: "x",
    runs: 5,
    successRate: 1,
    failovers: 0,
    errors: 0,
    ...over,
  });

  it("fastest uses measured median duration once it exists", () => {
    const result = route(
      baseReq({
        profile: "fastest",
        scores: new Map([
          ["claude", score({ medianDurationMs: 90_000 })],
          ["codex", score({ medianDurationMs: 30_000 })],
        ]),
      }),
      [candidate("claude", manifest({})), candidate("codex", manifest({}))],
    );
    expect(result.chosen).toBe("codex");
    expect(result.ruleFired).toMatch(/lowest median run time/);
  });

  it("says so plainly when it has no measurement, instead of implying one", () => {
    const result = route(baseReq({ profile: "fastest" }), [
      candidate("claude", manifest({})),
      candidate("codex", manifest({})),
    ]);
    expect(result.ruleFired).toMatch(/no latency telemetry yet/);
  });

  it("renders sub-second medians honestly rather than as 0s", () => {
    const result = route(
      baseReq({ profile: "fastest", scores: new Map([["claude", score({ medianDurationMs: 4 })]]) }),
      [candidate("claude", manifest({}))],
    );
    expect(result.ruleFired).toContain("4ms");
    expect(result.ruleFired).not.toContain("0s");
  });

  it("best-quality weighs success, tests, and failovers together", () => {
    const result = route(
      baseReq({
        profile: "best-quality",
        scores: new Map([
          // Finishes every run but its work keeps getting handed off elsewhere.
          ["claude", score({ successRate: 1, testPassRate: 1, failovers: 5, runs: 5 })],
          ["codex", score({ successRate: 0.9, testPassRate: 0.95, failovers: 0, runs: 5 })],
        ]),
      }),
      [candidate("claude", manifest({})), candidate("codex", manifest({}))],
    );
    expect(result.chosen).toBe("codex");
  });

  it("lowest-tokens ranks by measured median tokens", () => {
    const result = route(
      baseReq({
        profile: "lowest-tokens",
        scores: new Map([
          ["claude", score({ medianTokens: 9000 })],
          ["codex", score({ medianTokens: 2000 })],
        ]),
      }),
      [candidate("claude", manifest({})), candidate("codex", manifest({}))],
    );
    expect(result.chosen).toBe("codex");
    expect(result.ruleFired).toContain("2000");
  });
});
