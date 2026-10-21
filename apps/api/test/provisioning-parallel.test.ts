/**
 * Phase 7's last open condition: composed parallel runs. With the composer on, every compare or
 * race candidate composes its own revision, runs as its own Harness session in its own worktree,
 * provisions and verifies its own harness's profile, and disposes it however it ended: a race
 * loser that is cancelled, a candidate that fails, a cancelled task. A candidate whose full
 * profile fails the S5a startup check fails alone; the others are not cancelled.
 */
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ProvisioningVerifiedPayload } from "@agent-plane/core";
import { bootRig, reaches, type Rig } from "./helpers/composer-cockpit.js";

let rig: Rig | undefined;
afterEach(async () => {
  await rig?.close();
  rig = undefined;
});

const ASSISTANTS = { "fake-a": { provider: "fake" }, "fake-b": { provider: "fake", options: { harness: "codex" } } } as const;
/** Two Claude-harness candidates: under prompt-on-escalation Codex composes route-only (it cannot enforce it), so approval holds use these. */
const CLAUDES = { "fake-a": { provider: "fake" }, "fake-c": { provider: "fake" } } as const;
const HARNESS = { "fake-a": ["claude-code", "full"], "fake-b": ["codex", "partial"], "fake-c": ["claude-code", "full"] } as const;
const GOAL = "Add a typed helper to the TypeScript parser module";

const profilesDir = () => join(rig!.config.dir, "profiles");
const profiles = () => readdirSync(profilesDir()).sort();
interface RunRow { id: string; assistant_id: string; composition_revision_id: string | null; execution_request_id: string | null; outcome: string | null; worktree_path: string | null; branch: string | null }
const runsOf = (taskId: string) => rig!.db.prepare(
  "SELECT id, assistant_id, composition_revision_id, execution_request_id, outcome, worktree_path, branch FROM runs WHERE task_id = ? ORDER BY assistant_id",
).all(taskId) as RunRow[];
const eventsOf = (runId: string) => rig!.db.prepare("SELECT type, payload FROM events WHERE run_id = ? ORDER BY seq").all(runId) as Array<{ type: string; payload: string | null }>;
const verifiedOf = (runId: string) => {
  const e = eventsOf(runId).find((x) => x.type === "provisioning.verified");
  return e ? (JSON.parse(e.payload!) as ProvisioningVerifiedPayload) : undefined;
};
const sessionState = (runId: string) => (rig!.db.prepare("SELECT session_state FROM runs WHERE id = ?").get(runId) as { session_state: string | null } | undefined)?.session_state;
const failureOf = (runId: string) => {
  const row = rig!.db.prepare("SELECT result FROM execution_results WHERE session_id = ?").get(runId) as { result: string } | undefined;
  return row ? (JSON.parse(row.result) as { failure?: { kind: string; message: string } }).failure : undefined;
};

async function startParallel(mode: "compare" | "race", goal = GOAL, assistants = ["fake-a", "fake-b"]) {
  const taskId = rig!.built.tasks.create({ goal, repoPath: rig!.repo }).taskId;
  const res = await rig!.built.app.inject({ method: "POST", url: `/api/tasks/${taskId}/parallel`, headers: rig!.auth(), payload: { assistants, mode } });
  expect(res.statusCode, res.body).toBe(200);
  return { taskId, runs: (res.json() as { runs: Array<{ runId: string; assistantId: string }> }).runs };
}

/** Polls until every session of the task is waiting on an approval; returns each one's request id. */
async function pendingApprovals(runIds: string[]): Promise<Map<string, string>> {
  const deadline = Date.now() + 5000;
  for (;;) {
    const found = new Map<string, string>();
    for (const id of runIds) {
      const e = eventsOf(id).find((x) => x.type === "approval.requested");
      if (e && sessionState(id) === "AWAITING_APPROVAL") found.set(id, (JSON.parse(e.payload!) as { requestId: string }).requestId);
    }
    if (found.size === runIds.length) return found;
    if (Date.now() > deadline) throw new Error(`approvals pending on ${found.size} of ${runIds.length} sessions`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** Each run is its own composed Harness session with its own harness's verified, disposed profile. */
function expectOwnProfiles(runs: RunRow[], assistants = ["fake-a", "fake-b"]) {
  expect(runs.map((r) => r.assistant_id)).toEqual(assistants);
  const [a, b] = runs.map((r) => {
    expect(r.execution_request_id, `${r.assistant_id} ran on the Harness path`).not.toBeNull();
    expect(r.composition_revision_id, `${r.assistant_id} bound a revision`).not.toBeNull();
    const verified = verifiedOf(r.id)!;
    expect(verified, `${r.assistant_id} verified a profile`).toBeDefined();
    expect([verified.harness, verified.fidelity]).toEqual(HARNESS[r.assistant_id as keyof typeof HARNESS]);
    expect(verified.compositionRevisionId).toBe(r.composition_revision_id);
    expect(eventsOf(r.id).at(-1)!.type).toBe("provisioning.disposed");
    return verified;
  });
  expect(runs[0]!.composition_revision_id).not.toBe(runs[1]!.composition_revision_id);
  // Content-addressed: two harnesses give two digests; the same harness and bundle give one.
  if (a!.harness === b!.harness) expect(a!.profileDigest).toBe(b!.profileDigest);
  else expect(a!.profileDigest).not.toBe(b!.profileDigest);
  expect(profiles()).toEqual([]);
}

describe("composed compare and race candidates provision their own profiles", () => {
  it("compare: two harnesses, two revisions, two profiles, each disposed; the winner merges", async () => {
    rig = await bootRig({ assistants: ASSISTANTS });
    const { taskId } = await startParallel("compare");
    expect(await rig.built.orchestrator.waitForSettled(taskId)).toBe("WAITING_INPUT");
    const runs = runsOf(taskId);
    expectOwnProfiles(runs);
    // Each candidate ran in its own worktree, recorded on its row so the comparison can diff it.
    expect(new Set(runs.map((r) => r.worktree_path)).size).toBe(2);
    expect(runs.every((r) => r.branch)).toBe(true);

    const cmp = await rig.built.app.inject({ method: "GET", url: `/api/tasks/${taskId}/comparison`, headers: rig.auth() });
    expect((cmp.json() as { competitors: Array<{ branch: string | null }> }).competitors.map((c) => c.branch).every(Boolean)).toBe(true);
    const resolved = await rig.built.app.inject({ method: "POST", url: `/api/tasks/${taskId}/comparison/resolve`, headers: rig.auth(), payload: { winnerRunId: runs[1]!.id } });
    expect(resolved.statusCode, resolved.body).toBe(200);
    expect(rig.built.tasks.get(taskId)!.state).toBe("COMPLETED");
    expect(runsOf(taskId).map((r) => r.outcome)).toEqual(["rejected", "winner"]);
  });

  it("race: both profiles exist while both run; the loser is cancelled and its profile disposed", async () => {
    rig = await bootRig({ assistants: CLAUDES, configure: (c) => { c.policy.approvalMode = "prompt-on-escalation"; } });
    const { taskId, runs: started } = await startParallel("race", `${GOAL} [FAKE:APPROVAL]`, ["fake-a", "fake-c"]);
    const ids = started.map((r) => r.runId);
    const pending = await pendingApprovals(ids);
    // During: one profile directory per live session, named by that session.
    expect(profiles()).toEqual([...ids].sort());

    const winner = started.find((r) => r.assistantId === "fake-c")!.runId;
    const loser = started.find((r) => r.assistantId === "fake-a")!.runId;
    const done = reaches(rig.built, taskId, ["COMPLETED", "FAILED", "CANCELLED", "WAITING_INPUT"]);
    const answer = await rig.built.app.inject({ method: "POST", url: `/api/tasks/${taskId}/input`, headers: rig.auth(), payload: { kind: "approval", requestId: pending.get(winner), approved: true } });
    expect(answer.statusCode, answer.body).toBe(200);
    expect(await done).toBe("COMPLETED");
    await rig.built.orchestrator.waitForSettled(taskId);

    expect(sessionState(winner)).toBe("COMPLETED");
    expect(sessionState(loser)).toBe("CANCELLED");
    const runs = runsOf(taskId);
    expect(runs.map((r) => [r.assistant_id, r.outcome])).toEqual([["fake-a", "rejected"], ["fake-c", "winner"]]);
    expectOwnProfiles(runs, ["fake-a", "fake-c"]);
  });

  it("race: a candidate whose full profile fails the startup check fails alone and the other wins", async () => {
    rig = await bootRig({ assistants: ASSISTANTS });
    const { taskId, runs: started } = await startParallel("race", `${GOAL} [FAKE:INIT:extra-plugin]`);
    expect(await rig.built.orchestrator.waitForSettled(taskId)).toBe("COMPLETED");
    const claude = started.find((r) => r.assistantId === "fake-a")!.runId;
    const codex = started.find((r) => r.assistantId === "fake-b")!.runId;
    expect(sessionState(claude)).toBe("FAILED");
    expect(failureOf(claude)?.kind).toBe("policy_unenforceable");
    expect(sessionState(codex)).toBe("COMPLETED");
    expect(runsOf(taskId).find((r) => r.id === codex)!.outcome).toBe("winner");
    expectOwnProfiles(runsOf(taskId));
  });

  it("compare: the failed candidate does not cancel the other; the comparison still waits for the user", async () => {
    rig = await bootRig({ assistants: ASSISTANTS });
    const { taskId, runs: started } = await startParallel("compare", `${GOAL} [FAKE:INIT:missing-skill]`);
    expect(await rig.built.orchestrator.waitForSettled(taskId)).toBe("WAITING_INPUT");
    expect(sessionState(started.find((r) => r.assistantId === "fake-a")!.runId)).toBe("FAILED");
    expect(sessionState(started.find((r) => r.assistantId === "fake-b")!.runId)).toBe("COMPLETED");
    expectOwnProfiles(runsOf(taskId));
  });

  it("cancelling the task cancels every candidate session and disposes every profile", async () => {
    rig = await bootRig({ assistants: CLAUDES, configure: (c) => { c.policy.approvalMode = "prompt-on-escalation"; } });
    const { taskId, runs: started } = await startParallel("compare", `${GOAL} [FAKE:APPROVAL]`, ["fake-a", "fake-c"]);
    await pendingApprovals(started.map((r) => r.runId));
    const res = await rig.built.app.inject({ method: "POST", url: `/api/tasks/${taskId}/cancel`, headers: rig.auth() });
    expect(res.statusCode, res.body).toBe(200);
    expect(await rig.built.orchestrator.waitForSettled(taskId)).toBe("CANCELLED");
    for (const r of started) expect(sessionState(r.runId), r.assistantId).toBe("CANCELLED");
    expectOwnProfiles(runsOf(taskId), ["fake-a", "fake-c"]);
  });

  it("with the composer off, compare stays on the legacy path and provisions nothing", async () => {
    rig = await bootRig({ assistants: ASSISTANTS, enabled: false });
    const { taskId } = await startParallel("compare");
    expect(await rig.built.orchestrator.waitForSettled(taskId)).toBe("WAITING_INPUT");
    expect(runsOf(taskId).map((r) => [r.execution_request_id, r.composition_revision_id])).toEqual([[null, null], [null, null]]);
  });
});
