/**
 * P0-5 (docs/agentic-os-auto-copilot-plan.md §C.2.4): publications on a fake GitHub.
 *
 * The git side is real: a local bare repository plays `origin`, so the push, its lease and the
 * ancestry rule run through the git CLI. GitHub's REST side is a fake whose answers can be lost,
 * stale or refused.
 *
 * G12 (delayed push response → the repeated push is a no-op; a stale lookup causes no duplicate
 * mutation; 401 stops the autopilot), G13 (closed / merged / branch moved / head changed / wrong
 * base / missing marker) and G29 (a lost create that lands later is adopted; one that never lands
 * waits for itay; a delayed create after `retry` is a reported duplicate). Plus G23's publication
 * half (a verified SHA that does not descend from the reservation is refused) and §C.2.9 (a stop
 * issues nothing new; an issued create is listed as unresolved).
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { credentialPath, readCredential } from "../src/auth/credential-file.js";
import { generateOperateSecret, operateSecretPath, writeOperateSecretHash } from "../src/auth/operate-secret.js";
import { loadConfig } from "../src/config.js";
import { openDb, type Db } from "../src/db/index.js";
import { GitHubError, GitHubRestClient, gitCli, markerOf, type PublicationGit, type PublicationGitHub, type PullRequest } from "../src/modules/publications.js";
import { buildServer, type BuiltServer } from "../src/server.js";

// The container's commit-signing server is not part of what is tested.
const GIT_ENV = {
  GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "commit.gpgsign", GIT_CONFIG_VALUE_0: "false",
  GIT_AUTHOR_NAME: "aos test", GIT_AUTHOR_EMAIL: "aos@example.invalid", GIT_COMMITTER_NAME: "aos test", GIT_COMMITTER_EMAIL: "aos@example.invalid",
};
Object.assign(process.env, GIT_ENV);
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, ...GIT_ENV } }).trim();

const REPO = "osovlanski/demo";
const ITEM = "item-7";
const HEAD = `os/${ITEM}`;

/** GitHub's REST side. Refs are read from the bare repository; PRs live here. */
class FakeGitHub implements PublicationGitHub {
  prs: PullRequest[] = [];
  creates = 0;
  lists = 0;
  /** What the next create does with its response. */
  createMode: "ok" | "lose-and-land" | "lose-no-land" | "500" | "401" = "ok";
  /** The next N list calls return nothing (a stale search index). */
  staleLists = 0;
  /** The next N ref reads return this SHA instead of the truth. */
  staleRef?: { sha: string; n: number };
  authFail = false;
  transient = 0;
  private nextNumber = 41;
  constructor(private readonly bare: string) {}

  async getBranchSha(_repo: string, branch: string) {
    if (this.authFail) throw new GitHubError("auth", 401, "GET ref: HTTP 401");
    if (this.staleRef && this.staleRef.n > 0) { this.staleRef.n--; return this.staleRef.sha; }
    try { return git(this.bare, "rev-parse", "--verify", `refs/heads/${branch}`); } catch { return null; }
  }
  async listPullsForHead(_repo: string, branch: string) {
    this.lists++;
    if (this.authFail) throw new GitHubError("auth", 401, "GET pulls: HTTP 401");
    if (this.transient > 0) { this.transient--; throw new GitHubError("transient", 502, "GET pulls: HTTP 502"); }
    if (this.staleLists > 0) { this.staleLists--; return []; }
    return this.prs.filter((p) => p.headRef === branch).map((p) => ({ ...p }));
  }
  /** A PR as GitHub would hold it after a create, with the head's current SHA. */
  land(input: { head: string; base: string; body: string; title?: string }): PullRequest {
    const pr: PullRequest = { number: ++this.nextNumber, url: `https://github.invalid/${REPO}/pull/${this.nextNumber}`, state: "open", merged: false, draft: true, body: input.body, headRef: input.head, headSha: git(this.bare, "rev-parse", `refs/heads/${input.head}`), headRepo: REPO, baseRef: input.base };
    this.prs.push(pr);
    return pr;
  }
  pending?: { head: string; base: string; body: string };
  async createPull(_repo: string, input: { title: string; head: string; base: string; body: string; draft: boolean }) {
    this.creates++;
    expect(input.draft).toBe(true);
    switch (this.createMode) {
      case "401": throw new GitHubError("auth", 401, "POST pulls: HTTP 401");
      case "500": throw new GitHubError("transient", 500, "POST pulls: HTTP 500");
      case "lose-and-land": this.land(input); throw new GitHubError("unknown", undefined, "POST pulls: The operation was aborted due to timeout");
      case "lose-no-land": this.pending = input; throw new GitHubError("unknown", undefined, "POST pulls: The operation was aborted due to timeout");
      default: return this.land(input);
    }
  }
}

/** The real git CLI, with an optional lost response after a push that did land. */
class LossyGit implements PublicationGit {
  pushes = 0;
  loseNextPushResponses = 0;
  private readonly real = gitCli(30_000);
  isAncestor(repoPath: string, a: string, b: string) { return this.real.isAncestor(repoPath, a, b); }
  async pushWithLease(repoPath: string, remote: string, branch: string, sha: string, expected: string) {
    this.pushes++;
    await this.real.pushWithLease(repoPath, remote, branch, sha, expected);
    if (this.loseNextPushResponses > 0) { this.loseNextPushResponses--; throw new Error("git push: connection reset after the update"); }
  }
}

let home: string;
let db: Db;
let built: BuiltServer;
let planeDir: string;
let github: FakeGitHub;
let gitPort: LossyGit;
let work: string;
let bare: string;
let base: string;
let reservation: string;
let verified: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "aos-pub-"));
  bare = join(home, "origin.git");
  work = join(home, "work");
  mkdirSync(work);
  git(home, "init", "-q", "--bare", "-b", "main", bare);
  git(work, "init", "-q", "-b", "main");
  git(work, "commit", "-q", "--allow-empty", "-m", "base");
  git(work, "remote", "add", "origin", bare);
  git(work, "push", "-q", "origin", "main");
  base = git(work, "rev-parse", "HEAD");
  // §C.2.2: the reservation commit is the base's tree with the base as parent, already on os/<item>.
  reservation = git(work, "commit-tree", `${base}^{tree}`, "-p", base, "-m", `aos-reservation item=${ITEM} lane=plane reservation=res-1`);
  git(work, "push", "-q", "origin", `${reservation}:refs/heads/${HEAD}`);
  git(work, "checkout", "-q", "-b", HEAD, reservation);
  git(work, "commit", "-q", "--allow-empty", "-m", "the work");
  verified = git(work, "rev-parse", "HEAD");

  const config = loadConfig({ AGENT_PLANE_HOME: join(home, "plane") });
  planeDir = config.dir;
  db = openDb(config.dbPath);
  github = new FakeGitHub(bare);
  gitPort = new LossyGit();
  built = buildServer({ config, db, autopilotGitHub: github, autopilotGit: gitPort, publicationSleep: async () => {} });
  db.prepare("UPDATE autopilot_state SET status = 'running', stop_reason = NULL WHERE id = 1").run();
});

afterEach(async () => {
  await built.app.close();
  db.close();
  rmSync(home, { recursive: true, force: true });
});

const pubs = () => built.publications;
/** An attempt that acceptance passed (P0-4 / P0-6 own the steps before this). */
function accepted(): string {
  const task = built.tasks.create({ goal: "Ship item 7", repoPath: work });
  const at = new Date().toISOString();
  db.prepare(`INSERT INTO autopilot_attempts(id, item_id, attempt_no, reservation_id, reservation_sha, task_id, state, runtime_budget_ms, created_at, updated_at)
    VALUES('apa_1', ?, 1, 'res-1', ?, ?, 'accepted', 5400000, ?, ?)`).run(ITEM, reservation, task.taskId, at, at);
  return "apa_1";
}
function intend(sha = verified) {
  return pubs().intend({ attemptId: accepted(), repo: REPO, base: "main", repoPath: work, verifiedSha: sha, title: "Item 7", body: "Verdict: PASS" });
}
const remoteHead = () => git(bare, "rev-parse", `refs/heads/${HEAD}`);
const attemptState = () => built.autopilot.attempt("apa_1")!.state;
const mutations = (id: string) => db.prepare("SELECT kind, outcome FROM autopilot_publication_mutations WHERE publication_id = ? ORDER BY id").all(id) as Array<{ kind: string; outcome: string | null }>;

describe("publication: the happy path", () => {
  it("fast-forwards os/<item> under the lease and opens one draft PR carrying the marker", async () => {
    const intent = intend();
    expect(intent.state).toBe("publishing");
    expect(attemptState()).toBe("publishing");
    expect(markerOf((db.prepare("SELECT body FROM autopilot_publications WHERE id = ?").get(intent.id) as { body: string }).body)).toBe(intent.id);

    const done = await pubs().publish(intent.id);
    expect(done).toMatchObject({ state: "published", prNumber: 42, unresolved: [], duplicates: [] });
    expect(remoteHead()).toBe(verified);
    expect(github.creates).toBe(1);
    expect(github.prs[0]!.body).toContain(`aos-publication: ${intent.id}`);
    expect(github.prs[0]!.body).toContain("Verdict: PASS");
    expect(mutations(intent.id)).toEqual([{ kind: "push", outcome: "ok" }, { kind: "create_pr", outcome: "ok" }]);
    expect(attemptState()).toBe("published");
    expect(built.autopilot.currentAttempt()).toBeUndefined(); // the loop is free again

    // Running it again changes nothing.
    await pubs().publish(intent.id);
    await pubs().sweep();
    expect(github.creates).toBe(1);
  });

  it("refuses an attempt that is not accepted, and a second publication for one attempt", () => {
    intend();
    expect(() => pubs().intend({ attemptId: "apa_1", repo: REPO, base: "main", repoPath: work, verifiedSha: verified, title: "again" })).toThrow(/is publishing, not accepted/);
  });
});

describe("G12: delayed push, stale lookup, 401", () => {
  it("re-reads after a lost push response and repeats the push as a no-op", async () => {
    // The push lands but its response is lost, and the next two ref reads are stale.
    gitPort.loseNextPushResponses = 1;
    github.staleRef = { sha: reservation, n: 2 };
    const intent = intend();
    const done = await pubs().publish(intent.id);
    expect(done.state).toBe("published");
    expect(gitPort.pushes).toBe(2); // the second, identical push is accepted as up to date
    expect(mutations(intent.id)).toEqual([{ kind: "push", outcome: "ok" }, { kind: "push", outcome: "ok" }, { kind: "create_pr", outcome: "ok" }]);
    expect(remoteHead()).toBe(verified);
    expect(github.creates).toBe(1);
    expect(git(bare, "rev-list", "--count", `refs/heads/${HEAD}`)).toBe("3"); // base, reservation, work: nothing rewritten
  });

  it("the lease refuses a push when the branch moved underneath", async () => {
    const intruder = git(work, "commit-tree", `${base}^{tree}`, "-p", reservation, "-m", "someone else");
    git(work, "push", "-q", "origin", `${intruder}:refs/heads/${HEAD}`);
    await expect(gitCli().pushWithLease(work, "origin", HEAD, verified, reservation)).rejects.toThrow(/git push failed/);
    expect(remoteHead()).toBe(intruder);
  });

  it("a stale lookup after an interrupted create never causes a second create", async () => {
    const intent = intend();
    git(work, "push", "-q", "origin", `${verified}:refs/heads/${HEAD}`);
    // The plane died after sending the create: the mutation was logged and never settled.
    db.prepare("INSERT INTO autopilot_publication_mutations(publication_id, kind, issued_at) VALUES(?, 'create_pr', ?)").run(intent.id, new Date().toISOString());
    github.land({ head: HEAD, base: "main", body: `x\n\naos-publication: ${intent.id}\n` });
    github.staleLists = 3;
    await pubs().publish(intent.id);
    expect(pubs().get(intent.id)!.state).toBe("publish_uncertain");
    await pubs().sweep();
    await pubs().sweep();
    expect(pubs().get(intent.id)!.state).toBe("publish_uncertain");
    expect(github.creates).toBe(0);
    await pubs().sweep(); // the index caught up
    expect(pubs().get(intent.id)).toMatchObject({ state: "published", prNumber: 42, unresolved: [] });
    expect(github.creates).toBe(0);
  });

  it("backs off on 5xx reads, then continues", async () => {
    github.transient = 2;
    const done = await pubs().publish(intend().id);
    expect(done.state).toBe("published");
  });

  it("401 fails the publication and stops the autopilot with github-auth", async () => {
    const intent = intend();
    github.authFail = true;
    const done = await pubs().publish(intent.id);
    expect(done.state).toBe("failed");
    expect(done.reason).toMatch(/^github-auth/);
    expect(built.autopilot.status()).toMatchObject({ status: "stopped", stopReason: "github-auth" });
    expect(attemptState()).toBe("failed");
    expect(gitPort.pushes).toBe(0);
  });

  it("401 on the create itself does the same", async () => {
    github.createMode = "401";
    const done = await pubs().publish(intend().id);
    expect(done.state).toBe("failed");
    expect(built.autopilot.status().stopReason).toBe("github-auth");
  });
});

describe("G13: someone else's hands on the branch or the PR", () => {
  async function withPr(mutate: (pr: PullRequest, id: string) => void) {
    const intent = intend();
    git(work, "push", "-q", "origin", `${verified}:refs/heads/${HEAD}`);
    const pr = github.land({ head: HEAD, base: "main", body: `aos-publication: ${intent.id}` });
    mutate(pr, intent.id);
    return pubs().publish(intent.id);
  }

  it("closed PR → closed", async () => {
    expect(await withPr((pr) => { pr.state = "closed"; })).toMatchObject({ state: "closed" });
    expect(attemptState()).toBe("closed");
  });
  it("merged PR → closed", async () => {
    expect(await withPr((pr) => { pr.state = "closed"; pr.merged = true; })).toMatchObject({ state: "closed", reason: expect.stringMatching(/merged/) });
  });
  it("branch moved → conflict, nothing pushed", async () => {
    const intent = intend();
    const intruder = git(work, "commit-tree", `${base}^{tree}`, "-p", reservation, "-m", "someone else");
    git(work, "push", "-q", "origin", `${intruder}:refs/heads/${HEAD}`);
    const done = await pubs().publish(intent.id);
    expect(done).toMatchObject({ state: "conflict", reason: expect.stringMatching(/moved/) });
    expect(gitPort.pushes).toBe(0);
    expect(remoteHead()).toBe(intruder);
    expect(attemptState()).toBe("conflict");
  });
  it("head changed on our PR → conflict", async () => {
    expect(await withPr((pr) => { pr.headSha = reservation; })).toMatchObject({ state: "conflict", reason: expect.stringMatching(/not adopted.*head/) });
  });
  it("wrong base → not adopted", async () => {
    expect(await withPr((pr) => { pr.baseRef = "dev"; })).toMatchObject({ state: "conflict", reason: expect.stringMatching(/not adopted.*targets dev/) });
  });
  it("missing marker → not adopted", async () => {
    expect(await withPr((pr) => { pr.body = "hand-made"; })).toMatchObject({ state: "conflict", reason: expect.stringMatching(/not adopted.*no publication marker/) });
  });
  it("foreign marker → not adopted", async () => {
    expect(await withPr((pr) => { pr.body = "aos-publication: pub_someone_else"; })).toMatchObject({ state: "conflict", reason: expect.stringMatching(/foreign marker/) });
    expect(github.creates).toBe(0);
  });
});

describe("G23: lineage", () => {
  it("refuses a verified SHA that does not descend from the reservation, before any push", async () => {
    git(work, "checkout", "-q", "main");
    git(work, "commit", "-q", "--allow-empty", "-m", "not on the reservation");
    const stray = git(work, "rev-parse", "HEAD");
    const done = await pubs().publish(intend(stray).id);
    expect(done).toMatchObject({ state: "conflict", reason: expect.stringMatching(/^lineage/) });
    expect(gitPort.pushes).toBe(0);
    expect(remoteHead()).toBe(reservation);
  });
});

describe("G29: uncertain PR create", () => {
  async function operator() {
    const { secret, hash } = generateOperateSecret();
    writeOperateSecretHash(operateSecretPath(planeDir), hash);
    return { authorization: `Bearer ${secret}` };
  }

  it("response lost while the create lands later → adopted by marker, no second create", async () => {
    github.createMode = "lose-and-land";
    const intent = intend();
    expect((await pubs().publish(intent.id)).state).toBe("publish_uncertain");
    github.staleLists = 1; // the first reconcile does not see it yet
    expect(attemptState()).toBe("publish_uncertain");
    expect(pubs().get(intent.id)!.unresolved).toEqual([expect.objectContaining({ kind: "create_pr" })]);
    // Invariant 1: the loop is held.
    expect(built.autopilot.currentAttempt()?.state).toBe("publish_uncertain");
    await pubs().sweep();
    expect(pubs().get(intent.id)!.state).toBe("publish_uncertain");
    await pubs().sweep();
    expect(pubs().get(intent.id)).toMatchObject({ state: "published", prNumber: 42, unresolved: [] });
    expect(github.creates).toBe(1);
    expect(attemptState()).toBe("published");
  });

  it("response lost while the create never lands → uncertain until itay; retry creates; the late create is a reported duplicate", async () => {
    github.createMode = "lose-no-land";
    const intent = intend();
    await pubs().publish(intent.id);
    for (let i = 0; i < 5; i++) await pubs().sweep();
    expect(pubs().get(intent.id)!.state).toBe("publish_uncertain");
    expect(github.creates).toBe(1); // elapsed time proves nothing: no re-create

    // Only the operator secret resolves, and only with a known action.
    const ordinary = await built.app.inject({ method: "POST", url: `/api/autopilot/publications/${intent.id}/resolve`, payload: { action: "retry" } });
    expect(ordinary.statusCode).toBe(401);
    const headers = await operator();
    const bad = await built.app.inject({ method: "POST", url: `/api/autopilot/publications/${intent.id}/resolve`, headers: { ...headers }, payload: { action: "delete" } });
    expect(bad.statusCode).toBe(409);

    github.createMode = "ok";
    const resolved = await built.app.inject({ method: "POST", url: `/api/autopilot/publications/${intent.id}/resolve`, headers: { ...headers }, payload: { action: "retry" } });
    expect(resolved.statusCode, resolved.body).toBe(200);
    expect(resolved.json()).toMatchObject({ state: "published", prNumber: 42, resolution: "retry", unresolved: [] });
    expect(github.creates).toBe(2);

    // The first create finally lands.
    const late = github.land(github.pending!);
    await pubs().sweep();
    const after = pubs().get(intent.id)!;
    expect(after.state).toBe("published");
    expect(after.prNumber).toBe(42);
    expect(after.duplicates).toEqual([expect.objectContaining({ prNumber: late.number, prState: "open" })]);
    expect(github.prs).toHaveLength(2); // reported, never deleted

    expect((await built.app.inject({ method: "GET", url: "/api/autopilot/publications" })).statusCode).toBe(401);
    const ordinaryHeaders = { authorization: `Bearer ${readCredential(credentialPath(planeDir)).secrets[0]!.secret}` };
    const listed = await built.app.inject({ method: "GET", url: "/api/autopilot/publications", headers: ordinaryHeaders });
    expect(listed.statusCode).toBe(200);
    // The ordinary credential reads but cannot resolve.
    expect((await built.app.inject({ method: "POST", url: `/api/autopilot/publications/${intent.id}/resolve`, headers: ordinaryHeaders, payload: { action: "abandon" } })).statusCode).toBe(403);
    expect(listed.json().publications[0]).toMatchObject({ id: intent.id, duplicates: [{ prNumber: late.number }] });
  });

  it("5xx on the create is uncertain too; abandon ends the attempt and frees the loop", async () => {
    github.createMode = "500";
    const intent = intend();
    expect((await pubs().publish(intent.id)).state).toBe("publish_uncertain");
    const done = await pubs().resolve(intent.id, "abandon", "op_test");
    expect(done).toMatchObject({ state: "abandoned", resolution: "abandon", resolvedBy: "op_test", unresolved: [] });
    expect(attemptState()).toBe("cancelled");
    expect(built.autopilot.currentAttempt()).toBeUndefined();
    await expect(pubs().resolve(intent.id, "retry", "op_test")).rejects.toThrow(/only publish_uncertain/);
  });

  it("resolve adopts instead when the marker PR has appeared by then", async () => {
    github.createMode = "lose-and-land";
    const intent = intend();
    await pubs().publish(intent.id);
    const done = await pubs().resolve(intent.id, "retry", "op_test");
    expect(done).toMatchObject({ state: "published", prNumber: 42 });
    expect(done.resolution).toBeUndefined();
    expect(github.creates).toBe(1);
  });
});

describe("§C.2.9: stop", () => {
  it("a stopped autopilot issues no mutation; started again, the publication continues", async () => {
    built.autopilot.halt("operator");
    const intent = intend();
    const held = await pubs().publish(intent.id);
    expect(held).toMatchObject({ state: "publishing", reason: expect.stringMatching(/stopped/) });
    expect(gitPort.pushes).toBe(0);
    expect(github.creates).toBe(0);
    db.prepare("UPDATE autopilot_state SET status = 'running' WHERE id = 1").run();
    await pubs().sweep();
    expect(pubs().get(intent.id)!.state).toBe("published");
  });

  it("draining lets the publication finish", async () => {
    built.autopilot.stop("drain");
    expect((await pubs().publish(intend().id)).state).toBe("published");
  });
});

describe("GitHubRestClient", () => {
  it("maps statuses to error kinds and never follows a redirect", async () => {
    const seen: RequestInit[] = [];
    const answer = (status: number, body: unknown) => async (_url: string | URL | Request, init?: RequestInit) => { seen.push(init!); return new Response(body === undefined ? null : JSON.stringify(body), { status }); };
    const client = (f: (u: string | URL | Request, i?: RequestInit) => Promise<Response>) => new GitHubRestClient({ apiBase: "http://127.0.0.1:1", token: () => "FAKE-token-not-real", fetch: f as typeof fetch });
    await expect(client(answer(401, {})).listPullsForHead(REPO, HEAD)).rejects.toMatchObject({ kind: "auth" });
    await expect(client(answer(502, {})).listPullsForHead(REPO, HEAD)).rejects.toMatchObject({ kind: "transient" });
    await expect(client(answer(422, { message: "exists" })).createPull(REPO, { title: "t", head: HEAD, base: "main", body: "b", draft: true })).rejects.toMatchObject({ kind: "rejected" });
    await expect(client(async () => { throw new Error("timeout"); }).createPull(REPO, { title: "t", head: HEAD, base: "main", body: "b", draft: true })).rejects.toMatchObject({ kind: "unknown" });
    expect(await client(answer(404, { message: "Not Found" })).getBranchSha(REPO, HEAD)).toBeNull();
    expect(seen.every((i) => i.redirect === "error")).toBe(true);
    expect((seen[0]!.headers as Record<string, string>).authorization).toBe("Bearer FAKE-token-not-real");
  });
});
