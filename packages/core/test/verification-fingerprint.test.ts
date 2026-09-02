import { describe, expect, it } from "vitest";
import { verificationPlanFingerprint, type VerificationPlan } from "../src/index.js";

const plan = (overrides: Partial<VerificationPlan> = {}): VerificationPlan => ({
  schemaVersion: 1,
  planRevisionId: "vpr_1",
  revision: 1,
  checks: [{ checkId: "tests", name: "tests", kind: "tests", command: "pnpm test", required: true }],
  decisions: [{ checkId: "tests", selected: true, required: true, signals: ["changed:src/a.ts"], reason: "source changed" }],
  ...overrides,
});

describe("verification plan revision fingerprint", () => {
  it("is deterministic SHA-256 and ignores only its fingerprint envelope", () => {
    const first = verificationPlanFingerprint(plan());
    const replay = verificationPlanFingerprint(plan({ planFingerprint: first.fingerprint, fingerprintAlgorithm: first.algorithm }));
    expect(first).toEqual(replay);
    expect(first.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(first.fingerprint).toBe("fff12da4d2e18731ed3a4808a91f33a9437cb8a27bf550f87a0dd32804fb20d7");
  });

  it("binds plan identity and executable content", () => {
    expect(verificationPlanFingerprint(plan({ revision: 2 })).fingerprint)
      .not.toBe(verificationPlanFingerprint(plan()).fingerprint);
    expect(verificationPlanFingerprint(plan({ checks: [{ ...plan().checks[0]!, command: "pnpm test --run" }] })).fingerprint)
      .not.toBe(verificationPlanFingerprint(plan()).fingerprint);
  });
});
