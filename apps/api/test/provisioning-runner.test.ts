/**
 * M3 provisioning in the Harness (plans/m3-provisioning.md §2): a revision-bound session prepares,
 * provisions and verifies a per-run profile before `start`, launches with it, and disposes it when
 * the session ends. A profile that cannot be proven fails the session before any provider process;
 * an adapter with no lifecycle records `provisioning.ambient` instead of running silently ambient.
 */
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentAdapter, ExecutionResult, ProvisioningVerifiedPayload } from "@agent-plane/core";
import { bootRig, reaches, type Rig } from "./helpers/composer-cockpit.js";

let rig: Rig | undefined;
afterEach(async () => {
  await rig?.close();
  rig = undefined;
});

const settled = (id: string) => reaches(rig!.built, id, ["COMPLETED", "FAILED", "CANCELLED", "WAITING_INPUT"]);
const profilesDir = () => join(rig!.config.dir, "profiles");

async function startComposed(goal: string) {
  const taskId = rig!.built.tasks.create({ goal, repoPath: rig!.repo }).taskId;
  const done = settled(taskId);
  const res = await rig!.built.app.inject({ method: "POST", url: `/api/tasks/${taskId}/start`, headers: rig!.auth(), payload: {} });
  expect(res.statusCode).toBe(200);
  return { taskId, state: await done };
}

function sessionOf(taskId: string) {
  const run = rig!.db.prepare("SELECT id, composition_revision_id FROM runs WHERE task_id = ? ORDER BY started_at, rowid LIMIT 1").get(taskId) as { id: string; composition_revision_id: string | null };
  const events = rig!.db.prepare("SELECT seq, type, summary, payload FROM events WHERE run_id = ? ORDER BY seq").all(run.id) as Array<{ seq: number; type: string; summary: string; payload: string | null }>;
  const resultRow = rig!.db.prepare("SELECT result FROM execution_results WHERE session_id = ?").get(run.id) as { result: string } | undefined;
  return { run, events, result: resultRow ? (JSON.parse(resultRow.result) as ExecutionResult) : undefined };
}

describe("a composed run launches with a verified per-run profile", () => {
  it("Claude Code (fake): verified full before start, visible to the launch, disposed after, nothing left behind", async () => {
    rig = await bootRig();
    const { taskId, state } = await startComposed("Add a typed helper to the TypeScript parser module");
    expect(state).toBe("COMPLETED");
    const { run, events, result } = sessionOf(taskId);
    expect(run.composition_revision_id).toBe(`CR-${taskId}-1`);

    const types = events.map((e) => e.type);
    const verified = events.find((e) => e.type === "provisioning.verified")!;
    const payload = JSON.parse(verified.payload!) as ProvisioningVerifiedPayload;
    expect(payload).toMatchObject({ compositionRevisionId: `CR-${taskId}-1`, harness: "claude-code", fidelity: "full" });
    expect(payload.files.map((f) => f.relPath)).toEqual(["CLAUDE.md", "plugin/.claude-plugin/plugin.json", "plugin/skills/ts-review/SKILL.md"]);
    expect(payload.excluded).toContain("user settings and CLAUDE.md (~/.claude)");
    expect(payload.checks.every((c) => c.ok)).toBe(true);
    // Verified before the provider started; the provider saw every file; disposed last.
    expect(types.indexOf("provisioning.verified")).toBeLessThan(types.indexOf("run.started"));
    expect(events.find((e) => e.summary.startsWith("Fake launched with profile"))!.summary).toBe(`Fake launched with profile ${payload.profileDigest} (full): 3/3 files present`);
    expect(types.at(-1)).toBe("provisioning.disposed");
    expect(JSON.parse(events.at(-1)!.payload!)).toEqual({ compositionRevisionId: `CR-${taskId}-1`, profileDigest: payload.profileDigest, removed: true });

    expect(result!.enforcement.provisioning).toEqual({ fidelity: "full", profileDigest: payload.profileDigest });
    expect(readdirSync(profilesDir())).toEqual([]);
  });

  it("Codex (fake): partial, with ~/.codex stated as visible", async () => {
    rig = await bootRig({ assistants: { "fake-codex": { provider: "fake", options: { harness: "codex" } } } });
    const { taskId, state } = await startComposed("Add a typed helper to the TypeScript parser module");
    expect(state).toBe("COMPLETED");
    const { events, result } = sessionOf(taskId);
    const payload = JSON.parse(events.find((e) => e.type === "provisioning.verified")!.payload!) as ProvisioningVerifiedPayload;
    expect(payload).toMatchObject({ harness: "codex", fidelity: "partial" });
    expect(payload.files.map((f) => f.relPath)).toEqual(["AGENTS.md"]);
    expect(payload.visible).toContain("~/.codex/AGENTS.md");
    expect(result!.enforcement.provisioning?.fidelity).toBe("partial");
    expect(readdirSync(profilesDir())).toEqual([]);
  });

  it("equal bundles give one profile digest across sessions and revisions (content-addressed)", async () => {
    rig = await bootRig();
    const a = await startComposed("Add a typed helper to the TypeScript parser module");
    const b = await startComposed("Add a typed helper to the TypeScript parser module");
    const digestOf = (taskId: string) => (JSON.parse(sessionOf(taskId).events.find((e) => e.type === "provisioning.verified")!.payload!) as ProvisioningVerifiedPayload).profileDigest;
    // Different tasks and revisions, identical bundle and launch shape: one digest.
    expect(digestOf(a.taskId)).toBe(digestOf(b.taskId));
  });
});

describe("fidelity none is recorded, a failed proof fails before start", () => {
  it("an adapter with no lifecycle records provisioning.ambient and runs as before", async () => {
    rig = await bootRig();
    const adapter = rig.built.registry.adapter("fake-claude") as AgentAdapter & Record<string, unknown>;
    adapter.prepare = undefined;
    const { taskId, state } = await startComposed("Add a typed helper to the TypeScript parser module");
    expect(state).toBe("COMPLETED");
    const { events, result } = sessionOf(taskId);
    const ambient = events.find((e) => e.type === "provisioning.ambient")!;
    expect(JSON.parse(ambient.payload!)).toEqual({ compositionRevisionId: `CR-${taskId}-1`, fidelity: "none", reason: "the adapter has no provisioning lifecycle" });
    expect(events.some((e) => e.type === "provisioning.verified" || e.type === "provisioning.disposed")).toBe(false);
    expect(result!.enforcement.provisioning).toEqual({ fidelity: "none" });
    expect(existsSync(profilesDir())).toBe(false);
  });

  it("a verification that fails settles FAILED policy_unenforceable with no provider start, and the profile is still removed", async () => {
    rig = await bootRig();
    const adapter = rig.built.registry.adapter("fake-claude");
    const realVerify = adapter.verify!.bind(adapter);
    adapter.verify = async (profile) => {
      const v = await realVerify(profile);
      return { ...v, ok: false, fidelity: "none", checks: [...v.checks, { name: "forced", ok: false, detail: "test" }] };
    };
    const { taskId } = await startComposed("Add a typed helper to the TypeScript parser module");
    const { events, result } = sessionOf(taskId);
    expect(result!.terminalState).toBe("FAILED");
    expect(result!.failure).toMatchObject({ kind: "policy_unenforceable", retryable: false });
    expect(result!.failure!.message).toMatch(/^profile verification failed: forced \(test\)$/);
    expect(events.some((e) => e.type === "run.started" || e.type === "provisioning.verified")).toBe(false);
    expect(events.at(-1)!.type).toBe("provisioning.disposed");
    expect(readdirSync(profilesDir())).toEqual([]);
  });

  it("with the composer off nothing provisions", async () => {
    rig = await bootRig({ enabled: false });
    const { taskId, state } = await startComposed("Add a typed helper to the TypeScript parser module");
    expect(state).toBe("COMPLETED");
    const { run, events, result } = sessionOf(taskId);
    expect(run.composition_revision_id).toBeNull();
    expect(events.some((e) => e.type.startsWith("provisioning."))).toBe(false);
    expect(result?.enforcement.provisioning).toBeUndefined();
    expect(existsSync(profilesDir())).toBe(false);
  });
});
