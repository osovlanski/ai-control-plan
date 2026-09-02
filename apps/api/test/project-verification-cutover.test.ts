import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AssistantId, ExecutionResult, VerificationSpec } from "@agent-plane/core";
import { loadConfig } from "../src/config.js";
import { openDb, type Db } from "../src/db/index.js";
import { buildServer, type BuiltServer } from "../src/server.js";

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
    `assistants:\n  fake-project:\n    provider: fake\nrepoAllowlist:\n  - ${JSON.stringify(repo)}\nexecution:\n  harnessSingleMode: true\n`,
  );
  const config = loadConfig({ AGENT_PLANE_HOME: home });
  db = openDb(config.dbPath);
  built = buildServer({ config, db });
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

describe("project verification cutover", () => {
  it("persists and executes a discovered root script on a flag-ON repository task", async () => {
    const task = built.tasks.create({ goal: "change it", repoPath: repo });
    built.tasks.transition(task.taskId, "ROUTING");
    const { runId } = await built.orchestrator.startTask(task.taskId, assistant);

    expect(await built.orchestrator.waitForSettled(task.taskId)).toBe("COMPLETED");
    const request = db.prepare(
      "SELECT verification, verification_plan FROM execution_requests WHERE task_id = ?",
    ).get(task.taskId) as { verification: string; verification_plan: string };
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
  });
});
