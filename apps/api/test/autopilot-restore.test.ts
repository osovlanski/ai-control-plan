/**
 * P0-7b (docs/agentic-os-auto-copilot-plan.md §C.5 "Restore fails closed", D-11 local half).
 *
 * - The backup script's module: an online, integrity-checked copy with a manifest; pruning; a
 *   restore that refuses a tampered copy and a database another process holds open, writes the
 *   marker before it swaps the file, and moves the current database aside without deleting it.
 * - A restore end to end on a fake GitHub: the backup was taken while the autopilot ran; after it,
 *   another reservation, a PR and worktrees appeared. The restored plane boots stopped, a start
 *   is refused until one complete reconciliation was read back through `autopilot.operate`, and
 *   the report reattaches known refs, records unknown ones as external (never re-run), matches
 *   marker PRs, quarantines orphan worktrees (never deletes), suspends a running attempt whose
 *   session is gone, and reports the agent slice.
 * - The window that was open when the restore was detected admits no launch, even after a start;
 *   the next window does.
 */
import { execFileSync, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AGENT_USER_DEFAULTS, loadConfig } from "../src/config.js";
import { generateOperateSecret, operateSecretPath, writeOperateSecretHash } from "../src/auth/operate-secret.js";
import { openDb } from "../src/db/index.js";
import { buildServer, type BuiltServer } from "../src/server.js";
import { reservationMessage } from "../src/modules/autopilot-dispatcher.js";
import { detectRestore, RESTORE_MARKER_FILE, type RestoreReport } from "../src/modules/autopilot-restore.js";
import { holdersOf, pruneLocal, restoreBackup, takeBackup, directoryDestination, parseDestination } from "../src/modules/backup.js";
import { GitHubError, GitHubRestClient, type GitCommit, type PullRequest, type ReconcileGitHub, type PublicationGitHub } from "../src/modules/publications.js";
import { bootRig, type Rig } from "./helpers/composer-cockpit.js";

const T0 = Date.parse("2030-01-01T23:00:00.000Z");
const MIN = 60_000;
const REPO = "osovlanski/demo";
let instant = T0;
const now = () => new Date(instant);
const at = (ms: number) => new Date(ms).toISOString();
const hex = (n: number) => n.toString(16).padStart(40, "0");

let rig: Rig | undefined;
const extra: Array<{ built: BuiltServer; db: ReturnType<typeof openDb> }> = [];
afterEach(async () => {
  for (const e of extra.splice(0)) { await e.built.app.close(); if (e.db.open) e.db.close(); }
  if (rig) { try { execFileSync("chmod", ["-R", "u+w", rig.root]); } catch { /* ignore */ } }
  await rig?.close();
  rig = undefined;
  instant = T0;
});

/** GitHub's side, in memory: commits, branches and PRs. Reads can be made to fail. */
class FakeGitHub implements ReconcileGitHub, PublicationGitHub {
  commits = new Map<string, GitCommit>();
  branches = new Map<string, string>();
  prs: PullRequest[] = [];
  fail?: GitHubError;
  reads = 0;
  private n = 1;
  commit(message: string, parent?: string): string {
    const sha = hex(this.n++);
    this.commits.set(sha, { sha, message, parents: parent ? [parent] : [] });
    return sha;
  }
  async listBranches(_repo: string, prefix: string) {
    this.reads++;
    if (this.fail) throw this.fail;
    return [...this.branches].filter(([b]) => b.startsWith(prefix)).map(([branch, sha]) => ({ branch, sha }));
  }
  async listPulls() { this.reads++; if (this.fail) throw this.fail; return this.prs.map((p) => ({ ...p })); }
  async getCommit(_repo: string, sha: string) { return this.commits.get(sha) ?? null; }
  async getBranchSha(_repo: string, branch: string) { return this.branches.get(branch) ?? null; }
  async listPullsForHead(_repo: string, branch: string) { return this.prs.filter((p) => p.headRef === branch); }
  async createPull(): Promise<PullRequest> { throw new Error("TEST: no PR is created by a reconciliation"); }
  pr(number: number, head: string, marker: string | null, merged = false): void {
    this.prs.push({ number, state: merged ? "closed" : "open", merged, body: marker ? `Draft.\n\naos-publication: ${marker}\n` : "no marker", headRef: head, headSha: this.branches.get(head) ?? hex(999), headRepo: REPO, baseRef: "main" });
  }
}

/* ---------------------------------------------------------------- backup -- */

describe("backup script module (D-11 local half)", () => {
  it("takes an online, integrity-checked copy, prunes old ones, and restores fail-closed", async () => {
    rig = await bootRig({ now });
    const db = rig.db;
    db.prepare("UPDATE autopilot_state SET status = 'running', stop_reason = NULL WHERE id = 1").run();
    const local = join(rig.root, "backups");
    const offsite = join(rig.root, "offsite");
    // An old copy the prune must remove, and a file it must never touch.
    mkdirSync(local, { recursive: true });
    writeFileSync(join(local, "agent-plane-20291201T000000Z.db"), "old");
    writeFileSync(join(local, "agent-plane-20291201T000000Z.json"), "{}");
    writeFileSync(join(local, "notes.txt"), "keep me");

    const taken = await takeBackup({ dbPath: rig.config.dbPath, localDir: local, keepDays: 7, destination: directoryDestination(offsite), now });
    expect(taken.manifest).toMatchObject({ name: "agent-plane-20300101T230000Z.db", integrity: "ok", lastMigration: "051_runtime_lifecycle.sql" });
    expect(taken.pruned).toEqual(["agent-plane-20291201T000000Z.db"]);
    expect(readdirSync(local).sort()).toEqual(["agent-plane-20300101T230000Z.db", "agent-plane-20300101T230000Z.json", "notes.txt"]);
    expect(readdirSync(offsite).sort()).toEqual(["agent-plane-20300101T230000Z.db", "agent-plane-20300101T230000Z.json"]);
    expect((execFileSync("stat", ["-c", "%a", taken.path], { encoding: "utf8" })).trim()).toBe("600");
    expect(() => parseDestination("oci:bucket")).toThrow(/only dir:/);

    // After the backup the database moves on.
    db.prepare("UPDATE autopilot_state SET stop_reason = 'after-backup' WHERE id = 1").run();

    // A process holding the database open refuses the restore (the plane is still up).
    const holder = spawn(process.execPath, ["-e", `require("fs").openSync(${JSON.stringify(rig.config.dbPath)}, "r"); setTimeout(() => {}, 60000)`], { stdio: "ignore" });
    try {
      await new Promise((r) => setTimeout(r, 300));
      expect(holdersOf(rig.config.dbPath)).toContain(holder.pid);
      expect(() => restoreBackup({ dbPath: rig!.config.dbPath, workspaceDir: rig!.config.dir, backupPath: taken.path })).toThrow(/hold .* open: stop the plane first/);
    } finally { holder.kill(); }
    expect(existsSync(join(rig.config.dir, RESTORE_MARKER_FILE))).toBe(false);

    // A tampered copy is refused before anything changes.
    const fetched = await directoryDestination(offsite).get(taken.manifest.name, join(rig.root, "fetched"));
    writeFileSync(fetched, Buffer.concat([readFileSync(fetched), Buffer.from("x")]));
    db.close();
    expect(() => restoreBackup({ dbPath: rig!.config.dbPath, workspaceDir: rig!.config.dir, backupPath: fetched })).toThrow(/does not match its manifest/);
    expect(existsSync(join(rig.config.dir, RESTORE_MARKER_FILE))).toBe(false);

    instant += 30 * MIN;
    const restored = restoreBackup({ dbPath: rig.config.dbPath, workspaceDir: rig.config.dir, backupPath: taken.path, now });
    const marker = JSON.parse(readFileSync(join(rig.config.dir, RESTORE_MARKER_FILE), "utf8"));
    expect(marker).toEqual({ restoredAt: at(instant), backup: taken.manifest.name, backupTakenAt: at(T0), backupSha256: taken.manifest.sha256 });
    expect(restored.movedAside[0]).toMatch(/agent-plane\.db\.pre-restore-20300101T233000Z$/);
    expect(existsSync(restored.movedAside[0]!)).toBe(true);
    const back = openDb(rig.config.dbPath);
    try {
      expect(back.prepare("SELECT status, stop_reason FROM autopilot_state").get()).toEqual({ status: "running", stop_reason: null });
      // The plane's boot detection: one transaction stops it and records the restore; the marker moves aside.
      const first = detectRestore(back, rig.config.dir, now)!;
      expect(first.recorded).toBe(true);
      expect(back.prepare("SELECT status, stop_reason FROM autopilot_state").get()).toEqual({ status: "stopped", stop_reason: "restored" });
      expect(existsSync(join(rig.config.dir, RESTORE_MARKER_FILE))).toBe(false);
      expect(existsSync(join(rig.config.dir, `${RESTORE_MARKER_FILE}.consumed-${first.restoreId}`))).toBe(true);
      // A crash before the marker moved: the same marker is the same restore, recorded once.
      writeFileSync(join(rig.config.dir, RESTORE_MARKER_FILE), readFileSync(join(rig.config.dir, `${RESTORE_MARKER_FILE}.consumed-${first.restoreId}`)));
      expect(detectRestore(back, rig.config.dir, now)).toEqual({ restoreId: first.restoreId, recorded: false });
      // An unreadable marker still counts: the plane cannot tell what happened.
      writeFileSync(join(rig.config.dir, RESTORE_MARKER_FILE), "not json");
      expect(detectRestore(back, rig.config.dir, now)?.recorded).toBe(true);
      expect(back.prepare("SELECT COUNT(*) AS n FROM autopilot_restores").get()).toEqual({ n: 2 });
    } finally { back.close(); }
    expect(pruneLocal(local, 7, new Date(T0 + 8 * 86_400_000))).toEqual(["agent-plane-20300101T230000Z.db"]);
  });
});

/* -------------------------------------------------------- restore e2e -- */

async function bootAutopilot(gh: FakeGitHub, slice: { ok: boolean }): Promise<Rig> {
  rig = await bootRig({
    now,
    requireRevision: true,
    assistants: { "fake-claude": { provider: "fake", options: { agentUser: true } } },
    configure: (config) => {
      const tree = join(config.dir, "..", "aos");
      mkdirSync(join(tree, "worktrees", "acceptance"), { recursive: true });
      mkdirSync(join(tree, "profiles"), { recursive: true });
      chmodSync(join(tree, "profiles"), 0o2750);
      config.execution.agentUser = { ...AGENT_USER_DEFAULTS, profilesRoot: join(tree, "profiles"), worktreesRoot: join(tree, "worktrees") };
      config.scheduler = { ...config.scheduler!, resources: { "oci-heavy": 1 } };
      config.autopilot.repos = { "ai-control-plan": { github: REPO, path: config.repoAllowlist[0]!, base: "main" } };
    },
    autopilotHostGate: () => ({ ok: true }),
    serverDeps: deps(gh, slice),
  });
  return rig;
}
const deps = (gh: FakeGitHub, slice: { ok: boolean }) => ({
  autopilotGitHub: gh,
  autopilotRestoreAgentSlice: () => (slice.ok ? { ok: true as const } : { ok: false as const, detail: "TEST: agent slice is not empty: user-1001.slice/aos-run-x.scope: 1 process(es)" }),
});

describe("a restored database fails closed (§C.5)", () => {
  it("boots stopped, refuses a start until one complete report is read back, and reconciles refs, PRs, worktrees, attempts and the slice", async () => {
    const gh = new FakeGitHub();
    const slice = { ok: false };
    await bootAutopilot(gh, slice);
    const r = rig!;
    const ap = r.built.autopilot;
    const base = gh.commit("base");
    gh.branches.set("main", base);
    const window = ap.addWindow({ opensAt: at(T0 - 60 * MIN), closesAt: at(T0 + 6 * 60 * MIN) }, "op_test");
    const nextWindow = ap.addWindow({ opensAt: at(T0 + 24 * 60 * MIN), closesAt: at(T0 + 30 * 60 * MIN) }, "op_test");
    ap.attest({ extraUsageOff: true, autoReloadOff: true }, "op_test");
    ap.start("op_test");

    // alpha: published (a final attempt with its publication and a merged PR).
    const a1 = ap.reserve({ itemId: "alpha", reservationId: "res-alpha", repo: "ai-control-plan", baseSha: base });
    const resAlpha = gh.commit(reservationMessage("alpha", "oci-loop", "res-alpha"), base);
    gh.branches.set("os/alpha", gh.commit("work", resAlpha));
    ap.reservationOwned(a1.id, resAlpha, "created");
    ap.admit(a1.id, { goal: "alpha", repoPath: r.repo });
    r.db.prepare("UPDATE autopilot_attempts SET state = 'published', final_at = ? WHERE id = ?").run(at(T0), a1.id);
    r.db.prepare(`INSERT INTO autopilot_publications(id, attempt_id, repo, base, head, repo_path, remote, reservation_sha, verified_sha, title, body, state, pr_number, created_at, updated_at)
      VALUES('pub-alpha', ?, ?, 'main', 'os/alpha', ?, 'origin', ?, ?, 't', 'b', 'published', 101, ?, ?)`).run(a1.id, REPO, r.repo, resAlpha, gh.branches.get("os/alpha"), at(T0), at(T0));
    gh.pr(101, "os/alpha", "pub-alpha", true);

    // beta: admitted, then running (its session will not survive the restore).
    const a2 = ap.reserve({ itemId: "beta", reservationId: "res-beta", repo: "ai-control-plan", baseSha: base });
    const resBeta = gh.commit(reservationMessage("beta", "oci-loop", "res-beta"), base);
    gh.branches.set("os/beta", resBeta);
    ap.reservationOwned(a2.id, resBeta, "created");
    const t2 = ap.admit(a2.id, { goal: "beta", repoPath: r.repo }).taskId!;
    r.db.prepare("UPDATE autopilot_attempts SET state = 'running' WHERE id = ?").run(a2.id);
    const agentRoot = r.config.execution.agentUser!.worktreesRoot;
    mkdirSync(join(agentRoot, t2));

    // The nightly backup, taken while the autopilot runs.
    const backup = await takeBackup({ dbPath: r.config.dbPath, localDir: join(r.root, "backups"), keepDays: 7, now });

    // After the backup (lost from the database, still on GitHub and on disk):
    instant += 20 * MIN;
    const resGamma = gh.commit(reservationMessage("gamma", "oci-loop", "res-gamma-lost"), base);
    gh.branches.set("os/gamma", resGamma);
    gh.pr(102, "os/gamma", "pub-gamma-lost");
    gh.branches.set("os/delta", gh.commit("someone's branch", base));
    gh.pr(103, "os/delta", null);
    mkdirSync(join(agentRoot, "task_lost"));
    writeFileSync(join(agentRoot, "task_lost", "work.txt"), "unsaved work");
    mkdirSync(join(agentRoot, "acceptance", "acr_leftover"));
    mkdirSync(join(r.config.dir, "worktrees", "orphan"), { recursive: true });

    // The box dies. The plane is stopped; the restore script puts the backup back.
    await r.built.app.close();
    r.db.close();
    instant += 10 * MIN;
    restoreBackup({ dbPath: r.config.dbPath, workspaceDir: r.config.dir, backupPath: backup.path, now });

    // The plane boots on the restored database.
    instant += MIN;
    const db = openDb(r.config.dbPath);
    const built = buildServer({ config: r.config, db, now, composerHostname: "fake-host-s6.example", autopilotHostGate: () => ({ ok: true }), ...deps(gh, slice) });
    extra.push({ built, db });
    await built.app.ready();
    const op = generateOperateSecret();
    writeOperateSecretHash(operateSecretPath(r.config.dir), op.hash);
    const call = async (method: "GET" | "POST", url: string, secret?: string, payload?: unknown) => {
      const res = await built.app.inject({ method, url, headers: { authorization: secret ? `Bearer ${secret}` : r.auth().authorization }, ...(payload ? { payload: payload as Record<string, unknown> } : {}) });
      return { status: res.statusCode, body: res.json() as Record<string, unknown> };
    };

    const status = (await call("GET", "/api/autopilot")).body;
    expect(status).toMatchObject({ status: "stopped", stopReason: "restored", restore: { pending: true, startBlockedBy: { setting: "restore.reconcile" } } });
    expect((status.window as { exhaustedByRestore?: string }).exhaustedByRestore).toMatch(/^aprs_/);
    expect((await call("POST", "/api/autopilot/start", op.secret)).body).toMatchObject({ error: "autopilot_start_refused", setting: "restore.reconcile" });
    // Who may: the ordinary credential neither reconciles nor reads the report.
    expect((await call("POST", "/api/autopilot/restore/reconcile")).status).toBe(403);
    expect((await call("GET", "/api/autopilot/restore/report")).status).toBe(403);

    // GitHub unreadable: the report is incomplete and never unlocks a start.
    gh.fail = new GitHubError("transient", 503, "GET matching-refs: HTTP 503");
    const incomplete = await call("POST", "/api/autopilot/restore/reconcile", op.secret);
    expect(incomplete.body).toMatchObject({ pending: true, reportComplete: false, startBlockedBy: { setting: "restore.reconcile", detail: expect.stringContaining("incomplete") } });
    const incompleteAttempts = ((await call("GET", "/api/autopilot/restore/report", op.secret)).body.report as RestoreReport).attempts;
    expect((await call("POST", "/api/autopilot/start", op.secret)).body).toMatchObject({ setting: "restore.reconcile" });
    gh.fail = undefined;

    const done = await call("POST", "/api/autopilot/restore/reconcile", op.secret);
    expect(done.body).toMatchObject({ pending: true, reportComplete: true, startBlockedBy: { setting: "restore.report" } });
    // The summary is readable with tasks.read; the report itself is not in it.
    expect((await call("GET", "/api/autopilot/restore")).body).toMatchObject({ summary: { refs: { reattached: 2, external: 2 }, pulls: { matched: 1, external: 1 }, quarantined: 3, agentSliceEmpty: false } });
    expect((await call("POST", "/api/autopilot/start", op.secret)).body).toMatchObject({ setting: "restore.report" });

    const read = await call("GET", "/api/autopilot/restore/report", op.secret);
    expect(read.status).toBe(200);
    const report = read.body.report as RestoreReport;
    expect(read.body.digest).toBe(done.body.reportDigest);
    expect(report).toMatchObject({ complete: true, problems: [], backup: { name: backup.manifest.name, sha256: backup.manifest.sha256 } });
    expect(report.refs).toEqual([
      expect.objectContaining({ branch: "os/alpha", outcome: "reattached", attemptId: a1.id, reservationSha: resAlpha }),
      expect.objectContaining({ branch: "os/beta", outcome: "reattached", attemptId: a2.id }),
      expect.objectContaining({ branch: "os/delta", outcome: "external", itemId: "delta", detail: expect.stringContaining("no reservation commit") }),
      expect.objectContaining({ branch: "os/gamma", outcome: "external", reservationId: "res-gamma-lost", itemId: "gamma" }),
    ]);
    expect(report.pulls).toEqual([
      expect.objectContaining({ number: 101, outcome: "matched", publicationId: "pub-alpha", merged: true }),
      expect.objectContaining({ number: 102, outcome: "external", marker: "pub-gamma-lost" }),
    ]);
    expect(report.publications).toEqual([expect.objectContaining({ id: "pub-alpha", state: "published", markerPr: 101 })]);
    // Orphans moved aside, never deleted; the restored task's worktree stays.
    expect(report.worktrees.quarantined.map((q) => q.path).sort()).toEqual([join(agentRoot, "acceptance", "acr_leftover"), join(agentRoot, "task_lost"), join(r.config.dir, "worktrees", "orphan")].sort());
    expect(report.worktrees.failed).toEqual([]);
    expect(existsSync(join(agentRoot, t2))).toBe(true);
    expect(existsSync(join(agentRoot, "task_lost"))).toBe(false);
    const moved = report.worktrees.quarantined.find((q) => q.path.endsWith("task_lost"))!.to;
    expect(readFileSync(join(moved, "work.txt"), "utf8")).toBe("unsaved work");
    expect(execFileSync("stat", ["-c", "%a", join(agentRoot, ".quarantine")], { encoding: "utf8" }).trim()).toBe("700");
    // beta's attempt: running with no live session → suspended; nothing launched.
    // (The incomplete run above already applied the rule; the report says so.)
    expect(incompleteAttempts).toEqual([expect.objectContaining({ id: a2.id, state: "running", after: "suspended", rule: expect.stringContaining("did not survive") })]);
    expect(report.attempts).toEqual([expect.objectContaining({ id: a2.id, state: "suspended", after: "suspended", rule: expect.stringContaining("did not survive") })]);
    expect(built.autopilot.attempt(a2.id)).toMatchObject({ state: "suspended", reason: expect.stringContaining("restored") });
    expect(db.prepare("SELECT COUNT(*) AS n FROM runs").get()).toEqual({ n: 0 });
    expect(report.agentSlice).toMatchObject({ probed: true, empty: false, detail: expect.stringContaining("host gate stays closed") });
    expect(report.windows).toEqual([{ id: window.id, opensAt: window.opensAt, closesAt: window.closesAt }]);
    // External reservations are recorded and never re-run.
    expect(built.autopilot.externalReservationOf("gamma")).toBe("res-gamma-lost");
    expect(built.autopilot.externalReservationOf("delta")).toMatch(/no reservation commit/);
    expect(built.autopilot.externalReservationOf("beta")).toBeUndefined();

    // Read back: the start is accepted and clears the restore. The window stays exhausted.
    const started = await call("POST", "/api/autopilot/start", op.secret);
    expect(started.status).toBe(200);
    expect(started.body).toMatchObject({ status: "running", window: { id: window.id, exhaustedByRestore: expect.stringMatching(/^aprs_/) } });
    expect((await call("GET", "/api/autopilot/restore")).body).toMatchObject({ pending: false, reportReadCurrent: true });
    expect((await call("POST", "/api/autopilot/restore/reconcile", op.secret)).status).toBe(409);
    expect(built.autopilot.windows().find((w) => w.id === nextWindow.id)?.exhaustedByRestore).toBeUndefined();
    // A later reconciliation would need a new read: shown by a second restore below.
    expect(db.prepare("SELECT cleared_by FROM autopilot_restores").all()).toEqual([{ cleared_by: expect.any(String) }]);
  });

  it("a new report needs a new read, and a reserving attempt whose ref holds its reservation is reattached", async () => {
    const gh = new FakeGitHub();
    await bootAutopilot(gh, { ok: true });
    const r = rig!;
    const ap = r.built.autopilot;
    const base = gh.commit("base");
    const a = ap.reserve({ itemId: "eps", reservationId: "res-eps", repo: "ai-control-plan", baseSha: base });
    const res = gh.commit(reservationMessage("eps", "oci-loop", "res-eps"), base);
    gh.branches.set("os/eps", res); // the create landed; the plane died before recording it
    writeFileSync(join(r.config.dir, RESTORE_MARKER_FILE), JSON.stringify({ restoredAt: at(T0) }));
    expect(detectRestore(r.db, r.config.dir, now)?.recorded).toBe(true);
    const restore = r.built.restore;

    await restore.reconcile();
    const first = restore.readReport("op_test");
    expect(first.report.attempts).toEqual([expect.objectContaining({ id: a.id, state: "reserving", after: "reserving", rule: expect.stringContaining("reattached") })]);
    expect(ap.attempt(a.id)).toMatchObject({ reservationSha: res, reservationOutcome: "owned" });
    expect(restore.blocker()).toBeUndefined();

    instant += MIN;
    await restore.reconcile();
    expect(restore.blocker()).toMatchObject({ setting: "restore.report" });
    expect(() => ap.start("op_test")).toThrow(/restore\.report/);
    restore.readReport("op_test");
    expect(ap.start("op_test").status).toBe("running");
  });
});

/* ------------------------------------------------- exhausted window -- */

describe("the window open at a restore is exhausted (§C.5)", () => {
  it("refuses every launch in it, even after a start, and the next window launches", async () => {
    const gh = new FakeGitHub();
    await bootAutopilot(gh, { ok: true });
    const r = rig!;
    const ap = r.built.autopilot;
    const tonight = ap.addWindow({ opensAt: at(T0 - MIN), closesAt: at(T0 + 8 * 60 * MIN) }, "op_test");
    const next = ap.addWindow({ opensAt: at(T0 + 24 * 60 * MIN), closesAt: at(T0 + 30 * 60 * MIN) }, "op_test");
    ap.attest({ extraUsageOff: true, autoReloadOff: true }, "op_test");
    writeFileSync(join(r.config.dir, RESTORE_MARKER_FILE), JSON.stringify({ restoredAt: at(T0) }));
    instant += 5 * MIN;
    detectRestore(r.db, r.config.dir, now);
    gh.branches.clear();
    await r.built.restore.reconcile();
    r.built.restore.readReport("op_test");
    ap.start("op_test");
    expect(ap.openWindow()).toMatchObject({ id: tonight.id, exhaustedByRestore: expect.any(String) });

    const head = execFileSync("git", ["-C", r.repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    const reserved = ap.reserve({ itemId: "zeta", reservationId: "res-zeta", reservationSha: head });
    const taskId = ap.admit(reserved.id, { goal: "zeta", repoPath: r.repo }).taskId!;
    const parkedTo = new Promise<string>((resolve) => {
      const off = r.built.bus.subscribe(taskId, (p) => { if (p.kind === "state" && ["WAITING_RESOURCE", "WAITING_INPUT", "COMPLETED"].includes(p.state!.state) && r.built.scheduler.events(taskId).some((e) => e.type === "autopilot.parked")) { off(); resolve(p.state!.state); } });
    });
    await r.built.scheduler.tick();
    expect(await parkedTo).toBe("WAITING_RESOURCE");
    const parked = r.built.scheduler.events(taskId).filter((e) => e.type === "autopilot.parked").map((e) => e.payload);
    expect(parked[0]).toMatchObject({ reason: "window_closed", park: "time", notBefore: next.opensAt, detail: expect.stringContaining("restore") });
    expect(r.db.prepare("SELECT COUNT(*) AS n FROM runs WHERE task_id = ?").get(taskId)).toEqual({ n: 0 });
    expect(r.db.prepare("SELECT COUNT(*) AS n FROM autopilot_window_charges").get()).toEqual({ n: 0 });

    instant = Date.parse(next.opensAt) + 1000;
    const settled = new Promise<string>((resolve) => {
      const off = r.built.bus.subscribe(taskId, (p) => { if (p.kind === "state" && ["COMPLETED", "FAILED"].includes(p.state!.state)) { off(); resolve(p.state!.state); } });
    });
    await r.built.scheduler.tick();
    expect(await settled).toBe("COMPLETED");
    expect(r.db.prepare("SELECT window_id FROM autopilot_window_charges").all()).toEqual([{ window_id: next.id }]);
  });
});

/* --------------------------------------------------- config and REST -- */

describe("restore plumbing", () => {
  it("validates autopilot.backup in config", () => {
    const home = mkdtempSync(join(tmpdir(), "bk-config-"));
    mkdirSync(join(home, "personal"), { recursive: true });
    const load = (yaml: string) => { writeFileSync(join(home, "personal", "config.yaml"), yaml); return loadConfig({ AGENT_PLANE_HOME: home }); };
    expect(load("autopilot:\n  backup: {}\n").autopilot.backup).toEqual({ keepDays: 7 });
    expect(load("autopilot:\n  backup:\n    localDir: /var/backups/plane\n    keepDays: 3\n    destination: dir:/mnt/offsite\n").autopilot.backup)
      .toEqual({ localDir: "/var/backups/plane", keepDays: 3, destination: "dir:/mnt/offsite" });
    expect(load("autopilot: {}\n").autopilot.backup).toBeUndefined();
    expect(() => load("autopilot:\n  backup:\n    destination: oci://bucket\n")).toThrow(/dir:\/absolute\/path/);
    expect(() => load("autopilot:\n  backup:\n    localDir: rel\n")).toThrow(/absolute, normalized/);
    expect(() => load("autopilot:\n  backup:\n    key: x\n")).toThrow(/unknown key/);
  });

  it("the REST client pages os/* refs and every PR, and refuses an unbounded list", async () => {
    const seen: string[] = [];
    const page = (n: number, make: (i: number) => unknown) => Array.from({ length: n }, (_, i) => make(i));
    const pr = (i: number) => ({ number: i + 1, state: "open", body: `aos-publication: p${i}`, head: { ref: `os/i${i}`, sha: hex(i), repo: { full_name: REPO } }, base: { ref: "main" } });
    const client = new GitHubRestClient({
      apiBase: "http://127.0.0.1:1", token: () => "FAKE-token-not-real",
      fetch: (async (u: string | URL | Request) => {
        const url = new URL(String(u));
        seen.push(url.pathname + url.search);
        const p = Number(url.searchParams.get("page"));
        if (url.pathname.endsWith("/git/matching-refs/heads/os/")) return Response.json(page(p === 1 ? 100 : 3, (i) => ({ ref: `refs/heads/os/x${p}-${i}`, object: { sha: hex(i) } })));
        if (url.pathname.endsWith("/pulls")) return Response.json(p === 1 ? page(100, pr) : page(1, (i) => pr(100 + i)));
        return new Response("{}", { status: 404 });
      }) as typeof fetch,
    });
    const refs = await client.listBranches(REPO, "os/");
    expect(refs).toHaveLength(103);
    expect(refs[0]).toEqual({ branch: "os/x1-0", sha: hex(0) });
    expect((await client.listPulls(REPO))).toHaveLength(101);
    expect(seen.filter((s) => s.includes("pulls"))).toEqual([
      `/repos/${REPO}/pulls?state=all&per_page=100&page=1&sort=created&direction=asc`, `/repos/${REPO}/pulls?state=all&per_page=100&page=2&sort=created&direction=asc`,
    ]);
    await expect(client.listBranches(REPO, "os")).rejects.toThrow(/must end with/);
    const endless = new GitHubRestClient({ apiBase: "http://127.0.0.1:1", token: () => "FAKE-token-not-real", fetch: (async () => Response.json(page(100, pr))) as typeof fetch });
    await expect(endless.listPulls(REPO)).rejects.toMatchObject({ kind: "unknown", message: expect.stringContaining("more than 3000") });
  });
});

/* ------------------------------------------- P0-7c external records -- */

describe("itay dismisses an external record (P0-7c)", () => {
  it("lists externals, dismisses one through autopilot.operate, keeps it on a re-run, and reopens it on a new restore", async () => {
    const gh = new FakeGitHub();
    await bootAutopilot(gh, { ok: true });
    const r = rig!;
    const ap = r.built.autopilot;
    const base = gh.commit("base");
    gh.branches.set("os/theta", gh.commit(reservationMessage("theta", "oci-loop", "res-theta-lost"), base));
    gh.pr(104, "os/theta", "pub-theta-lost");
    writeFileSync(join(r.config.dir, RESTORE_MARKER_FILE), JSON.stringify({ restoredAt: at(T0) }));
    detectRestore(r.db, r.config.dir, now);
    await r.built.restore.reconcile();
    expect(ap.externalReservationOf("theta")).toBe("res-theta-lost");

    const op = generateOperateSecret();
    writeOperateSecretHash(operateSecretPath(r.config.dir), op.hash);
    const call = async (method: "GET" | "POST", url: string, secret?: string, payload?: unknown) => {
      const res = await r.built.app.inject({ method, url, headers: { authorization: secret ? `Bearer ${secret}` : r.auth().authorization }, ...(payload ? { payload: payload as Record<string, unknown> } : {}) });
      return { status: res.statusCode, body: res.json() as Record<string, unknown> };
    };

    const listed = (await call("GET", "/api/autopilot/externals")).body.externals as Array<{ id: number; kind: string; head: string; resolution: unknown }>;
    expect(listed.map((x) => [x.kind, x.head, x.resolution])).toEqual([["publication", "os/theta", null], ["reservation", "os/theta", null]]);
    const reservation = listed.find((x) => x.kind === "reservation")!;
    const report = async () => ((await call("GET", "/api/autopilot/report")).body.unresolvedEffects as Array<{ kind: string; externalId?: number }>).filter((e) => e.kind === "external_record").map((e) => e.externalId).sort();
    expect(await report()).toEqual(listed.map((x) => x.id).sort());

    // Who may, and what is refused.
    expect((await call("POST", `/api/autopilot/externals/${reservation.id}/resolve`, undefined, { action: "dismiss" })).status).toBe(403);
    expect(await call("POST", `/api/autopilot/externals/${reservation.id}/resolve`, op.secret, { action: "adopt" })).toEqual({ status: 400, body: { error: "action must be dismiss" } });
    expect((await call("POST", `/api/autopilot/externals/${reservation.id}/resolve`, op.secret, { action: "dismiss", note: "x".repeat(501) })).status).toBe(400);
    expect((await call("POST", "/api/autopilot/externals/999/resolve", op.secret, { action: "dismiss" })).status).toBe(404);
    expect((await call("POST", "/api/autopilot/externals/abc/resolve", op.secret, { action: "dismiss" })).status).toBe(400);

    instant += MIN;
    const dismissed = await call("POST", `/api/autopilot/externals/${reservation.id}/resolve`, op.secret, { action: "dismiss", note: " my manual lane; ref deleted " });
    expect(dismissed.status).toBe(200);
    expect(dismissed.body.external).toMatchObject({ id: reservation.id, resolution: { action: "dismissed", at: at(instant), by: expect.any(String), note: "my manual lane; ref deleted" } });
    expect((await call("POST", `/api/autopilot/externals/${reservation.id}/resolve`, op.secret, { action: "dismiss" })).status).toBe(409);
    expect(ap.externalReservationOf("theta")).toBeUndefined();
    expect(((await call("GET", "/api/autopilot/externals")).body.externals as unknown[]).length).toBe(1);
    expect(((await call("GET", "/api/autopilot/externals?all=1")).body.externals as unknown[]).length).toBe(2);
    expect(await report()).toEqual([listed.find((x) => x.kind === "publication")!.id]);

    // A re-run of the same restore's reconciliation keeps the decision.
    await r.built.restore.reconcile();
    expect(ap.externalReservationOf("theta")).toBeUndefined();

    // A new restore that finds the same ref again reopens it.
    instant += MIN;
    writeFileSync(join(r.config.dir, RESTORE_MARKER_FILE), JSON.stringify({ restoredAt: at(instant) }));
    expect(detectRestore(r.db, r.config.dir, now)?.recorded).toBe(true);
    await r.built.restore.reconcile();
    expect(ap.externalReservationOf("theta")).toBe("res-theta-lost");
    expect(r.db.prepare("SELECT COUNT(*) AS n FROM autopilot_externals").get()).toEqual({ n: 2 });
  });
});
