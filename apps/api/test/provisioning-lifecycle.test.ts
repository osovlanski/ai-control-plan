/**
 * M3 S3 (plans/m3-provisioning.md §3): profiles across a task's lifecycle. A K11 continuation on
 * the same revision provisions again under its own session and verifies the same digest. A
 * cross-harness failover never receives the source profile: the destination's revision binds its
 * own. A boot sweep removes owned profiles a crash left behind and never touches what the plane
 * cannot prove it owns.
 */
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExecutionSessionState, NormalizedEvent, ProvisioningVerifiedPayload } from "@agent-plane/core";
import { PROFILE_MARKER } from "@agent-plane/adapters";
import type { HarnessRecovery } from "../src/modules/harness/recovery.js";
import { sweepProfiles } from "../src/modules/harness/profile-sweep.js";
import { processAlive } from "../src/modules/harness/provider-processes.js";
import { bootRig, reaches, type Rig } from "./helpers/composer-cockpit.js";

let rig: Rig | undefined;
let scratch: string | undefined;
let instant = Date.parse("2030-01-01T00:00:00.000Z");
const now = () => new Date(instant);
afterEach(async () => {
  await rig?.built.orchestrator.shutdown();
  await rig?.close();
  rig = undefined;
  if (scratch) rmSync(scratch, { recursive: true, force: true });
  scratch = undefined;
});

// Exercise the production-wired recovery without adding a public server surface.
const recovery = () => (rig!.built.orchestrator as unknown as { harnessRecovery: HarnessRecovery }).harnessRecovery;
const profilesDir = () => join(rig!.config.dir, "profiles");
const runsOf = (taskId: string) => rig!.db.prepare("SELECT id, assistant_id, composition_revision_id FROM runs WHERE task_id = ? ORDER BY started_at, rowid").all(taskId) as Array<{ id: string; assistant_id: string; composition_revision_id: string }>;
const eventsOf = (runId: string) => rig!.db.prepare("SELECT type, payload FROM events WHERE run_id = ? ORDER BY seq").all(runId) as Array<{ type: string; payload: string | null }>;
const verifiedOf = (runId: string) => {
  const e = eventsOf(runId).find((x) => x.type === "provisioning.verified");
  return e ? (JSON.parse(e.payload!) as ProvisioningVerifiedPayload) : undefined;
};

describe("a task's sessions and their profiles", () => {
  it("a K11 continuation reuses the revision and verifies the same profile digest under its own session", async () => {
    rig = await bootRig({ now, assistants: { "fake-a": { provider: "fake" } } });
    const id = rig.built.tasks.create({ goal: "implement the change [FAKE:CONTEXT:0.96>0.3]", repoPath: rig.repo, overrides: { assistantId: "fake-a" } as never }).taskId;
    rig.built.scheduler.attach(id, { kind: "time", notBefore: new Date(instant + 1000).toISOString() });
    instant += 1000;
    const done = reaches(rig.built, id, ["COMPLETED", "FAILED", "CANCELLED", "WAITING_INPUT"]);
    await rig.built.scheduler.tick();
    expect(await done).toBe("COMPLETED");

    const [first, second] = runsOf(id);
    expect(second!.composition_revision_id).toBe(first!.composition_revision_id);
    const a = verifiedOf(first!.id)!;
    const b = verifiedOf(second!.id)!;
    expect(b.profileDigest).toBe(a.profileDigest);
    for (const run of [first!, second!]) expect(eventsOf(run.id).at(-1)!.type).toBe("provisioning.disposed");
    expect(readdirSync(profilesDir())).toEqual([]);
  });

  it("a claude-code to codex failover binds a new revision whose profile is the destination's own (risk 9)", async () => {
    rig = await bootRig({
      now,
      assistants: { "fake-a": { provider: "fake" }, "fake-b": { provider: "fake", options: { harness: "codex" } } },
    });
    const id = rig.built.tasks.create({ goal: "Ship the feature [FAKE:LIMIT]", repoPath: rig.repo }).taskId;
    const res = await rig.built.app.inject({ method: "POST", url: `/api/tasks/${id}/start`, headers: rig.auth(), payload: {} });
    expect(res.statusCode).toBe(200);
    expect(await rig.built.orchestrator.waitForSettled(id)).toBe("COMPLETED");

    const [source, destination] = runsOf(id);
    expect(new Set([source!.assistant_id, destination!.assistant_id])).toEqual(new Set(["fake-a", "fake-b"]));
    expect(destination!.composition_revision_id).not.toBe(source!.composition_revision_id);
    const a = verifiedOf(source!.id)!;
    const b = verifiedOf(destination!.id)!;
    // Each session verified the profile of its own harness: full for claude-code, partial for codex.
    const expected = { "fake-a": ["claude-code", "full"], "fake-b": ["codex", "partial"] } as const;
    expect([a.harness, a.fidelity]).toEqual(expected[source!.assistant_id as "fake-a" | "fake-b"]);
    expect([b.harness, b.fidelity]).toEqual(expected[destination!.assistant_id as "fake-a" | "fake-b"]);
    expect(b.profileDigest).not.toBe(a.profileDigest);
    expect(b.compositionRevisionId).toBe(destination!.composition_revision_id);
    expect(readdirSync(profilesDir())).toEqual([]);
  });
});

describe("boot sweep", () => {
  const marker = (sessionId: string) => JSON.stringify({ owner: "agent-plane", sessionId, compositionRevisionId: `CR-${sessionId}`, profileDigest: `sha256:${"cd".repeat(32)}` });
  const profile = (root: string, name: string, sessionId = name, withMarker = true) => {
    mkdirSync(join(root, name, "plugin"), { recursive: true });
    writeFileSync(join(root, name, "CLAUDE.md"), "x");
    if (withMarker) writeFileSync(join(root, name, PROFILE_MARKER), marker(sessionId));
  };

  it("removes owned profiles of ended or unknown sessions, keeps live ones, and leaves what it cannot prove it owns", () => {
    scratch = mkdtempSync(join(tmpdir(), "agent-plane-sweep-"));
    const root = join(scratch, "profiles");
    mkdirSync(root);
    const staging = "S-ended.staging-0f0e0d0c-0b0a-4908-8706-050403020100";
    profile(root, "S-ended");
    profile(root, "S-live");
    profile(root, "S-starting");
    profile(root, "S-gone");
    profile(root, "S-nomarker", "S-nomarker", false);
    profile(root, "S-other", "S-someone-else");
    profile(root, staging, "S-ended");
    profile(root, "S-ended.staging-11111111-2222-4333-8444-555555555555", "S-ended", false);
    mkdirSync(join(scratch, "elsewhere"));
    writeFileSync(join(scratch, "elsewhere", PROFILE_MARKER), marker("S-link"));
    symlinkSync(join(scratch, "elsewhere"), join(root, "S-link"));
    writeFileSync(join(root, "stray.txt"), "x");

    const states: Record<string, ExecutionSessionState> = { "S-ended": "FAILED", "S-live": "RUNNING", "S-starting": "STARTING", "S-nomarker": "COMPLETED", "S-other": "COMPLETED", "S-link": "COMPLETED" };
    const recorded: Array<{ sessionId: string; events: NormalizedEvent[] }> = [];
    const result = sweepProfiles({ root, sessionState: (sid) => states[sid], record: (sessionId, events) => recorded.push({ sessionId, events }), now: () => new Date(instant) });

    expect(result.removed).toEqual(["S-ended", staging, "S-gone"].sort());
    expect(result.retained).toEqual(["S-live", "S-starting"]);
    expect(result.unowned).toEqual(["S-ended.staging-11111111-2222-4333-8444-555555555555", "S-link", "S-nomarker", "S-other", "stray.txt"]);
    expect(readdirSync(root).sort()).toEqual([...result.retained, ...result.unowned].sort());
    expect(readdirSync(join(scratch, "elsewhere"))).toEqual([PROFILE_MARKER]); // never followed the link
    // A witness on each ended session that still has a row; none for the unknown one.
    expect(recorded.map((r) => [r.sessionId, r.events[0]!.type, r.events[0]!.payload])).toEqual([
      ["S-ended", "provisioning.swept", { compositionRevisionId: "CR-S-ended", profileDigest: `sha256:${"cd".repeat(32)}`, staging: false }],
      ["S-ended", "provisioning.swept", { compositionRevisionId: "CR-S-ended", profileDigest: `sha256:${"cd".repeat(32)}`, staging: true }],
    ]);
  });

  it("with no profiles directory there is nothing to do", () => {
    scratch = mkdtempSync(join(tmpdir(), "agent-plane-sweep-"));
    expect(sweepProfiles({ root: join(scratch, "profiles"), sessionState: () => undefined, record: () => {} })).toEqual({ removed: [], retained: [], unowned: [] });
  });

  it("periodically sweeps a crash-left profile after a resume-offered session is cancelled", async () => {
    rig = await bootRig({ configure: (config) => { config.policy.approvalMode = "prompt-on-escalation"; } });
    const id = rig.built.tasks.create({ goal: "Implement a typed helper [FAKE:APPROVAL]", repoPath: rig.repo }).taskId;
    expect((await rig.built.app.inject({ method: "POST", url: `/api/tasks/${id}/start`, headers: rig.auth(), payload: {} })).statusCode).toBe(200);
    const [run] = runsOf(id);
    expect(run!.composition_revision_id).toBeTruthy();
    await vi.waitFor(() => expect(rig!.db.prepare("SELECT session_state FROM runs WHERE id = ?").get(run!.id)).toEqual({ session_state: "AWAITING_APPROVAL" }));
    const beforeCrash = rig.db.prepare("SELECT * FROM runs WHERE id = ?").get(run!.id) as Record<string, unknown>;
    expect(beforeCrash.session_state).toBe("AWAITING_APPROVAL");
    expect(beforeCrash.provider_session_ref).toBeTruthy();
    // Drain the in-process runner, then restore its pre-crash durable session row and profile.
    // This models a dead runner without leaving a real runner racing recovery in the test.
    await rig.built.orchestrator.shutdown();
    await vi.waitFor(() => expect(eventsOf(run!.id).at(-1)?.type).toBe("provisioning.disposed"));
    rig.db.prepare("DELETE FROM execution_results WHERE session_id = ?").run(run!.id);
    rig.db.prepare(`UPDATE runs SET ${Object.keys(beforeCrash).map((key) => `${key} = ?`).join(", ")} WHERE id = ?`).run(...Object.values(beforeCrash), run!.id);
    profile(profilesDir(), run!.id);

    expect(await recovery().reconcileOnBoot()).toContainEqual(expect.objectContaining({ sessionId: run!.id, action: "resume_offered" }));
    expect(readdirSync(profilesDir())).toContain(run!.id);
    await rig.built.orchestrator.cancelTask(id);
    expect(await recovery().recoverSession(run!.id)).toMatchObject({ sessionId: run!.id, action: "cancelled" });
    expect(rig.db.prepare("SELECT session_state FROM runs WHERE id = ?").get(run!.id)).toEqual({ session_state: "CANCELLED" });
    expect(readdirSync(profilesDir())).toContain(run!.id);
    expect(await recovery().sweepExpiredLeases()).toEqual([]);
    expect(readdirSync(profilesDir())).not.toContain(run!.id);
    expect(eventsOf(run!.id).at(-1)?.type).toBe("provisioning.swept");
    expect(JSON.parse(eventsOf(run!.id).at(-1)!.payload!)).toEqual({ compositionRevisionId: `CR-${run!.id}`, profileDigest: `sha256:${"cd".repeat(32)}`, staging: false });
    await recovery().sweepExpiredLeases();
    expect(eventsOf(run!.id).filter((e) => e.type === "provisioning.swept")).toHaveLength(1);
  });

  it("keeps a RUNNING session's verified profile while its runner holds a valid lease", async () => {
    rig = await bootRig();
    const id = rig.built.tasks.create({ goal: "Implement a typed helper [FAKE:APPROVAL]", repoPath: rig.repo }).taskId;
    expect((await rig.built.app.inject({ method: "POST", url: `/api/tasks/${id}/start`, headers: rig.auth(), payload: {} })).statusCode).toBe(200);
    const [run] = runsOf(id);
    const state = () => rig!.db.prepare("SELECT session_state, lease_token FROM runs WHERE id = ?").get(run!.id) as { session_state: string; lease_token: string };
    await vi.waitFor(() => expect(state().session_state).toBe("RUNNING"), { interval: 1 });
    const lease = state().lease_token;
    expect(lease).toBeTruthy();
    expect(verifiedOf(run!.id)).toBeDefined();
    expect(readdirSync(profilesDir())).toContain(run!.id);

    expect(await recovery().sweepExpiredLeases()).toEqual([]);
    expect(state()).toEqual({ session_state: "RUNNING", lease_token: lease });
    expect(readdirSync(profilesDir())).toContain(run!.id);
    expect(eventsOf(run!.id).some((e) => e.type === "provisioning.swept")).toBe(false);
  });

  const completedRun = async () => {
    rig = await bootRig();
    const id = rig.built.tasks.create({ goal: "Add a typed helper to the TypeScript parser module", repoPath: rig.repo }).taskId;
    const done = reaches(rig.built, id, ["COMPLETED", "FAILED", "CANCELLED", "WAITING_INPUT"]);
    expect((await rig.built.app.inject({ method: "POST", url: `/api/tasks/${id}/start`, headers: rig.auth(), payload: {} })).statusCode).toBe(200);
    expect(await done).toBe("COMPLETED");
    const [run] = runsOf(id);
    return run!.id;
  };
  const setLease = (sessionId: string, token: string | null, expiresInMs = 0) =>
    rig!.db.prepare("UPDATE runs SET lease_token = ?, lease_expires_at = ? WHERE id = ?")
      .run(token, token ? new Date(Date.now() + expiresInMs).toISOString() : null, sessionId);
  const swept = (sessionId: string) => eventsOf(sessionId).filter((e) => e.type === "provisioning.swept").length;

  it("keeps a terminal session's profile while its runner still holds the lease, and takes it on the pass after release", async () => {
    const sid = await completedRun();
    // Stand in for the teardown window: the state is terminal, the runner has not disposed or released yet.
    profile(profilesDir(), sid);
    setLease(sid, "lease_tearing-down", 60_000);

    expect(await recovery().sweepExpiredLeases()).toEqual([]);
    expect(readdirSync(profilesDir())).toContain(sid);
    expect(swept(sid)).toBe(0);

    setLease(sid, null);
    await recovery().sweepExpiredLeases();
    expect(readdirSync(profilesDir())).not.toContain(sid);
    expect(swept(sid)).toBe(1);
  });

  it("still sweeps a terminal session's profile when the lease it left has expired", async () => {
    const sid = await completedRun();
    profile(profilesDir(), sid);
    setLease(sid, "lease_crash-left", -1_000);

    await recovery().sweepExpiredLeases();
    expect(readdirSync(profilesDir())).not.toContain(sid);
    expect(swept(sid)).toBe(1);
  });

  it("the boot sweep still decides on state alone: a dead incarnation's unexpired lease keeps nothing", async () => {
    const sid = await completedRun();
    profile(profilesDir(), sid);
    setLease(sid, "lease_dead-incarnation", 60_000);

    await rig!.built.orchestrator.reconcileOnBoot();
    expect(readdirSync(profilesDir())).not.toContain(sid);
    expect(swept(sid)).toBe(1);
  });

  it("a real runner tearing down a slow-exit provider keeps its profile through a periodic sweep and disposes it itself", async () => {
    rig = await bootRig();
    // FAKE slow-exit provider: a real child the runner tracks. It survives SIGTERM until the test closes
    // its stdin, so the teardown window stays open on the test's word rather than on a timer. It reports
    // "ready" only once the handler is installed, so a SIGTERM can never land on Node's default action.
    const child = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => { process.stdin.on('end', () => process.exit(0)).resume(); }); process.stdout.write('ready\\n'); setInterval(() => {}, 1000);"], { stdio: ["pipe", "pipe", "ignore"] });
    const exited = once(child, "exit");
    await once(child.stdout!, "data");
    const spawnedAt = new Date().toISOString();
    // The runner's own liveness test (zombie = gone), not ChildProcess.exitCode, which is set only when
    // Node delivers the exit event — after the runner may already have seen the process die.
    const alive = () => processAlive(child.pid!);
    const adapter = rig.built.registry.adapter("fake-claude") as { providerProcess?: unknown };
    adapter.providerProcess = () => ({ pid: child.pid!, spawnedAt, alive });
    try {
      const id = rig.built.tasks.create({ goal: "Add a typed helper to the TypeScript parser module", repoPath: rig.repo }).taskId;
      expect((await rig.built.app.inject({ method: "POST", url: `/api/tasks/${id}/start`, headers: rig.auth(), payload: {} })).statusCode).toBe(200);
      const [run] = runsOf(id);
      const row = () => rig!.db.prepare("SELECT session_state, lease_token FROM runs WHERE id = ?").get(run!.id) as { session_state: string; lease_token: string | null };
      // The teardown window: terminal state written, provider still exiting, lease still held.
      await vi.waitFor(() => expect(row().session_state).toBe("COMPLETED"), { interval: 5, timeout: 5_000 });
      expect(alive()).toBe(true);
      expect(row().lease_token).toBeTruthy();
      expect(readdirSync(profilesDir())).toContain(run!.id);

      await recovery().sweepExpiredLeases();
      expect(readdirSync(profilesDir())).toContain(run!.id);
      expect(swept(run!.id)).toBe(0);
      expect(alive()).toBe(true);
      expect(row().lease_token).toBeTruthy();

      child.stdin!.end(); // let the provider finish exiting
      await vi.waitFor(() => expect(row().lease_token).toBeNull(), { interval: 25, timeout: 10_000 });
      expect(alive()).toBe(false);
      expect(eventsOf(run!.id).at(-1)?.type).toBe("provisioning.disposed");
      expect(readdirSync(profilesDir())).not.toContain(run!.id);
      expect(swept(run!.id)).toBe(0);
    } finally {
      child.kill("SIGKILL");
      await exited;
    }
  });

  it("runs at boot after recovery: a crash-left profile of a settled session is swept and witnessed on its timeline", async () => {
    rig = await bootRig();
    const id = rig.built.tasks.create({ goal: "Add a typed helper to the TypeScript parser module", repoPath: rig.repo }).taskId;
    const done = reaches(rig.built, id, ["COMPLETED", "FAILED", "CANCELLED", "WAITING_INPUT"]);
    expect((await rig.built.app.inject({ method: "POST", url: `/api/tasks/${id}/start`, headers: rig.auth(), payload: {} })).statusCode).toBe(200);
    expect(await done).toBe("COMPLETED");
    const [run] = runsOf(id);
    // Stand in for a crash between provision and dispose: the same profile, left on disk.
    profile(profilesDir(), run!.id);
    mkdirSync(join(profilesDir(), "not-ours"));

    await rig.built.orchestrator.reconcileOnBoot();
    expect(readdirSync(profilesDir())).toEqual(["not-ours"]);
    const last = eventsOf(run!.id).at(-1)!;
    expect(last.type).toBe("provisioning.swept");
    expect(JSON.parse(last.payload!)).toEqual({ compositionRevisionId: `CR-${run!.id}`, profileDigest: `sha256:${"cd".repeat(32)}`, staging: false });
  });
});
