import { describe, expect, it } from "vitest";
import type {
  AssistantId,
  RepositoryId,
  TaskId,
  WorkspaceId,
  WorktreeId,
} from "../src/ids.js";
import type { ExecutionRequest } from "../src/execution.js";
import {
  FINGERPRINT_ALGORITHM,
  canonicalJson,
  canonicalRequestProjection,
  digestString,
  requestFingerprint,
} from "../src/fingerprint.js";

function baseRequest(): ExecutionRequest {
  return {
    schemaVersion: 1,
    executionRequestId: "erq_1",
    taskId: "AG-1" as TaskId,
    attempt: 1,
    assistantId: "asst-a" as AssistantId,
    model: { id: "m-1" },
    routingDecisionRef: "rd_1",
    runSpec: {
      taskId: "AG-1" as TaskId,
      prompt: "Do the thing, carefully.",
      workdir: "/tmp/wt-1",
      permissionPolicy: { mode: "prompt-on-escalation" },
      env: { redactionRules: [{ name: "r", pattern: "x" }], maxRuntimeMs: 1000 },
    },
    policy: {
      budget: { enforcement: "advisory" },
      timeout: { hardMs: 60_000 },
      approval: { mode: "prompt-on-escalation" },
      tools: { mode: "audit" },
      checkpoint: { onSoftLimit: true },
      isolation: { required: "partial" },
    },
    context: {},
    verification: [{ name: "unit", kind: "tests", required: true }],
    origin: { kind: "fresh" },
  };
}

const fp = (r: ExecutionRequest) => requestFingerprint(r).fingerprint;

describe("requestFingerprint", () => {
  it("is stable across calls for an identical request", () => {
    expect(fp(baseRequest())).toBe(fp(baseRequest()));
  });

  it("records the algorithm and its version beside the digest", () => {
    const result = requestFingerprint(baseRequest());
    expect(result.algorithm).toBe(FINGERPRINT_ALGORITHM);
    expect(result.fingerprint).toMatch(/^[0-9a-f]{32}$/);
    expect(result.promptDigest).toMatch(/^[0-9a-f]{32}$/);
  });

  it("excludes only observational metadata: correlation and schemaVersion", () => {
    const withCorrelation = baseRequest();
    withCorrelation.correlation = { parentTaskId: "AG-parent" as TaskId, groupId: "g1" };
    expect(fp(withCorrelation)).toBe(fp(baseRequest()));
  });

  it("keeps executionRequestId in the projection (§2 'only exclusions' clause)", () => {
    const { projection } = canonicalRequestProjection(baseRequest());
    expect(projection.executionRequestId).toBe("erq_1");
    const other = baseRequest();
    other.executionRequestId = "erq_2";
    expect(fp(other)).not.toBe(fp(baseRequest()));
  });

  it("changes when any execution-affecting field changes", () => {
    const base = fp(baseRequest());
    const mutate = (f: (r: ExecutionRequest) => void): string => {
      const r = baseRequest();
      f(r);
      return fp(r);
    };
    const changed: Array<[string, (r: ExecutionRequest) => void]> = [
      ["taskId", (r) => (r.taskId = "AG-2" as TaskId)],
      ["attempt", (r) => (r.attempt = 2)],
      ["assistantId", (r) => (r.assistantId = "asst-b" as AssistantId)],
      ["model", (r) => (r.model = { id: "m-2" })],
      ["compositionRevisionId", (r) => (r.compositionRevisionId = "cr_1")],
      ["routingDecisionRef", (r) => (r.routingDecisionRef = "rd_2")],
      ["runSpec.taskId", (r) => (r.runSpec.taskId = "AG-mismatch" as TaskId)],
      ["runSpec.workdir", (r) => (r.runSpec.workdir = "/tmp/other")],
      ["runSpec.model", (r) => (r.runSpec.model = { id: "rs-m2" })],
      ["runSpec.permissionPolicy", (r) => (r.runSpec.permissionPolicy = { mode: "read-only" })],
      ["runSpec.env.maxRuntimeMs", (r) => (r.runSpec.env.maxRuntimeMs = 2000)],
      ["runSpec.env.redactionRules", (r) => (r.runSpec.env.redactionRules = [])],
      ["policy.budget.enforcement", (r) => (r.policy.budget.enforcement = "bounded")],
      ["policy.budget.maxTokens", (r) => (r.policy.budget.maxTokens = 5000)],
      ["policy.timeout.hardMs", (r) => (r.policy.timeout.hardMs = 30_000)],
      ["policy.timeout.idleMs", (r) => (r.policy.timeout.idleMs = 5_000)],
      ["policy.approval.mode", (r) => (r.policy.approval = { mode: "auto-approve" })],
      ["policy.tools.mode", (r) => (r.policy.tools = { mode: "preventive" })],
      ["policy.tools.deny", (r) => (r.policy.tools = { mode: "audit", deny: ["shell"] })],
      ["policy.checkpoint.periodicMs", (r) => (r.policy.checkpoint.periodicMs = 60_000)],
      ["policy.isolation.required", (r) => (r.policy.isolation.required = "full")],
      ["verification", (r) => (r.verification = [])],
      ["verification[].required", (r) => (r.verification = [{ name: "unit", kind: "tests", required: false }])],
      ["verification[].checkId", (r) =>
        (r.verification = [{ checkId: "check-unit", name: "unit", kind: "tests", required: true }])],
      ["verification[].provider", (r) =>
        (r.verification = [{ name: "unit", kind: "tests", provider: "native", required: true }])],
      ["verificationPlan", (r) =>
        (r.verificationPlan = {
          schemaVersion: 1,
          checks: [{ checkId: "unit", name: "unit", kind: "tests", required: true }],
          decisions: [{ checkId: "unit", selected: true, required: true, signals: ["explicit:tests"], reason: "explicit:tests" }],
        })],
      ["origin", (r) => (r.origin = { kind: "handoff", envelopeId: "env_1" })],
      ["context.priorCheckpointId", (r) => (r.context = { priorCheckpointId: "ckpt_1" })],
      ["context.target", (r) =>
        (r.context = {
          target: {
            kind: "worktree",
            workspaceId: "ws-1" as WorkspaceId,
            repositoryId: "repo-1" as RepositoryId,
            worktreeId: "wt-1" as WorktreeId,
          },
        })],
      ["context.worktree", (r) =>
        (r.context = {
          worktree: { repoPath: "/r", branch: "b", worktreePath: "/wt", baseRef: "ref" },
        })],
    ];
    for (const [label, fn] of changed) {
      expect(mutate(fn), label).not.toBe(base);
    }
  });

  it("fingerprints each stable target identity independently", () => {
    const request = baseRequest();
    request.context.target = {
      kind: "worktree",
      workspaceId: "ws-1" as WorkspaceId,
      repositoryId: "repo-1" as RepositoryId,
      worktreeId: "wt-1" as WorktreeId,
    };
    const base = fp(request);

    const mutateTarget = (field: "workspaceId" | "repositoryId" | "worktreeId", value: string) => {
      const changed = structuredClone(request);
      changed.context.target = { ...request.context.target!, [field]: value } as typeof request.context.target;
      return fp(changed);
    };

    expect(mutateTarget("workspaceId", "ws-2")).not.toBe(base);
    expect(mutateTarget("repositoryId", "repo-2")).not.toBe(base);
    expect(mutateTarget("worktreeId", "wt-2")).not.toBe(base);
  });

  it("distinguishes repository targets from allocated worktree targets", () => {
    const repository = baseRequest();
    repository.context.target = {
      kind: "repository",
      workspaceId: "ws-1" as WorkspaceId,
      repositoryId: "repo-1" as RepositoryId,
    };
    const worktree = baseRequest();
    worktree.context.target = {
      kind: "worktree",
      workspaceId: "ws-1" as WorkspaceId,
      repositoryId: "repo-1" as RepositoryId,
      worktreeId: "wt-1" as WorktreeId,
    };

    expect(fp(repository)).not.toBe(fp(worktree));
  });

  it("changes when the prompt changes, via the prompt digest", () => {
    const r = baseRequest();
    r.runSpec.prompt = "A completely different instruction.";
    const changed = requestFingerprint(r);
    const original = requestFingerprint(baseRequest());
    expect(changed.promptDigest).not.toBe(original.promptDigest);
    expect(changed.fingerprint).not.toBe(original.fingerprint);
  });

  it("never puts the raw prompt into the canonical projection", () => {
    const { projection } = canonicalRequestProjection(baseRequest());
    const runSpec = projection.runSpec as Record<string, unknown>;
    expect(runSpec.promptDigest).toBeDefined();
    expect(runSpec.prompt).toBeUndefined();
    expect(canonicalJson(projection)).not.toContain("Do the thing");
  });
});

describe("canonicalJson", () => {
  it("is insensitive to key insertion order", () => {
    expect(canonicalJson({ b: 1, a: { d: 4, c: 3 } })).toBe(canonicalJson({ a: { c: 3, d: 4 }, b: 1 }));
  });

  it("preserves array order", () => {
    expect(canonicalJson([3, 1, 2])).toBe("[3,1,2]");
  });

  it("omits undefined members", () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}');
  });
});

describe("digestString", () => {
  it("is deterministic and 128-bit hex", () => {
    expect(digestString("hello")).toBe(digestString("hello"));
    expect(digestString("hello")).toMatch(/^[0-9a-f]{32}$/);
    expect(digestString("hello")).not.toBe(digestString("world"));
  });
});
