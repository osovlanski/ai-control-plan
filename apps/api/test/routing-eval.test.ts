/**
 * Offline routing eval (docs/agentic-os-eval-plan.md area 3).
 *
 * Runs a labelled corpus through the pure `route()` and reports overall accuracy
 * plus a per-case pass/fail table. The corpus is DATA — grow it by appending to
 * `routing-eval.corpus.json`, no code change. router.test.ts stays the place for
 * asserting *why* a rule fired; this is the regression net for *which* assistant
 * a labelled situation routes to, and a number ("accuracy") to watch over time.
 */
import { describe, expect, it } from "vitest";
import type { AssistantId, CapabilityManifest } from "@agent-plane/core";
import { route, type RouteCandidate, type RouteRequest } from "../src/modules/router.js";
import type { AssistantScore } from "../src/modules/telemetry.js";
import corpus from "./routing-eval.corpus.json" with { type: "json" };

interface CandidateSpec {
  id: string;
  enabled?: boolean;
  manifest?: null | { auth?: "ok" | "missing"; quota?: number; reportsLimits?: boolean; noFs?: boolean };
}

interface Case {
  name: string;
  profile: RouteRequest["profile"];
  needsRepo?: boolean;
  repoPathAllowed?: boolean;
  cooldowns?: Record<string, string>;
  userOverride?: string;
  scores?: Record<string, Partial<AssistantScore>>;
  candidates: CandidateSpec[];
  expect: { chosen: string | null; ruleFired?: string; tieBreaker?: string };
}

function manifestOf(spec: Exclude<CandidateSpec["manifest"], null | undefined>, id: string): CapabilityManifest {
  return {
    assistantId: id as AssistantId,
    provider: "test",
    core: {
      models: [],
      canResume: true,
      canMcp: true,
      supportsMidRunInput: true,
      reportsUsage: true,
      reportsLimits: spec.reportsLimits ?? true,
      execution: { shell: !spec.noFs, filesystem: !spec.noFs, web: "unknown" },
      auth: { state: spec.auth ?? "ok" },
      limits:
        spec.quota !== undefined
          ? [{ window: "5h", usedPercent: spec.quota, source: "runtime-probe", observedAt: "t" }]
          : undefined,
    },
    providerDetail: {},
    evidence: { source: "runtime-probe", observedAt: "t" },
  };
}

function candidateOf(spec: CandidateSpec): RouteCandidate {
  const manifest =
    spec.manifest === null ? null : manifestOf(spec.manifest ?? {}, spec.id);
  return { id: spec.id as AssistantId, enabled: spec.enabled ?? true, manifest };
}

function requestOf(c: Case): RouteRequest {
  return {
    taskId: "AG-1",
    profile: c.profile,
    needsRepo: c.needsRepo ?? false,
    repoPathAllowed: c.repoPathAllowed ?? true,
    cooldowns: new Map(Object.entries(c.cooldowns ?? {})),
    ...(c.userOverride ? { userOverride: c.userOverride as AssistantId } : {}),
    ...(c.scores
      ? {
          scores: new Map(
            Object.entries(c.scores).map(([id, s]) => [
              id,
              { assistantId: id, runs: 5, successRate: 1, failovers: 0, errors: 0, ...s } as AssistantScore,
            ]),
          ),
        }
      : {}),
  };
}

const cases = (corpus as { cases: Case[] }).cases;

describe("routing offline eval", () => {
  const results = cases.map((c) => {
    const out = route(requestOf(c), c.candidates.map(candidateOf));
    const chosen = out.chosen ?? null;
    const chosenOk = chosen === c.expect.chosen;
    const ruleOk = c.expect.ruleFired === undefined || out.ruleFired.includes(c.expect.ruleFired);
    const tbOk = c.expect.tieBreaker === undefined || (out.tieBreaker ?? "").includes(c.expect.tieBreaker);
    return {
      name: c.name,
      want: c.expect.chosen,
      got: chosen,
      ruleFired: out.ruleFired,
      pass: chosenOk && ruleOk && tbOk,
    };
  });

  it("every labelled case routes to its expected assistant", () => {
    const failures = results.filter((r) => !r.pass);
    const table = failures
      .map((r) => `  ✗ ${r.name}\n      want=${r.want} got=${r.got} ruleFired="${r.ruleFired}"`)
      .join("\n");
    expect(failures, failures.length ? `\n${table}\n` : "").toEqual([]);
  });

  it("reports accuracy over the corpus (informational, must stay 1.0)", () => {
    const accuracy = results.filter((r) => r.pass).length / results.length;
    expect(results.length).toBeGreaterThanOrEqual(15);
    expect(accuracy).toBe(1);
  });
});
