/**
 * P0-A2 (docs/agentic-os-auto-copilot-plan.md §C.0): the plane side of the agent-user boundary.
 *
 * - `autopilot.operate` is carried only by the operator secret, whose hash alone is stored (G0).
 * - A task created with `runAs: "agent"` reaches a provider only on the Harness single path, with
 *   `policy.runAs` on its request, its worktree in the agent tree, and the native command
 *   verifier never run for it (G21).
 *
 * The provider here is the fake adapter. The real launch through sudo and the wrapper is driven
 * on the host; `packages/adapters/test/claude-agent-launch.test.ts` pins the command line.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ExecutionPolicy, ExecutionResult } from "@agent-plane/core";
import { atomicWriteCredential, credentialPath, readCredential, rotateCredential } from "../src/auth/credential-file.js";
import { generateOperateSecret, hashOperateSecret, operateSecretPath, readOperateSecret, writeOperateSecretHash } from "../src/auth/operate-secret.js";
import { AGENT_USER_DEFAULTS, loadConfig, worktreesRoot, type ResolvedConfig } from "../src/config.js";
import { openDb, type Db } from "../src/db/index.js";
import { AGENT_UNITS_DIR, reapStrayAgentUnits } from "../src/modules/harness/provider-processes.js";
import { CommandVerifier } from "../src/modules/harness/verification-providers.js";
import { createTaskWorktree } from "../src/repo/git.js";
import { buildServer, type BuiltServer } from "../src/server.js";

let root: string, plane: string, repo: string, agentTree: string;
let db: Db | undefined, built: BuiltServer | undefined, config: ResolvedConfig;

const git = (args: string[]) => execFileSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@example.invalid", ...args], { stdio: "pipe" });

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "agent-user-"));
  plane = join(root, "plane");
  repo = join(root, "repo");
  agentTree = join(root, "aos");
  mkdirSync(plane);
  mkdirSync(repo);
  mkdirSync(join(agentTree, "worktrees"), { recursive: true });
  mkdirSync(join(agentTree, "profiles"), { recursive: true });
  // A project whose own test command leaves a mark: if the plane ever runs it, the file exists.
  writeFileSync(join(repo, "package.json"), JSON.stringify({ name: "x", packageManager: "npm@10.9.0", scripts: { test: "node -e \"require('fs').writeFileSync('VERIFIER_RAN','x')\"" } }));
  git(["init", "-q"]);
  git(["add", "."]);
  git(["commit", "-q", "-m", "init"]);
});

afterEach(async () => {
  await built?.app.close();
  built = undefined;
  db?.close();
  db = undefined;
  rmSync(root, { recursive: true, force: true });
});

async function boot(setup: { agentUser?: boolean; fakeDeclares?: boolean; harness?: boolean } = {}): Promise<BuiltServer> {
  config = loadConfig({ AGENT_PLANE_HOME: plane });
  config.assistants = { fake: { provider: "fake", options: setup.fakeDeclares === false ? {} : { agentUser: true } } };
  config.repoAllowlist = [repo];
  config.policy.approvalMode = "auto-approve";
  config.execution.harnessModes.single = setup.harness ?? true;
  if (setup.agentUser !== false) {
    config.execution.agentUser = { ...AGENT_USER_DEFAULTS, profilesRoot: join(agentTree, "profiles"), worktreesRoot: join(agentTree, "worktrees") };
  }
  db = openDb(config.dbPath);
  built = buildServer({ config, db });
  built.registry.init();
  await built.registry.syncAll();
  await built.app.ready();
  return built;
}

const bearer = (secret: string) => ({ authorization: `Bearer ${secret}` });
const ordinary = () => bearer(readCredential(credentialPath(config.dir)).secrets[0]!.secret);
const post = (url: string, headers: Record<string, string>, payload: object = {}) => built!.app.inject({ method: "POST", url, headers, payload });

async function until<T>(read: () => T, ok: (v: T) => boolean, ms = 10_000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = read();
    if (ok(v)) return v;
    if (Date.now() - start > ms) throw new Error(`timed out; last ${JSON.stringify(v)}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

/**
 * Give the task its worktree before the run, with an uncommitted change in it. The fake provider
 * edits nothing, and the plane settles project checks as `skipped:unchanged` for an untouched
 * tree, which would hide whether the command verifier was reached.
 */
async function changedWorktree(taskId: string, runAs?: "agent"): Promise<string> {
  const wt = await createTaskWorktree(repo, taskId, worktreesRoot(config, runAs));
  writeFileSync(join(wt.path, "change.txt"), "edited\n");
  built!.tasks.setWorktree(taskId, wt.path, wt.branch, wt.baseRef);
  return wt.path;
}

interface Settled { policy: ExecutionPolicy; result: ExecutionResult; worktree: string }
async function runToEnd(taskId: string): Promise<Settled> {
  const started = await post(`/api/tasks/${taskId}/start`, ordinary(), { assistantId: "fake" });
  expect(started.statusCode, started.body).toBe(200);
  const row = await until(
    () => db!.prepare("SELECT r.result AS result FROM execution_results r JOIN runs s ON s.id = r.session_id WHERE s.task_id = ?").get(taskId) as { result: string } | undefined,
    (v) => v !== undefined,
  );
  const request = db!.prepare("SELECT policy FROM execution_requests WHERE task_id = ?").get(taskId) as { policy: string };
  const task = db!.prepare("SELECT worktree_path FROM tasks WHERE id = ?").get(taskId) as { worktree_path: string };
  return { policy: JSON.parse(request.policy) as ExecutionPolicy, result: JSON.parse(row!.result) as ExecutionResult, worktree: task.worktree_path };
}

describe("autopilot.operate (G0)", () => {
  it("refuses start, release and resolve to the ordinary credential and leaves stop open to it", async () => {
    await boot();
    for (const route of ["start", "release", "resolve"]) {
      const res = await post(`/api/autopilot/${route}`, ordinary());
      expect(res.statusCode, route).toBe(403);
      expect(res.json()).toEqual({ error: "autopilot.operate required" });
    }
    expect((await post("/api/autopilot/start", {})).statusCode).toBe(401);
    // Stop is authorised for the ordinary credential; 501 is the honest answer until the autopilot exists.
    expect((await post("/api/autopilot/stop", ordinary())).statusCode).toBe(501);
  });

  it("accepts the operator secret, which carries that capability and no other", async () => {
    await boot();
    const { secret, hash } = generateOperateSecret();
    expect((await post("/api/autopilot/start", bearer(secret))).statusCode).toBe(401); // no hash stored yet
    writeOperateSecretHash(operateSecretPath(config.dir), hash);
    for (const route of ["start", "release", "resolve"]) {
      const res = await post(`/api/autopilot/${route}`, bearer(secret));
      expect(res.statusCode, route).toBe(501);
      expect(res.json().error).toBe("autopilot_not_implemented");
    }
    expect((await built!.app.inject({ method: "GET", url: "/api/tasks", headers: bearer(secret) })).statusCode).toBe(403);
    expect((await post("/api/tasks", bearer(secret), { goal: "x" })).statusCode).toBe(403);
    expect((await post("/api/autopilot/stop", bearer(secret))).statusCode).toBe(403);
  });

  it("stores only the hash, mode 0600, and a rotation ends the old secret at once", async () => {
    await boot();
    const path = operateSecretPath(config.dir);
    const first = generateOperateSecret();
    writeOperateSecretHash(path, first.hash);
    const onDisk = readFileSync(path, "utf8");
    expect(onDisk).not.toContain(first.secret);
    expect(readOperateSecret(path)!.hash).toBe(hashOperateSecret(first.secret));
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const second = generateOperateSecret();
    writeOperateSecretHash(path, second.hash);
    expect((await post("/api/autopilot/start", bearer(first.secret))).statusCode).toBe(401);
    expect((await post("/api/autopilot/start", bearer(second.secret))).statusCode).toBe(501);
    expect(() => writeOperateSecretHash(path, "sha256:nothex")).toThrow(/sha256/);
  });

  it("fails closed on a group-readable hash file", async () => {
    await boot();
    const path = operateSecretPath(config.dir);
    const { secret, hash } = generateOperateSecret();
    writeOperateSecretHash(path, hash);
    execFileSync("chmod", ["640", path]);
    expect((await post("/api/autopilot/start", bearer(secret))).statusCode).toBe(401);
  });

  it("cannot be granted by a stored credential", async () => {
    await boot();
    const path = credentialPath(config.dir);
    expect(() => rotateCredential(path, 0, ["tasks.read", "autopilot.operate"])).toThrow(/may not be granted by a stored credential/);
    const file = readCredential(path);
    file.secrets[0]!.capabilities.push("autopilot.operate");
    atomicWriteCredential(path, file);
    expect(() => readCredential(path)).toThrow(/may not be granted by a stored credential/);
  });
});

describe("runAs agent at task creation", () => {
  it("is refused when the workspace has no execution.agentUser", async () => {
    await boot({ agentUser: false });
    const res = await post("/api/tasks", ordinary(), { goal: "x", repoPath: repo, runAs: "agent" });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/needs execution\.agentUser/);
  });

  it("needs a repository and accepts only the one value", async () => {
    await boot();
    expect((await post("/api/tasks", ordinary(), { goal: "x", runAs: "agent" })).json().error).toMatch(/needs a repository/);
    expect((await post("/api/tasks", ordinary(), { goal: "x", repoPath: repo, runAs: "root" })).json().error).toMatch(/accepts only "agent"/);
    const made = await post("/api/tasks", ordinary(), { goal: "x", repoPath: repo, runAs: "agent" });
    expect(made.statusCode).toBe(201);
    expect((db!.prepare("SELECT run_as FROM tasks WHERE id = ?").get(made.json().taskId) as { run_as: string }).run_as).toBe("agent");
  });
});

describe("an agent task through the Harness (G21, fake provider)", () => {
  it("never runs the project's command as the plane user, and says so on the check", async () => {
    await boot();
    const taskId = (await post("/api/tasks", ordinary(), { goal: "agent task", repoPath: repo, runAs: "agent" })).json().taskId as string;
    await changedWorktree(taskId, "agent");
    const { policy, result, worktree } = await runToEnd(taskId);
    expect(policy.runAs).toBe("agent");
    expect(result.outcome).toBe("completed");
    expect(existsSync(join(worktree, "VERIFIER_RAN"))).toBe(false);
    const tests = (result.verification?.checks ?? []).filter((c) => c.kind === "tests");
    expect(tests).toHaveLength(1);
    expect(tests[0]!.status).toBe("skipped");
    expect(tests[0]!.summary).toMatch(/repository commands never run as the plane user/);
  });

  it("creates the worktree in the agent tree, open to the group", async () => {
    await boot();
    const taskId = (await post("/api/tasks", ordinary(), { goal: "agent task", repoPath: repo, runAs: "agent" })).json().taskId as string;
    const { worktree } = await runToEnd(taskId);
    expect(worktree).toBe(join(agentTree, "worktrees", taskId));
    // The agent user is a group member: rwx and setgid on directories, rw on files.
    expect(statSync(worktree).mode & 0o2070).toBe(0o2070);
    expect(statSync(join(worktree, "package.json")).mode & 0o060).toBe(0o060);
  });

  it("control: the same project's command does run for an ordinary task", async () => {
    await boot();
    const taskId = (await post("/api/tasks", ordinary(), { goal: "plain task", repoPath: repo })).json().taskId as string;
    await changedWorktree(taskId);
    const { policy, result, worktree } = await runToEnd(taskId);
    expect(policy.runAs).toBeUndefined();
    expect(worktree.startsWith(config.dir)).toBe(true);
    expect(existsSync(join(worktree, "VERIFIER_RAN"))).toBe(true);
    expect(result.verification?.checks.find((c) => c.kind === "tests")?.status).toBe("passed");
  });

  it("is rejected at Prepare when the adapter cannot launch as the agent user", async () => {
    await boot({ fakeDeclares: false });
    const taskId = (await post("/api/tasks", ordinary(), { goal: "agent task", repoPath: repo, runAs: "agent" })).json().taskId as string;
    const { result } = await runToEnd(taskId);
    expect(result.outcome).toBe("failed");
    expect(result.failure?.kind).toBe("policy_unenforceable");
    expect(result.failure?.message).toMatch(/adapter that can launch as the agent user/);
  });

  it("cannot start off the Harness path or as a parallel comparison", async () => {
    await boot({ harness: false });
    const taskId = built!.tasks.create({ goal: "agent task", repoPath: repo, runAs: "agent" }).taskId;
    const res = await post(`/api/tasks/${taskId}/start`, ordinary(), { assistantId: "fake" });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.body).toMatch(/runs as the agent user and can only start on the Harness single path/);
    expect(db!.prepare("SELECT COUNT(*) AS n FROM runs WHERE task_id = ?").get(taskId)).toEqual({ n: 0 });
    expect((db!.prepare("SELECT worktree_path FROM tasks WHERE id = ?").get(taskId) as { worktree_path: string | null }).worktree_path).toBeNull();
  });
});

describe("CommandVerifier", () => {
  it("returns skipped before it touches the authority when repository commands are refused", async () => {
    let reached = false;
    const authority = { runCommand: async () => { reached = true; return { exitCode: 0, timedOut: false }; } };
    const outcome = await new CommandVerifier().run(
      { name: "test", kind: "tests", command: "npm test", required: true },
      { authority: authority as never, worktreePath: "/nowhere", repositoryCommands: "refused", remainingMs: () => 1000 },
    );
    expect(outcome.status).toBe("skipped");
    expect(reached).toBe(false);
  });
});

describe("reapStrayAgentUnits", () => {
  it("stops the units a dead incarnation recorded, keeps a live one's, and ignores unsafe names", async () => {
    const dir = join(root, "ws");
    mkdirSync(join(dir, AGENT_UNITS_DIR), { recursive: true });
    writeFileSync(join(dir, AGENT_UNITS_DIR, "999999999"), "es_dead-1\nes_dead-1\n../evil\nes_dead-2\n");
    writeFileSync(join(dir, AGENT_UNITS_DIR, String(process.pid)), "es_mine\n");
    const stopped: string[] = [];
    const out = await reapStrayAgentUnits(dir, async (unit) => { stopped.push(unit); });
    expect(out).toEqual(["es_dead-1", "es_dead-2"]);
    expect(stopped).toEqual(["es_dead-1", "es_dead-2"]);
    expect(existsSync(join(dir, AGENT_UNITS_DIR, "999999999"))).toBe(false);
    expect(existsSync(join(dir, AGENT_UNITS_DIR, String(process.pid)))).toBe(true);
  });
});

describe("execution.agentUser config", () => {
  const write = (yaml: string) => {
    const dir = join(plane, "personal");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "config.yaml"), yaml);
  };

  it("takes the setup's defaults from an empty mapping", () => {
    write("execution:\n  harnessModes:\n    single: true\n  agentUser: {}\n");
    expect(loadConfig({ AGENT_PLANE_HOME: plane }).execution.agentUser).toEqual(AGENT_USER_DEFAULTS);
  });

  it("refuses unknown keys, relative paths and a workspace off the Harness path", () => {
    write("execution:\n  harnessModes:\n    single: true\n  agentUser:\n    wraper: /x\n");
    expect(() => loadConfig({ AGENT_PLANE_HOME: plane })).toThrow(/unknown key\(s\): wraper/);
    write("execution:\n  harnessModes:\n    single: true\n  agentUser:\n    wrapper: bin/run-as-agent\n");
    expect(() => loadConfig({ AGENT_PLANE_HOME: plane })).toThrow(/wrapper must be an absolute, normalized path/);
    write("execution:\n  agentUser: {}\n");
    expect(() => loadConfig({ AGENT_PLANE_HOME: plane })).toThrow(/needs execution\.harnessModes\.single/);
  });
});
