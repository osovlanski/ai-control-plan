import { describe, expect, it } from "vitest";
import type { VerificationCapability } from "../src/verification-planner.js";
import { planVerification, reviseVerificationPlan } from "../src/verification-planner.js";

const capabilities: VerificationCapability[] = [
  { checkId: "tests", name: "unit", kind: "tests", command: "pnpm test", required: true },
  { checkId: "types", name: "typecheck", kind: "typecheck", command: "pnpm typecheck", required: true },
  { checkId: "lint", name: "lint", kind: "lint", command: "pnpm lint", required: false },
  { checkId: "ui", name: "browser", kind: "browser", provider: "playwright", required: true },
  { checkId: "api", name: "api", kind: "api", provider: "native-http", required: true },
  { checkId: "eval", name: "evaluation", kind: "evaluator", required: false },
  { checkId: "review", name: "review", kind: "review", required: true },
];

describe("VerificationPlanner", () => {
  it.each([
    ["component", ["src/components/Checkout.tsx"], ["tests", "types", "lint", "ui"]],
    ["styles", ["src/styles/checkout.css"], ["ui"]],
    ["API route", ["src/api/orders.ts"], ["tests", "types", "lint", "api"]],
    ["OpenAPI", ["spec/openapi.yaml"], ["api"]],
  ])("selects deterministic checks for %s changes", (_label, changedFiles, expected) => {
    const plan = planVerification({ changedFiles, capabilities });
    expect(plan.checks.map((check) => check.checkId)).toEqual(expected);
  });

  it("selects browser verification from acceptance criteria without mentioning Playwright", () => {
    const plan = planVerification({
      changedFiles: [],
      acceptanceCriteria: ["The checkout page remains responsive and accessible"],
      capabilities,
    });
    expect(plan.checks.map((check) => check.checkId)).toContain("ui");
  });

  it("selects metadata and explicitly required checks", () => {
    const plan = planVerification({
      changedFiles: [],
      taskMetadata: { evaluation: true, review: true },
      explicitRequiredKinds: ["api"],
      capabilities,
    });
    expect(plan.checks.map((check) => check.checkId)).toEqual(["api", "eval", "review"]);
    expect(plan.checks.find((check) => check.checkId === "api")?.required).toBe(true);
  });

  it("reports a required kind with no trusted capability", () => {
    const plan = planVerification({
      changedFiles: [],
      explicitRequiredKinds: ["browser"],
      capabilities: capabilities.filter((capability) => capability.kind !== "browser"),
    });
    expect(plan.unmetRequirements).toEqual(["browser"]);
  });

  it("rejects duplicate capability identities", () => {
    expect(() =>
      planVerification({ changedFiles: [], capabilities: [capabilities[0]!, capabilities[0]!] }),
    ).toThrow("duplicate verification checkId");
  });

  it("is deterministic for identical inputs", () => {
    const input = { changedFiles: ["src/components/App.tsx"], capabilities };
    expect(JSON.stringify(planVerification(input))).toBe(JSON.stringify(planVerification(input)));
  });

  it("adds post-change checks without removing an earlier requirement", () => {
    const original = planVerification({ changedFiles: ["src/api/orders.ts"], capabilities });
    const after = planVerification({ changedFiles: ["src/components/Orders.tsx"], capabilities });
    const revised = reviseVerificationPlan(original, after);
    expect(revised.checks.map((check) => check.checkId)).toEqual(["tests", "types", "lint", "api", "ui"]);
    expect(revised.decisions.find((decision) => decision.checkId === "api")?.selected).toBe(true);
  });

  it("cannot downgrade required checks or mutate their executable identity", () => {
    const original = planVerification({ changedFiles: ["src/api/orders.ts"], capabilities });
    const downgraded = {
      ...original,
      checks: original.checks.map((check) => ({ ...check, required: false })),
      decisions: original.decisions.map((decision) => ({ ...decision, required: false })),
    };
    const merged = reviseVerificationPlan(original, downgraded);
    expect(merged.checks.find((check) => check.checkId === "api")?.required).toBe(true);
    expect(merged.decisions.find((decision) => decision.checkId === "api")?.required).toBe(true);

    const mutated = {
      ...original,
      checks: original.checks.map((check) =>
        check.checkId === "api" ? { ...check, provider: "untrusted-replacement" } : check,
      ),
    };
    expect(() => reviseVerificationPlan(original, mutated)).toThrow("identity changed");
  });

  it("resolves an unmet requirement when a later plan supplies it", () => {
    const withoutBrowser = capabilities.filter((capability) => capability.kind !== "browser");
    const original = planVerification({
      changedFiles: [],
      explicitRequiredKinds: ["browser"],
      capabilities: withoutBrowser,
    });
    const supplied = planVerification({
      changedFiles: [],
      explicitRequiredKinds: ["browser"],
      capabilities,
    });
    const revised = reviseVerificationPlan(original, supplied);
    expect(revised.unmetRequirements).toBeUndefined();
    expect(revised.checks.map((check) => check.checkId)).toContain("ui");
  });

  it("upgrades a newly available advisory capability when it satisfies an earlier requirement", () => {
    const withoutLint = capabilities.filter((capability) => capability.kind !== "lint");
    const original = planVerification({
      changedFiles: [],
      explicitRequiredKinds: ["lint"],
      capabilities: withoutLint,
    });
    const suppliedAdvisory = planVerification({ changedFiles: ["src/domain.ts"], capabilities });
    const revised = reviseVerificationPlan(original, suppliedAdvisory);
    expect(revised.unmetRequirements).toBeUndefined();
    expect(revised.checks.find((check) => check.checkId === "lint")?.required).toBe(true);
    expect(revised.decisions.find((decision) => decision.checkId === "lint")?.required).toBe(true);
  });

  it("rejects identity reuse by a capability that was originally unselected", () => {
    const original = planVerification({ changedFiles: [], capabilities });
    const changedRegistry = capabilities.map((capability) =>
      capability.checkId === "ui"
        ? { ...capability, kind: "api" as const, provider: "replacement" }
        : capability,
    );
    const revised = planVerification({
      changedFiles: [],
      explicitRequiredKinds: ["api"],
      capabilities: changedRegistry,
    });
    expect(() => reviseVerificationPlan(original, revised)).toThrow("capability identity changed");
  });
});
