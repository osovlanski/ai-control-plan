/**
 * M6 S1 (docs/agentic-os-m6-composition-telemetry.md §5 row S1): a settled, revision-bound session
 * is projected into `asset_usage` once — from the settle path, a crash restart's release, or the
 * boot backfill. Replays write nothing, a different body under a key is a counted conflict, and
 * invocation is `not_observable` everywhere.
 */
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { assetUsageEventId, type AgentAdapter } from "@agent-plane/core";
import { PROFILE_MARKER } from "@agent-plane/adapters";
import { AssetTelemetry } from "../src/modules/asset-telemetry.js";
import { bootRig, reaches, type Rig } from "./helpers/composer-cockpit.js";

let rig: Rig | undefined;
afterEach(async () => {
  await rig?.close();
  rig = undefined;
});

const GOAL = "Add a typed helper to the TypeScript parser module";
const sha = { sha256: (t: string) => createHash("sha256").update(t, "utf8").digest("hex") };

async function startComposed(goal: string, assistantId?: string) {
  const taskId = rig!.built.tasks.create({ goal, repoPath: rig!.repo, ...(assistantId ? { overrides: { assistantId } as never } : {}) }).taskId;
  const done = reaches(rig!.built, taskId, ["COMPLETED", "FAILED", "CANCELLED", "WAITING_INPUT"]);
  const res = await rig!.built.app.inject({ method: "POST", url: `/api/tasks/${taskId}/start`, headers: rig!.auth(), payload: {} });
  expect(res.statusCode).toBe(200);
  const state = await done;
  const sessionId = (rig!.db.prepare("SELECT id FROM runs WHERE task_id = ? ORDER BY started_at, rowid LIMIT 1").get(taskId) as { id: string }).id;
  return { taskId, state, sessionId };
}

type Row = Record<string, unknown>;
const rowsOf = (sessionId: string) =>
  rig!.db.prepare("SELECT * FROM asset_usage WHERE session_id = ? ORDER BY ingest_seq").all(sessionId) as Row[];
const ledgerOf = (sessionId: string) =>
  rig!.db.prepare("SELECT * FROM asset_usage_sessions WHERE session_id = ?").get(sessionId) as Row | undefined;
const count = (table: string) => (rig!.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
const telemetry = () => new AssetTelemetry(rig!.db);

describe("asset_usage projection at settle", () => {
  it("a composed Claude run: skill runtime_confirmed, fragment files_verified, success, invocation not observable; a replay writes nothing", async () => {
    rig = await bootRig();
    const { state, sessionId } = await startComposed(GOAL);
    expect(state).toBe("COMPLETED");
    const rows = rowsOf(sessionId);
    expect(rows.map((r) => [r.asset_kind, r.asset_id, r.attached, r.validation])).toEqual([
      ["skill", "claude-skills:ts-review", 1, "runtime_confirmed"],
      ["fragment", "typescript-style", 1, "files_verified"],
    ]);
    for (const r of rows) {
      expect(r).toMatchObject({ fidelity: "full", harness: "claude-code", invocation_method: "not_observable", invocation_count: null, invocation_failed: null, session_outcome: "success", attribution_method: "co-occurrence/v1", deriver_version: 1 });
      expect(r.at).toBe((rig.db.prepare("SELECT at FROM execution_results WHERE session_id = ?").get(sessionId) as { at: string }).at);
    }
    expect(ledgerOf(sessionId)).toMatchObject({ rows: 2, deriver_version: 1 });

    const before = count("asset_usage");
    expect(telemetry().project(sessionId)).toEqual({ status: "projected", rows: 2, inserted: 0, conflicts: 0 });
    expect(count("asset_usage")).toBe(before);
    expect(() => rig!.db.prepare("UPDATE asset_usage SET attached = 0").run()).toThrow(/immutable/);
    expect(() => rig!.db.prepare("DELETE FROM asset_usage_sessions").run()).toThrow(/immutable/);
  });

  it("a different body under a stored key is a counted conflict and the first row stays", async () => {
    rig = await bootRig();
    rig.built.orchestrator.assetTelemetry = undefined;
    const { taskId, sessionId } = await startComposed(GOAL);
    // Stand in for an earlier deriver: the skill row's key already holds another body.
    const rev = (rig.db.prepare("SELECT composition_revision_id AS rev FROM runs WHERE id = ?").get(sessionId) as { rev: string }).rev;
    const skillDigest = (JSON.parse((rig.db.prepare("SELECT spec_json FROM agent_specs WHERE composition_revision_id = ?").get(rev) as { spec_json: string }).spec_json) as { assets: { skills: Array<{ digest: string }> } }).assets.skills[0]!.digest;
    const eventId = assetUsageEventId({ revision: rev, session: sessionId, kind: "skill", id: "claude-skills:ts-review", digest: skillDigest }, sha);
    rig.db.prepare(`INSERT INTO asset_usage VALUES (?, 1, ?, ?, ?, 'skill', 'claude-skills:ts-review', ?, 'claude-code', 'full', 0, 'none', 'not_observable', NULL, NULL, 'error', NULL, 'co-occurrence/v1', 0, 'sha256:older', '2000-01-01T00:00:00.000Z')`)
      .run(eventId, rev, sessionId, taskId, skillDigest);
    const t = telemetry();
    expect(t.project(sessionId)).toEqual({ status: "projected", rows: 2, inserted: 1, conflicts: 1 });
    expect(t.conflicts).toBe(1);
    expect(rig.db.prepare("SELECT body_digest, attached FROM asset_usage WHERE event_id = ?").get(eventId)).toEqual({ body_digest: "sha256:older", attached: 0 });
  });

  it("judge failed: validation failed and not_run", async () => {
    rig = await bootRig();
    const { state, sessionId } = await startComposed(`${GOAL} [FAKE:INIT:missing-skill]`);
    expect(state).toBe("FAILED");
    const rows = rowsOf(sessionId);
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(r).toMatchObject({ attached: 1, validation: "failed", session_outcome: "not_run" });
  });

  it("ambient: attached 0, validation none", async () => {
    rig = await bootRig();
    (rig.built.registry.adapter("fake-claude") as AgentAdapter & Record<string, unknown>).prepare = undefined;
    const { state, sessionId } = await startComposed(GOAL);
    expect(state).toBe("COMPLETED");
    const rows = rowsOf(sessionId);
    expect(rows.length).toBe(2);
    for (const r of rows) expect(r).toMatchObject({ attached: 0, validation: "none", fidelity: "none", session_outcome: "success" });
  });

  it("Codex partial: files_verified; the skill bundle v1 does not give Codex is not attached", async () => {
    rig = await bootRig({ assistants: { "fake-codex": { provider: "fake", options: { harness: "codex" } } } });
    const { state, sessionId } = await startComposed(GOAL);
    expect(state).toBe("COMPLETED");
    const rows = rowsOf(sessionId);
    expect(rows.find((r) => r.asset_kind === "fragment")).toMatchObject({ fidelity: "partial", attached: 1, validation: "files_verified" });
    for (const r of rows.filter((x) => x.asset_kind === "skill")) expect(r).toMatchObject({ attached: 0, validation: "none" });
  });

  it("a zero-asset session gets its ledger row and no asset rows", async () => {
    rig = await bootRig({ configure: (c) => { c.composer.context.fragments.default = []; c.composer.assets.allowlist = []; } });
    const { state, sessionId } = await startComposed("Rename a variable in the README");
    expect(state).toBe("COMPLETED");
    expect(rowsOf(sessionId)).toEqual([]);
    expect(ledgerOf(sessionId)).toMatchObject({ rows: 0 });
  });

  it("boot backfill projects a session settled before a simulated crash, and nothing twice", async () => {
    rig = await bootRig();
    rig.built.orchestrator.assetTelemetry = undefined; // the crash lands between settle and projection
    const { state, sessionId } = await startComposed(GOAL);
    expect(state).toBe("COMPLETED");
    expect(rowsOf(sessionId)).toEqual([]);
    rig.built.orchestrator.assetTelemetry = telemetry();
    await rig.built.orchestrator.reconcileOnBoot();
    expect(rowsOf(sessionId)).toHaveLength(2);
    expect(ledgerOf(sessionId)).toBeDefined();
    expect(telemetry().backfill()).toEqual({ projected: 0, inserted: 0, conflicts: 0 });
    await rig.built.orchestrator.reconcileOnBoot();
    expect(rowsOf(sessionId)).toHaveLength(2);
  });

  it("a session released by POST /restart is projected as neutral, not failed", async () => {
    rig = await bootRig({ configure: (config) => { config.policy.approvalMode = "prompt-on-escalation"; } });
    const orchestrator = rig.built.orchestrator;
    orchestrator.assetTelemetry = undefined; // the pre-crash process never projected it
    const taskId = rig.built.tasks.create({ goal: "Implement a typed helper [FAKE:APPROVAL]", repoPath: rig.repo }).taskId;
    expect((await rig.built.app.inject({ method: "POST", url: `/api/tasks/${taskId}/start`, headers: rig.auth(), payload: {} })).statusCode).toBe(200);
    const runOf = () => rig!.db.prepare("SELECT * FROM runs WHERE task_id = ? ORDER BY started_at, rowid LIMIT 1").get(taskId) as Record<string, unknown> & { id: string; session_state: string; composition_revision_id: string };
    await vi.waitFor(() => expect(runOf().session_state).toBe("AWAITING_APPROVAL"));
    const runRow = runOf();
    const sessionId = runRow.id;
    const taskRow = rig.db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId) as Record<string, unknown>;
    const verified = JSON.parse((rig.db.prepare("SELECT payload FROM events WHERE run_id = ? AND type = 'provisioning.verified'").get(sessionId) as { payload: string }).payload) as { profileDigest: string };
    // The restart-after-crash model: drain the runner, restore the pre-crash rows and profile, reboot.
    await orchestrator.shutdown();
    await vi.waitFor(() => expect((rig!.db.prepare("SELECT type FROM events WHERE run_id = ? ORDER BY seq DESC LIMIT 1").get(sessionId) as { type: string }).type).toBe("provisioning.disposed"));
    rig.db.prepare("DELETE FROM execution_results WHERE session_id = ?").run(sessionId);
    rig.db.prepare("DELETE FROM checkpoints WHERE task_id = ?").run(taskId);
    for (const [table, row, id] of [["runs", runRow, sessionId], ["tasks", taskRow, taskId]] as const) {
      rig.db.prepare(`UPDATE ${table} SET ${Object.keys(row).map((key) => `${key} = ?`).join(", ")} WHERE id = ?`).run(...Object.values(row), id);
    }
    const dir = join(rig.config.dir, "profiles", sessionId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, PROFILE_MARKER), JSON.stringify({ owner: "agent-plane", sessionId, compositionRevisionId: runRow.composition_revision_id, profileDigest: verified.profileDigest }));
    orchestrator.assetTelemetry = telemetry();
    await orchestrator.reconcileOnBoot();
    expect(rowsOf(sessionId)).toEqual([]); // offered for resume: still live, nothing settled

    expect((await rig.built.app.inject({ method: "POST", url: `/api/tasks/${taskId}/restart`, headers: rig.auth(), payload: {} })).statusCode).toBe(200);
    const rows = rowsOf(sessionId);
    expect(rows.length).toBe(2);
    expect(rows.map((r) => [r.asset_kind, r.attached, r.validation, r.session_outcome])).toEqual([
      ["skill", 1, "runtime_confirmed", "neutral"],
      ["fragment", 1, "files_verified", "neutral"],
    ]);
  });

  it("no FAKE value reaches the new tables", async () => {
    rig = await bootRig();
    await startComposed(GOAL);
    await startComposed(`${GOAL} [FAKE:INIT:none]`);
    const dump = JSON.stringify([...rig.db.prepare("SELECT * FROM asset_usage").all(), ...rig.db.prepare("SELECT * FROM asset_usage_sessions").all()]);
    expect(count("asset_usage")).toBeGreaterThan(0);
    expect(dump).not.toMatch(/FAKE/);
  });
});
