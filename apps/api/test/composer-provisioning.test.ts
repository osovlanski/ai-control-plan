/**
 * M3 S2 (plans/m3-provisioning.md §3): the revision binds the profile. Stage 5 asks the chosen
 * adapter's `prepare` (which writes nothing) for the profile it would provision, and the revision
 * records `requested: isolated`, the fidelity and the profile digest. The run must then verify
 * that same digest, or fail before any provider process starts. `partial` needs the workspace's
 * `permitPartial` (or `permitAmbient`); no profile is ambient only where ambient is permitted.
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentSpec, ExecutionResult, ProvisioningPlan, ProvisioningVerifiedPayload } from "@agent-plane/core";
import { computeProfileDigest } from "@agent-plane/adapters";
import type { PreviewResponse } from "../src/modules/composer/service.js";
import { bootRig, reaches, type Rig } from "./helpers/composer-cockpit.js";

let rig: Rig | undefined;
afterEach(async () => {
  await rig?.close();
  rig = undefined;
});

const sha256 = (text: string) => `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;
const GOAL = "Add a typed helper to the TypeScript parser module";
const CODEX = { "fake-codex": { provider: "fake", options: { harness: "codex" } } } as const;
const profilesDir = () => join(rig!.config.dir, "profiles");
const settled = (id: string) => reaches(rig!.built, id, ["COMPLETED", "FAILED", "CANCELLED", "WAITING_INPUT"]);

async function preview(taskId: string) {
  const res = await rig!.built.app.inject({ method: "POST", url: `/api/tasks/${taskId}/compose`, headers: rig!.auth(), payload: {} });
  expect(res.statusCode).toBe(200);
  return res.json() as PreviewResponse;
}

async function start(taskId: string) {
  const done = settled(taskId);
  const res = await rig!.built.app.inject({ method: "POST", url: `/api/tasks/${taskId}/start`, headers: rig!.auth(), payload: {} });
  expect(res.statusCode).toBe(200);
  return done;
}

function session(taskId: string) {
  const run = rig!.db.prepare("SELECT id, composition_revision_id FROM runs WHERE task_id = ? ORDER BY started_at, rowid LIMIT 1").get(taskId) as { id: string; composition_revision_id: string };
  const spec = JSON.parse((rig!.db.prepare("SELECT spec_json FROM agent_specs WHERE composition_revision_id = ?").get(run.composition_revision_id) as { spec_json: string }).spec_json) as AgentSpec;
  const events = rig!.db.prepare("SELECT type, payload FROM events WHERE run_id = ? ORDER BY seq").all(run.id) as Array<{ type: string; payload: string | null }>;
  const result = JSON.parse((rig!.db.prepare("SELECT result FROM execution_results WHERE session_id = ?").get(run.id) as { result: string }).result) as ExecutionResult;
  const verified = events.find((e) => e.type === "provisioning.verified");
  return { spec, events, result, verified: verified ? (JSON.parse(verified.payload!) as ProvisioningVerifiedPayload) : undefined };
}

const policyStage = (body: PreviewResponse) => body.decision.stages.find((s) => s.stage === "policy")!;

describe("the revision binds the profile the run verifies", () => {
  it("Claude Code (fake): the preview predicts a full profile, writes nothing, and the run verifies that same digest", async () => {
    rig = await bootRig();
    const taskId = rig.built.tasks.create({ goal: GOAL, repoPath: rig.repo }).taskId;
    const body = await preview(taskId);
    expect(body.outcome).toEqual({ status: "composed" });
    const predicted = body.specDraft!.provisioning;
    expect(predicted).toEqual({ requested: "isolated", achieved: "full", profile_digest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/) });
    expect(policyStage(body).candidates.find((c) => c.ref === "provisioning:isolated")).toMatchObject({ digest: predicted.profile_digest });
    // `prepare` plans; it never materializes.
    expect(existsSync(profilesDir())).toBe(false);

    expect(await start(taskId)).toBe("COMPLETED");
    const { spec, verified, result } = session(taskId);
    expect(spec.provisioning).toEqual(predicted);
    expect(verified!.profileDigest).toBe(predicted.profile_digest);
    expect(result.enforcement.provisioning).toEqual({ fidelity: "full", profileDigest: predicted.profile_digest });
    expect(readdirSync(profilesDir())).toEqual([]);
  });

  it("a profile that drifts from the revision's digest fails policy_unenforceable before the provider starts", async () => {
    rig = await bootRig();
    const adapter = rig.built.registry.adapter("fake-claude");
    const realPrepare = adapter.prepare!.bind(adapter);
    // The run's prepare (not the composer's prediction) delivers different instructions: a
    // self-consistent plan that verifies on disk, but is not the profile the revision bound.
    adapter.prepare = async (input) => {
      const plan = await realPrepare(input);
      if (input.sessionId === "composer-predict") return plan;
      const files = plan.files.map((f) => (f.relPath === "CLAUDE.md" ? { relPath: f.relPath, content: "drifted\n", digest: sha256("drifted\n") } : f));
      const drifted: ProvisioningPlan = { ...plan, files, launch: { ...plan.launch, systemPromptAppend: "drifted\n" } as ProvisioningPlan["launch"] };
      return { ...drifted, profileDigest: computeProfileDigest(drifted) };
    };
    const taskId = rig.built.tasks.create({ goal: GOAL, repoPath: rig.repo }).taskId;
    expect(await start(taskId)).toBe("FAILED");
    const { spec, events, result } = session(taskId);
    expect(result.failure).toMatchObject({ kind: "policy_unenforceable", retryable: false });
    expect(result.failure!.message).toMatch(new RegExp(`^verified profile sha256:[0-9a-f]{64} is not the revision's ${spec.provisioning.profile_digest}$`));
    expect(result.failure!.message).not.toContain(`profile ${spec.provisioning.profile_digest} is`);
    expect(events.some((e) => e.type === "run.started" || e.type === "provisioning.verified")).toBe(false);
    expect(events.at(-1)!.type).toBe("provisioning.disposed");
    expect(readdirSync(profilesDir())).toEqual([]);
  });
});

describe("partial needs permitPartial or permitAmbient; no profile needs permitAmbient", () => {
  it("Codex (fake) partial with neither permitted: isolation_unavailable, and the decision says why", async () => {
    rig = await bootRig({ assistants: CODEX, configure: (c) => { c.composer.policy.permitAmbient = false; } });
    const body = await preview(rig.built.tasks.create({ goal: GOAL, repoPath: rig.repo }).taskId);
    expect(body.outcome).toEqual({ status: "failed", reason: "isolation_unavailable" });
    const stage = policyStage(body);
    expect(stage.filters.map((f) => f.filter)).toEqual(["partial_not_permitted", "isolation_unavailable"]);
    expect(stage.why).toContain("the profile is partial and partial is not permitted");
    // The candidate survives the text guard: visible scopes name home paths, so they are counted.
    expect(stage.candidates.find((c) => c.ref === "provisioning:isolated")!.evidence).toEqual([
      "fake-codex prepares a partial codex profile", "4 machine-global or workspace scope(s) stay visible",
    ]);
  });

  it("Codex (fake) partial with permitPartial: the revision binds partial and the run verifies it", async () => {
    rig = await bootRig({ assistants: CODEX, configure: (c) => { c.composer.policy.permitAmbient = false; c.composer.policy.permitPartial = true; } });
    const taskId = rig.built.tasks.create({ goal: GOAL, repoPath: rig.repo }).taskId;
    const predicted = (await preview(taskId)).specDraft!.provisioning;
    expect(predicted).toMatchObject({ requested: "isolated", achieved: "partial" });
    expect(await start(taskId)).toBe("COMPLETED");
    const { spec, verified } = session(taskId);
    expect(spec.provisioning).toEqual(predicted);
    expect(verified).toMatchObject({ harness: "codex", fidelity: "partial", profileDigest: predicted.profile_digest });
  });

  it("an adapter with no lifecycle composes ambient only where ambient is permitted", async () => {
    rig = await bootRig({ configure: (c) => { c.composer.policy.permitAmbient = false; c.composer.policy.permitPartial = true; } });
    const adapter = rig.built.registry.adapter("fake-claude") as { prepare?: unknown };
    adapter.prepare = undefined;
    const body = await preview(rig.built.tasks.create({ goal: GOAL, repoPath: rig.repo }).taskId);
    expect(body.outcome).toEqual({ status: "failed", reason: "isolation_unavailable" });
    expect(policyStage(body).why).toContain("no profile (fake-claude has no provisioning lifecycle)");
  });
});
