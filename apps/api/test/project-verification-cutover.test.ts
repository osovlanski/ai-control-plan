import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AssistantId, ExecutionResult, VerificationSpec } from "@agent-plane/core";
import { loadConfig } from "../src/config.js";
import { openDb, type Db } from "../src/db/index.js";
import { buildServer, type BuiltServer } from "../src/server.js";
import { RepositoryIdentityRegistry } from "../src/repo/identity-registry.js";
import { credentialPath, readCredential } from "../src/auth/credential-file.js";

let home: string;
let repo: string;
let db: Db;
let built: BuiltServer;
const assistant = "fake-project" as AssistantId;

const git = (...args: string[]): void => {
  execFileSync("git", ["-C", repo, ...args], { stdio: "ignore" });
};

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), "project-verification-home-"));
  repo = mkdtempSync(join(tmpdir(), "project-verification-repo-"));
  writeFileSync(join(repo, "package.json"), JSON.stringify({
    packageManager: "npm@11.0.0",
    scripts: { test: "node -e \"process.exit(0)\"" },
  }));
  git("init", "-b", "main");
  git("config", "user.email", "test@example.invalid");
  git("config", "user.name", "Test");
  git("add", "package.json");
  git("commit", "-m", "fixture");

  mkdirSync(join(home, "personal"), { recursive: true });
  writeFileSync(
    join(home, "personal", "config.yaml"),
    `assistants:\n  fake-project:\n    provider: fake\nrepoAllowlist:\n  - ${JSON.stringify(repo)}\nexecution:\n  harnessModes:\n    single: true\npolicy:\n  approvalMode: prompt-on-escalation\n`,
  );
  const config = loadConfig({ AGENT_PLANE_HOME: home });
  db = openDb(config.dbPath);
  built = buildServer({ config, db });
  const inject = built.app.inject.bind(built.app); const authorization = `Bearer ${readCredential(credentialPath(config.dir)).secrets[0]!.secret}`;
  built.app.inject = ((options: Record<string, unknown> = {}) => inject({ ...options, headers: { ...(options.headers as Record<string, string> | undefined), authorization } } as never)) as typeof built.app.inject;
  built.registry.init();
  await built.registry.syncAll();
});

afterEach(async () => {
  await built.orchestrator.shutdown();
  await built.app.close();
  db.close();
  rmSync(home, { recursive: true, force: true });
  rmSync(repo, { recursive: true, force: true });
});

async function pollFor<T>(read: () => T | undefined): Promise<T> {
  for (let i = 0; i < 400; i++) {
    const value = read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("timed out");
}

/** The fake never writes, so a "writing" run pauses on an approval while the test writes for it. */
async function runWriting(write: (worktreePath: string) => void, watch?: (taskId: string) => void): Promise<{ taskId: string; runId: string }> {
  const task = built.tasks.create({ goal: "change it [FAKE:APPROVAL]", repoPath: repo });
  watch?.(task.taskId);
  built.tasks.transition(task.taskId, "ROUTING");
  const { runId } = await built.orchestrator.startTask(task.taskId, assistant);
  const requestId = await pollFor(() => {
    const row = db.prepare("SELECT payload FROM events WHERE run_id = ? AND type = 'approval.requested'")
      .get(runId) as { payload: string } | undefined;
    return row ? (JSON.parse(row.payload) as { requestId: string }).requestId : undefined;
  });
  const { worktree_path } = db.prepare("SELECT worktree_path FROM tasks WHERE id = ?")
    .get(task.taskId) as { worktree_path: string };
  write(worktree_path);
  await built.orchestrator.respondApproval(task.taskId, requestId, true);
  return { taskId: task.taskId, runId };
}

function verificationOf(runId: string): ExecutionResult["verification"] {
  const row = db.prepare("SELECT result FROM execution_results WHERE session_id = ?").get(runId) as { result: string };
  return (JSON.parse(row.result) as ExecutionResult).verification;
}

/** The orchestrator's notices go to the task bus only; collect them for one task. */
function noticesOf(taskId: string): string[] {
  const texts: string[] = [];
  built.bus.subscribe(taskId, (payload) => {
    if (payload.kind === "notice" && payload.notice) texts.push(payload.notice.text);
  });
  return texts;
}

function addLockfile(): void {
  writeFileSync(join(repo, "package-lock.json"), JSON.stringify({ name: "fixture", lockfileVersion: 3, packages: {} }));
  git("add", "package-lock.json");
  git("commit", "-m", "lockfile");
}

describe("project verification cutover", () => {
  it("skips project verification for a run that changed nothing, and completes", async () => {
    const task = built.tasks.create({ goal: "read-only question", repoPath: repo });
    built.tasks.transition(task.taskId, "ROUTING");
    const { runId } = await built.orchestrator.startTask(task.taskId, assistant);

    expect(await built.orchestrator.waitForSettled(task.taskId)).toBe("COMPLETED");
    expect(verificationOf(runId)).toEqual({
      passed: true,
      checks: [expect.objectContaining({
        checkId: "project:test",
        status: "skipped",
        required: false,
        summary: expect.stringContaining("changed nothing relative to its base"),
      })],
    });
    const revision = db.prepare(
      "SELECT plan FROM verification_plan_revisions WHERE session_id = ? AND revision = 2",
    ).get(runId) as { plan: string };
    expect(JSON.parse(revision.plan)).toMatchObject({
      checks: [],
      decisions: [{ checkId: "project:test", selected: false, signals: ["explicit:tests", "skipped:unchanged"] }],
    });
  });

  it("blocks, without running, a changed run whose lockfile has no installed dependencies", async () => {
    addLockfile();
    let notices: string[] = [];
    const { taskId, runId } = await runWriting((worktree) => writeFileSync(join(worktree, "note.txt"), "x\n"), (id) => { notices = noticesOf(id); });

    expect(await built.orchestrator.waitForSettled(taskId)).toBe("WAITING_INPUT");
    expect(notices).toContain("verification blocked — run `npm ci` in the worktree to install dependencies — awaiting your call");
    expect(notices.join("\n")).not.toMatch(/verification failed/);
    expect(verificationOf(runId)).toEqual({
      passed: false,
      checks: [expect.objectContaining({
        checkId: "project:test",
        status: "blocked",
        required: true,
        summary: "blocked: dependencies not installed: package-lock.json present, node_modules missing; " +
          "run `npm ci` in the worktree to install them",
      })],
    });
  });

  it("runs the checks of a changed run once its dependencies are installed", async () => {
    addLockfile();
    const { taskId, runId } = await runWriting((worktree) => {
      mkdirSync(join(worktree, "node_modules"));
      writeFileSync(join(worktree, "note.txt"), "x\n");
    });

    expect(await built.orchestrator.waitForSettled(taskId)).toBe("COMPLETED");
    expect(verificationOf(runId)).toMatchObject({
      passed: true,
      checks: [{ checkId: "project:test", status: "passed", required: true }],
    });
  });

  it("still fails a changed run whose check ran and failed", async () => {
    writeFileSync(join(repo, "package.json"), JSON.stringify({
      packageManager: "npm@11.0.0",
      scripts: { test: "node -e \"process.exit(3)\"" },
    }));
    git("commit", "-am", "failing test");
    let notices: string[] = [];
    const { taskId, runId } = await runWriting((worktree) => writeFileSync(join(worktree, "note.txt"), "x\n"), (id) => { notices = noticesOf(id); });

    expect(await built.orchestrator.waitForSettled(taskId)).toBe("WAITING_INPUT");
    expect(notices).toContain("verification failed — awaiting your call");
    expect(verificationOf(runId)).toMatchObject({
      passed: false,
      checks: [{ checkId: "project:test", status: "failed", required: true }],
    });
  });

  it("persists and executes a discovered root script on a flag-ON repository task", async () => {
    const { taskId, runId } = await runWriting((worktree) => writeFileSync(join(worktree, "note.txt"), "x\n"));
    const task = { taskId };

    expect(await built.orchestrator.waitForSettled(taskId)).toBe("COMPLETED");
    const request = db.prepare(
      `SELECT verification, verification_plan, target_kind, workspace_id, repository_id, worktree_id
         FROM execution_requests WHERE task_id = ?`,
    ).get(task.taskId) as {
      verification: string;
      verification_plan: string;
      target_kind: string;
      workspace_id: string;
      repository_id: string;
      worktree_id: string;
    };
    expect(request).toMatchObject({
      target_kind: "worktree",
      workspace_id: expect.stringMatching(/^ws_/),
      repository_id: expect.stringMatching(/^repo_/),
      worktree_id: expect.stringMatching(/^wt_/),
    });
    expect(JSON.parse(request.verification) as VerificationSpec[]).toEqual([
      {
        checkId: "project:test",
        name: "project test",
        kind: "tests",
        provider: "native",
        command: "npm run test",
        required: true,
      },
    ]);
    expect(JSON.parse(request.verification_plan)).toMatchObject({
      schemaVersion: 1,
      checks: [{ checkId: "project:test", command: "npm run test" }],
      decisions: [{ checkId: "project:test", selected: true, signals: ["explicit:tests"] }],
    });
    const resultRow = db.prepare("SELECT result FROM execution_results WHERE session_id = ?").get(runId) as {
      result: string;
    };
    const result = JSON.parse(resultRow.result) as ExecutionResult;
    expect(result.verification).toMatchObject({
      passed: true,
      checks: [{ checkId: "project:test", status: "passed", required: true }],
    });

    const detail = await built.app.inject({ method: "GET", url: `/api/sessions/${runId}` });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().request.target).toEqual({
      kind: "worktree",
      workspaceId: request.workspace_id,
      repositoryId: request.repository_id,
      worktreeId: request.worktree_id,
    });

    const sourceIdentity = await new RepositoryIdentityRegistry(db).resolve(repo);
    expect(request.repository_id).toBe(sourceIdentity.repositoryId);
    expect(request.worktree_id).not.toBe(sourceIdentity.worktreeId);
  });
});
