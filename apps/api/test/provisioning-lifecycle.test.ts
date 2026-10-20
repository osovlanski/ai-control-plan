/**
 * M3 S3 (plans/m3-provisioning.md §3): profiles across a task's lifecycle. A K11 continuation on
 * the same revision provisions again under its own session and verifies the same digest. A
 * cross-harness failover never receives the source profile: the destination's revision binds its
 * own. A boot sweep removes owned profiles a crash left behind and never touches what the plane
 * cannot prove it owns.
 */
import { mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ExecutionSessionState, NormalizedEvent, ProvisioningVerifiedPayload } from "@agent-plane/core";
import { PROFILE_MARKER } from "@agent-plane/adapters";
import { sweepProfiles } from "../src/modules/harness/profile-sweep.js";
import { bootRig, reaches, type Rig } from "./helpers/composer-cockpit.js";

let rig: Rig | undefined;
let scratch: string | undefined;
let instant = Date.parse("2030-01-01T00:00:00.000Z");
const now = () => new Date(instant);
afterEach(async () => {
  await rig?.close();
  rig = undefined;
  if (scratch) rmSync(scratch, { recursive: true, force: true });
  scratch = undefined;
});

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
    profile(root, "S-gone");
    profile(root, "S-nomarker", "S-nomarker", false);
    profile(root, "S-other", "S-someone-else");
    profile(root, staging, "S-ended");
    profile(root, "S-ended.staging-11111111-2222-4333-8444-555555555555", "S-ended", false);
    mkdirSync(join(scratch, "elsewhere"));
    writeFileSync(join(scratch, "elsewhere", PROFILE_MARKER), marker("S-link"));
    symlinkSync(join(scratch, "elsewhere"), join(root, "S-link"));
    writeFileSync(join(root, "stray.txt"), "x");

    const states: Record<string, ExecutionSessionState> = { "S-ended": "FAILED", "S-live": "RUNNING", "S-nomarker": "COMPLETED", "S-other": "COMPLETED", "S-link": "COMPLETED" };
    const recorded: Array<{ sessionId: string; events: NormalizedEvent[] }> = [];
    const result = sweepProfiles({ root, sessionState: (sid) => states[sid], record: (sessionId, events) => recorded.push({ sessionId, events }), now: () => new Date(instant) });

    expect(result.removed).toEqual(["S-ended", staging, "S-gone"].sort());
    expect(result.retained).toEqual(["S-live"]);
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
