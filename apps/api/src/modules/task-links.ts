/**
 * tlm-02b: link a task to the GitHub issues and pull requests it belongs to.
 *
 * Two kinds of evidence, each named by its source in the read:
 *
 * - `operator`: a link an operator recorded (`task_links`, migration 052). It is a claim: the plane
 *   does not call GitHub to check that the issue or PR exists, and says so by its source.
 * - `autopilot_publication` / `autopilot_duplicate`: derived at read time from the P0-5 records of
 *   the task's autopilot attempt (`autopilot_publications` with a PR number, and the marker PRs
 *   recorded in `autopilot_publication_duplicates`). They are never copied into `task_links`, so
 *   the publication record stays the only source for them.
 *
 * GitHub numbers issues and PRs in one sequence per repository, so `repo#number` names one object.
 * Entries are keyed by it (repo compared case-insensitively) and carry every piece of evidence for
 * that object, so an operator link to the PR autopilot published shows as one entry with two
 * sources.
 *
 * A future interactive publication (roadmap "chat-publish") reuses autopilot publications by
 * identity; when it lands it adds one more derived source in `derivedEvidence`, not a stored row.
 */
import { randomUUID } from "node:crypto";
import { redactSecrets } from "@agent-plane/core";
import type { Db } from "../db/index.js";

export type LinkKind = "issue" | "pull_request";
export type LinkRelation = "tracks" | "implements" | "closes" | "related";
const RELATIONS: readonly LinkRelation[] = ["tracks", "implements", "closes", "related"];
const MAX_NOTE = 500;

export type LinkEvidence =
  | { source: "operator"; linkId: string; relation: LinkRelation; note: string | null; createdBy: string | null; createdAt: string }
  | { source: "autopilot_publication"; publicationId: string; attemptId: string; state: string; head: string; base: string; verifiedSha: string; at: string }
  | { source: "autopilot_duplicate"; publicationId: string; attemptId: string; prState: string; at: string };

export interface TaskLink {
  kind: LinkKind;
  repo: string;
  number: number;
  url: string;
  evidence: LinkEvidence[];
}

export interface TaskLinks {
  taskId: string;
  links: TaskLink[];
}

export interface LinkedTask {
  taskId: string;
  goal: string;
  state: string;
  link: TaskLink;
}

export class TaskLinkError extends Error {
  constructor(readonly status: 400 | 404 | 409, readonly code: string, message: string) {
    super(message);
    this.name = "TaskLinkError";
  }
}

/* ------------------------------------------------------------- parsing -- */

const REPO = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;
const URL_RE = /^https:\/\/github\.com\/([A-Za-z0-9-]{1,39})\/([A-Za-z0-9._-]{1,100})\/(issues|pull)\/(\d{1,10})(?:[/?#].*)?$/;

export const linkUrl = (kind: LinkKind, repo: string, number: number) =>
  `https://github.com/${repo}/${kind === "issue" ? "issues" : "pull"}/${number}`;

export interface LinkTarget { kind: LinkKind; repo: string; number: number }

/** `{ url }` or `{ repo, number, kind }`, normalised: repo lower case, a positive integer number. */
export function parseLinkTarget(body: Record<string, unknown>): LinkTarget {
  if (body.url !== undefined) {
    if (typeof body.url !== "string") throw new TaskLinkError(400, "invalid_link", "url must be a string");
    const m = URL_RE.exec(body.url.trim());
    if (!m) throw new TaskLinkError(400, "invalid_link", "url must be https://github.com/<owner>/<repo>/issues/<n> or /pull/<n>");
    const kind: LinkKind = m[3] === "pull" ? "pull_request" : "issue";
    if (body.kind !== undefined && body.kind !== kind) throw new TaskLinkError(400, "invalid_link", `kind ${String(body.kind)} disagrees with the url (${kind})`);
    return { kind, repo: `${m[1]}/${m[2]}`.toLowerCase(), number: positive(m[4]) };
  }
  if (body.kind !== "issue" && body.kind !== "pull_request") throw new TaskLinkError(400, "invalid_link", "kind must be issue or pull_request (or pass url)");
  if (typeof body.repo !== "string" || !REPO.test(body.repo) || body.repo.split("/")[1]!.startsWith(".")) {
    throw new TaskLinkError(400, "invalid_link", "repo must be owner/name");
  }
  return { kind: body.kind, repo: body.repo.toLowerCase(), number: positive(body.number) };
}

function positive(value: unknown): number {
  const n = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
  if (typeof n !== "number" || !Number.isSafeInteger(n) || n < 1) throw new TaskLinkError(400, "invalid_link", "number must be a positive integer");
  return n;
}

/* -------------------------------------------------------------- service -- */

interface LinkRow { id: string; task_id: string; kind: LinkKind; repo: string; number: number; relation: LinkRelation; note: string | null; created_by: string | null; created_at: string }
interface PublicationRow { id: string; attempt_id: string; task_id: string; repo: string; base: string; head: string; verified_sha: string; state: string; pr_number: number; pr_url: string | null; updated_at: string }
interface DuplicateRow { publication_id: string; attempt_id: string; task_id: string; repo: string; pr_number: number; pr_url: string | null; pr_state: string; found_at: string }

const tableExists = (db: Db, name: string) =>
  !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);

const keyOf = (repo: string, number: number) => `${repo.toLowerCase()}#${number}`;

export class TaskLinkService {
  constructor(private readonly db: Db, private readonly now: () => Date = () => new Date()) {}

  private taskExists(taskId: string) {
    return !!this.db.prepare("SELECT 1 FROM tasks WHERE id = ?").get(taskId);
  }

  /** Every link of a task, or undefined when the task does not exist. */
  forTask(taskId: string): TaskLinks | undefined {
    if (!this.taskExists(taskId)) return undefined;
    const rows = this.db.prepare(
      "SELECT * FROM task_links WHERE task_id = ? AND removed_at IS NULL ORDER BY created_at, rowid",
    ).all(taskId) as LinkRow[];
    const { publications, duplicates } = this.derived("a.task_id = ?", [taskId]);
    return { taskId, links: assemble(rows, publications, duplicates) };
  }

  /** The tasks linked to `repo#number`, by any source. */
  forTarget(repoInput: unknown, numberInput: unknown): { repo: string; number: number; tasks: LinkedTask[] } {
    if (typeof repoInput !== "string" || !REPO.test(repoInput)) throw new TaskLinkError(400, "invalid_link", "repo must be owner/name");
    const repo = repoInput.toLowerCase();
    const number = positive(numberInput);
    const rows = this.db.prepare(
      "SELECT * FROM task_links WHERE repo = ? AND number = ? AND removed_at IS NULL ORDER BY created_at, rowid",
    ).all(repo, number) as LinkRow[];
    const { publications, duplicates } = this.derived("lower(p.repo) = ? AND {num} = ?", [repo, number]);
    const taskIds = [...new Set([...rows.map((r) => r.task_id), ...publications.map((p) => p.task_id), ...duplicates.map((d) => d.task_id)])];
    const tasks: LinkedTask[] = [];
    for (const taskId of taskIds) {
      const task = this.db.prepare("SELECT goal, state FROM tasks WHERE id = ?").get(taskId) as { goal: string; state: string } | undefined;
      if (!task) continue;
      const [link] = assemble(rows.filter((r) => r.task_id === taskId), publications.filter((p) => p.task_id === taskId), duplicates.filter((d) => d.task_id === taskId));
      if (link) tasks.push({ taskId, goal: task.goal, state: task.state, link });
    }
    return { repo, number, tasks };
  }

  add(taskId: string, body: unknown, actor: string | null): { link: TaskLink; linkId: string } {
    if (!this.taskExists(taskId)) throw new TaskLinkError(404, "not_found", "task not found");
    const input = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
    const target = parseLinkTarget(input);
    const relation = input.relation === undefined ? (target.kind === "issue" ? "tracks" : "implements") : input.relation;
    if (typeof relation !== "string" || !RELATIONS.includes(relation as LinkRelation)) {
      throw new TaskLinkError(400, "invalid_link", `relation must be one of ${RELATIONS.join(", ")}`);
    }
    if (relation === "implements" && target.kind === "issue") throw new TaskLinkError(400, "invalid_link", "an issue cannot be implemented by a task link; use tracks or closes");
    if (relation === "closes" && target.kind === "pull_request") throw new TaskLinkError(400, "invalid_link", "closes applies to an issue");
    let note: string | null = null;
    if (input.note !== undefined && input.note !== null) {
      if (typeof input.note !== "string" || input.note.length > MAX_NOTE) throw new TaskLinkError(400, "invalid_link", `note must be a string of at most ${MAX_NOTE} characters`);
      note = redactSecrets(input.note.trim()) || null;
    }
    const existing = this.db.prepare(
      "SELECT id, kind FROM task_links WHERE task_id = ? AND repo = ? AND number = ? AND removed_at IS NULL",
    ).get(taskId, target.repo, target.number) as { id: string; kind: LinkKind } | undefined;
    if (existing) {
      throw new TaskLinkError(409, "already_linked", existing.kind === target.kind
        ? `${target.repo}#${target.number} is already linked to this task (${existing.id})`
        : `${target.repo}#${target.number} is already linked as ${existing.kind}; GitHub numbers issues and PRs in one sequence`);
    }
    const published = this.forTask(taskId)!.links.find((l) => keyOf(l.repo, l.number) === keyOf(target.repo, target.number));
    if (published && published.kind !== target.kind) {
      throw new TaskLinkError(409, "already_linked", `${target.repo}#${target.number} is this task's autopilot pull request, not an issue`);
    }
    const id = `tl_${randomUUID()}`;
    this.db.prepare(
      `INSERT INTO task_links (id, task_id, kind, repo, number, relation, note, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, taskId, target.kind, target.repo, target.number, relation, note, actor, this.now().toISOString());
    const link = this.forTask(taskId)!.links.find((l) => keyOf(l.repo, l.number) === keyOf(target.repo, target.number))!;
    return { link, linkId: id };
  }

  /** Unlinks an operator link. Derived links cannot be removed here: their record is the publication. */
  remove(taskId: string, linkId: string, actor: string | null): void {
    if (!this.taskExists(taskId)) throw new TaskLinkError(404, "not_found", "task not found");
    const res = this.db.prepare(
      "UPDATE task_links SET removed_at = ?, removed_by = ? WHERE id = ? AND task_id = ? AND removed_at IS NULL",
    ).run(this.now().toISOString(), actor, linkId, taskId);
    if (res.changes === 0) throw new TaskLinkError(404, "not_found", "link not found");
  }

  private derived(where: string, params: unknown[]): { publications: PublicationRow[]; duplicates: DuplicateRow[] } {
    if (!tableExists(this.db, "autopilot_publications")) return { publications: [], duplicates: [] };
    const publications = this.db.prepare(
      `SELECT p.id, p.attempt_id, a.task_id, p.repo, p.base, p.head, p.verified_sha, p.state, p.pr_number, p.pr_url, p.updated_at
         FROM autopilot_publications p JOIN autopilot_attempts a ON a.id = p.attempt_id
        WHERE p.pr_number IS NOT NULL AND a.task_id IS NOT NULL AND ${where.replace("{num}", "p.pr_number")}
        ORDER BY p.created_at, p.rowid`,
    ).all(...params) as PublicationRow[];
    const duplicates = tableExists(this.db, "autopilot_publication_duplicates")
      ? this.db.prepare(
        `SELECT d.publication_id, p.attempt_id, a.task_id, p.repo, d.pr_number, d.pr_url, d.pr_state, d.found_at
           FROM autopilot_publication_duplicates d
           JOIN autopilot_publications p ON p.id = d.publication_id
           JOIN autopilot_attempts a ON a.id = p.attempt_id
          WHERE a.task_id IS NOT NULL AND ${where.replace("{num}", "d.pr_number")}
          ORDER BY d.found_at`,
      ).all(...params) as DuplicateRow[]
      : [];
    return { publications, duplicates };
  }
}

function assemble(rows: LinkRow[], publications: PublicationRow[], duplicates: DuplicateRow[]): TaskLink[] {
  const byKey = new Map<string, TaskLink>();
  const entry = (kind: LinkKind, repo: string, number: number, url: string | null) => {
    const key = keyOf(repo, number);
    let link = byKey.get(key);
    if (!link) { link = { kind, repo: repo.toLowerCase(), number, url: url ?? linkUrl(kind, repo.toLowerCase(), number), evidence: [] }; byKey.set(key, link); }
    return link;
  };
  // Publication evidence first: the PR's own URL (from GitHub) wins over a built one.
  for (const p of publications) {
    entry("pull_request", p.repo, p.pr_number, p.pr_url).evidence.push({
      source: "autopilot_publication", publicationId: p.id, attemptId: p.attempt_id, state: p.state,
      head: p.head, base: p.base, verifiedSha: p.verified_sha, at: p.updated_at,
    });
  }
  for (const d of duplicates) {
    entry("pull_request", d.repo, d.pr_number, d.pr_url).evidence.push({
      source: "autopilot_duplicate", publicationId: d.publication_id, attemptId: d.attempt_id, prState: d.pr_state, at: d.found_at,
    });
  }
  for (const r of rows) {
    entry(r.kind, r.repo, r.number, null).evidence.push({
      source: "operator", linkId: r.id, relation: r.relation, note: r.note, createdBy: r.created_by, createdAt: r.created_at,
    });
  }
  return [...byKey.values()];
}
