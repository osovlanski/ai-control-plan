/**
 * Refusals around a crash-parked task (phase 7 resume, the slice 4 drive findings):
 * - D3: a handoff refused by routing leaves no checkpoint behind, so `/wait` still works.
 * - D4: a same-assistant handoff says the source assistant is excluded and names the restart route.
 * - D5: an approval answered on a `resume_offered` session is refused (409) and writes nothing.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProvisioningVerifiedPayload } from "@agent-plane/core";
import { PROFILE_MARKER } from "@agent-plane/adapters";
import { bootRig, reaches, type Rig } from "./helpers/composer-cockpit.js";

let rig: Rig | undefined;
afterEach(async () => {
  await rig?.built.orchestrator.shutdown();
  await rig?.close();
  rig = undefined;
});

const post = (url: string, payload: unknown = {}) => rig!.built.app.inject({ method: "POST", url, headers: rig!.auth(), payload: payload as object });
const runsOf = (taskId: string) => rig!.db.prepare("SELECT id, assistant_id, session_state, composition_revision_id FROM runs WHERE task_id = ? ORDER BY started_at, rowid").all(taskId) as Array<{ id: string; assistant_id: string; session_state: string; composition_revision_id: string }>;
const checkpointsOf = (taskId: string) => rig!.db.prepare("SELECT id, run_id, reason FROM checkpoints WHERE task_id = ? ORDER BY at, rowid").all(taskId);
const approvalsOf = (sessionId: string) => rig!.db.prepare("SELECT * FROM approvals WHERE session_id = ? ORDER BY created_at, id").all(sessionId);
const eventsOf = (runId: string) => rig!.db.prepare("SELECT type, payload FROM events WHERE run_id = ? ORDER BY seq").all(runId) as Array<{ type: string; payload: string | null }>;

/** The restart test's crash model: AWAITING_APPROVAL, drain, restore pre-crash rows, reboot. */
async function crashMidRun(): Promise<{ taskId: string; sessionId: string; assistantId: string }> {
  rig = await bootRig({
    assistants: { "fake-claude": { provider: "fake" }, "fake-codex": { provider: "fake" } },
    configure: (config) => { config.policy.approvalMode = "prompt-on-escalation"; },
  });
  const taskId = rig.built.tasks.create({ goal: "Implement a typed helper [FAKE:APPROVAL]", repoPath: rig.repo }).taskId;
  expect((await post(`/api/tasks/${taskId}/start`)).statusCode).toBe(200);
  const [run] = runsOf(taskId);
  await vi.waitFor(() => expect(runsOf(taskId)[0]!.session_state).toBe("AWAITING_APPROVAL"));
  const verified = eventsOf(run!.id).find((e) => e.type === "provisioning.verified")!;
  const digest = (JSON.parse(verified.payload!) as ProvisioningVerifiedPayload).profileDigest;
  const runRow = rig.db.prepare("SELECT * FROM runs WHERE id = ?").get(run!.id) as Record<string, unknown>;
  const taskRow = rig.db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId) as Record<string, unknown>;
  // A kill -9 leaves the pending approval pending; the graceful drain below would expire it.
  const approvalRows = approvalsOf(run!.id) as Array<Record<string, unknown>>;
  await rig.built.orchestrator.shutdown();
  await vi.waitFor(() => expect(eventsOf(run!.id).at(-1)?.type).toBe("provisioning.disposed"));
  rig.db.prepare("DELETE FROM execution_results WHERE session_id = ?").run(run!.id);
  rig.db.prepare("DELETE FROM checkpoints WHERE task_id = ?").run(taskId);
  for (const [table, row, id] of [["runs", runRow, run!.id], ["tasks", taskRow, taskId], ...approvalRows.map((a) => ["approvals", a, a.id as string] as const)] as const) {
    rig.db.prepare(`UPDATE ${table} SET ${Object.keys(row).map((key) => `${key} = ?`).join(", ")} WHERE id = ?`).run(...Object.values(row), id);
  }
  const dir = join(rig.config.dir, "profiles", run!.id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, PROFILE_MARKER), JSON.stringify({ owner: "agent-plane", sessionId: run!.id, compositionRevisionId: run!.composition_revision_id, profileDigest: digest }));
  await rig.built.orchestrator.reconcileOnBoot();
  expect(rig.built.tasks.get(taskId)).toMatchObject({ state: "WAITING_INPUT", pause_kind: "harness_error" });
  return { taskId, sessionId: run!.id, assistantId: run!.assistant_id };
}

describe("refusals around a crash-parked task", () => {
  it("D5: refuses an approval answered on a resume-offered session with 409 naming the restart route, and writes nothing", async () => {
    const { taskId, sessionId } = await crashMidRun();
    const before = approvalsOf(sessionId);
    const { provider_request_id } = before.find((a) => (a as { state: string }).state === "pending") as { provider_request_id: string };

    const res = await post(`/api/tasks/${taskId}/input`, { kind: "approval", requestId: provider_request_id, approved: true });
    expect(res.statusCode).toBe(409);
    expect((res.json() as { error: string }).error).toMatch(new RegExp(`POST /api/tasks/${taskId}/restart`));
    expect(approvalsOf(sessionId)).toEqual(before);
    expect(runsOf(taskId)[0]!.session_state).toBe("AWAITING_APPROVAL");
  });

  it("D4: refuses a same-assistant handoff as the excluded source, points at restart, and leaves the session alone", async () => {
    const { taskId, sessionId, assistantId } = await crashMidRun();
    const res = await post(`/api/tasks/${taskId}/handoff`, { to: assistantId });
    expect(res.statusCode).toBe(409);
    const error = (res.json() as { error: string }).error;
    expect(error).not.toMatch(/disabled in workspace config/);
    expect(error).toMatch(new RegExp(`${assistantId} is the source assistant`));
    expect(error).toMatch(new RegExp(`POST /api/tasks/${taskId}/restart`));
    expect(checkpointsOf(taskId)).toEqual([]);
    expect(runsOf(taskId)[0]).toMatchObject({ id: sessionId, session_state: "AWAITING_APPROVAL" });
    expect(rig!.built.tasks.get(taskId)).toMatchObject({ state: "WAITING_INPUT", pause_kind: "harness_error" });
    // Still restartable.
    expect((await post(`/api/tasks/${taskId}/restart`)).statusCode).toBe(200);
  });

  it("D4: a same-assistant handoff of a task that is not restartable says excluded without pointing at restart", async () => {
    rig = await bootRig({ assistants: { "fake-claude": { provider: "fake" }, "fake-codex": { provider: "fake" } } });
    const taskId = rig.built.tasks.create({ goal: "quota [FAKE:LIMIT]", repoPath: rig.repo }).taskId;
    rig.config.failover.auto = false;
    const settled = reaches(rig.built, taskId, ["WAITING_INPUT", "COMPLETED", "FAILED"]);
    expect((await post(`/api/tasks/${taskId}/start`)).statusCode).toBe(200);
    expect(await settled).toBe("WAITING_INPUT");
    const assistantId = runsOf(taskId)[0]!.assistant_id;
    const res = await post(`/api/tasks/${taskId}/handoff`, { to: assistantId });
    expect(res.statusCode).toBe(409);
    const error = (res.json() as { error: string }).error;
    expect(error).toMatch(new RegExp(`${assistantId} is the source assistant`));
    expect(error).not.toMatch(/restart/);
  });

  it("D3: a handoff refused by routing leaves no checkpoint behind, so /wait still attaches", async () => {
    rig = await bootRig({ assistants: { "fake-claude": { provider: "fake" }, "fake-codex": { provider: "fake", enabled: false } } });
    const taskId = rig.built.tasks.create({ goal: "quota [FAKE:LIMIT]", repoPath: rig.repo }).taskId;
    rig.config.failover.auto = false;
    const settled = reaches(rig.built, taskId, ["WAITING_INPUT", "COMPLETED", "FAILED"]);
    expect((await post(`/api/tasks/${taskId}/start`)).statusCode).toBe(200);
    expect(await settled).toBe("WAITING_INPUT");
    const before = checkpointsOf(taskId);

    const refused = await post(`/api/tasks/${taskId}/handoff`, { to: "fake-codex" });
    expect(refused.statusCode).toBe(409);
    const error = (refused.json() as { error: string }).error;
    expect(error).toMatch(/No eligible assistant for handoff/);
    expect(error).toMatch(/fake-claude: excluded as the handoff source/);
    expect(checkpointsOf(taskId)).toEqual(before);

    const wait = await post(`/api/tasks/${taskId}/wait`, { kind: "time", notBefore: new Date(Date.now() + 3_600_000).toISOString(), reason: "later" });
    expect(wait.statusCode).toBe(200);
    expect(rig.built.tasks.get(taskId)!.state).toBe("WAITING_RESOURCE");
  });
});
