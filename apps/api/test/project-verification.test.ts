import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { planProjectVerification, snapshotProjectVerification } from "../src/modules/project-verification.js";
import { buildExecutionRequest } from "../src/modules/harness/control-plane-bridge.js";
import { WorkspaceAuthority, WorkspaceError } from "../src/modules/harness/workspace-authority.js";

const snapshot = (value: unknown, lockfiles: string[] = []) => ({ packageJson: JSON.stringify(value), lockfiles });

describe("planProjectVerification", () => {
  it("plans only exact root scripts with fixed package-manager commands", () => {
    const result = planProjectVerification(snapshot({
      packageManager: "pnpm@10.33.0",
      scripts: {
        test: "node malicious-body.js && printenv",
        typecheck: "tsc --noEmit",
        lint: "eslint .",
        "test; touch /tmp/owned": "echo unsafe",
        pretest: "echo also-not-a-check",
      },
    }));

    expect(result.plan).toMatchObject({
      checks: [
        { checkId: "project:test", name: "project test", kind: "tests", provider: "native", command: "pnpm run test", required: true },
        { checkId: "project:typecheck", name: "project typecheck", kind: "typecheck", provider: "native", command: "pnpm run typecheck", required: true },
        { checkId: "project:lint", name: "project lint", kind: "lint", provider: "native", command: "pnpm run lint", required: true },
      ],
    });
    expect(result.plan?.decisions.map((decision) => decision.signals)).toEqual([
      ["explicit:tests"], ["explicit:typecheck"], ["explicit:lint"],
    ]);
  });

  it("threads the trusted plan into the immutable bridge request", () => {
    const verification = [{
      checkId: "project:test",
      name: "project test",
      kind: "tests" as const,
      provider: "native",
      command: "npm run test",
      required: true,
    }];
    const plan = planProjectVerification(snapshot({ packageManager: "npm@11.0.0", scripts: { test: "ignored" } })).plan!;
    const request = buildExecutionRequest({
      taskId: "task_1",
      assistantId: "assistant_1",
      attempt: 1,
      prompt: "do it",
      workdir: "/tmp/repo",
      approvalMode: "prompt-on-escalation",
      maxRuntimeMs: 1000,
      routingDecisionRef: "route_1",
      verification,
      verificationPlan: plan,
    });
    expect(request.verification).toEqual(verification);
    expect(request.verificationPlan).toEqual(plan);
    expect(request.verification).toEqual(plan.checks);
  });

  it("derives executable checks from the canonical plan when inputs disagree", () => {
    const plan = planProjectVerification({
      packageJson: JSON.stringify({ packageManager: "npm@11.0.0", scripts: { test: "anything" } }),
      lockfiles: [],
    }).plan!;
    const request = buildExecutionRequest({
      taskId: "task_1",
      assistantId: "assistant_1",
      attempt: 1,
      prompt: "do it",
      workdir: "/tmp/repo",
      approvalMode: "prompt-on-escalation",
      maxRuntimeMs: 1000,
      routingDecisionRef: "route_1",
      verification: [],
      verificationPlan: plan,
    });
    expect(request.verification).toEqual(plan.checks);
  });

  it("rejects a package.json symlink instead of following it", () => {
    const parent = mkdtempSync(join(tmpdir(), "project-snapshot-"));
    const worktree = join(parent, "worktree");
    const outside = join(parent, "outside.json");
    mkdirSync(worktree);
    writeFileSync(outside, JSON.stringify({ packageManager: "npm@11.0.0", scripts: { test: "unsafe" } }));
    symlinkSync(outside, join(worktree, "package.json"));
    const authority = new WorkspaceAuthority({ repoAllowlist: [], worktreeRoot: parent });
    try {
      expect(() => snapshotProjectVerification(authority, worktree)).toThrow(WorkspaceError);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it("rejects an oversized package.json before reading it", () => {
    const parent = mkdtempSync(join(tmpdir(), "project-snapshot-"));
    const worktree = join(parent, "worktree");
    mkdirSync(worktree);
    writeFileSync(join(worktree, "package.json"), " ".repeat(1024 * 1024 + 1));
    const authority = new WorkspaceAuthority({ repoAllowlist: [], worktreeRoot: parent });
    try {
      expect(() => snapshotProjectVerification(authority, worktree)).toThrow(/exceeds 1048576 bytes/);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it("uses a single recognized lockfile when packageManager is absent", () => {
    expect(planProjectVerification(snapshot({ scripts: { test: "anything" } }, ["yarn.lock"])).plan?.checks[0]?.command)
      .toBe("yarn run test");
  });

  it("does not guess when packageManager is malformed even with a lockfile", () => {
    const result = planProjectVerification(snapshot(
      { packageManager: "pnpm; touch owned", scripts: { test: "ok" } }, ["pnpm-lock.yaml"],
    ));
    expect(result.plan).toBeUndefined();
    expect(result.warnings).toEqual(["project verification skipped: malformed packageManager declaration"]);
  });

  it("does not guess when lockfiles are ambiguous", () => {
    const result = planProjectVerification(snapshot({ scripts: { test: "ok" } }, ["package-lock.json", "pnpm-lock.yaml"]));
    expect(result.plan).toBeUndefined();
    expect(result.warnings).toEqual(["project verification skipped: ambiguous package-manager lockfiles"]);
  });

  it("returns a bounded warning for malformed package JSON", () => {
    expect(planProjectVerification({ packageJson: "{ definitely not JSON", lockfiles: [] })).toEqual({
      warnings: ["project verification skipped: malformed package.json"],
    });
  });

  it("ignores nested manifests and repositories without a root manifest", () => {
    expect(planProjectVerification({ lockfiles: [] })).toEqual({ warnings: [] });
  });
});
