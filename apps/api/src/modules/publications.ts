/**
 * P0-5 (docs/agentic-os-auto-copilot-plan.md §C.2.4) — publications: exactly-once by identity,
 * and uncertainty stops.
 *
 * An `accepted` attempt gets one publication: a fast-forward push of `os/<item>` from the
 * reservation commit to the verified SHA, sent with a lease, then one draft PR whose body carries
 * `aos-publication: <id>`. Identity is repo + head + base + verified SHA + that id, and a PR is
 * adopted only when all five match.
 *
 * Rules this module keeps:
 * - Re-check before each mutation: the autopilot is not stopped, the publication is still
 *   `publishing`, the remote ref is where the mutation expects it, and no PR exists for the head
 *   in any state. Closed or merged → `closed`. Moved head, wrong base, a changed head SHA, a
 *   foreign marker or none → `conflict` (not adopted).
 * - Every mutation is logged before it is issued and settled after (`autopilot_publication_mutations`).
 * - A PR create whose outcome is unknown (timeout, 5xx, unreadable) → `publish_uncertain`, and the
 *   publisher never creates again on its own. A create that was issued and never settled (the plane
 *   died) counts the same. The sweep keeps looking for the marker; only itay's `retry` or `abandon`
 *   moves it otherwise. A marker PR seen after a resolution is recorded as a duplicate, never deleted.
 * - 401/403 fails the publication and stops the autopilot (`github-auth`). 429 and 5xx on reads
 *   get a bounded backoff, after which the publication stays where it is for the next sweep.
 *
 * Who calls it: P0-6's loop records the intent when acceptance passes and runs `publish`; the
 * sweep (server.ts) reconciles. GitHub and git are ports, so tests run on a fake GitHub and a
 * local bare repository.
 */
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs";
import { registerSecret } from "@agent-plane/core";
import type { Db } from "../db/index.js";
import type { AutopilotService } from "./autopilot.js";

/* --------------------------------------------------------------- ports -- */

export interface PullRequest {
  number: number;
  url?: string;
  state: "open" | "closed";
  merged: boolean;
  draft?: boolean;
  body: string;
  headRef: string;
  headSha: string;
  /** owner/name of the head repository; a PR from a fork never matches. */
  headRepo?: string;
  baseRef: string;
}

/**
 * `auth`: 401/403. `rejected`: GitHub answered and refused (4xx other than auth, e.g. 422).
 * `transient`: 429 or 5xx. `unknown`: no readable answer (timeout, network, unparseable body).
 */
export type GitHubErrorKind = "auth" | "rejected" | "transient" | "unknown";
export class GitHubError extends Error {
  constructor(readonly kind: GitHubErrorKind, readonly status: number | undefined, message: string) {
    super(message);
    this.name = "GitHubError";
  }
}

export interface PublicationGitHub {
  /** The ref's SHA, or null when it does not exist. */
  getBranchSha(repo: string, branch: string): Promise<string | null>;
  /** Every PR (any state) whose head is `branch` in `repo` itself. */
  listPullsForHead(repo: string, branch: string): Promise<PullRequest[]>;
  createPull(repo: string, input: { title: string; head: string; base: string; body: string; draft: boolean }): Promise<PullRequest>;
}

export interface PublicationGit {
  /** `git merge-base --is-ancestor ancestor descendant` in `repoPath`. */
  isAncestor(repoPath: string, ancestor: string, descendant: string): Promise<boolean>;
  /** Push `sha` to `refs/heads/<branch>` on `remote` with `--force-with-lease=<branch>:<expected>`. Throws on any failure. */
  pushWithLease(repoPath: string, remote: string, branch: string, sha: string, expected: string): Promise<void>;
}

/* ------------------------------------------------------ real adapters -- */

function run(cmd: string, args: string[], cwd: string, timeoutMs: number): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { cwd, timeout: timeoutMs, maxBuffer: 1 << 20, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as { code?: unknown }).code === "number" ? (err as { code: number }).code : -1) : 0;
      resolve({ code, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

/** The git CLI. The push never forces past the lease: a moved branch is refused by the remote. */
export function gitCli(timeoutMs = 120_000): PublicationGit {
  return {
    async isAncestor(repoPath, ancestor, descendant) {
      const r = await run("git", ["merge-base", "--is-ancestor", ancestor, descendant], repoPath, timeoutMs);
      if (r.code === 0) return true;
      if (r.code === 1) return false;
      throw new Error(`git merge-base failed (${r.code}): ${r.stderr.trim()}`);
    },
    async pushWithLease(repoPath, remote, branch, sha, expected) {
      const ref = `refs/heads/${branch}`;
      const r = await run("git", ["push", "--porcelain", `--force-with-lease=${ref}:${expected}`, remote, `${sha}:${ref}`], repoPath, timeoutMs);
      if (r.code !== 0) throw new Error(`git push failed (${r.code}): ${(r.stderr || r.stdout).trim().slice(0, 500)}`);
    },
  };
}

/**
 * P0-6: the plane user's GitHub token, read per request: one fd for the check and the read,
 * `O_NOFOLLOW`, a regular file owned by this uid with no group or other bits. Any problem is an
 * `auth` error, which stops the autopilot (`github-auth`). The value is registered for redaction.
 */
export function readGitHubTokenFile(path: string): string {
  let fd: number;
  try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); } catch (err) {
    throw new GitHubError("auth", undefined, `GitHub token file unreadable (${(err as NodeJS.ErrnoException).code ?? "error"})`);
  }
  let token: string;
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.uid !== process.getuid?.() || (st.mode & 0o077) !== 0) throw new GitHubError("auth", undefined, "GitHub token file must be a regular file of this user with mode 0600 or tighter");
    token = readFileSync(fd, "utf8").trim();
  } finally {
    closeSync(fd);
  }
  if (!token) throw new GitHubError("auth", undefined, "GitHub token file is empty");
  registerSecret(token);
  return token;
}

/** Minimal GitHub REST client. The token is read per request from its file, so a rotation needs no restart. */
export class GitHubRestClient implements PublicationGitHub, ReservationGitHub {
  private readonly fetchImpl: typeof fetch;
  constructor(private readonly opts: { apiBase?: string; tokenFile?: string; token?: () => string; timeoutMs?: number; fetch?: typeof fetch }) {
    this.fetchImpl = opts.fetch ?? fetch;
  }
  private token(): string {
    if (this.opts.token) return this.opts.token();
    if (!this.opts.tokenFile) throw new GitHubError("auth", undefined, "no GitHub token configured");
    return readFileSync(this.opts.tokenFile, "utf8").trim();
  }
  private async call(method: string, path: string, body?: unknown): Promise<{ status: number; json: unknown }> {
    const base = (this.opts.apiBase ?? "https://api.github.com").replace(/\/+$/, "");
    let res: Response;
    try {
      res = await this.fetchImpl(`${base}${path}`, {
        method,
        redirect: "error",
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${this.token()}`,
          "x-github-api-version": "2022-11-28",
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(this.opts.timeoutMs ?? 30_000),
      });
    } catch (err) {
      if (err instanceof GitHubError) throw err;
      throw new GitHubError("unknown", undefined, `${method} ${path}: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (res.status === 401 || res.status === 403) throw new GitHubError("auth", res.status, `${method} ${path}: HTTP ${res.status}`);
    if (res.status === 429 || res.status >= 500) throw new GitHubError("transient", res.status, `${method} ${path}: HTTP ${res.status}`);
    let json: unknown;
    try { json = res.status === 204 ? undefined : await res.json(); } catch {
      throw new GitHubError("unknown", res.status, `${method} ${path}: unreadable body (HTTP ${res.status})`);
    }
    return { status: res.status, json };
  }
  async getBranchSha(repo: string, branch: string): Promise<string | null> {
    try {
      const { status, json } = await this.call("GET", `/repos/${repo}/git/ref/heads/${branch.split("/").map(encodeURIComponent).join("/")}`);
      if (status === 404) return null;
      if (status !== 200) throw new GitHubError("rejected", status, `GET ref ${branch}: HTTP ${status}`);
      const sha = (json as { object?: { sha?: unknown } })?.object?.sha;
      if (typeof sha !== "string") throw new GitHubError("unknown", status, `GET ref ${branch}: no sha in the answer`);
      return sha;
    } catch (err) {
      if (err instanceof GitHubError && err.status === 404) return null;
      throw err;
    }
  }
  async listPullsForHead(repo: string, branch: string): Promise<PullRequest[]> {
    const owner = repo.split("/")[0]!;
    const { status, json } = await this.call("GET", `/repos/${repo}/pulls?state=all&per_page=100&head=${encodeURIComponent(`${owner}:${branch}`)}`);
    if (status !== 200 || !Array.isArray(json)) throw new GitHubError(status === 200 ? "unknown" : "rejected", status, `GET pulls for ${branch}: HTTP ${status}`);
    return json.map(toPull).filter((p) => p.headRef === branch && (!p.headRepo || p.headRepo === repo));
  }
  async createPull(repo: string, input: { title: string; head: string; base: string; body: string; draft: boolean }): Promise<PullRequest> {
    const { status, json } = await this.call("POST", `/repos/${repo}/pulls`, input);
    if (status !== 201) throw new GitHubError("rejected", status, `POST pulls: HTTP ${status}: ${JSON.stringify(json).slice(0, 300)}`);
    try { return toPull(json); } catch { throw new GitHubError("unknown", status, "POST pulls: unreadable PR in the answer"); }
  }

  /* P0-6 (§C.2.2): the reservation calls. */

  async getCommit(repo: string, sha: string): Promise<GitCommit | null> {
    if (!/^[0-9a-f]{40}$/.test(sha)) throw new GitHubError("rejected", undefined, "GET commit: not a full SHA");
    const { status, json } = await this.call("GET", `/repos/${repo}/git/commits/${sha}`);
    if (status === 404) return null;
    if (status !== 200) throw new GitHubError("rejected", status, `GET commit ${sha}: HTTP ${status}`);
    const c = json as { sha?: unknown; message?: unknown; parents?: Array<{ sha?: unknown }> };
    if (typeof c?.sha !== "string" || typeof c.message !== "string" || !Array.isArray(c.parents)) throw new GitHubError("unknown", status, `GET commit ${sha}: unreadable answer`);
    return { sha: c.sha, message: c.message, parents: c.parents.map((p) => String(p.sha)) };
  }
  async createCommit(repo: string, input: ReservationCommitInput): Promise<string> {
    const { status, json } = await this.call("POST", `/repos/${repo}/git/commits`, {
      message: input.message, tree: input.tree, parents: [input.parent],
      author: { name: input.name, email: input.email, date: input.date },
      committer: { name: input.name, email: input.email, date: input.date },
    });
    if (status !== 201) throw new GitHubError("rejected", status, `POST git/commits: HTTP ${status}: ${JSON.stringify(json).slice(0, 300)}`);
    const sha = (json as { sha?: unknown })?.sha;
    if (typeof sha !== "string") throw new GitHubError("unknown", status, "POST git/commits: no sha in the answer");
    return sha;
  }
  async createRef(repo: string, branch: string, sha: string): Promise<"created" | "exists"> {
    const { status, json } = await this.call("POST", `/repos/${repo}/git/refs`, { ref: `refs/heads/${branch}`, sha });
    if (status === 201) return "created";
    // "Reference already exists" is the only 422 that means a ref is there; anything else is a refusal.
    if (status === 422 && /already exists/i.test(JSON.stringify(json))) return "exists";
    throw new GitHubError("rejected", status, `POST git/refs: HTTP ${status}: ${JSON.stringify(json).slice(0, 300)}`);
  }
}

/** A git commit as GitHub's git-data API returns it. */
export interface GitCommit { sha: string; message: string; parents: string[] }
/** The reservation commit's content (§C.2.2 step 1): fixed from the intent, so every retry is identical. */
export interface ReservationCommitInput { tree: string; parent: string; message: string; name: string; email: string; date: string }

/** P0-6: GitHub's side of a reservation. `createRef` answers `exists` for GitHub's 422 "already exists". */
export interface ReservationGitHub {
  getBranchSha(repo: string, branch: string): Promise<string | null>;
  listPullsForHead(repo: string, branch: string): Promise<PullRequest[]>;
  getCommit(repo: string, sha: string): Promise<GitCommit | null>;
  createCommit(repo: string, input: ReservationCommitInput): Promise<string>;
  createRef(repo: string, branch: string, sha: string): Promise<"created" | "exists">;
}

function toPull(raw: unknown): PullRequest {
  const p = raw as { number?: unknown; html_url?: string; state?: string; merged_at?: string | null; merged?: boolean; draft?: boolean; body?: string | null; head?: { ref?: string; sha?: string; repo?: { full_name?: string } | null }; base?: { ref?: string } };
  if (typeof p?.number !== "number" || typeof p.head?.ref !== "string" || typeof p.head.sha !== "string" || typeof p.base?.ref !== "string") throw new Error("not a pull request");
  return {
    number: p.number, ...(p.html_url ? { url: p.html_url } : {}),
    state: p.state === "closed" ? "closed" : "open", merged: !!(p.merged || p.merged_at), ...(p.draft !== undefined ? { draft: p.draft } : {}),
    body: p.body ?? "", headRef: p.head.ref, headSha: p.head.sha, ...(p.head.repo?.full_name ? { headRepo: p.head.repo.full_name } : {}), baseRef: p.base.ref,
  };
}

/* ------------------------------------------------------------- service -- */

export const PUBLICATION_MARKER = "aos-publication";
export const markerOf = (body: string): string | undefined => new RegExp(`^${PUBLICATION_MARKER}: *(\\S+) *$`, "m").exec(body)?.[1];

export type PublicationState = "publishing" | "publish_uncertain" | "published" | "closed" | "conflict" | "failed" | "abandoned";
const FINAL: readonly PublicationState[] = ["published", "closed", "conflict", "failed", "abandoned"];

interface PublicationRow {
  id: string; attempt_id: string; repo: string; base: string; head: string; repo_path: string; remote: string;
  reservation_sha: string; verified_sha: string; title: string; body: string; state: PublicationState; reason: string | null;
  pr_number: number | null; pr_url: string | null; resolution: "retry" | "abandon" | null; resolved_by: string | null; resolved_at: string | null;
  created_at: string; updated_at: string; final_at: string | null;
}
interface MutationRow { id: number; publication_id: string; kind: "push" | "create_pr"; issued_at: string; outcome: "ok" | "rejected" | "unknown" | null; detail: string | null; settled_at: string | null; resolved_at: string | null }

export interface Publication {
  id: string; attemptId: string; repo: string; base: string; head: string; reservationSha: string; verifiedSha: string;
  state: PublicationState; reason?: string; prNumber?: number; prUrl?: string;
  resolution?: "retry" | "abandon"; resolvedBy?: string; resolvedAt?: string; createdAt: string; updatedAt: string; finalAt?: string;
  /** Issued mutations whose outcome nobody knows (§C.2.9: listed, never undone). */
  unresolved: Array<{ kind: "push" | "create_pr"; issuedAt: string; detail?: string }>;
  duplicates: Array<{ prNumber: number; prUrl?: string; prState: string; foundAt: string }>;
}

export class PublicationRefused extends Error {
  constructor(message: string) { super(message); this.name = "PublicationRefused"; }
}

export interface PublicationDeps {
  db: Db;
  autopilot: AutopilotService;
  github?: PublicationGitHub;
  git?: PublicationGit;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  /** Read retries on 429/5xx before giving up until the next sweep. */
  readAttempts?: number;
  backoffMs?: number;
  /** Lease-respecting push attempts per `publish` call. */
  pushAttempts?: number;
  /** How long after a resolution the sweep keeps looking for a late marker PR. */
  duplicateWatchMs?: number;
}

/** What one step of the re-check decided. */
type Verdict =
  | { kind: "continue" }
  | { kind: "adopt"; pr: PullRequest; extras: PullRequest[] }
  | { kind: "final"; state: "closed" | "conflict" | "failed"; reason: string };

export class PublicationService {
  private readonly db: Db;
  private readonly now: () => Date;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly inFlight = new Set<string>();

  constructor(private readonly d: PublicationDeps) {
    this.db = d.db;
    this.now = d.now ?? (() => new Date());
    this.sleep = d.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  get configured(): boolean { return !!this.d.github && !!this.d.git; }
  private iso(): string { return this.now().toISOString(); }
  private github(): PublicationGitHub { if (!this.d.github) throw new PublicationRefused("no GitHub client is configured for publications"); return this.d.github; }
  private git(): PublicationGit { return this.d.git ?? gitCli(); }

  /* ------------------------------------------------------------- reads -- */

  private row(id: string): PublicationRow | undefined {
    return this.db.prepare("SELECT * FROM autopilot_publications WHERE id = ?").get(id) as PublicationRow | undefined;
  }
  private toPublication(r: PublicationRow): Publication {
    const unresolved = (this.db.prepare(`SELECT kind, issued_at, detail FROM autopilot_publication_mutations
      WHERE publication_id = ? AND (outcome IS NULL OR outcome = 'unknown') AND resolved_at IS NULL ORDER BY id`).all(r.id) as Array<{ kind: "push" | "create_pr"; issued_at: string; detail: string | null }>)
      .map((m) => ({ kind: m.kind, issuedAt: m.issued_at, ...(m.detail ? { detail: m.detail } : {}) }));
    const duplicates = (this.db.prepare("SELECT pr_number, pr_url, pr_state, found_at FROM autopilot_publication_duplicates WHERE publication_id = ? ORDER BY pr_number").all(r.id) as Array<{ pr_number: number; pr_url: string | null; pr_state: string; found_at: string }>)
      .map((x) => ({ prNumber: x.pr_number, ...(x.pr_url ? { prUrl: x.pr_url } : {}), prState: x.pr_state, foundAt: x.found_at }));
    return {
      id: r.id, attemptId: r.attempt_id, repo: r.repo, base: r.base, head: r.head, reservationSha: r.reservation_sha, verifiedSha: r.verified_sha,
      state: r.state, ...(r.reason ? { reason: r.reason } : {}), ...(r.pr_number !== null ? { prNumber: r.pr_number } : {}), ...(r.pr_url ? { prUrl: r.pr_url } : {}),
      ...(r.resolution ? { resolution: r.resolution } : {}), ...(r.resolved_by ? { resolvedBy: r.resolved_by } : {}), ...(r.resolved_at ? { resolvedAt: r.resolved_at } : {}),
      createdAt: r.created_at, updatedAt: r.updated_at, ...(r.final_at ? { finalAt: r.final_at } : {}), unresolved, duplicates,
    };
  }
  get(id: string): Publication | undefined { const r = this.row(id); return r ? this.toPublication(r) : undefined; }
  ofAttempt(attemptId: string): Publication | undefined {
    const r = this.db.prepare("SELECT * FROM autopilot_publications WHERE attempt_id = ?").get(attemptId) as PublicationRow | undefined;
    return r ? this.toPublication(r) : undefined;
  }
  list(limit = 50): Publication[] {
    return (this.db.prepare("SELECT * FROM autopilot_publications ORDER BY created_at DESC, rowid DESC LIMIT ?").all(limit) as PublicationRow[]).map((r) => this.toPublication(r));
  }

  /* ------------------------------------------------------------ intent -- */

  /**
   * §C.2.1 `accepting → accepted`'s "publication intent row", and `accepted → publishing`: one
   * transaction. Refuses an attempt that is not `accepted`, has no reservation SHA, or already has
   * a publication. The marker is appended to the body here, so it is fixed before any request.
   */
  intend(input: { attemptId: string; repo: string; base: string; repoPath: string; verifiedSha: string; title: string; body?: string; remote?: string }): Publication {
    if (!/^[\w.-]+\/[\w.-]+$/.test(input.repo)) throw new PublicationRefused("repo must be owner/name");
    if (!/^[0-9a-f]{40}$/.test(input.verifiedSha)) throw new PublicationRefused("verifiedSha must be a full commit SHA");
    if (!input.base || !input.title?.trim() || !input.repoPath) throw new PublicationRefused("base, title and repoPath are required");
    return this.db.transaction((): Publication => {
      const attempt = this.d.autopilot.attempt(input.attemptId);
      if (!attempt) throw new PublicationRefused(`attempt ${input.attemptId} does not exist`);
      if (attempt.state !== "accepted") throw new PublicationRefused(`attempt ${attempt.id} is ${attempt.state}, not accepted`);
      if (!attempt.reservationSha) throw new PublicationRefused(`attempt ${attempt.id} has no reservation SHA`);
      if (this.ofAttempt(attempt.id)) throw new PublicationRefused(`attempt ${attempt.id} already has a publication`);
      const id = `pub_${randomUUID()}`;
      const body = `${(input.body ?? "").trimEnd()}${input.body?.trim() ? "\n\n" : ""}${PUBLICATION_MARKER}: ${id}\n`;
      const at = this.iso();
      this.db.prepare(`INSERT INTO autopilot_publications(id, attempt_id, repo, base, head, repo_path, remote, reservation_sha, verified_sha, title, body, state, created_at, updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,'publishing',?,?)`)
        .run(id, attempt.id, input.repo, input.base, `os/${attempt.itemId}`, input.repoPath, input.remote ?? "origin", attempt.reservationSha, input.verifiedSha, input.title.trim(), body, at, at);
      this.d.autopilot.publicationMoved(attempt.id, "publishing");
      return this.get(id)!;
    })();
  }

  /* --------------------------------------------------------- transitions -- */

  private move(id: string, state: PublicationState, reason: string | null, extra: { prNumber?: number; prUrl?: string } = {}): void {
    this.db.transaction(() => {
      const r = this.row(id)!;
      if (r.state === state && state !== "publishing") return;
      const at = this.iso();
      this.db.prepare(`UPDATE autopilot_publications SET state = ?, reason = ?, pr_number = COALESCE(?, pr_number), pr_url = COALESCE(?, pr_url),
        updated_at = ?, final_at = ? WHERE id = ?`)
        .run(state, reason, extra.prNumber ?? null, extra.prUrl ?? null, at, FINAL.includes(state) ? at : null, id);
      const attemptState = state === "abandoned" ? "cancelled" : state;
      this.d.autopilot.publicationMoved(r.attempt_id, attemptState, reason ?? undefined);
    })();
  }
  private note(id: string, reason: string): void {
    this.db.prepare("UPDATE autopilot_publications SET reason = ?, updated_at = ? WHERE id = ?").run(reason, this.iso(), id);
  }
  private issue(id: string, kind: "push" | "create_pr", detail: string): number {
    return Number(this.db.prepare("INSERT INTO autopilot_publication_mutations(publication_id, kind, issued_at, detail) VALUES(?,?,?,?)").run(id, kind, this.iso(), detail).lastInsertRowid);
  }
  private settle(mutationId: number, outcome: "ok" | "rejected" | "unknown", detail?: string): void {
    this.db.prepare("UPDATE autopilot_publication_mutations SET outcome = ?, settled_at = ?, detail = COALESCE(?, detail) WHERE id = ?").run(outcome, this.iso(), detail ?? null, mutationId);
  }
  /** A create that left and has no known outcome, not yet accounted for by a resolution. */
  private openCreate(id: string): MutationRow | undefined {
    return this.db.prepare(`SELECT * FROM autopilot_publication_mutations WHERE publication_id = ? AND kind = 'create_pr'
      AND (outcome IS NULL OR outcome = 'unknown') AND resolved_at IS NULL ORDER BY id DESC LIMIT 1`).get(id) as MutationRow | undefined;
  }
  private recordDuplicates(id: string, prs: PullRequest[]): void {
    for (const pr of prs) {
      this.db.prepare("INSERT OR IGNORE INTO autopilot_publication_duplicates(publication_id, pr_number, pr_url, pr_state, found_at) VALUES(?,?,?,?,?)")
        .run(id, pr.number, pr.url ?? null, pr.merged ? "merged" : pr.state, this.iso());
    }
  }

  /** 401/403 anywhere: the publication fails and the autopilot stops (§C.2.4). */
  private authFailed(id: string, err: GitHubError): void {
    this.move(id, "failed", `github-auth: ${err.message}`);
    this.d.autopilot.halt("github-auth");
  }

  /** A read with bounded backoff on 429/5xx. Other errors pass through. */
  private async read<T>(fn: () => Promise<T>): Promise<T> {
    const attempts = this.d.readAttempts ?? 3;
    for (let i = 1; ; i++) {
      try { return await fn(); } catch (err) {
        if (!(err instanceof GitHubError) || err.kind !== "transient" || i >= attempts) throw err;
        await this.sleep((this.d.backoffMs ?? 2_000) * 2 ** (i - 1));
      }
    }
  }

  /**
   * The PRs for the head, judged against this publication's identity. Ours (marker matches): open
   * with the right base and head SHA → adopt; closed or merged → `closed`; otherwise `conflict`.
   * Any PR that is not ours → `conflict` (not adopted). None → continue.
   */
  private judge(r: PublicationRow, prs: PullRequest[]): Verdict {
    const ours = prs.filter((p) => markerOf(p.body) === r.id).sort((a, b) => a.number - b.number);
    if (ours.length > 0) {
      const [first, ...extras] = ours;
      const pr = first!;
      if (pr.merged) return { kind: "final", state: "closed", reason: `PR #${pr.number} was merged by someone` };
      if (pr.state === "closed") return { kind: "final", state: "closed", reason: `PR #${pr.number} was closed by someone` };
      if (pr.baseRef !== r.base) return { kind: "final", state: "conflict", reason: `not adopted: PR #${pr.number} targets ${pr.baseRef}, not ${r.base}` };
      if (pr.headSha !== r.verified_sha) return { kind: "final", state: "conflict", reason: `not adopted: PR #${pr.number} head is ${pr.headSha}, not the verified ${r.verified_sha}` };
      return { kind: "adopt", pr, extras };
    }
    const other = prs[0];
    if (other) {
      const marker = markerOf(other.body);
      return { kind: "final", state: "conflict", reason: `not adopted: PR #${other.number} for ${r.head} ${marker ? `carries a foreign marker ${marker}` : "has no publication marker"}` };
    }
    return { kind: "continue" };
  }

  /** The re-check before each mutation (§C.2.4). `refAt` is where the head must be for the next mutation. */
  private async recheck(r: PublicationRow, refAt: "expected-or-verified" | "verified"): Promise<Verdict | { kind: "hold"; reason: string } | { kind: "ref"; sha: string }> {
    const current = this.row(r.id)!;
    if (current.state !== "publishing") return { kind: "hold", reason: `publication is ${current.state}` };
    if (this.d.autopilot.runState() === "stopped") return { kind: "hold", reason: "autopilot is stopped; no new mutation" };
    const prs = await this.read(() => this.github().listPullsForHead(r.repo, r.head));
    const verdict = this.judge(r, prs);
    if (verdict.kind !== "continue") return verdict;
    const sha = await this.read(() => this.github().getBranchSha(r.repo, r.head));
    if (sha === null) return { kind: "final", state: "conflict", reason: `${r.head} no longer exists on ${r.repo}` };
    if (sha === r.verified_sha) return { kind: "ref", sha };
    if (refAt === "expected-or-verified" && sha === r.reservation_sha) return { kind: "ref", sha };
    return { kind: "final", state: "conflict", reason: `${r.head} moved: it is at ${sha}, expected ${refAt === "verified" ? r.verified_sha : `${r.reservation_sha} or ${r.verified_sha}`}` };
  }

  private adopt(r: PublicationRow, pr: PullRequest, extras: PullRequest[], how: string): void {
    this.db.transaction(() => {
      this.recordDuplicates(r.id, extras);
      // A create whose response was lost is now known to have landed.
      this.db.prepare(`UPDATE autopilot_publication_mutations SET outcome = 'ok', settled_at = ?, detail = ? WHERE publication_id = ? AND kind = 'create_pr'
        AND (outcome IS NULL OR outcome = 'unknown') AND resolved_at IS NULL`).run(this.iso(), `adopted PR #${pr.number}`, r.id);
      this.move(r.id, "published", how, { prNumber: pr.number, ...(pr.url ? { prUrl: pr.url } : {}) });
    })();
  }

  /* ------------------------------------------------------------ publish -- */

  /**
   * Drive one publication as far as it can safely go. Idempotent: run again after a crash, a
   * transient failure or a stop, it re-reads GitHub and continues from what it finds. Never
   * creates a PR while a previous create is unaccounted for.
   */
  async publish(id: string): Promise<Publication> {
    if (this.inFlight.has(id)) return this.get(id)!;
    this.inFlight.add(id);
    try {
      await this.step(id);
    } catch (err) {
      if (err instanceof GitHubError && err.kind === "auth") this.authFailed(id, err);
      else if (err instanceof PublicationRefused) throw err;
      else this.note(id, `will retry: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.inFlight.delete(id);
    }
    return this.get(id)!;
  }

  private async step(id: string): Promise<void> {
    const r = this.row(id);
    if (!r) throw new PublicationRefused(`publication ${id} does not exist`);
    if (r.state !== "publishing") return;
    this.github();

    // A create that left and never settled (the plane died mid-request): uncertain, never re-sent.
    if (this.openCreate(id)) {
      const prs = await this.read(() => this.github().listPullsForHead(r.repo, r.head));
      const verdict = this.judge(r, prs);
      if (verdict.kind === "adopt") return this.adopt(r, verdict.pr, verdict.extras, "adopted by marker after an interrupted create");
      if (verdict.kind === "final") return this.move(id, verdict.state, verdict.reason);
      return this.move(id, "publish_uncertain", "a PR create was issued and its outcome is unknown");
    }

    // Lineage (§C.2.2): the verified SHA must descend from the reservation commit.
    if (!(await this.git().isAncestor(r.repo_path, r.reservation_sha, r.verified_sha))) {
      return this.move(id, "conflict", `lineage: ${r.verified_sha} does not descend from the reservation ${r.reservation_sha}`);
    }

    // Push, under the lease. An uncertain push is re-read and repeated; the lease and the
    // ancestry rule make an identical second push a no-op.
    const pushAttempts = this.d.pushAttempts ?? 3;
    for (let i = 1; ; i++) {
      const check = await this.recheck(r, "expected-or-verified");
      if (check.kind === "hold") return this.note(id, check.reason);
      if (check.kind === "adopt") return this.adopt(r, check.pr, check.extras, "adopted by marker");
      if (check.kind === "final") return this.move(id, check.state, check.reason);
      if (check.kind !== "ref") return;
      if (check.sha === r.verified_sha) break; // pushed, by this call or an earlier one whose response was lost
      const m = this.issue(id, "push", `${r.head} ${r.reservation_sha} → ${r.verified_sha}`);
      try {
        await this.git().pushWithLease(r.repo_path, r.remote, r.head, r.verified_sha, r.reservation_sha);
        break;
      } catch (err) {
        // Unknown until the next re-read says where the branch is. Never assumed either way.
        this.settle(m, "unknown", err instanceof Error ? err.message.slice(0, 500) : String(err));
        if (i >= pushAttempts) return this.note(id, `push did not land after ${i} attempt(s); next sweep retries`);
      }
    }
    // The branch is at the verified SHA: every push of this publication is accounted for.
    this.db.prepare(`UPDATE autopilot_publication_mutations SET outcome = 'ok', settled_at = ? WHERE publication_id = ? AND kind = 'push'
      AND (outcome IS NULL OR outcome = 'unknown')`).run(this.iso(), id);

    // Create the PR, once.
    const check = await this.recheck(r, "verified");
    if (check.kind === "hold") return this.note(id, check.reason);
    if (check.kind === "adopt") return this.adopt(r, check.pr, check.extras, "adopted by marker");
    if (check.kind === "final") return this.move(id, check.state, check.reason);
    const m = this.issue(id, "create_pr", `${r.repo} ${r.head} → ${r.base}`);
    let pr: PullRequest;
    try {
      pr = await this.github().createPull(r.repo, { title: r.title, head: r.head, base: r.base, body: r.body, draft: true });
    } catch (err) {
      if (!(err instanceof GitHubError)) {
        this.settle(m, "unknown", String(err));
        return this.move(id, "publish_uncertain", `PR create outcome unknown: ${String(err)}`);
      }
      if (err.kind === "auth") { this.settle(m, "rejected", err.message); throw err; }
      if (err.kind === "rejected") {
        // GitHub answered and refused (e.g. 422: a PR already exists). What exists decides.
        this.settle(m, "rejected", err.message);
        const prs = await this.read(() => this.github().listPullsForHead(r.repo, r.head));
        const verdict = this.judge(r, prs);
        if (verdict.kind === "adopt") return this.adopt(r, verdict.pr, verdict.extras, "adopted by marker after a refused create");
        if (verdict.kind === "final") return this.move(id, verdict.state, verdict.reason);
        return this.move(id, "failed", `PR create refused: ${err.message}`);
      }
      // Timeout, 5xx, unreadable: the create may have landed. Elapsed time proves nothing.
      this.settle(m, "unknown", err.message);
      return this.move(id, "publish_uncertain", `PR create outcome unknown: ${err.message}`);
    }
    this.settle(m, "ok", `PR #${pr.number}`);
    if (markerOf(pr.body) !== r.id || pr.headSha !== r.verified_sha || pr.baseRef !== r.base) {
      return this.move(id, "conflict", `not adopted: created PR #${pr.number} does not match the publication identity`);
    }
    this.move(id, "published", "created", { prNumber: pr.number, ...(pr.url ? { prUrl: pr.url } : {}) });
  }

  /* ------------------------------------------------------- reconcile -- */

  /** `publish_uncertain`: look for the marker, never create. */
  private async reconcileUncertain(id: string): Promise<void> {
    const r = this.row(id)!;
    const prs = await this.read(() => this.github().listPullsForHead(r.repo, r.head));
    const verdict = this.judge(r, prs);
    if (verdict.kind === "adopt") return this.adopt(r, verdict.pr, verdict.extras, "adopted by marker after an uncertain create");
    if (verdict.kind === "final") return this.move(id, verdict.state, verdict.reason);
    this.note(id, "PR create outcome unknown; no PR with the marker yet; waiting for itay");
  }

  /** After a resolution: any marker PR that is not the adopted one is a duplicate. Reported, never deleted. */
  private async watchDuplicates(id: string): Promise<void> {
    const r = this.row(id)!;
    const prs = await this.read(() => this.github().listPullsForHead(r.repo, r.head));
    this.recordDuplicates(id, prs.filter((p) => markerOf(p.body) === r.id && p.number !== r.pr_number));
  }

  /**
   * The sweep: `publishing` rows not in flight are driven again, `publish_uncertain` rows are
   * reconciled by marker, and resolved rows are watched for late duplicates. Nothing runs while
   * no GitHub client is configured. One publication's failure never stops the others.
   */
  async sweep(): Promise<void> {
    if (!this.d.github) return;
    const rows = this.db.prepare(`SELECT id, state, resolved_at FROM autopilot_publications
      WHERE state IN ('publishing','publish_uncertain') OR (resolved_at IS NOT NULL AND resolved_at > ?)`)
      .all(new Date(this.now().getTime() - (this.d.duplicateWatchMs ?? 7 * 86_400_000)).toISOString()) as Array<{ id: string; state: PublicationState; resolved_at: string | null }>;
    for (const r of rows) {
      if (this.inFlight.has(r.id)) continue;
      this.inFlight.add(r.id);
      try {
        if (r.state === "publishing") { this.inFlight.delete(r.id); await this.publish(r.id); continue; }
        if (r.state === "publish_uncertain") await this.reconcileUncertain(r.id);
        else await this.watchDuplicates(r.id);
      } catch (err) {
        if (err instanceof GitHubError && err.kind === "auth") {
          if (!FINAL.includes(this.row(r.id)!.state)) this.authFailed(r.id, err);
          else this.d.autopilot.halt("github-auth");
        }
      } finally {
        this.inFlight.delete(r.id);
      }
    }
  }

  /* ---------------------------------------------------------- resolve -- */

  /**
   * `autopilot.operate`: itay resolves a `publish_uncertain` publication. A marker PR found now is
   * adopted whatever the action. `abandon` ends the publication and its attempt (`cancelled`).
   * `retry` accounts for the unknown create and runs the publisher again, which re-checks
   * everything before it creates; a delayed create landing later is recorded as a duplicate.
   */
  async resolve(id: string, action: unknown, by: string): Promise<Publication> {
    if (action !== "retry" && action !== "abandon") throw new PublicationRefused("action must be retry or abandon");
    const r = this.row(id);
    if (!r) throw new PublicationRefused(`publication ${id} does not exist`);
    if (r.state !== "publish_uncertain") throw new PublicationRefused(`publication ${id} is ${r.state}; only publish_uncertain is resolved`);
    if (this.inFlight.has(id)) throw new PublicationRefused(`publication ${id} is being reconciled; try again`);
    this.inFlight.add(id);
    try {
      try {
        await this.reconcileUncertain(id);
      } catch (err) {
        if (err instanceof GitHubError && err.kind === "auth") { this.authFailed(id, err); return this.get(id)!; }
        // GitHub unreadable: the operator's word still stands; the duplicate watch covers the rest.
      }
      if (this.row(id)!.state !== "publish_uncertain") return this.get(id)!;
      const at = this.iso();
      this.db.transaction(() => {
        this.db.prepare("UPDATE autopilot_publication_mutations SET resolved_at = ? WHERE publication_id = ? AND (outcome IS NULL OR outcome = 'unknown') AND resolved_at IS NULL").run(at, id);
        this.db.prepare("UPDATE autopilot_publications SET resolution = ?, resolved_by = ?, resolved_at = ? WHERE id = ?").run(action, by, at, id);
        if (action === "abandon") this.move(id, "abandoned", `abandoned by ${by}`);
        else this.move(id, "publishing", `retry by ${by}`);
      })();
    } finally {
      this.inFlight.delete(id);
    }
    if (action === "retry") return this.publish(id);
    return this.get(id)!;
  }
}
