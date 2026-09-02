import { describe, expect, expectTypeOf, it } from "vitest";
import { evaluationResult } from "../src/execution.js";
import type {
  EvidenceBundle,
  ExecutionArtifact,
  VerificationPlan,
  VerificationSpec,
} from "../src/execution.js";
import type { ExecutionSessionId } from "../src/ids.js";
import type { VerificationCheckResult, VerificationKind } from "../src/events.js";

describe("verification and evidence contracts", () => {
  it("includes automatic API, browser, and review verification kinds", () => {
    const kinds: VerificationKind[] = ["api", "browser", "review"];
    expect(kinds).toEqual(["api", "browser", "review"]);
  });

  it("represents passed, failed, skipped, and blocked checks without losing the legacy boolean", () => {
    const checks: VerificationCheckResult[] = [
      { name: "ok", kind: "tests", passed: true, status: "passed", required: true, summary: "ok" },
      { name: "bad", kind: "api", passed: false, status: "failed", required: true, summary: "bad" },
      { name: "none", kind: "browser", passed: false, status: "skipped", required: false, summary: "none" },
      { name: "blocked", kind: "review", passed: false, status: "blocked", required: true, summary: "blocked" },
    ];
    expect(checks.map((check) => check.status)).toEqual(["passed", "failed", "skipped", "blocked"]);
    expect(checks.filter((check) => check.required && check.status !== "passed")).toHaveLength(2);
    expect(evaluationResult(checks).passed).toBe(false);
  });

  it("ignores advisory failures but never passes a required skipped or blocked check", () => {
    expect(
      evaluationResult([
        { name: "advisory", kind: "lint", passed: false, status: "skipped", required: false, summary: "missing" },
      ]).passed,
    ).toBe(true);
    expect(
      evaluationResult([
        { name: "required", kind: "browser", passed: false, status: "blocked", required: true, summary: "no browser" },
      ]).passed,
    ).toBe(false);
  });

  it("keeps evidence as references rather than inline payloads", () => {
    const artifact: ExecutionArtifact = {
      kind: "screenshot",
      ref: "artifact://sessions/es_1/screenshot-1.png",
      summary: "checkout confirmation",
      digest: "sha256:abc",
      mediaType: "image/png",
      sizeBytes: 1024,
      retention: "session",
    };
    const bundle: EvidenceBundle = {
      sessionId: "es_1" as ExecutionSessionId,
      artifacts: [artifact],
    };
    expect(bundle.artifacts[0]).not.toHaveProperty("data");
    expectTypeOf<ExecutionArtifact>().not.toHaveProperty("data");
  });

  it("defines planner decisions separately from execution results", () => {
    const check: VerificationSpec = {
      name: "ui",
      kind: "browser",
      provider: "playwright",
      required: true,
    };
    const plan: VerificationPlan = {
      schemaVersion: 1,
      checks: [{ ...check, checkId: "check-ui" }],
      decisions: [
        {
          checkId: "check-ui",
          selected: true,
          required: true,
          signals: ["changed:src/components/Checkout.tsx"],
          reason: "user-visible component changed",
        },
      ],
    };
    expect(plan.checks[0]?.provider).toBe("playwright");
  });

  it("rejects contradictory explicit status at compile time", () => {
    // @ts-expect-error an explicit passed status requires passed: true
    const contradictory: VerificationCheckResult = {
      name: "bad-wire",
      kind: "tests",
      status: "passed",
      passed: false,
      required: true,
      summary: "invalid",
    };
    expect(contradictory.status).toBe("passed");
  });
});
