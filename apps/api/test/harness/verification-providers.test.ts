import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { VerificationSpec } from "@agent-plane/core";
import { WorkspaceAuthority } from "../../src/modules/harness/workspace-authority.js";
import {
  DEFAULT_VERIFICATION_PROVIDERS,
  VerificationProviderRegistry,
  type VerificationProvider,
} from "../../src/modules/harness/verification-providers.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("VerificationProviderRegistry", () => {
  it("routes every native command kind and preserves check ids", async () => {
    const dir = mkdtempSync(join(tmpdir(), "verification-provider-"));
    dirs.push(dir);
    const authority = new WorkspaceAuthority({ repoAllowlist: [dir], worktreeRoot: dir });
    const kinds = ["tests", "typecheck", "lint", "command", "evaluator"] as const;
    const specs: VerificationSpec[] = kinds.map((kind) => ({
      checkId: `check-${kind}`,
      name: kind,
      kind,
      provider: "native",
      command: "exit 0",
      required: true,
    }));
    const evaluated = await DEFAULT_VERIFICATION_PROVIDERS.run(specs, {
      authority,
      worktreePath: dir,
      remainingMs: () => 5_000,
    });
    expect(evaluated?.evaluation.passed).toBe(true);
    expect(evaluated?.evaluation.checks.map((check) => [check.checkId, check.status])).toEqual(
      kinds.map((kind) => [`check-${kind}`, "passed"]),
    );
  });

  it("distinguishes unavailable workspace, unsupported kinds, and non-native providers", async () => {
    const evaluated = await DEFAULT_VERIFICATION_PROVIDERS.run(
      [
        { name: "unit", kind: "tests", command: "exit 0", required: true },
        { name: "ui", kind: "browser", provider: "playwright", required: true },
        { name: "remote-test", kind: "tests", provider: "external", command: "exit 0", required: true },
        { name: "remote-artifact", kind: "artifact_exists", provider: "external", command: "file", required: true },
      ],
      { remainingMs: () => 5_000 },
    );
    expect(evaluated?.evaluation.checks.map((check) => check.status)).toEqual(["skipped", "blocked", "blocked", "blocked"]);
    expect(evaluated?.evaluation.passed).toBe(false);
  });

  it("uses an explicitly supplied provider registry", async () => {
    const injected: VerificationProvider = {
      id: "test-browser",
      supports: (spec) => spec.kind === "browser",
      run: async () => ({
        status: "passed",
        summary: "injected provider ran",
      }),
    };
    const registry = new VerificationProviderRegistry([injected]);
    const evaluated = await registry.run(
      [{ name: "ui", kind: "browser", provider: "playwright", required: true }],
      { remainingMs: () => 5_000 },
    );
    expect(evaluated).toMatchObject({
      evaluation: { passed: true, checks: [{ status: "passed", summary: "injected provider ran" }] },
    });
  });

  it("contains provider failures and preserves canonical check policy", async () => {
    const registry = new VerificationProviderRegistry([{
      id: "throwing-browser",
      supports: () => true,
      run: async () => { throw new Error("launch failed with token=secret-value"); },
    }]);
    const evaluated = await registry.run(
      [{ checkId: "ui-1", name: "ui", kind: "browser", required: true }],
      { remainingMs: () => 5_000 },
    );
    expect(evaluated?.evaluation).toMatchObject({
      passed: false,
      checks: [{ checkId: "ui-1", name: "ui", kind: "browser", required: true, status: "blocked" }],
    });
  });

  it("returns first-class provider evidence separately from the canonical check", async () => {
    const registry = new VerificationProviderRegistry([{
      id: "browser",
      supports: () => true,
      run: async () => ({
        status: "passed",
        summary: "flow passed",
        artifacts: [{ kind: "screenshot", ref: "artifact://shot-1", summary: "checkout" }],
      }),
    }]);
    const evaluated = await registry.run(
      [{ checkId: "ui-1", name: "ui", kind: "browser", required: true }],
      { remainingMs: () => 5_000 },
    );
    expect(evaluated?.evaluation.checks[0]).toMatchObject({
      checkId: "ui-1", name: "ui", kind: "browser", required: true, status: "passed",
    });
    expect(evaluated?.artifacts).toEqual([
      { kind: "screenshot", ref: "artifact://shot-1", summary: "checkout" },
    ]);
  });

  it("validates, redacts, and caps provider artifacts before persistence", async () => {
    const registry = new VerificationProviderRegistry([{
      id: "browser",
      supports: () => true,
      run: async () => ({
        status: "passed",
        summary: "flow passed",
        artifacts: [
          {
            kind: "browser_report",
            ref: "https://report.invalid/?authorization=Bearer abcdefghijklmnop",
            summary: `access_token=opaque-value ${"x".repeat(2200)}`,
            sizeBytes: 12,
            retention: "session",
          },
          { kind: "not-an-artifact", ref: "inline", summary: "invalid" },
        ] as never,
      }),
    }]);
    const evaluated = await registry.run(
      [{ name: "ui", kind: "browser", required: true }],
      { remainingMs: () => 5_000 },
    );
    expect(evaluated?.artifacts).toHaveLength(1);
    expect(evaluated?.artifacts[0]?.ref).toContain("[REDACTED]");
    expect(evaluated?.artifacts[0]?.summary).not.toContain("opaque-value");
    expect(evaluated?.artifacts[0]?.summary.length).toBeLessThanOrEqual(2000);
    expect(evaluated?.artifacts[0]).toMatchObject({ sizeBytes: 12, retention: "session" });
  });
});
