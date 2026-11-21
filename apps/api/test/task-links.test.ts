/**
 * tlm-02b: a task names the GitHub issues and pull requests it belongs to. Operator links are
 * recorded claims; an autopilot task's published PR (and any marker duplicate) is derived from the
 * P0-5 records at read time, never copied, and merges with an operator link to the same object.
 */
import { afterEach, describe, expect, it } from "vitest";
import type { TaskLink, TaskLinks } from "../src/modules/task-links.js";
import { bootRig, type Rig } from "./helpers/composer-cockpit.js";

let rig: Rig | undefined;
afterEach(async () => {
  await rig?.close();
  rig = undefined;
});

async function boot() {
  rig = await bootRig({ assistants: { "fake-a": { provider: "fake" } }, enabled: false });
  return rig;
}
const task = (goal = "Fix the parser") => rig!.built.tasks.create({ goal }).taskId;
const inject = (method: "GET" | "POST" | "DELETE", url: string, payload?: unknown, headers = rig!.auth()) =>
  rig!.built.app.inject({ method, url, headers, ...(payload !== undefined ? { payload: payload as object } : {}) });
async function links(taskId: string): Promise<TaskLinks> {
  const res = await inject("GET", `/api/tasks/${taskId}/links`);
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as TaskLinks;
}

function autopilotPublication(taskId: string, opts: { prNumber: number | null; state?: string; repo?: string }) {
  const at = "2026-11-21T10:00:00.000Z";
  rig!.db.prepare(
    `INSERT INTO autopilot_attempts (id, item_id, attempt_no, reservation_id, task_id, state, runtime_budget_ms, created_at, updated_at)
     VALUES ('AA-FAKE-1', 'tlm-02b', 1, 'R-FAKE-not-real', ?, 'accepted', 60000, ?, ?)`,
  ).run(taskId, at, at);
  rig!.db.prepare(
    `INSERT INTO autopilot_publications (id, attempt_id, repo, base, head, repo_path, remote, reservation_sha, verified_sha, title, body, state, pr_number, pr_url, created_at, updated_at)
     VALUES ('pub-FAKE-1', 'AA-FAKE-1', ?, 'main', 'os/tlm-02b', '/tmp/x', 'origin', 'aaa', 'bbb', 't', 'aos-publication: pub-FAKE-1', ?, ?, ?, ?, ?)`,
  ).run(opts.repo ?? "Osovlanski/AI-Control-Plan", opts.state ?? "published", opts.prNumber,
    opts.prNumber ? `https://github.com/Osovlanski/AI-Control-Plan/pull/${opts.prNumber}` : null, at, at);
}

describe("task links (tlm-02b)", () => {
  it("needs tasks.read to read and commands.write to link, and 404s an unknown task", async () => {
    await boot();
    expect((await inject("GET", "/api/tasks/nope/links")).statusCode).toBe(404);
    expect((await inject("POST", "/api/tasks/nope/links", { url: "https://github.com/a/b/issues/1" })).statusCode).toBe(404);
    expect((await rig!.built.app.inject({ method: "GET", url: "/api/tasks/nope/links" })).statusCode).toBe(401);
    const id = task();
    expect((await inject("GET", `/api/tasks/${id}/links`, undefined, rig!.usageAuth())).statusCode).toBe(403);
    expect((await inject("POST", `/api/tasks/${id}/links`, { url: "https://github.com/a/b/issues/1" }, rig!.usageAuth())).statusCode).toBe(403);
    expect(await links(id)).toEqual({ taskId: id, links: [] });
  });

  it("links an issue by url and a PR by parts, normalising repo case and defaulting the relation", async () => {
    await boot();
    const id = task();
    const issue = await inject("POST", `/api/tasks/${id}/links`, { url: "https://github.com/Osovlanski/AI-Control-Plan/issues/41#issuecomment-1", note: "root cause" });
    expect(issue.statusCode, issue.body).toBe(201);
    const pr = await inject("POST", `/api/tasks/${id}/links`, { kind: "pull_request", repo: "osovlanski/cockpit", number: "55", relation: "related" });
    expect(pr.statusCode, pr.body).toBe(201);
    const read = await links(id);
    expect(read.links.map(({ kind, repo, number, url }) => ({ kind, repo, number, url }))).toEqual([
      { kind: "issue", repo: "osovlanski/ai-control-plan", number: 41, url: "https://github.com/osovlanski/ai-control-plan/issues/41" },
      { kind: "pull_request", repo: "osovlanski/cockpit", number: 55, url: "https://github.com/osovlanski/cockpit/pull/55" },
    ]);
    expect(read.links[0]!.evidence).toEqual([expect.objectContaining({ source: "operator", relation: "tracks", note: "root cause" })]);
    expect(read.links[1]!.evidence).toEqual([expect.objectContaining({ source: "operator", relation: "related" })]);
  });

  it("refuses malformed targets, bad relations, and a second live link to the same number", async () => {
    await boot();
    const id = task();
    for (const body of [
      {}, { url: "https://gitlab.com/a/b/issues/1" }, { url: "https://github.com/a/b/issues/0" },
      { kind: "issue", repo: "not-a-repo", number: 1 }, { kind: "issue", repo: "a/b", number: -3 },
      { kind: "commit", repo: "a/b", number: 1 }, { url: "https://github.com/a/b/pull/2", kind: "issue" },
      { url: "https://github.com/a/b/issues/2", relation: "implements" }, { url: "https://github.com/a/b/pull/2", relation: "closes" },
      { url: "https://github.com/a/b/issues/2", note: "x".repeat(501) },
    ]) {
      const res = await inject("POST", `/api/tasks/${id}/links`, body);
      expect(res.statusCode, JSON.stringify(body)).toBe(400);
      expect(res.json().error).toBe("invalid_link");
    }
    expect((await inject("POST", `/api/tasks/${id}/links`, { url: "https://github.com/a/b/issues/7" })).statusCode).toBe(201);
    const again = await inject("POST", `/api/tasks/${id}/links`, { url: "https://github.com/A/B/pull/7" });
    expect(again.statusCode).toBe(409);
    expect(again.json().error).toBe("already_linked");
  });

  it("unlinks by keeping the row with who removed it, then allows a fresh link", async () => {
    await boot();
    const id = task();
    const { linkId } = (await inject("POST", `/api/tasks/${id}/links`, { url: "https://github.com/a/b/issues/7" })).json() as { linkId: string };
    expect((await inject("DELETE", `/api/tasks/${id}/links/${linkId}`)).statusCode).toBe(204);
    expect((await inject("DELETE", `/api/tasks/${id}/links/${linkId}`)).statusCode).toBe(404);
    expect((await links(id)).links).toEqual([]);
    const row = rig!.db.prepare("SELECT removed_at, removed_by FROM task_links WHERE id = ?").get(linkId) as { removed_at: string | null; removed_by: string | null };
    expect(row.removed_at).not.toBeNull();
    expect((await inject("POST", `/api/tasks/${id}/links`, { url: "https://github.com/a/b/issues/7" })).statusCode).toBe(201);
  });

  it("derives an autopilot task's published PR and merges an operator link to the same PR into one entry", async () => {
    await boot();
    const id = task();
    autopilotPublication(id, { prNumber: 231 });
    const derived = (await links(id)).links;
    expect(derived).toEqual([{
      kind: "pull_request", repo: "osovlanski/ai-control-plan", number: 231,
      url: "https://github.com/Osovlanski/AI-Control-Plan/pull/231",
      evidence: [{ source: "autopilot_publication", publicationId: "pub-FAKE-1", attemptId: "AA-FAKE-1", state: "published", head: "os/tlm-02b", base: "main", verifiedSha: "bbb", at: "2026-11-21T10:00:00.000Z" }],
    }]);
    // Nothing was copied into task_links.
    expect(rig!.db.prepare("SELECT COUNT(*) AS n FROM task_links").get()).toEqual({ n: 0 });
    // Linking the same PR adds operator evidence to the one entry; claiming it is an issue is refused.
    expect((await inject("POST", `/api/tasks/${id}/links`, { url: "https://github.com/osovlanski/ai-control-plan/issues/231" })).statusCode).toBe(409);
    expect((await inject("POST", `/api/tasks/${id}/links`, { url: "https://github.com/osovlanski/ai-control-plan/pull/231" })).statusCode).toBe(201);
    const merged = (await links(id)).links;
    expect(merged).toHaveLength(1);
    expect(merged[0]!.evidence.map((e) => e.source)).toEqual(["autopilot_publication", "operator"]);
    // A marker duplicate shows as its own derived PR.
    rig!.db.prepare("INSERT INTO autopilot_publication_duplicates (publication_id, pr_number, pr_url, pr_state, found_at) VALUES ('pub-FAKE-1', 232, NULL, 'open', '2026-11-21T11:00:00.000Z')").run();
    const dup = (await links(id)).links.find((l) => l.number === 232)!;
    expect(dup).toEqual({ kind: "pull_request", repo: "osovlanski/ai-control-plan", number: 232, url: "https://github.com/osovlanski/ai-control-plan/pull/232",
      evidence: [{ source: "autopilot_duplicate", publicationId: "pub-FAKE-1", attemptId: "AA-FAKE-1", prState: "open", at: "2026-11-21T11:00:00.000Z" }] });
  });

  it("a publication with no PR yet (publishing, uncertain) links nothing", async () => {
    await boot();
    const id = task();
    autopilotPublication(id, { prNumber: null, state: "publish_uncertain" });
    expect((await links(id)).links).toEqual([]);
  });

  it("finds every task linked to repo#number, by operator link or publication", async () => {
    await boot();
    const a = task("Task A");
    const b = task("Task B");
    task("Task C, unrelated");
    autopilotPublication(a, { prNumber: 300 });
    expect((await inject("POST", `/api/tasks/${b}/links`, { url: "https://github.com/osovlanski/ai-control-plan/pull/300", relation: "related" })).statusCode).toBe(201);
    const res = await inject("GET", "/api/task-links?repo=OSOVLANSKI/ai-control-plan&number=300");
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json() as { repo: string; number: number; tasks: Array<{ taskId: string; goal: string; link: TaskLink }> };
    expect(body.repo).toBe("osovlanski/ai-control-plan");
    expect(body.tasks.map((t) => [t.goal, t.link.evidence.map((e) => e.source)])).toEqual([
      ["Task B", ["operator"]], ["Task A", ["autopilot_publication"]],
    ]);
    expect((await inject("GET", "/api/task-links?repo=bad&number=1")).statusCode).toBe(400);
    expect((await inject("GET", "/api/task-links?repo=a/b&number=x")).statusCode).toBe(400);
  });
});
