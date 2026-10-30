import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AssistantId, ExecutionRequest, TaskId } from "@agent-plane/core";
import { openDb, type Db } from "../../src/db/index.js";
import { SessionStore } from "../../src/modules/harness/session-store.js";
import { VerificationStore } from "../../src/modules/harness/verification-store.js";
import { WorkspaceAuthority } from "../../src/modules/harness/workspace-authority.js";
import {
  VerificationCoordinator,
  type VerificationCoordinatorCheckpoints,
} from "../../src/modules/verification-coordinator.js";
import { planProjectVerification, snapshotProjectVerification } from "../../src/modules/project-verification.js";

let dir: string;
let worktree: string;
let db: Db;

function request(id = "erq_1", taskId = "AG-1"): ExecutionRequest {
  return {
    schemaVersion: 1,
    executionRequestId: id,
    taskId: taskId as TaskId,
    attempt: 1,
    assistantId: "a1" as AssistantId,
    routingDecisionRef: "rd_1",
    runSpec: { taskId: taskId as TaskId, prompt: "change source", workdir: worktree,
      permissionPolicy: { mode: "auto-approve" }, env: { redactionRules: [], maxRuntimeMs: 10_000 } },
    policy: { budget: { enforcement: "advisory" }, timeout: { hardMs: 10_000 },
      approval: { mode: "auto-approve" }, tools: { mode: "audit" },
      checkpoint: { onSoftLimit: true }, isolation: { required: "ambient" } },
    context: { worktree: { repoPath: worktree, worktreePath: worktree, branch: "task/test", baseRef: "HEAD" } },
    verification: [{ checkId: "request:review", name: "review", kind: "review", required: true }],
    origin: { kind: "fresh" },
  };
}

function createSession(req: ExecutionRequest): string {
  db.prepare("INSERT OR IGNORE INTO tasks (id,goal,envelope,created_at,updated_at) VALUES (?, 'g', '{}', 't', 't')")
    .run(req.taskId);
  const sessions = new SessionStore(db);
  sessions.recordRequest(req);
  return sessions.createSession(req.executionRequestId).sessionId;
}

function coordinator(
  changedFiles: string[],
  checkpointOverride?: VerificationCoordinatorCheckpoints,
  unchanged?: () => Promise<boolean>,
) {
  const checkpoints: VerificationCoordinatorCheckpoints = checkpointOverride ?? {
    create: async () => ({ changedFiles }),
  };
  const authority = new WorkspaceAuthority({ repoAllowlist: [dir], worktreeRoot: dir });
  return new VerificationCoordinator(new VerificationStore(db), checkpoints, authority, unchanged);
}

/** The request the orchestrator builds: the project plan is bound at start. */
function projectRequest(id = "erq_p", taskId = "AG-p"): ExecutionRequest {
  const authority = new WorkspaceAuthority({ repoAllowlist: [dir], worktreeRoot: dir });
  const plan = planProjectVerification(snapshotProjectVerification(authority, worktree)).plan!;
  return { ...request(id, taskId), verification: plan.checks, verificationPlan: plan };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "verification-coordinator-"));
  worktree = join(dir, "repo");
  mkdirSync(worktree);
  writeFileSync(join(worktree, "package.json"), JSON.stringify({
    packageManager: "pnpm@10.0.0",
    scripts: { test: "vitest", typecheck: "tsc --noEmit", lint: "eslint ." },
  }));
  db = openDb(join(dir, "test.db"));
  db.prepare("INSERT INTO assistants (id, provider) VALUES ('a1','fake')").run();
});

afterEach(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });

describe("VerificationCoordinator", () => {
  it("keeps an unchanged plan and prepares idempotently", async () => {
    const req = request();
    const sid = createSession(req);
    let checkpoints = 0;
    const subject = coordinator([], {
      create: async () => { checkpoints += 1; return { changedFiles: [] }; },
    });
    const first = await subject.prepare(sid, req);
    const second = await subject.prepare(sid, req);
    expect(second).toEqual(first);
    expect(checkpoints).toBe(1);
    expect(first.planRevisionId).toBe(`vpr_${sid}_2`);
    expect(first.checks.map((check) => check.checkId)).toEqual(["request:review"]);
  });

  it("adds trusted checks after source changes without removing accepted checks", async () => {
    const req = request();
    const sid = createSession(req);
    const prepared = await coordinator(["src/widget.ts"]).prepare(sid, req);
    expect(prepared.planRevisionId).toBe(`vpr_${sid}_2`);
    expect(prepared.checks.map((check) => check.checkId)).toEqual([
      "request:review", "project:test", "project:typecheck", "project:lint",
    ]);
    expect(prepared.checks.every((check) => check.required)).toBe(true);
  });

  it("persists a required blocked preflight when discovery cannot run", async () => {
    const req = request();
    const sid = createSession(req);
    const subject = coordinator([], { create: async () => { throw new Error("checkpoint sk-secret-value failed"); } });
    const prepared = await subject.prepare(sid, req);
    expect(prepared.preflightFailure).toMatchObject({
      checkId: "preflight:planning", required: true, status: "blocked", passed: false,
    });
    expect(prepared.preflightFailure?.summary).not.toContain("sk-secret-value");
    const token = "runner";
    subject.claim(prepared, token);
    const completed = subject.complete(prepared, token, { passed: false, checks: [prepared.preflightFailure!] }, []);
    expect(completed.state).toBe("completed");
    expect(completed.evaluation?.passed).toBe(false);
  });

  it("isolates parallel sessions and rejects a swapped binding", async () => {
    const left = request("erq_left", "AG-left");
    const right = request("erq_right", "AG-right");
    const leftSid = createSession(left);
    const rightSid = createSession(right);
    const subject = coordinator(["src/x.ts"]);
    const [leftPrepared, rightPrepared] = await Promise.all([
      subject.prepare(leftSid, left), subject.prepare(rightSid, right),
    ]);
    expect(leftPrepared.planRevisionId).not.toBe(rightPrepared.planRevisionId);
    expect(() => subject.claim({ ...leftPrepared, sessionId: rightSid }, "runner"))
      .toThrow("revision binding mismatch");
  });

  it("skips project checks with a recorded reason when the run changed nothing", async () => {
    const req = projectRequest();
    const sid = createSession(req);
    const subject = coordinator([], undefined, async () => true);
    const prepared = await subject.prepare(sid, req);
    expect(prepared.checks).toEqual([]);
    expect(prepared.outcomes?.map((o) => [o.checkId, o.status, o.required])).toEqual([
      ["project:test", "skipped", false], ["project:typecheck", "skipped", false], ["project:lint", "skipped", false],
    ]);
    expect(prepared.outcomes?.[0]?.summary).toContain("changed nothing relative to its base");
    // A replayed prepare (crash recovery) settles them the same way, from the stored decision.
    expect(await subject.prepare(sid, req)).toEqual(prepared);
    subject.claim(prepared, "runner");
    const completed = subject.complete(prepared, "runner", { passed: true, checks: [] }, []);
    expect(completed.evaluation?.passed).toBe(true);
    expect(completed.evaluation?.checks.map((check) => check.status)).toEqual(["skipped", "skipped", "skipped"]);
  });

  it("verifies as before when the change probe cannot prove the run unchanged", async () => {
    const req = projectRequest();
    const sid = createSession(req);
    const prepared = await coordinator([], undefined, async () => false).prepare(sid, req);
    expect(prepared.checks.map((check) => check.checkId)).toEqual(["project:test", "project:typecheck", "project:lint"]);
    expect(prepared.outcomes).toBeUndefined();
  });

  it("does not consult the change probe when the checkpoint saw changed files", async () => {
    const req = projectRequest();
    const sid = createSession(req);
    let probed = false;
    const prepared = await coordinator(["src/widget.ts"], undefined, async () => { probed = true; return true; })
      .prepare(sid, req);
    expect(probed).toBe(false);
    expect(prepared.checks).toHaveLength(3);
  });

  it("blocks project checks, keeping them required, when the lockfile has no installed tree", async () => {
    writeFileSync(join(worktree, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
    const req = projectRequest();
    const sid = createSession(req);
    const subject = coordinator(["src/widget.ts"], undefined, async () => false);
    const prepared = await subject.prepare(sid, req);
    expect(prepared.checks).toEqual([]);
    expect(prepared.outcomes).toHaveLength(3);
    expect(prepared.outcomes?.[0]).toMatchObject({
      checkId: "project:test", status: "blocked", required: true, passed: false,
      summary: "blocked: dependencies not installed: pnpm-lock.yaml present, node_modules missing; " +
        "run `pnpm install --frozen-lockfile` in the worktree to install them",
    });
    subject.claim(prepared, "runner");
    const completed = subject.complete(prepared, "runner", { passed: true, checks: [] }, []);
    expect(completed.evaluation?.passed).toBe(false);
  });

  it("runs project checks when the lockfile's tree is installed", async () => {
    writeFileSync(join(worktree, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
    mkdirSync(join(worktree, "node_modules"));
    const req = projectRequest();
    const sid = createSession(req);
    const prepared = await coordinator(["src/widget.ts"], undefined, async () => false).prepare(sid, req);
    expect(prepared.checks).toHaveLength(3);
    expect(prepared.outcomes).toBeUndefined();
  });
});
