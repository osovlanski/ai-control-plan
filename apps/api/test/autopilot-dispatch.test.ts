/**
 * P0-6 (docs/agentic-os-auto-copilot-plan.md §C.2.1, §C.2.2, §C.3): the in-plane dispatcher on a
 * fake GitHub whose refs and commits live in a real bare repository, with the fake provider, a
 * local acceptance executor and the real publisher.
 *
 * - The loop with no human step (G15's shape, fake): select from an empty queue → reservation
 *   commit + create-ref → task + wait in one transaction → launch → settled → acceptance on the
 *   checkpoint → draft PR with the marker. Then the next item waits for its dependency's merge.
 * - G11: a create whose response is lost (landed or not), another lane's reservation at the same
 *   base (seen before selection, and racing between selection and create-ref), a branch with no
 *   reservation commit, a GitHub commit SHA that differs from the local one, 401.
 * - G23: a stale local HEAD (the task starts at the reservation SHA, which sits on the fetched
 *   origin), and ownership recovered from history after work was pushed on top of the reservation.
 * - G24: a crash between create-ref and the task insert leaves `reserving` with the outcome
 *   recorded, and the next tick admits exactly one task.
 * - Retries reuse the ref only while it holds nothing but the earlier reservation.
 */
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AGENT_USER_DEFAULTS } from "../src/config.js";
import type { AcceptanceExecutor } from "../src/modules/acceptance-run.js";
import { dispatchGitCli, itemRevision, parseReservation, reservationMessage, type DispatchGit } from "../src/modules/autopilot-dispatcher.js";
import { GitHubError, gitCli, markerOf, type GitCommit, type PullRequest, type ReservationCommitInput, type ReservationGitHub, type PublicationGitHub } from "../src/modules/publications.js";
import { bootRig, reaches, type Rig } from "./helpers/composer-cockpit.js";

const GIT_ENV = {
  ...process.env, GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "commit.gpgsign", GIT_CONFIG_VALUE_0: "false",
  GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid",
};
// The plane's own `git commit` (the checkpoint) reads the process environment; a CI runner has no identity.
Object.assign(process.env, GIT_ENV);
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", env: GIT_ENV }).trim();
const gitIn = (cwd: string, input: string, env: Record<string, string>, ...args: string[]) =>
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", input, env: { ...GIT_ENV, ...env } }).trim();

const T0 = Date.parse("2030-01-01T23:00:00.000Z");
const MIN = 60_000;
const REPO = "osovlanski/demo";
let instant = T0;
const now = () => new Date(instant);
const at = (ms: number) => new Date(ms).toISOString();

/** GitHub's REST side for reservations and publications. Refs and commits are the bare repository's; PRs live here. */
class FakeGitHub implements ReservationGitHub, PublicationGitHub {
  prs: PullRequest[] = [];
  refCreates: Array<{ branch: string; sha: string; answer: string }> = [];
  commitCreates = 0;
  /** What the next create-ref calls do: lose the response after landing, lose it without landing, or answer 401. */
  refMode: Array<"lose-and-land" | "lose-no-land" | "401"> = [];
  /** Runs right before a create-ref lands (another lane racing us). */
  beforeCreateRef?: (branch: string) => void;
  /** Serialise the reservation commit differently from git (a different date), as a GitHub that normalises might. */
  skewCommitDate = false;
  private nextNumber = 100;
  /** Set by the rig's configure step, once the bare repository exists. */
  bare = "";

  async getBranchSha(_repo: string, branch: string) {
    try { return git(this.bare, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`); } catch { return null; }
  }
  async listPullsForHead(_repo: string, branch: string) { return this.prs.filter((p) => p.headRef === branch).map((p) => ({ ...p })); }
  async getCommit(_repo: string, sha: string): Promise<GitCommit | null> {
    let raw: string;
    try { raw = execFileSync("git", ["-C", this.bare, "cat-file", "commit", sha], { encoding: "utf8" }); } catch { return null; }
    const [head, ...rest] = raw.split("\n\n");
    const parents = head!.split("\n").filter((l) => l.startsWith("parent ")).map((l) => l.slice(7));
    return { sha, message: rest.join("\n\n"), parents };
  }
  async createCommit(_repo: string, c: ReservationCommitInput) {
    this.commitCreates++;
    const date = `${Math.floor(Date.parse(c.date) / 1000) + (this.skewCommitDate ? 1 : 0)} +0000`;
    return gitIn(this.bare, c.message, { GIT_AUTHOR_NAME: c.name, GIT_AUTHOR_EMAIL: c.email, GIT_AUTHOR_DATE: date, GIT_COMMITTER_NAME: c.name, GIT_COMMITTER_EMAIL: c.email, GIT_COMMITTER_DATE: date },
      "commit-tree", c.tree, "-p", c.parent, "-F", "-");
  }
  async createRef(_repo: string, branch: string, sha: string): Promise<"created" | "exists"> {
    const mode = this.refMode.shift();
    if (mode === "401") throw new GitHubError("auth", 401, "POST git/refs: HTTP 401");
    if (mode === "lose-no-land") { this.refCreates.push({ branch, sha, answer: "lost, not landed" }); throw new GitHubError("unknown", undefined, "POST git/refs: The operation was aborted due to timeout"); }
    this.beforeCreateRef?.(branch);
    this.beforeCreateRef = undefined;
    // Create-if-absent, atomically: the empty old value makes update-ref refuse an existing ref.
    let created = true;
    try { execFileSync("git", ["-C", this.bare, "update-ref", `refs/heads/${branch}`, sha, ""], { stdio: "pipe" }); } catch { created = false; }
    this.refCreates.push({ branch, sha, answer: created ? (mode ? "201, response lost" : "201") : "422" });
    if (mode === "lose-and-land") throw new GitHubError("unknown", undefined, "POST git/refs: The operation was aborted due to timeout");
    return created ? "created" : "exists";
  }
  async createPull(_repo: string, input: { title: string; head: string; base: string; body: string; draft: boolean }) {
    const pr: PullRequest = { number: ++this.nextNumber, url: `https://github.invalid/${REPO}/pull/${this.nextNumber}`, state: "open", merged: false, draft: input.draft,
      body: input.body, headRef: input.head, headSha: git(this.bare, "rev-parse", `refs/heads/${input.head}`), headRepo: REPO, baseRef: input.base };
    this.prs.push(pr);
    return { ...pr };
  }
  /** A ref another lane made: its own reservation commit on `base`. */
  foreignReservation(item: string, base: string, lane = "manual-cloud"): string {
    const tree = git(this.bare, "rev-parse", `${base}^{tree}`);
    const sha = gitIn(this.bare, reservationMessage(item, lane, "manual-res-1"), {}, "commit-tree", tree, "-p", base, "-F", "-");
    git(this.bare, "update-ref", `refs/heads/os/${item}`, sha, "");
    return sha;
  }
  /** A commit on top of `os/<item>` (work pushed after the reservation). */
  pushWork(item: string): string {
    const head = git(this.bare, "rev-parse", `refs/heads/os/${item}`);
    const sha = gitIn(this.bare, "work\n", {}, "commit-tree", `${head}^{tree}`, "-p", head, "-F", "-");
    git(this.bare, "update-ref", `refs/heads/os/${item}`, sha, head);
    return sha;
  }
}

/** The real git CLI, with a fetch of `os/*` that can fail (the plane dying between create-ref and the task insert). */
class FlakyGit implements DispatchGit {
  failOsFetches = 0;
  private readonly real = dispatchGitCli();
  async fetch(repoPath: string, refspecs: string[]) {
    if (this.failOsFetches > 0 && refspecs.some((r) => r.includes("refs/heads/os/"))) { this.failOsFetches--; throw new Error("git fetch: connection reset"); }
    return this.real.fetch(repoPath, refspecs);
  }
  revParse(repoPath: string, rev: string) { return this.real.revParse(repoPath, rev); }
  show(repoPath: string, rev: string, path: string) { return this.real.show(repoPath, rev, path); }
  commitTree(repoPath: string, input: Parameters<DispatchGit["commitTree"]>[1]) { return this.real.commitTree(repoPath, input); }
}

/** Runs once, the next time an acceptance command starts (someone pushing during the run). */
let onExec: (() => void) | undefined;
/** Runs the command as the test user in the snapshot (TEST-ONLY: online, so the server allows it explicitly). */
function localExecutor(): AcceptanceExecutor {
  return {
    offline: false,
    stop: async () => {},
    exec: (req) => new Promise((resolve) => {
      const hook = onExec; onExec = undefined; hook?.();
      try {
        const output = execFileSync("/bin/sh", ["-c", req.command], { cwd: req.cwd, encoding: "utf8", stdio: "pipe" });
        resolve({ exitCode: 0, signal: null, output });
      } catch (err) {
        resolve({ exitCode: (err as { status?: number }).status ?? 1, signal: null, output: String((err as { stderr?: string }).stderr ?? "") });
      }
    }),
  };
}

interface Item { id: string; depends_on?: string[]; lane?: string; night?: boolean; run?: string }
const backlogYaml = (items: Item[]) => [
  "version: 1", "items:",
  ...items.flatMap((i) => [
    `  - id: ${i.id}`, `    title: "Do ${i.id}"`, `    phase: "test"`, `    repo: ai-control-plan`, `    size: S`,
    `    depends_on: [${(i.depends_on ?? []).join(", ")}]`, `    files: ["${i.id}.txt"]`, `    lane: ${i.lane ?? "oci-loop"}`, `    profile: auto`, `    night: ${i.night ?? true}`,
    `    notes: "Write ${i.id}.txt."`,
    `    acceptance:`, `      commands:`, `        - { run: "${i.run ?? `test -f ${i.id}.txt`}", replaySafe: true }`, `      writable: ["out"]`,
  ]),
].join("\n") + "\n";

let rig: Rig | undefined;
let gh: FakeGitHub;
let flaky: FlakyGit;
let idle: { ok: boolean };
afterEach(async () => {
  if (rig) { try { execFileSync("chmod", ["-R", "u+w", rig.root]); } catch { /* ignore */ } }
  await rig?.close();
  rig = undefined;
  instant = T0;
});

async function boot(items: Item[]): Promise<Rig> {
  idle = { ok: true };
  onExec = undefined;
  flaky = new FlakyGit();
  gh = new FakeGitHub();
  rig = await bootRig({
    now,
    requireRevision: true,
    assistants: { "fake-claude": { provider: "fake", options: { agentUser: true } } },
    configure: (config) => {
      const repo = config.repoAllowlist[0]!;
      const root = join(config.dir, "..");
      const tree = join(root, "aos");
      mkdirSync(join(tree, "worktrees"), { recursive: true });
      mkdirSync(join(tree, "profiles"), { recursive: true });
      chmodSync(join(tree, "profiles"), 0o2750);
      config.execution.agentUser = { ...AGENT_USER_DEFAULTS, profilesRoot: join(tree, "profiles"), worktreesRoot: join(tree, "worktrees") };
      config.scheduler = { ...config.scheduler!, resources: { "oci-heavy": 1 } };
      config.autopilot.repos = { "ai-control-plan": { github: REPO, path: repo, base: "main" } };
      // origin: a bare repository holding main with the backlog on it.
      const bare = join(root, "origin.git");
      gh.bare = bare;
      execFileSync("git", ["init", "-q", "--bare", "-b", "main", bare]);
      mkdirSync(join(repo, "docs", "progress"), { recursive: true });
      writeFileSync(join(repo, "docs", "progress", "backlog.yaml"), backlogYaml(items));
      git(repo, "add", ".");
      git(repo, "commit", "-q", "-m", "backlog");
      git(repo, "remote", "add", "origin", bare);
      git(repo, "push", "-q", "origin", "main");
    },
    autopilotHostGate: () => ({ ok: true }),
    serverDeps: {
      acceptanceExecutor: localExecutor(),
      acceptanceAgentIdle: () => (idle.ok ? { ok: true } : { ok: false, detail: "TEST: agent slice held" }),
      publicationSleep: async () => {},
      autopilotGit: gitCli(30_000),
      autopilotGitHub: gh,
      autopilotDispatchGit: flaky,
    },
  });
  return rig;
}

const ap = () => rig!.built.autopilot;
const dispatcher = () => rig!.built.dispatcher;
/** A window open now, a current attestation and a running autopilot. */
function open(maxItems = 3) {
  ap().addWindow({ opensAt: at(instant - MIN), closesAt: at(instant + 8 * 60 * MIN), maxItems }, "op_test");
  ap().attest({ extraUsageOff: true, autoReloadOff: true }, "op_test");
  ap().start("op_test");
}
const bareRef = (branch: string) => { try { return git(gh.bare, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`); } catch { return null; } };
const originMain = () => git(gh.bare, "rev-parse", "refs/heads/main");
const tasks = () => rig!.db.prepare("SELECT id FROM tasks").all() as Array<{ id: string }>;
/** Another clone pushes to origin main, so the plane's clone (and its HEAD) is stale. */
function advanceOrigin(): string {
  const other = join(rig!.root, `other-${Date.now()}`);
  execFileSync("git", ["clone", "-q", gh.bare, other], { env: GIT_ENV });
  writeFileSync(join(other, "upstream.txt"), "moved on\n");
  git(other, "add", ".");
  git(other, "commit", "-q", "-m", "upstream change");
  git(other, "push", "-q", "origin", "main");
  return git(other, "rev-parse", "HEAD");
}
/** Launch the admitted task and let it complete with the fake provider. */
async function runTask(taskId: string): Promise<void> {
  const done = reaches(rig!.built, taskId, ["COMPLETED", "FAILED", "CANCELLED", "WAITING_INPUT"]);
  await rig!.built.scheduler.tick();
  expect(await done).toBe("COMPLETED");
}

describe("the loop with no human step (fake G15)", () => {
  it("selects from an empty queue, reserves on the fetched origin, runs, accepts the checkpoint and opens one draft PR", async () => {
    await boot([{ id: "item-a" }, { id: "item-b", depends_on: ["item-a"] }]);
    const localHead = git(rig!.repo, "rev-parse", "HEAD");
    const upstream = advanceOrigin(); // G23: the plane's clone is now behind origin
    open();
    expect(tasks()).toHaveLength(0);

    const tick = await dispatcher().tick();
    expect(tick).toMatchObject({ action: "reserved", itemId: "item-a", outcome: "created" });
    const a = ap().currentAttempt()!;
    expect(a).toMatchObject({ itemId: "item-a", attemptNo: 1, state: "admitted", reservationOutcome: "created", repo: "ai-control-plan", baseSha: upstream });
    // §C.2.2: the reservation commit is the base's tree with the base as parent, fixed message, built locally and on GitHub alike.
    expect(bareRef("os/item-a")).toBe(a.reservationSha);
    const commit = (await gh.getCommit(REPO, a.reservationSha!))!;
    expect(commit.parents).toEqual([upstream]);
    expect(parseReservation(commit.message)).toEqual({ itemId: "item-a", lane: "oci-loop", reservationId: a.reservationId });
    expect(git(gh.bare, "rev-parse", `${a.reservationSha}^{tree}`)).toBe(git(gh.bare, "rev-parse", `${upstream}^{tree}`));
    expect(gh.refCreates).toEqual([{ branch: "os/item-a", sha: a.reservationSha, answer: "201" }]);
    // The item's revision digest and the backlog commit it was read at are on the attempt.
    expect(a.backlogSha).toBe(originMain());
    expect(a.itemRevision).toMatch(/^[0-9a-f]{64}$/);
    // One task, owned by the attempt, waiting on the pool.
    expect(tasks()).toEqual([{ id: a.taskId }]);
    expect(rig!.built.scheduler.condition(a.taskId!)).toMatchObject({ kind: "resource", resource: "oci-heavy" });

    // G23: the worktree starts at the reservation SHA, not at the stale local HEAD.
    idle.ok = false; // hold acceptance until the "agent's work" is in the worktree
    await runTask(a.taskId!);
    const task = rig!.built.tasks.get(a.taskId!)!;
    expect(task.base_ref).toBe(a.reservationSha);
    expect(task.base_ref).not.toBe(localHead);
    expect(git(task.worktree_path!, "rev-parse", "HEAD")).toBe(a.reservationSha);
    await dispatcher().idle();
    expect(ap().attempt(a.id)!.state).toBe("settled"); // acceptance waited: the agent slice was "busy"

    writeFileSync(join(task.worktree_path!, "item-a.txt"), "done\n");
    idle.ok = true;
    await dispatcher().tick();
    await dispatcher().idle();

    const final = ap().attempt(a.id)!;
    expect(final.state).toBe("published");
    const runs = rig!.built.acceptance!.runs(a.id);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ state: "passed", sourceRef: "origin/main", sourceSha: a.backlogSha });
    const verified = runs[0]!.sha!;
    expect(git(rig!.repo, "merge-base", "--is-ancestor", a.reservationSha!, verified)).toBe("");
    expect(bareRef("os/item-a")).toBe(verified);
    expect(gh.prs).toHaveLength(1);
    const pr = gh.prs[0]!;
    expect(pr).toMatchObject({ headRef: "os/item-a", baseRef: "main", draft: true, headSha: verified });
    expect(markerOf(pr.body)).toBe(rig!.built.publications.ofAttempt(a.id)!.id);
    expect(pr.body).toContain("acceptance PASSED");

    // item-b waits on item-a's merge; item-a is in review.
    expect(await dispatcher().tick()).toEqual({ action: "idle", reason: "no item is queued or retryable" });
    expect(dispatcher().status().selection).toEqual([
      { itemId: "item-a", status: "in review", reason: "attempt 1 is published (created)" },
      { itemId: "item-b", status: "skipped", reason: "waits on item-a" },
    ]);
    pr.state = "closed"; pr.merged = true;
    expect(await dispatcher().tick()).toMatchObject({ action: "reserved", itemId: "item-b", outcome: "created" });
  });

  it("selects nothing while stopped, without a window, with a full window or a stale attestation, and never a non-night or non-loop item", async () => {
    await boot([{ id: "manual", lane: "manual-cloud" }, { id: "day", night: false }]);
    expect(await dispatcher().tick()).toEqual({ action: "idle", reason: "autopilot is stopped" });
    ap().attest({ extraUsageOff: true, autoReloadOff: true }, "op_test");
    ap().start("op_test");
    expect(await dispatcher().tick()).toEqual({ action: "idle", reason: "no window is open" });
    ap().addWindow({ opensAt: at(instant - MIN), closesAt: at(instant + 5 * MIN), maxItems: 1 }, "op_test");
    expect(await dispatcher().tick()).toEqual({ action: "idle", reason: "the window closes within minSliceMs" });
    instant += 10 * MIN;
    ap().addWindow({ opensAt: at(instant - MIN), closesAt: at(instant + 60 * MIN), maxItems: 1 }, "op_test");
    expect(await dispatcher().tick()).toEqual({ action: "idle", reason: "no item is queued or retryable" });
    expect(dispatcher().status().selection.map((v) => v.reason)).toEqual(["lane manual-cloud", "not night-eligible"]);
    expect(gh.refCreates).toHaveLength(0);
    expect(tasks()).toHaveLength(0);
  });
});

describe("reservation on fake GitHub (G11)", () => {
  it("a lost create that did not land is created again: one ref, owned", async () => {
    await boot([{ id: "item-a" }]);
    open();
    gh.refMode = ["lose-no-land"];
    expect(await dispatcher().tick()).toMatchObject({ action: "reserved", outcome: "created" });
    expect(gh.refCreates.map((c) => c.answer)).toEqual(["lost, not landed", "201"]);
    expect(ap().currentAttempt()!.state).toBe("admitted");
  });

  it("a lost 201 is recognised from the ref's history: owned, never external", async () => {
    await boot([{ id: "item-a" }]);
    open();
    gh.refMode = ["lose-and-land"];
    expect(await dispatcher().tick()).toMatchObject({ action: "reserved", outcome: "owned" });
    const a = ap().currentAttempt()!;
    expect(a).toMatchObject({ state: "admitted", reservationOutcome: "owned" });
    expect(bareRef("os/item-a")).toBe(a.reservationSha);
    expect(gh.refCreates.map((c) => c.answer)).toEqual(["201, response lost"]);
  });

  it("another lane's reservation at the same base: seen first, the item is running there and not selected", async () => {
    await boot([{ id: "item-a" }]);
    open();
    gh.foreignReservation("item-a", "main");
    expect(await dispatcher().tick()).toEqual({ action: "idle", reason: "no item is queued or retryable" });
    expect(dispatcher().status().selection[0]).toMatchObject({ status: "running" });
    expect(ap().attempts()).toHaveLength(0);
    expect(gh.refCreates).toHaveLength(0);
  });

  it("a manual lane that wins the race between selection and create-ref makes the attempt external: exactly one 201", async () => {
    await boot([{ id: "item-a" }]);
    open();
    let manual = "";
    gh.beforeCreateRef = () => { manual = gh.foreignReservation("item-a", "main"); };
    expect(await dispatcher().tick()).toMatchObject({ action: "reserved", outcome: expect.stringContaining("external: os/item-a was reserved by lane manual-cloud") });
    expect(ap().attempts()[0]).toMatchObject({ state: "external" });
    expect(bareRef("os/item-a")).toBe(manual);
    expect(tasks()).toHaveLength(0);
    // The external attempt is final; the item is never re-run by the plane.
    expect(await dispatcher().tick()).toEqual({ action: "idle", reason: "no item is queued or retryable" });
    expect(dispatcher().status().selection[0]).toMatchObject({ status: "blocked", reason: expect.stringContaining("is external") });
  });

  it("a branch with no reservation commit in its history is external", async () => {
    await boot([{ id: "item-a" }]);
    open();
    gh.beforeCreateRef = () => { git(gh.bare, "update-ref", "refs/heads/os/item-a", originMain(), ""); };
    expect(await dispatcher().tick()).toMatchObject({ outcome: expect.stringContaining("no reservation commit") });
    expect(ap().attempts()[0]!.state).toBe("external");
  });

  it("uses GitHub's SHA when it serialises the reservation commit differently, and bases the task on it", async () => {
    await boot([{ id: "item-a" }]);
    open();
    gh.skewCommitDate = true;
    expect(await dispatcher().tick()).toMatchObject({ outcome: "created" });
    const a = ap().currentAttempt()!;
    expect(bareRef("os/item-a")).toBe(a.reservationSha);
    expect(git(rig!.repo, "cat-file", "-t", a.reservationSha!)).toBe("commit"); // fetched before the task
    expect(rig!.built.autopilot.baseCommitOf(a.taskId!)).toBe(a.reservationSha);
  });

  it("401 stops the autopilot (github-auth) and leaves the intent reserving", async () => {
    await boot([{ id: "item-a" }]);
    open();
    gh.refMode = ["401"];
    const tick = await dispatcher().tick();
    expect(tick).toMatchObject({ action: "drove", state: "reserving", detail: expect.stringContaining("github-auth") });
    expect(ap().status()).toMatchObject({ status: "stopped", stopReason: "github-auth" });
    expect(ap().currentAttempt()).toMatchObject({ state: "reserving" });
    expect(tasks()).toHaveLength(0);
  });
});

describe("lineage and recovery (G23, G24)", () => {
  it("a crash between create-ref and the task insert: the next tick admits exactly one task", async () => {
    await boot([{ id: "item-a" }]);
    open();
    flaky.failOsFetches = 1;
    const first = await dispatcher().tick();
    expect(first).toMatchObject({ action: "drove", state: "reserving" });
    const a = ap().currentAttempt()!;
    expect(a).toMatchObject({ state: "reserving", reservationOutcome: "created" });
    expect(a.taskId).toBeUndefined();
    expect(tasks()).toHaveLength(0);

    expect(await dispatcher().tick()).toMatchObject({ action: "reserved", outcome: "created" });
    expect(ap().attempts()).toHaveLength(1);
    expect(tasks()).toEqual([{ id: ap().currentAttempt()!.taskId }]);
    expect(gh.refCreates).toHaveLength(1);
    // Two concurrent reconciliations: one tick at a time; neither makes a second task.
    await Promise.all([dispatcher().tick(), dispatcher().tick()]);
    expect(tasks()).toHaveLength(1);
  });

  it("an intent whose outcome was lost is recovered from history after work was pushed on top of the reservation", async () => {
    await boot([{ id: "item-a" }]);
    open();
    // The create lands, its answer is lost, and the plane dies before it re-reads the ref.
    gh.refMode = ["lose-and-land"];
    const realGet = gh.getBranchSha.bind(gh);
    const realCreate = gh.createRef.bind(gh);
    let died = false;
    // From the moment the create lands, reading the ref times out (the plane's view of GitHub is gone).
    let first = true;
    gh.createRef = async (repo, branch, sha) => { try { return await realCreate(repo, branch, sha); } finally { if (first) died = true; first = false; } };
    gh.getBranchSha = async (repo, branch) => { if (died && branch === "os/item-a") throw new GitHubError("unknown", undefined, "GET ref: timeout"); return realGet(repo, branch); };
    await dispatcher().tick();
    const a = ap().currentAttempt()!;
    expect(a).toMatchObject({ state: "reserving" });
    expect(a.reservationOutcome).toBeUndefined();
    died = false;
    const work = gh.pushWork("item-a"); // e.g. a restore from a backup older than the push
    expect(await dispatcher().tick()).toMatchObject({ action: "reserved", outcome: "owned" });
    expect(ap().attempt(a.id)).toMatchObject({ state: "admitted", reservationOutcome: "owned", reservationSha: a.reservationSha });
    expect(bareRef("os/item-a")).toBe(work);
  });
});

describe("retries", () => {
  /** Attempt 1 runs, acceptance fails (no item-a.txt), `duringAcceptance` runs, and the loop then moves on by itself. */
  async function failFirstAttempt(duringAcceptance?: () => void): Promise<string> {
    open();
    await dispatcher().tick();
    const a = ap().currentAttempt()!;
    onExec = duringAcceptance;
    await runTask(a.taskId!);
    await dispatcher().idle();
    expect(ap().attempt(a.id)).toMatchObject({ state: "failed", reason: expect.stringContaining("acceptance failed") });
    return a.reservationSha!;
  }

  it("a failed attempt's ref is reused while it holds only that reservation", async () => {
    await boot([{ id: "item-a" }]);
    const first = await failFirstAttempt();
    // The failure kicked a tick, which reserved the retry on the same ref without a second commit.
    const second = ap().currentAttempt()!;
    expect(second).toMatchObject({ attemptNo: 2, state: "admitted", reservationOutcome: "reused", reservationSha: first });
    expect(gh.refCreates.map((c) => c.answer)).toEqual(["201", "422"]);
  });

  it("a task that fails before any session started ends its attempt instead of holding the slot (first live run)", async () => {
    // Live, the launch was refused ("requires an adapter that can launch as the agent user"): the
    // task went FAILED with no session, so nothing settled and the attempt stayed `admitted`.
    await boot([{ id: "item-a" }]);
    open();
    await dispatcher().tick();
    const a = ap().currentAttempt()!;
    expect(a).toMatchObject({ state: "admitted", attemptNo: 1 });
    expect(await dispatcher().tick()).toMatchObject({ action: "drove", state: "admitted" }); // a healthy wait is left alone
    // The end state a refused launch leaves (the scheduler owns the transition, so set it directly).
    rig!.db.prepare("UPDATE tasks SET state = 'FAILED' WHERE id = ?").run(a.taskId);
    const out = await dispatcher().tick();
    expect(out).toMatchObject({ action: "drove", attemptId: a.id, state: "failed", detail: expect.stringContaining("failed before a session started") });
    expect(ap().attempt(a.id)).toMatchObject({ state: "failed", reason: "task failed before a session started" });
    // The retry rule applies as for any failure: attempt 2 reuses the untouched reservation.
    await dispatcher().tick();
    expect(ap().currentAttempt()).toMatchObject({ attemptNo: 2, state: "admitted", reservationOutcome: "reused", reservationSha: a.reservationSha });
  });

  it("a failed attempt's ref that carries pushed work is left for itay, and attempts run out", async () => {
    await boot([{ id: "item-a" }]);
    await failFirstAttempt(() => { gh.pushWork("item-a"); });
    expect(ap().currentAttempt()).toBeUndefined();
    expect(await dispatcher().tick()).toEqual({ action: "idle", reason: "no item is queued or retryable" });
    expect(dispatcher().status().selection[0]).toMatchObject({ status: "blocked", reason: expect.stringContaining("carries work past attempt 1") });
    expect(ap().attempts()).toHaveLength(1);
  });
});

describe("revision digest", () => {
  it("matches scripts/backlog-check.mjs --digests", async () => {
    await boot([{ id: "item-a" }, { id: "item-b", depends_on: ["item-a"] }]);
    const file = join(rig!.repo, "docs", "progress", "backlog.yaml");
    const out = execFileSync("node", [join(__dirname, "..", "..", "..", "scripts", "backlog-check.mjs"), file, "--digests"], { encoding: "utf8" });
    const { parse } = await import("yaml");
    const doc = parse(execFileSync("cat", [file], { encoding: "utf8" })) as { items: unknown[] };
    const ours = doc.items.map((i) => `${(i as { id: string }).id} ${itemRevision(i)}`);
    for (const line of ours) expect(out).toContain(line);
  });
});

describe("config and the GitHub token file", () => {
  it("resolves autopilot.repos, backlogRepo and github, and rejects what it cannot honour", async () => {
    const { mkdtempSync, mkdirSync: mk, writeFileSync: w } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { loadConfig } = await import("../src/config.js");
    const home = mkdtempSync(join(tmpdir(), "aos-cfg-"));
    mk(join(home, "personal"), { recursive: true });
    const load = (autopilot: string) => {
      w(join(home, "personal", "config.yaml"), `autopilot:\n${autopilot}\n`);
      return loadConfig({ AGENT_PLANE_HOME: home });
    };
    const ok = load(`  repos:\n    ai-control-plan: { github: osovlanski/ai-control-plan, path: /srv/acp }\n  github: { tokenFile: /etc/aos/gh-token }`);
    expect(ok.autopilot.repos["ai-control-plan"]).toEqual({ github: "osovlanski/ai-control-plan", path: "/srv/acp", base: "main" });
    expect(ok.autopilot.github).toEqual({ tokenFile: "/etc/aos/gh-token" });
    expect(() => load(`  repos:\n    x: { github: nope, path: /srv/x }`)).toThrow(/owner\/name/);
    expect(() => load(`  repos:\n    x: { github: a/b, path: srv/x }`)).toThrow(/absolute/);
    expect(() => load(`  github: { tokenFile: rel }`)).toThrow(/absolute/);
    expect(() => load(`  github: { tokenFile: /t, apiBase: "http://evil" }`)).toThrow(/https/);
    expect(() => load(`  dispatchIntervalMs: 10`)).toThrow(/at least 5000/);
  });

  it("reads the token only from a private regular file of this user, as an auth error otherwise", async () => {
    const { mkdtempSync, writeFileSync: w, symlinkSync, chmodSync: c } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { readGitHubTokenFile } = await import("../src/modules/publications.js");
    const dir = mkdtempSync(join(tmpdir(), "aos-tok-"));
    const file = join(dir, "t");
    w(file, "FAKE-github-token-not-real\n", { mode: 0o600 });
    expect(readGitHubTokenFile(file)).toBe("FAKE-github-token-not-real");
    c(file, 0o640);
    expect(() => readGitHubTokenFile(file)).toThrow(expect.objectContaining({ kind: "auth" }));
    c(file, 0o600);
    symlinkSync(file, join(dir, "link"));
    expect(() => readGitHubTokenFile(join(dir, "link"))).toThrow(expect.objectContaining({ kind: "auth" }));
    expect(() => readGitHubTokenFile(join(dir, "missing"))).toThrow(expect.objectContaining({ kind: "auth" }));
    w(join(dir, "empty"), "\n", { mode: 0o600 });
    expect(() => readGitHubTokenFile(join(dir, "empty"))).toThrow(/empty/);
  });

  it("the REST client's reservation calls: 422 'already exists' is exists, any other 422 is a refusal, and a lost answer is unknown", async () => {
    const { GitHubRestClient } = await import("../src/modules/publications.js");
    const replies: Array<() => Response | Promise<Response>> = [];
    const calls: Array<{ url: string; body?: unknown }> = [];
    const client = new GitHubRestClient({
      token: () => "FAKE-github-token-not-real",
      fetch: (async (url: string, init?: RequestInit) => { calls.push({ url, ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) }); return replies.shift()!(); }) as unknown as typeof fetch,
    });
    const json = (status: number, body: unknown) => () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    replies.push(json(201, { ref: "refs/heads/os/x" }));
    expect(await client.createRef("o/r", "os/x", "a".repeat(40))).toBe("created");
    expect(calls[0]).toMatchObject({ url: "https://api.github.com/repos/o/r/git/refs", body: { ref: "refs/heads/os/x", sha: "a".repeat(40) } });
    replies.push(json(422, { message: "Reference already exists" }));
    expect(await client.createRef("o/r", "os/x", "a".repeat(40))).toBe("exists");
    replies.push(json(422, { message: "Object does not exist" }));
    await expect(client.createRef("o/r", "os/x", "a".repeat(40))).rejects.toMatchObject({ kind: "rejected", status: 422 });
    replies.push(() => { throw new Error("aborted"); });
    await expect(client.createRef("o/r", "os/x", "a".repeat(40))).rejects.toMatchObject({ kind: "unknown" });
    replies.push(json(404, { message: "Not Found" }));
    expect(await client.getCommit("o/r", "b".repeat(40))).toBeNull();
    replies.push(json(201, { sha: "c".repeat(40) }));
    expect(await client.createCommit("o/r", { tree: "t".repeat(40), parent: "p".repeat(40), message: "m\n", name: "n", email: "e@x.invalid", date: "2030-01-01T00:00:00Z" })).toBe("c".repeat(40));
    expect(calls.at(-1)!.body).toMatchObject({ parents: ["p".repeat(40)], author: { date: "2030-01-01T00:00:00Z" }, committer: { date: "2030-01-01T00:00:00Z" } });
  });
});
