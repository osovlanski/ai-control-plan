/**
 * Phase 7 resume: POST /api/tasks/:id/restart continues a task that boot recovery parked with a
 * `resume_offered` session. The offered session is released through recovery's fenced cancel,
 * its profile is swept, and the task continues from the checkpoint on the same assistant: the
 * new session provisions under its own id and verifies the same digest.
 */
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
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

const profilesDir = () => join(rig!.config.dir, "profiles");
const runsOf = (taskId: string) => rig!.db.prepare("SELECT id, session_state, composition_revision_id FROM runs WHERE task_id = ? ORDER BY started_at, rowid").all(taskId) as Array<{ id: string; session_state: string; composition_revision_id: string }>;
const eventsOf = (runId: string) => rig!.db.prepare("SELECT type, payload FROM events WHERE run_id = ? ORDER BY seq").all(runId) as Array<{ type: string; payload: string | null }>;
const verifiedOf = (runId: string) => {
  const e = eventsOf(runId).find((x) => x.type === "provisioning.verified");
  return e ? (JSON.parse(e.payload!) as ProvisioningVerifiedPayload) : undefined;
};
const restart = (taskId: string) => rig!.built.app.inject({ method: "POST", url: `/api/tasks/${taskId}/restart`, headers: rig!.auth(), payload: {} });

/** Start a composed task, let it reach AWAITING_APPROVAL, then model a kill -9 and a reboot. */
async function crashMidRun(): Promise<{ taskId: string; sessionId: string; digest: string }> {
  rig = await bootRig({ configure: (config) => { config.policy.approvalMode = "prompt-on-escalation"; } });
  const taskId = rig.built.tasks.create({ goal: "Implement a typed helper [FAKE:APPROVAL]", repoPath: rig.repo }).taskId;
  expect((await rig.built.app.inject({ method: "POST", url: `/api/tasks/${taskId}/start`, headers: rig.auth(), payload: {} })).statusCode).toBe(200);
  const [run] = runsOf(taskId);
  await vi.waitFor(() => expect(runsOf(taskId)[0]!.session_state).toBe("AWAITING_APPROVAL"));
  const digest = verifiedOf(run!.id)!.profileDigest;
  const runRow = rig.db.prepare("SELECT * FROM runs WHERE id = ?").get(run!.id) as Record<string, unknown>;
  const taskRow = rig.db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId) as Record<string, unknown>;
  // Drain the in-process runner, then restore the pre-crash durable rows and the profile, so no
  // live runner races recovery (the provisioning-lifecycle crash model).
  await rig.built.orchestrator.shutdown();
  await vi.waitFor(() => expect(eventsOf(run!.id).at(-1)?.type).toBe("provisioning.disposed"));
  rig.db.prepare("DELETE FROM execution_results WHERE session_id = ?").run(run!.id);
  rig.db.prepare("DELETE FROM checkpoints WHERE task_id = ?").run(taskId);
  for (const [table, row, id] of [["runs", runRow, run!.id], ["tasks", taskRow, taskId]] as const) {
    rig.db.prepare(`UPDATE ${table} SET ${Object.keys(row).map((key) => `${key} = ?`).join(", ")} WHERE id = ?`).run(...Object.values(row), id);
  }
  const dir = join(profilesDir(), run!.id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, PROFILE_MARKER), JSON.stringify({ owner: "agent-plane", sessionId: run!.id, compositionRevisionId: run!.composition_revision_id, profileDigest: digest }));
  await rig.built.orchestrator.reconcileOnBoot();
  return { taskId, sessionId: run!.id, digest };
}

describe("restart after a crash", () => {
  it("releases the resume-offered session and continues on the same assistant with the same profile digest", async () => {
    const { taskId, sessionId, digest } = await crashMidRun();
    expect(rig!.built.tasks.get(taskId)).toMatchObject({ state: "WAITING_INPUT", pause_kind: "harness_error" });
    expect(eventsOf(sessionId).some((e) => e.type === "recovery.decision" && JSON.parse(e.payload!).action === "resume_offered")).toBe(true);
    expect(readdirSync(profilesDir())).toEqual([sessionId]);

    const res = await restart(taskId);
    expect(res.statusCode).toBe(200);
    const body = res.json() as { sessionId: string; checkpointId: string; wake: { outcome: string } };
    expect(body.sessionId).toBe(sessionId);
    expect(rig!.db.prepare("SELECT run_id FROM checkpoints WHERE id = ?").get(body.checkpointId)).toEqual({ run_id: sessionId });
    expect(eventsOf(sessionId).map((e) => e.type)).toContain("provisioning.swept");

    // The continuation asks for the approval again; answering it lets the task finish.
    await vi.waitFor(() => expect(runsOf(taskId)).toHaveLength(2));
    const next = runsOf(taskId)[1]!;
    await vi.waitFor(() => expect(runsOf(taskId)[1]!.session_state).toBe("AWAITING_APPROVAL"));
    const { provider_request_id } = rig!.db.prepare("SELECT provider_request_id FROM approvals WHERE session_id = ? AND state = 'pending'").get(next.id) as { provider_request_id: string };
    const done = reaches(rig!.built, taskId, ["COMPLETED", "FAILED", "CANCELLED", "WAITING_INPUT"]);
    await rig!.built.app.inject({ method: "POST", url: `/api/tasks/${taskId}/input`, headers: rig!.auth(), payload: { kind: "approval", requestId: provider_request_id, approved: true } });
    expect(await done).toBe("COMPLETED");

    expect(runsOf(taskId).map((r) => r.session_state)).toEqual(["CANCELLED", "COMPLETED"]);
    expect(next.id).not.toBe(sessionId);
    expect(verifiedOf(next.id)!.profileDigest).toBe(digest);
    expect(eventsOf(next.id).at(-1)!.type).toBe("provisioning.disposed");
    expect(readdirSync(profilesDir())).toEqual([]);
    const handoff = rig!.db.prepare("SELECT from_run_id, to_run_id, checkpoint_id FROM handoffs WHERE task_id = ?").get(taskId);
    expect(handoff).toEqual({ from_run_id: sessionId, to_run_id: next.id, checkpoint_id: body.checkpointId });
  });

  it("refuses a task that is not parked by crash recovery, and a second restart", async () => {
    const { taskId } = await crashMidRun();
    const other = rig!.built.tasks.create({ goal: "not started", repoPath: rig!.repo }).taskId;
    const refused = await restart(other);
    expect(refused.statusCode).toBe(409);
    expect((refused.json() as { error: string }).error).toMatch(/only a task parked by crash recovery/);

    expect((await restart(taskId)).statusCode).toBe(200);
    const again = await restart(taskId);
    expect(again.statusCode).toBe(409);
  });

  it("is refused while the scheduler is disabled, and leaves the offered session as it was", async () => {
    const { taskId, sessionId } = await crashMidRun();
    rig!.config.scheduler = { ...rig!.config.scheduler!, enabled: false };
    const res = await restart(taskId);
    expect(res.statusCode).toBe(409);
    expect(runsOf(taskId)[0]).toMatchObject({ id: sessionId, session_state: "AWAITING_APPROVAL" });
  });
});
