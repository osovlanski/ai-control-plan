/**
 * M3 S5 (plans/m3-provisioning.md row S5): a `full` profile is proven by the provider itself. The
 * first event must be `run.started` carrying `profileEvidence` for the verified digest with every
 * check passing; otherwise the session fails policy_unenforceable before RUNNING (the provider
 * start is never acknowledged) and the profile is still disposed. `partial` profiles promise no
 * runtime proof and are not judged. The fake reports Claude-shaped init; `[FAKE:INIT:<drift>]`
 * scripts a mismatch.
 */
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ExecutionResult, ProfileRuntimeEvidence, ProvisioningVerifiedPayload } from "@agent-plane/core";
import { bootRig, reaches, type Rig } from "./helpers/composer-cockpit.js";

let rig: Rig | undefined;
afterEach(async () => {
  await rig?.close();
  rig = undefined;
});

const GOAL = "Add a typed helper to the TypeScript parser module";
const profilesDir = () => join(rig!.config.dir, "profiles");

async function startComposed(goal: string, assistantId?: string) {
  const taskId = rig!.built.tasks.create({ goal, repoPath: rig!.repo, ...(assistantId ? { overrides: { assistantId } as never } : {}) }).taskId;
  const done = reaches(rig!.built, taskId, ["COMPLETED", "FAILED", "CANCELLED", "WAITING_INPUT"]);
  const res = await rig!.built.app.inject({ method: "POST", url: `/api/tasks/${taskId}/start`, headers: rig!.auth(), payload: {} });
  expect(res.statusCode).toBe(200);
  return { taskId, state: await done };
}

function sessionOf(taskId: string) {
  const run = rig!.db.prepare("SELECT id, provider_start_acked FROM runs WHERE task_id = ? ORDER BY started_at, rowid LIMIT 1").get(taskId) as { id: string; provider_start_acked: number };
  const events = rig!.db.prepare("SELECT type, summary, payload FROM events WHERE run_id = ? ORDER BY seq").all(run.id) as Array<{ type: string; summary: string; payload: string | null }>;
  const resultRow = rig!.db.prepare("SELECT result FROM execution_results WHERE session_id = ?").get(run.id) as { result: string } | undefined;
  const payloadOf = <T>(type: string) => {
    const e = events.find((x) => x.type === type);
    return e?.payload ? (JSON.parse(e.payload) as T) : undefined;
  };
  return { run, events, payloadOf, result: resultRow ? (JSON.parse(resultRow.result) as ExecutionResult) : undefined };
}

describe("a full profile is proven by the provider's startup inventory", () => {
  it("a faithful init passes: evidence for the verified digest is recorded on run.started and the run completes", async () => {
    rig = await bootRig();
    const { taskId, state } = await startComposed(GOAL);
    expect(state).toBe("COMPLETED");
    const { run, payloadOf } = sessionOf(taskId);
    expect(run.provider_start_acked).toBe(1);
    const verified = payloadOf<ProvisioningVerifiedPayload>("provisioning.verified")!;
    const evidence = payloadOf<{ profileEvidence: ProfileRuntimeEvidence }>("run.started")!.profileEvidence;
    expect(evidence.ok).toBe(true);
    expect(evidence.profileDigest).toBe(verified.profileDigest);
    expect(evidence.checks.map((c) => c.name)).toEqual(["runtime_plugins", "runtime_skills", "runtime_mcp"]);
  });

  it.each([
    ["extra-plugin", /^the provider's startup inventory does not match the profile \(runtime_plugins: plugins outside the profile loaded: user-plugin\)$/],
    ["missing-skill", /^the provider's startup inventory does not match the profile \(runtime_skills: profile skills not loaded: agent-plane-profile:ts-review\)$/],
    ["none", /^the provider reported no startup inventory, so the full profile sha256:[0-9a-f]{64} is unproven$/],
  ])("drift %s fails policy_unenforceable before RUNNING, records the evidence, and still disposes", async (drift, message) => {
    rig = await bootRig();
    const { taskId, state } = await startComposed(`${GOAL} [FAKE:INIT:${drift}]`);
    expect(state).toBe("FAILED");
    const { run, events, result } = sessionOf(taskId);
    expect(run.provider_start_acked).toBe(0);
    expect(result!.terminalState).toBe("FAILED");
    expect(result!.failure).toMatchObject({ kind: "policy_unenforceable", retryable: false });
    expect(result!.failure!.message).toMatch(message);
    const types = events.map((e) => e.type);
    // The judged run.started is kept for the operator; nothing the provider did after it is.
    expect(types).toContain("run.started");
    expect(events.some((e) => e.summary.startsWith("Fake launched with profile"))).toBe(false);
    expect(types.at(-1)).toBe("provisioning.disposed");
    expect(readdirSync(profilesDir())).toEqual([]);
  });

  it("a partial (Codex) profile is not judged: the same drift marker completes", async () => {
    rig = await bootRig({ assistants: { "fake-codex": { provider: "fake", options: { harness: "codex" } } } });
    const { taskId, state } = await startComposed(`${GOAL} [FAKE:INIT:none]`, "fake-codex");
    expect(state).toBe("COMPLETED");
    const { payloadOf } = sessionOf(taskId);
    expect(payloadOf<ProvisioningVerifiedPayload>("provisioning.verified")!.fidelity).toBe("partial");
    expect(payloadOf<{ profileEvidence?: unknown }>("run.started")!.profileEvidence).toBeUndefined();
  });
});
