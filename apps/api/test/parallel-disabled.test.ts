/**
 * Compare and race name their candidates explicitly, so route()'s hard filters never see them.
 * A NEW parallel start must still honour both disable sources route() enforces: config
 * `enabled: false` and the operator disable overlay (migration 051). The refusal comes before
 * anything is written: no mode change, routing decision, worktree, revision or provider start.
 * A disable that lands after a candidate started never stops it.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ResolvedConfig } from "../src/config.js";
import { bootRig, type Rig } from "./helpers/composer-cockpit.js";

let rig: Rig | undefined;
afterEach(async () => {
  vi.restoreAllMocks();
  await rig?.close();
  rig = undefined;
});

const GOAL = "Add a typed helper to the TypeScript parser module";
/** fake-c is off in workspace config; fake-a and fake-b are on. All three run the Claude harness. */
const ASSISTANTS: ResolvedConfig["assistants"] = {
  "fake-a": { provider: "fake" },
  "fake-b": { provider: "fake" },
  "fake-c": { provider: "fake", enabled: false },
};

/** The three ways startParallel can run its candidates. */
const PATHS = {
  composed: { enabled: true },
  "legacy (composer off)": { enabled: false },
  "legacy (composer on, Harness path off)": { enabled: true, configure: (c: ResolvedConfig) => { c.execution.harnessModes.single = false; } },
} as const;
type PathName = keyof typeof PATHS;

async function boot(path: PathName, extra?: (c: ResolvedConfig) => void) {
  const base = PATHS[path];
  rig = await bootRig({
    // A copy: one test reloads config with an assistant turned off, which must not leak into the next.
    assistants: structuredClone(ASSISTANTS),
    enabled: base.enabled,
    configure: (c) => {
      if ("configure" in base) base.configure(c);
      extra?.(c);
    },
  });
  return rig;
}

const post = (url: string, payload?: Record<string, unknown>) => rig!.built.app.inject({ method: "POST", url, headers: rig!.auth(), ...(payload === undefined ? {} : { payload }) });
const count = (sql: string, ...args: unknown[]) => (rig!.db.prepare(sql).get(...args) as { n: number }).n;

/** Everything a parallel start could write for the task, plus the repo's branches and worktrees. */
function footprint(taskId: string) {
  const task = rig!.built.tasks.get(taskId)!;
  return {
    state: task.state,
    mode: task.mode,
    branch: task.branch,
    worktree: task.worktree_path,
    routingDecisions: count("SELECT COUNT(*) n FROM routing_decisions WHERE task_id = ?", taskId),
    runs: count("SELECT COUNT(*) n FROM runs WHERE task_id = ?", taskId),
    executionRequests: count("SELECT COUNT(*) n FROM execution_requests WHERE task_id = ?", taskId),
    compositionAttempts: count("SELECT COUNT(*) n FROM composition_attempts WHERE task_id = ?", taskId),
    compositionRevisions: count("SELECT COUNT(*) n FROM agent_specs WHERE task_id = ?", taskId),
    branches: execFileSync("git", ["-C", rig!.repo, "branch", "--format=%(refname:short)"], { encoding: "utf8" }).trim().split("\n").sort(),
    worktrees: existsSync(join(rig!.config.dir, "worktrees")) ? readdirSync(join(rig!.config.dir, "worktrees")).sort() : [],
  };
}

function spyStarts() {
  return ["fake-a", "fake-b", "fake-c"].map((id) => vi.spyOn(rig!.built.registry.adapter(id), "start"));
}

describe.each(Object.keys(PATHS) as PathName[])("%s path", (path) => {
  describe.each(["compare", "race"] as const)("%s", (mode) => {
    it("refuses a config-disabled candidate before writing anything", async () => {
      await boot(path);
      const taskId = rig!.built.tasks.create({ goal: GOAL, repoPath: rig!.repo }).taskId;
      const before = footprint(taskId);
      const starts = spyStarts();

      const res = await post(`/api/tasks/${taskId}/parallel`, { assistants: ["fake-a", "fake-c"], mode });
      expect(res.statusCode, res.body).toBe(409);
      expect(res.json()).toEqual({
        error: `Cannot start a ${mode} with fake-a, fake-c: fake-c is disabled in workspace config (assistants.fake-c.enabled is false)`,
      });
      expect(footprint(taskId)).toEqual(before);
      expect(before).toMatchObject({ state: "CREATED", mode: "single", routingDecisions: 0, runs: 0, branches: ["main"], worktrees: [] });
      for (const start of starts) expect(start).not.toHaveBeenCalled();
    });

    it("refuses an operator-disabled candidate before writing anything", async () => {
      await boot(path);
      expect((await post("/api/assistants/fake-b/disable")).statusCode).toBe(200);
      const taskId = rig!.built.tasks.create({ goal: GOAL, repoPath: rig!.repo }).taskId;
      const before = footprint(taskId);
      const starts = spyStarts();

      const res = await post(`/api/tasks/${taskId}/parallel`, { assistants: ["fake-a", "fake-b"], mode });
      expect(res.statusCode, res.body).toBe(409);
      expect(res.json()).toEqual({
        error: `Cannot start a ${mode} with fake-a, fake-b: fake-b is disabled by operator (POST /api/assistants/fake-b/enable clears it)`,
      });
      expect(footprint(taskId)).toEqual(before);
      for (const start of starts) expect(start).not.toHaveBeenCalled();
    });

    it("starts with enabled candidates, and again once the operator re-enables one", async () => {
      await boot(path);
      await post("/api/assistants/fake-b/disable");
      const refused = rig!.built.tasks.create({ goal: GOAL, repoPath: rig!.repo }).taskId;
      expect((await post(`/api/tasks/${refused}/parallel`, { assistants: ["fake-a", "fake-b"], mode })).statusCode).toBe(409);
      expect((await post("/api/assistants/fake-b/enable")).statusCode).toBe(200);

      // The refused task is still fresh, so the same task starts once the cause is cleared.
      const res = await post(`/api/tasks/${refused}/parallel`, { assistants: ["fake-a", "fake-b"], mode });
      expect(res.statusCode, res.body).toBe(200);
      expect((res.json() as { runs: Array<{ assistantId: string }> }).runs.map((r) => r.assistantId)).toEqual(["fake-a", "fake-b"]);
      expect(await rig!.built.orchestrator.waitForSettled(refused)).toBe(mode === "compare" ? "WAITING_INPUT" : "COMPLETED");
      const runs = rig!.db.prepare("SELECT assistant_id, composition_revision_id, execution_request_id FROM runs WHERE task_id = ? ORDER BY assistant_id").all(refused) as Array<{ assistant_id: string; composition_revision_id: string | null; execution_request_id: string | null }>;
      expect(runs.map((r) => r.assistant_id)).toEqual(["fake-a", "fake-b"]);
      // Each path ran as itself: only the composed one binds revisions on the Harness path.
      const composed = path === "composed";
      for (const r of runs) {
        expect(r.composition_revision_id !== null, `${r.assistant_id} revision`).toBe(composed);
        expect(r.execution_request_id !== null, `${r.assistant_id} Harness session`).toBe(composed);
      }
    });

    it("a disable after the candidates started stops neither of them", async () => {
      await boot(path, (c) => { c.policy.approvalMode = "prompt-on-escalation"; });
      const taskId = rig!.built.tasks.create({ goal: `${GOAL} [FAKE:APPROVAL]`, repoPath: rig!.repo }).taskId;
      const res = await post(`/api/tasks/${taskId}/parallel`, { assistants: ["fake-a", "fake-b"], mode });
      expect(res.statusCode, res.body).toBe(200);
      const requests = await pendingApprovals(taskId, 2);

      // One candidate is disabled by the operator, the other by config (a reload that turns it off).
      expect((await post("/api/assistants/fake-a/disable")).json()).toMatchObject({ changed: true });
      rig!.config.assistants["fake-b"] = { provider: "fake", enabled: false };
      rig!.built.registry.init();
      expect(rig!.built.registry.list().find((a) => a.id === "fake-b")!.enabled).toBe(0);

      // A race loser may already be cancelled by the time its approval is answered.
      for (const requestId of requests) await post(`/api/tasks/${taskId}/input`, { kind: "approval", requestId, approved: true });
      const settled = await rig!.built.orchestrator.waitForSettled(taskId);
      const outcomes = rig!.db.prepare("SELECT assistant_id, outcome FROM runs WHERE task_id = ? ORDER BY assistant_id").all(taskId) as Array<{ assistant_id: string; outcome: string | null }>;
      expect(outcomes.map((r) => r.assistant_id)).toEqual(["fake-a", "fake-b"]);
      if (mode === "compare") {
        // Both finished and are offered for the pick.
        expect(settled).toBe("WAITING_INPUT");
        expect(rig!.built.tasks.get(taskId)!.pause_kind).toBe("comparison_pending");
      } else {
        // The first to finish won; nothing was cancelled for being disabled.
        expect(settled).toBe("COMPLETED");
        expect(outcomes.filter((r) => r.outcome === "winner")).toHaveLength(1);
      }
      // A NEW start with them is refused, naming each cause.
      const next = rig!.built.tasks.create({ goal: GOAL, repoPath: rig!.repo }).taskId;
      const refused = await post(`/api/tasks/${next}/parallel`, { assistants: ["fake-a", "fake-b"], mode });
      expect(refused.statusCode).toBe(409);
      expect(refused.json().error).toBe(
        `Cannot start a ${mode} with fake-a, fake-b: fake-a is disabled by operator (POST /api/assistants/fake-a/enable clears it); ` +
        "fake-b is disabled in workspace config (assistants.fake-b.enabled is false)",
      );
    });
  });
});

describe("refusal text", () => {
  it("names both causes when config and operator disable the same candidate, and an unknown one", async () => {
    await boot("composed");
    await post("/api/assistants/fake-c/disable");
    const taskId = rig!.built.tasks.create({ goal: GOAL, repoPath: rig!.repo }).taskId;
    const before = footprint(taskId);
    const res = await post(`/api/tasks/${taskId}/parallel`, { assistants: ["fake-c", "nope", "fake-a"], mode: "race" });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe(
      "Cannot start a race with fake-c, nope, fake-a: fake-c is disabled in workspace config (assistants.fake-c.enabled is false) " +
      "and by operator (POST /api/assistants/fake-c/enable clears only the operator disable); nope is not a configured assistant",
    );
    expect(footprint(taskId)).toEqual(before);
  });
});

/** Polls until `n` sessions of the task each wait on an approval; returns their request ids. */
async function pendingApprovals(taskId: string, n: number): Promise<string[]> {
  const deadline = Date.now() + 5000;
  for (;;) {
    const rows = rig!.db.prepare(
      "SELECT e.payload FROM events e JOIN runs r ON r.id = e.run_id WHERE r.task_id = ? AND e.type = 'approval.requested'",
    ).all(taskId) as Array<{ payload: string }>;
    const ids = [...new Set(rows.map((r) => (JSON.parse(r.payload) as { requestId: string }).requestId))];
    if (ids.length >= n) return ids;
    if (Date.now() > deadline) throw new Error(`approvals pending on ${ids.length} of ${n} sessions`);
    await new Promise((r) => setTimeout(r, 10));
  }
}
