/**
 * Continuing a compare after its candidates settle. The comparison made the shared branch
 * `task/<id>` (never checked out) and one sibling branch and worktree per candidate under
 * `worktrees/<id>/`. A manual handoff continues as one single-mode run: on the task branch
 * without a pick, on the picked candidate's branch with one. A successor start that throws
 * parks the task in WAITING_INPUT on both the Harness and the legacy path.
 */
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSpec } from "@agent-plane/core";
import { bootRig, reaches, type Rig } from "./helpers/composer-cockpit.js";

let rig: Rig | undefined;
afterEach(async () => {
  vi.restoreAllMocks();
  await rig?.close();
  rig = undefined;
});

const ASSISTANTS = { "fake-a": { provider: "fake" }, "fake-b": { provider: "fake" } } as const;
const GOAL = "Add a typed helper to the TypeScript parser module";
const legacy = (c: Rig["config"]) => { c.execution.harnessModes.single = false; };

interface RunRow { id: string; assistant_id: string; branch: string | null; worktree_path: string | null; composition_revision_id: string | null; execution_request_id: string | null }
const runsOf = (taskId: string) => rig!.db.prepare(
  "SELECT id, assistant_id, branch, worktree_path, composition_revision_id, execution_request_id FROM runs WHERE task_id = ? ORDER BY started_at, rowid",
).all(taskId) as RunRow[];
const branches = () => execFileSync("git", ["-C", rig!.repo, "branch", "--format=%(refname:short) %(objectname)"], { encoding: "utf8" }).trim().split("\n").sort();
const worktreeBranches = () => execFileSync("git", ["-C", rig!.repo, "worktree", "list", "--porcelain"], { encoding: "utf8" })
  .split("\n").filter((l) => l.startsWith("branch ")).map((l) => l.slice("branch refs/heads/".length)).sort();
const revisionSpec = (revisionId: string | null) =>
  JSON.parse((rig!.db.prepare("SELECT spec_json FROM agent_specs WHERE composition_revision_id = ?").get(revisionId) as { spec_json: string }).spec_json) as AgentSpec;
/** Notices go to the task's event bus only. */
const collectNotices = (taskId: string) => {
  const seen: string[] = [];
  rig!.built.bus.subscribe(taskId, (p) => { if (p.kind === "notice") seen.push(p.notice!.text); });
  return seen;
};

async function settledCompare() {
  const taskId = rig!.built.tasks.create({ goal: GOAL, repoPath: rig!.repo }).taskId;
  const res = await rig!.built.app.inject({ method: "POST", url: `/api/tasks/${taskId}/parallel`, headers: rig!.auth(), payload: { assistants: ["fake-a", "fake-b"], mode: "compare" } });
  expect(res.statusCode, res.body).toBe(200);
  expect(await rig!.built.orchestrator.waitForSettled(taskId)).toBe("WAITING_INPUT");
  expect(rig!.built.tasks.get(taskId)!.pause_kind).toBe("comparison_pending");
  return taskId;
}

async function handoff(taskId: string) {
  const running = reaches(rig!.built, taskId, ["RUNNING"]);
  const res = await rig!.built.app.inject({ method: "POST", url: `/api/tasks/${taskId}/handoff`, headers: rig!.auth(), payload: {} });
  return { res, running };
}

describe("handoff of a settled compare", () => {
  it("without a pick, continues on the shared task branch as a composed single run with the task remainder", async () => {
    rig = await bootRig({ assistants: ASSISTANTS, budget: { maxTokens: 10_000, maxRuntimeMs: 600_000 } });
    const taskId = await settledCompare();
    const before = branches();

    const { res, running } = await handoff(taskId);
    expect(res.statusCode, res.body).toBe(200);
    expect(await running).toBe("RUNNING");
    const task = rig.built.tasks.get(taskId)!;
    expect(task.mode).toBe("single");
    expect(task.branch).toBe(`task/${taskId}`);
    expect(task.worktree_path).toBe(join(rig.config.dir, "worktrees", taskId, "_task"));

    const successor = runsOf(taskId).at(-1)!;
    expect(successor.id).toBe((res.json() as { runId: string }).runId);
    const spec = revisionSpec(successor.composition_revision_id);
    expect(spec.workspace.branch).toBe(`task/${taskId}`);
    expect(spec.policy.budget.max_tokens).toBeGreaterThan(5_000); // the task remainder, not a 1-of-2 share

    // Every candidate branch survives at the commit it had; the task branch is now checked out.
    expect(branches()).toEqual(before);
    expect(worktreeBranches()).toEqual(expect.arrayContaining([`task/${taskId}`, `task/${taskId}--fake-a`, `task/${taskId}--fake-b`]));
    expect(await rig.built.orchestrator.waitForSettled(taskId)).toBe("COMPLETED");
  });

  it("with a recorded pick, continues from the picked candidate's branch", async () => {
    rig = await bootRig({ assistants: ASSISTANTS });
    const taskId = await settledCompare();
    const picked = runsOf(taskId).find((r) => r.assistant_id === "fake-b")!;
    // Through the API a pick completes the task; the rule still covers a pick recorded on a task
    // that is waiting, so it is recorded directly here.
    rig.db.prepare("UPDATE runs SET outcome = 'winner' WHERE id = ?").run(picked.id);
    const before = branches();

    const { res, running } = await handoff(taskId);
    expect(res.statusCode, res.body).toBe(200);
    expect(await running).toBe("RUNNING");
    const task = rig.built.tasks.get(taskId)!;
    expect(task.branch).toBe(`task/${taskId}--fake-b`);
    expect(task.worktree_path).toBe(picked.worktree_path);
    const successor = runsOf(taskId).at(-1)!;
    expect(revisionSpec(successor.composition_revision_id).workspace.branch).toBe(`task/${taskId}--fake-b`);
    expect(branches()).toEqual(before);
    expect(await rig.built.orchestrator.waitForSettled(taskId)).toBe("COMPLETED");
  });

  it.each([
    ["Harness", undefined],
    ["legacy", legacy],
  ] as const)("%s path: a successor start that throws parks the task in WAITING_INPUT, never HANDING_OFF", async (_path, configure) => {
    rig = await bootRig({ assistants: ASSISTANTS, ...(configure ? { configure } : {}) });
    const taskId = await settledCompare();
    const orchestrator = rig.built.orchestrator as unknown as { startTask: (...args: unknown[]) => Promise<unknown> };
    vi.spyOn(orchestrator, "startTask").mockRejectedValueOnce(new Error("FAKE injected start failure"));
    const notices = collectNotices(taskId);

    const res = await rig.built.app.inject({ method: "POST", url: `/api/tasks/${taskId}/handoff`, headers: rig.auth(), payload: {} });
    expect(res.statusCode).toBe(409);
    expect(res.body).toContain("FAKE injected start failure");
    const task = rig.built.tasks.get(taskId)!;
    expect(task.state).toBe("WAITING_INPUT");
    expect(task.pause_kind).toBe("intervention_required");
    expect(notices).toContainEqual(expect.stringContaining("did not start; task parked: FAKE injected start failure"));

    // Parked, it can be handed off again, and that continuation runs.
    vi.restoreAllMocks();
    const again = await handoff(taskId);
    expect(again.res.statusCode, again.res.body).toBe(200);
    expect(await again.running).toBe("RUNNING");
    expect(await rig.built.orchestrator.waitForSettled(taskId)).toBe("COMPLETED");
  });

  it("legacy path: without a pick, continues on the shared task branch", async () => {
    rig = await bootRig({ assistants: ASSISTANTS, enabled: false, configure: legacy });
    const taskId = await settledCompare();
    const { res, running } = await handoff(taskId);
    expect(res.statusCode, res.body).toBe(200);
    expect(await running).toBe("RUNNING");
    const successor = runsOf(taskId).at(-1)!;
    expect(successor.execution_request_id).toBeNull();
    expect(rig.built.tasks.get(taskId)!.branch).toBe(`task/${taskId}`);
    expect(await rig.built.orchestrator.waitForSettled(taskId)).toBe("COMPLETED");
  });
});

describe("handoff of a single task", () => {
  it("is unchanged: its tree is created at worktrees/<id> on a new task/<id>", async () => {
    rig = await bootRig({ assistants: ASSISTANTS });
    const taskId = rig.built.tasks.create({ goal: GOAL, repoPath: rig.repo }).taskId;
    const { res, running } = await handoff(taskId);
    expect(res.statusCode, res.body).toBe(200);
    expect(await running).toBe("RUNNING");
    const task = rig.built.tasks.get(taskId)!;
    expect(task.mode).toBe("single");
    expect(task.worktree_path).toBe(join(rig.config.dir, "worktrees", taskId));
    expect(task.branch).toBe(`task/${taskId}`);
    expect(worktreeBranches()).toEqual(["main", `task/${taskId}`]);
    expect(await rig.built.orchestrator.waitForSettled(taskId)).toBe("COMPLETED");
  });
});
