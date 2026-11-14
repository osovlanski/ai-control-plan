/**
 * P0-6 (docs/agentic-os-auto-copilot-plan.md §C.2.1, §C.2.2, §C.3, §C.4) — the in-plane
 * dispatcher: `selectNext()`, the GitHub reservation, and the calls that carry an attempt from
 * `settled` through acceptance (P0-4) to a publication (P0-5).
 *
 * One `tick` does at most this, in order:
 *
 * 1. **Drive the one non-final attempt** (invariant 1), by its state:
 *    - `reserving`: finish the reservation (§C.2.2) and admit the task, so a crash between the
 *      create-ref and the task insert is recovered (G24);
 *    - `settled`, `suspended` with a completed task, or `accepting` after a replay-safe crash:
 *      `AcceptanceRunner.accept`;
 *    - `accepted`: `PublicationService.intend` with the verified SHA, then `publish`;
 *    - `publishing`: `publish` again (the sweep does the same);
 *    - `admitted`, `running`, `suspended` with work left, `accepting` in flight, `publish_uncertain`:
 *      nothing here. The scheduler, the runner, the sweep or itay moves them.
 * 2. **Otherwise select** (§C.3), only while the autopilot is `running`, a window is open with
 *    `minSliceMs` left and an uncharged item, and the billing attestation is current. The backlog
 *    is read at `origin/<base>` of the backlog repo after a fetch, never from a worktree. Items are
 *    taken in file order; the first one whose derived status is `queued` or `retryable` wins.
 * 3. **Reserve** it (§C.2.2): build the reservation commit locally (base tree, base as parent,
 *    fixed message, author, committer and date), persist the intent (the attempt row in
 *    `reserving`), `POST /git/commits`, then `POST /git/refs`. 201 → owned. 422 → walk the ref's
 *    first-parent history to its reservation commit: ours → owned; another lane's → `external`.
 *    No readable answer → re-read the ref: absent → create again, present → the 422 rule.
 * 4. **Admit**: fetch `os/<item>`, then create the task and its pool wait with the attempt in one
 *    transaction (`AutopilotService.admit`). The orchestrator bases the task's worktree on the
 *    reservation SHA (`baseCommitOf`), never on the composer's base or the clone's HEAD.
 *
 * A retry of an item (its last attempt `failed`, attempts left) reuses the ref only while it
 * still points at that earlier attempt's own reservation commit; a ref that carries pushed work is
 * left for itay.
 *
 * Triggers: a timer (`autopilot.dispatchIntervalMs`), the start, window, release and resolve
 * routes, an attempt reaching `settled`, and the end of every acceptance or publication call.
 * The state is all in SQLite and GitHub, so any trigger can be lost: the next one finds the same
 * work. Ticks are single-flight in the process; the unique index on non-final attempts guards
 * the rest.
 *
 * Nothing here runs repository code or a provider. Git commands run as the plane user with hooks
 * off, only `fetch`, `rev-parse`, `show` and `commit-tree`.
 */
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { parse as parseYaml } from "yaml";
import type { RoutingProfile } from "@agent-plane/core";
import type { AutopilotRepoConfig, ResolvedConfig } from "../config.js";
import type { AcceptanceRunner } from "./acceptance-run.js";
import { BACKLOG_PATH } from "./acceptance-run.js";
import type { AutopilotAttempt, AutopilotService } from "./autopilot.js";
import { GitHubError, type PublicationService, type PullRequest, type ReservationGitHub } from "./publications.js";

/* ------------------------------------------------------------- backlog -- */

export interface BacklogItem {
  id: string; title: string; phase: string; repo: string; size: string; depends_on: string[]; files: string[];
  lane: string; profile: string; night: boolean; source?: string; notes?: string;
  acceptance?: { commands: Array<{ run: string; replaySafe: boolean; timeoutSec?: number }>; writable: unknown[]; drive?: string };
  /** The item exactly as parsed: what the revision digest is computed over. */
  raw: Record<string, unknown>;
}

const ID_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const PROFILES: readonly RoutingProfile[] = ["auto", "preserve-quota", "fastest", "best-quality", "lowest-tokens"];
const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

/** Canonical JSON (sorted keys), the same as `scripts/backlog-check.mjs`. */
export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  if (isObj(v)) return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(v[k])}`).join(",")}}`;
  return JSON.stringify(v);
}
/** §C.3 revision digest: `backlog-check --digests` prints the same value. */
export const itemRevision = (raw: unknown): string => createHash("sha256").update(canonicalJson(raw)).digest("hex");

/**
 * The fields the dispatcher relies on, checked. The full schema is `backlog-check`'s job in CI;
 * here a backlog with any structural problem selects nothing, and says why.
 */
export function parseBacklog(text: string): { items: BacklogItem[] } | { problem: string } {
  let doc: unknown;
  try { doc = parseYaml(text, { uniqueKeys: true }); } catch (err) { return { problem: `the backlog is not valid YAML: ${err instanceof Error ? err.message : String(err)}` }; }
  if (!isObj(doc) || doc.version !== 1 || !Array.isArray(doc.items)) return { problem: "the backlog needs version 1 and an items list" };
  const items: BacklogItem[] = [];
  const seen = new Set<string>();
  for (const [i, raw] of doc.items.entries()) {
    if (!isObj(raw)) return { problem: `item ${i + 1} is not a mapping` };
    const id = raw.id;
    if (typeof id !== "string" || !ID_RE.test(id) || id.length > 60) return { problem: `item ${i + 1} has no valid id` };
    if (seen.has(id)) return { problem: `item ${id} appears twice` };
    seen.add(id);
    const strings = ["title", "phase", "repo", "size", "lane", "profile"] as const;
    for (const k of strings) if (typeof raw[k] !== "string" || !(raw[k] as string).trim()) return { problem: `item ${id}: ${k} must be a string` };
    if (typeof raw.night !== "boolean") return { problem: `item ${id}: night must be a boolean` };
    if (!Array.isArray(raw.depends_on) || !raw.depends_on.every((d) => typeof d === "string")) return { problem: `item ${id}: depends_on must be a list of ids` };
    if (!Array.isArray(raw.files) || !raw.files.every((f) => typeof f === "string")) return { problem: `item ${id}: files must be a list of paths` };
    items.push({
      id, title: raw.title as string, phase: raw.phase as string, repo: raw.repo as string, size: raw.size as string,
      depends_on: raw.depends_on as string[], files: raw.files as string[], lane: raw.lane as string, profile: raw.profile as string, night: raw.night,
      ...(typeof raw.source === "string" ? { source: raw.source } : {}), ...(typeof raw.notes === "string" ? { notes: raw.notes } : {}),
      ...(isObj(raw.acceptance) ? { acceptance: raw.acceptance as unknown as NonNullable<BacklogItem["acceptance"]> } : {}),
      raw,
    });
  }
  for (const it of items) for (const d of it.depends_on) if (!seen.has(d)) return { problem: `item ${it.id} depends on ${d}, which is not in the backlog` };
  return { items };
}

/* ---------------------------------------------------------- reservation -- */

export const RESERVATION_LANE = "oci-loop";
export const RESERVATION_AUTHOR = { name: "aos autopilot", email: "aos-autopilot@noreply.invalid" } as const;
/** §C.2.2 step 1: the message is the reservation's identity; the trailing newline is part of it. */
export const reservationMessage = (itemId: string, lane: string, reservationId: string): string =>
  `aos-reservation item=${itemId} lane=${lane} reservation=${reservationId}\n`;
const RESERVATION_RE = /^aos-reservation item=(\S+) lane=(\S+) reservation=(\S+)\s*$/;
export function parseReservation(message: string): { itemId: string; lane: string; reservationId: string } | undefined {
  const m = RESERVATION_RE.exec(message.split("\n")[0] ?? "");
  return m ? { itemId: m[1]!, lane: m[2]!, reservationId: m[3]! } : undefined;
}
/** How far back the 422 walk looks for the reservation commit before calling the ref foreign. */
const WALK_LIMIT = 200;

/** The local git the dispatcher needs, as the plane user. A port so tests can lose answers. */
export interface DispatchGit {
  /** `git fetch --no-tags origin <refspec>...`. Throws on failure. */
  fetch(repoPath: string, refspecs: string[]): Promise<void>;
  /** The full SHA `rev` names, or null. */
  revParse(repoPath: string, rev: string): Promise<string | null>;
  /** `git show <rev>:<path>`, or null when it does not exist. */
  show(repoPath: string, rev: string, path: string): Promise<string | null>;
  /** `git commit-tree` with the given content, fixed identity and date. Returns the SHA. */
  commitTree(repoPath: string, input: { tree: string; parent: string; message: string; name: string; email: string; date: string }): Promise<string>;
}

function gitRun(repoPath: string, args: string[], opts: { input?: string; env?: Record<string, string>; timeoutMs?: number } = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = execFile("git", ["-c", "core.hooksPath=/dev/null", "-C", repoPath, ...args], {
      timeout: opts.timeoutMs ?? 120_000, maxBuffer: 32 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...(opts.env ?? {}) },
    }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as { code?: unknown }).code === "number" ? (err as { code: number }).code : -1) : 0;
      resolve({ code, stdout: String(stdout), stderr: String(stderr) });
    });
    // A child that exits before reading (bad arguments) must not turn into an unhandled EPIPE.
    child.stdin?.on("error", () => undefined);
    child.stdin?.end(opts.input ?? "");
  });
}

export function dispatchGitCli(): DispatchGit {
  return {
    async fetch(repoPath, refspecs) {
      const r = await gitRun(repoPath, ["fetch", "--no-tags", "--quiet", "origin", ...refspecs]);
      if (r.code !== 0) throw new Error(`git fetch failed (${r.code}): ${r.stderr.trim().slice(0, 300)}`);
    },
    async revParse(repoPath, rev) {
      const r = await gitRun(repoPath, ["rev-parse", "--verify", "--quiet", rev]);
      return r.code === 0 ? r.stdout.trim() : null;
    },
    async show(repoPath, rev, path) {
      const r = await gitRun(repoPath, ["show", `${rev}:${path}`]);
      return r.code === 0 ? r.stdout : null;
    },
    async commitTree(repoPath, input) {
      // The date is git's raw `<epoch> +0000`, the same instant GitHub is sent as ISO 8601 UTC.
      const date = `${Math.floor(Date.parse(input.date) / 1000)} +0000`;
      const r = await gitRun(repoPath, ["commit-tree", "--no-gpg-sign", input.tree, "-p", input.parent, "-F", "-"], {
        input: input.message,
        env: {
          GIT_AUTHOR_NAME: input.name, GIT_AUTHOR_EMAIL: input.email, GIT_AUTHOR_DATE: date,
          GIT_COMMITTER_NAME: input.name, GIT_COMMITTER_EMAIL: input.email, GIT_COMMITTER_DATE: date,
        },
      });
      if (r.code !== 0) throw new Error(`git commit-tree failed (${r.code}): ${r.stderr.trim().slice(0, 300)}`);
      return r.stdout.trim();
    },
  };
}

/* ------------------------------------------------------------ service -- */

/** §C.3 derived status of one item, as the dispatcher saw it on its last selection. */
export interface ItemView { itemId: string; status: "queued" | "retryable" | "running" | "in review" | "done" | "blocked" | "skipped"; reason: string }
export type TickAction =
  | { action: "idle"; reason: string }
  | { action: "reserved"; attemptId: string; itemId: string; outcome: string }
  | { action: "drove"; attemptId: string; state: string; detail: string };

export interface DispatcherDeps {
  config: ResolvedConfig;
  autopilot: AutopilotService;
  publications: PublicationService;
  /** Absent = the instance has no acceptance (no agent user): nothing is selected. */
  acceptance?: AcceptanceRunner;
  /** Absent = no GitHub token configured: nothing is selected or reserved. */
  github?: ReservationGitHub;
  git?: DispatchGit;
  now?: () => Date;
  log?: (level: "info" | "warn" | "error", msg: string) => void;
}

export class AutopilotDispatcher {
  private readonly now: () => Date;
  private readonly git: DispatchGit;
  private ticking?: Promise<TickAction>;
  private again = false;
  private readonly background = new Set<Promise<unknown>>();
  private readonly busy = new Set<string>();
  private timer?: NodeJS.Timeout;
  private last?: { at: string; result: TickAction };
  private selection: ItemView[] = [];

  constructor(private readonly d: DispatcherDeps) {
    this.now = d.now ?? (() => new Date());
    this.git = d.git ?? dispatchGitCli();
  }

  private get cfg() { return this.d.config.autopilot; }
  private log(level: "info" | "warn" | "error", msg: string): void { this.d.log?.(level, `autopilot dispatcher: ${msg}`); }

  /** What stops the dispatcher from selecting at all on this instance, each named by its setting. */
  problems(): string[] {
    const out: string[] = [];
    if (!this.d.github) out.push("autopilot.github.tokenFile is not configured");
    if (!this.d.acceptance) out.push("acceptance is not available (execution.agentUser is not configured)");
    const backlog = this.cfg.repos[this.cfg.backlogRepo];
    if (!backlog) out.push(`autopilot.repos.${this.cfg.backlogRepo} (the backlog repo) is not configured`);
    else if (backlog.base !== "main") out.push(`autopilot.repos.${this.cfg.backlogRepo}.base must be main: acceptance reads the backlog at origin/main`);
    for (const [name, r] of Object.entries(this.cfg.repos)) {
      if (!this.d.config.repoAllowlist.includes(r.path)) out.push(`autopilot.repos.${name}.path is not in repoAllowlist`);
    }
    return out;
  }

  status() {
    return {
      problems: this.problems(),
      ...(this.last ? { lastTick: this.last } : {}),
      selection: this.selection,
      inFlight: [...this.busy],
    };
  }

  /* ----------------------------------------------------------- triggers -- */

  startTimer(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.kick(), this.cfg.dispatchIntervalMs);
    this.timer.unref();
  }
  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = undefined; }

  /** Fire-and-forget trigger. A trigger during a tick runs one more tick after it. */
  kick(): void {
    void this.tick().catch((err) => this.log("error", `tick failed: ${err instanceof Error ? err.message : String(err)}`));
  }

  /** Resolves when no tick and no background acceptance or publication call is running (tests, drives). */
  async idle(): Promise<void> {
    for (;;) {
      if (this.ticking) { await this.ticking.catch(() => undefined); continue; }
      if (this.background.size === 0) return;
      await Promise.allSettled([...this.background]);
    }
  }

  /** One tick, single-flight. A caller that arrives during a tick gets that tick's result and a follow-up tick is queued. */
  tick(): Promise<TickAction> {
    if (this.ticking) { this.again = true; return this.ticking; }
    this.ticking = (async () => {
      try {
        let result = await this.tickOnce();
        while (this.again) { this.again = false; result = await this.tickOnce(); }
        this.last = { at: this.now().toISOString(), result };
        return result;
      } finally {
        this.ticking = undefined;
      }
    })();
    return this.ticking;
  }

  /**
   * Runs acceptance or a publication off the tick. It kicks one more tick afterwards only when the
   * attempt moved: a refused or no-op call re-kicking itself would spin, and the timer and the
   * other triggers already retry it.
   */
  private runInBackground(attemptId: string, key: string, work: () => Promise<unknown>): void {
    if (this.busy.has(key)) return;
    this.busy.add(key);
    const before = this.d.autopilot.attempt(attemptId)?.state;
    const p = work()
      .catch((err) => this.log("error", `${key}: ${err instanceof Error ? err.message : String(err)}`))
      .finally(() => {
        this.busy.delete(key); this.background.delete(p);
        if (this.d.autopilot.attempt(attemptId)?.state !== before) this.kick();
      });
    this.background.add(p);
  }

  private async tickOnce(): Promise<TickAction> {
    const current = this.d.autopilot.currentAttempt();
    if (current) return this.drive(current);
    return this.selectNext();
  }

  /* ------------------------------------------------------------- drive -- */

  private async drive(a: AutopilotAttempt): Promise<TickAction> {
    const drove = (detail: string): TickAction => ({ action: "drove", attemptId: a.id, state: this.d.autopilot.attempt(a.id)?.state ?? a.state, detail });
    switch (a.state) {
      case "reserving": {
        if (!this.d.github) return drove("no GitHub client; the reservation waits");
        try {
          return await this.finishReservation(a);
        } catch (err) {
          return drove(this.githubFailure(err, "reservation"));
        }
      }
      case "settled":
      case "suspended":
      case "accepting": {
        const acceptance = this.d.acceptance;
        if (!acceptance) return drove("no acceptance runner");
        const task = a.taskId ? this.d.autopilot.taskState(a.taskId) : undefined;
        if (a.state === "suspended" && task !== "COMPLETED") return drove("suspended with work left; the scheduler resumes it");
        if (this.busy.has(`accept:${a.id}`)) return drove("acceptance is running");
        this.runInBackground(a.id, `accept:${a.id}`, async () => {
          const out = await acceptance.accept(a.id);
          this.log("info", `acceptance for ${a.id}: ${out.started ? `${out.run.state} → attempt ${out.attemptState}` : `not started (${out.reason})`}`);
        });
        return drove("acceptance started");
      }
      case "accepted": {
        if (!this.d.publications.configured) return drove("no GitHub client for publications");
        this.runInBackground(a.id, `publish:${a.id}`, () => this.publish(a));
        return drove("publication started");
      }
      case "publishing": {
        const pub = this.d.publications.ofAttempt(a.id);
        if (!pub || !this.d.publications.configured) return drove("no publication to drive");
        this.runInBackground(a.id, `publish:${a.id}`, () => this.d.publications.publish(pub.id));
        return drove("publication resumed");
      }
      default:
        return drove(`${a.state}: moved by the scheduler, the sweep or itay`);
    }
  }

  /** `accepted` → the publication intent with the verified SHA, then the first publish. */
  private async publish(a: AutopilotAttempt): Promise<void> {
    const repo = a.repo ? this.cfg.repos[a.repo] : undefined;
    if (!repo) throw new Error(`attempt ${a.id} has no configured repo; it was not reserved by the dispatcher`);
    const verifiedSha = this.d.acceptance?.verifiedSha(a.id);
    if (!verifiedSha) throw new Error(`attempt ${a.id} is accepted with no passed acceptance run`);
    const item = await this.itemAt(a);
    const run = this.d.acceptance?.runs(a.id).filter((r) => r.state === "passed").at(-1);
    const body = [
      `Autopilot draft for backlog item \`${a.itemId}\`${item ? `: ${item.title}` : ""}.`,
      "",
      `- attempt ${a.attemptNo}, reservation \`${a.reservationId}\` at \`${a.reservationSha}\``,
      `- acceptance PASSED on \`${verifiedSha}\` (run ${run?.runNo ?? "?"}, commands from \`${run?.sourceRef ?? "origin/main"}\` at \`${run?.sourceSha ?? "?"}\`):`,
      ...(run?.commands ?? []).map((c) => `  - \`${c.run}\` → ${c.status}`),
      ...(item?.acceptance?.drive ? ["", `Drive (not run by the autopilot): ${item.acceptance.drive}`] : []),
      "",
      "Opened by the Agentic OS autopilot as a draft. No agent merges it.",
    ].join("\n");
    const pub = this.d.publications.intend({
      attemptId: a.id, repo: repo.github, base: repo.base, repoPath: repo.path, verifiedSha,
      title: `[${a.itemId}] ${item?.title ?? "autopilot item"}`.slice(0, 250), body,
    });
    await this.d.publications.publish(pub.id);
  }

  /* -------------------------------------------------------- reservation -- */

  /**
   * Finish a `reserving` attempt: the GitHub half of §C.2.2 if its outcome is not recorded yet,
   * then the admit. Safe to repeat from any point: the commit content is fixed by the intent, and
   * an existing ref is judged by the reservation commit in its history.
   */
  private async finishReservation(a: AutopilotAttempt): Promise<TickAction> {
    const github = this.d.github!;
    const repo = a.repo ? this.cfg.repos[a.repo] : undefined;
    if (!repo || !a.baseSha || !a.reservationDate) {
      this.d.autopilot.reservationFailed(a.id, "the reservation intent is incomplete or its repo is no longer configured");
      return { action: "drove", attemptId: a.id, state: "failed", detail: "incomplete intent" };
    }
    const branch = `os/${a.itemId}`;
    let attempt = a;
    if (!a.reservationOutcome) {
      const outcome = await this.claimRef(github, repo, branch, a);
      if (outcome.kind === "pending") return { action: "drove", attemptId: a.id, state: "reserving", detail: outcome.detail };
      if (outcome.kind === "external") {
        this.d.autopilot.external(a.id);
        this.log("warn", `${branch} on ${repo.github} is not ours: ${outcome.detail}`);
        return { action: "reserved", attemptId: a.id, itemId: a.itemId, outcome: `external: ${outcome.detail}` };
      }
      if (outcome.kind !== "owned") {
        this.d.autopilot.reservationFailed(a.id, outcome.detail);
        return { action: "reserved", attemptId: a.id, itemId: a.itemId, outcome: `failed: ${outcome.detail}` };
      }
      attempt = this.d.autopilot.reservationOwned(a.id, outcome.sha, outcome.how);
    }
    // Lineage: the reservation commit must exist locally before a worktree can start at it.
    await this.git.fetch(repo.path, [`+refs/heads/${branch}:refs/remotes/origin/${branch}`]);
    const local = await this.git.revParse(repo.path, `${attempt.reservationSha}^{commit}`);
    if (local !== attempt.reservationSha) throw new Error(`reservation commit ${attempt.reservationSha} is not in ${repo.path} after the fetch`);
    const item = await this.itemAt(attempt);
    const admitted = this.d.autopilot.admit(attempt.id, {
      goal: taskGoal(attempt.itemId, item),
      repoPath: repo.path,
      constraints: taskConstraints(branch, item),
      profile: item && (PROFILES as readonly string[]).includes(item.profile) ? item.profile as RoutingProfile : "auto",
    });
    this.log("info", `admitted ${attempt.itemId} attempt ${attempt.attemptNo} as task ${admitted.taskId} (${attempt.reservationOutcome ?? "owned"})`);
    return { action: "reserved", attemptId: attempt.id, itemId: attempt.itemId, outcome: attempt.reservationOutcome ?? "owned" };
  }

  /** Steps 3–4 of §C.2.2. Bounded: a create whose outcome stays unknown leaves the attempt `reserving` for the next tick. */
  private async claimRef(github: ReservationGitHub, repo: AutopilotRepoConfig, branch: string, a: AutopilotAttempt):
    Promise<{ kind: "owned"; sha: string; how: "created" | "owned" | "reused" } | { kind: "external" | "failed" | "pending"; detail: string }> {
    // The base's tree is local (the base was fetched before the intent); after a restore, fetch it.
    let tree = await this.git.revParse(repo.path, `${a.baseSha}^{tree}`);
    if (!tree) {
      await this.git.fetch(repo.path, [`+refs/heads/${repo.base}:refs/remotes/origin/${repo.base}`]);
      tree = await this.git.revParse(repo.path, `${a.baseSha}^{tree}`);
      if (!tree) return { kind: "failed", detail: `base ${a.baseSha} is not in ${repo.path}` };
    }
    const content = { tree, parent: a.baseSha!, message: reservationMessage(a.itemId, RESERVATION_LANE, a.reservationId), ...RESERVATION_AUTHOR, date: a.reservationDate! };
    let sha: string;
    try {
      sha = await github.createCommit(repo.github, content);
    } catch (err) {
      if (err instanceof GitHubError && err.kind === "rejected") return { kind: "failed", detail: `GitHub refused the reservation commit: ${err.message}` };
      throw err;
    }
    if (sha !== a.reservationSha) {
      // Same content, other SHA: GitHub serialised it differently. Still deterministic on its side,
      // and ownership is judged by the reservation id in the message, so it is GitHub's SHA from here.
      this.log("warn", `GitHub's reservation commit ${sha} differs from the local ${a.reservationSha}; using GitHub's`);
    }
    for (let i = 0; i < 3; i++) {
      let answer: "created" | "exists" | "unknown";
      try {
        answer = await github.createRef(repo.github, branch, sha);
      } catch (err) {
        if (err instanceof GitHubError && (err.kind === "transient" || err.kind === "unknown")) answer = "unknown";
        else if (err instanceof GitHubError && err.kind === "rejected") return { kind: "failed", detail: `GitHub refused ${branch}: ${err.message}` };
        else throw err;
      }
      if (answer === "created") return { kind: "owned", sha, how: "created" };
      if (answer === "unknown" && (await github.getBranchSha(repo.github, branch)) === null) continue; // absent: create again
      return this.judgeExistingRef(github, repo, branch, a);
    }
    return { kind: "pending", detail: `create of ${branch} has no known outcome after 3 tries; the next tick re-reads it` };
  }

  /** The 422 rule: walk the ref's first-parent history to its reservation commit and judge whose it is. */
  private async judgeExistingRef(github: ReservationGitHub, repo: AutopilotRepoConfig, branch: string, a: AutopilotAttempt):
    Promise<{ kind: "owned"; sha: string; how: "owned" | "reused" } | { kind: "external" | "failed" | "pending"; detail: string }> {
    const head = await github.getBranchSha(repo.github, branch);
    if (head === null) return { kind: "pending", detail: `${branch} answered "exists" and then read as absent; the next tick retries` };
    const root = await this.reservationOf(github, repo.github, head);
    if (!root) return { kind: "external", detail: `${branch} has no reservation commit in its last ${WALK_LIMIT} first-parent commits` };
    if (root.itemId !== a.itemId) return { kind: "external", detail: `${branch} starts at a reservation for item ${root.itemId}` };
    if (root.reservationId === a.reservationId) return { kind: "owned", sha: root.sha, how: "owned" };
    const earlier = this.d.autopilot.attemptOfReservation(root.reservationId);
    if (!earlier || earlier.itemId !== a.itemId || root.lane !== RESERVATION_LANE) {
      return { kind: "external", detail: `${branch} was reserved by lane ${root.lane} (reservation ${root.reservationId})` };
    }
    // An earlier attempt of ours. Its ref is reused only while it holds nothing but that reservation.
    if (earlier.state === "failed" && head === root.sha) return { kind: "owned", sha: root.sha, how: "reused" };
    return { kind: "failed", detail: `${branch} belongs to attempt ${earlier.attemptNo} (${earlier.state}) and is at ${head}, not its reservation ${root.sha}; itay decides` };
  }

  private async reservationOf(github: ReservationGitHub, repo: string, head: string): Promise<{ sha: string; itemId: string; lane: string; reservationId: string } | undefined> {
    let sha: string | undefined = head;
    for (let i = 0; sha && i < WALK_LIMIT; i++) {
      const commit = await github.getCommit(repo, sha);
      if (!commit) return undefined;
      const r = parseReservation(commit.message);
      if (r) return { sha: commit.sha, ...r };
      sha = commit.parents[0];
    }
    return undefined;
  }

  /* --------------------------------------------------------- selectNext -- */

  /**
   * §C.2.1 first row: pick an item and record the intent. Refuses (returns `idle` with the reason)
   * while any attempt is non-final, the autopilot is not running, no window has room, the
   * attestation is stale or the instance is not configured.
   */
  async selectNext(): Promise<TickAction> {
    const idle = (reason: string): TickAction => ({ action: "idle", reason });
    const problems = this.problems();
    if (problems.length > 0) return idle(problems[0]!);
    const status = this.d.autopilot.status();
    if (status.attempt) return idle(`attempt ${status.attempt.id} is ${status.attempt.state}`);
    if (status.status !== "running") return idle(`autopilot is ${status.status}`);
    const w = status.window;
    if (!w) return idle("no window is open");
    if (Date.parse(w.closesAt) - this.now().getTime() < this.cfg.minSliceMs) return idle("the window closes within minSliceMs");
    if (w.charged >= w.maxItems) return idle(`window count: ${w.charged} of ${w.maxItems} items already charged`);
    if (!status.billingAttestation?.current) return idle("no current billing attestation");
    if (status.settings.length > 0) return idle(`${status.settings[0]!.setting} ${status.settings[0]!.detail}`);

    const backlogRepo = this.cfg.repos[this.cfg.backlogRepo]!;
    let picked: { item: BacklogItem; items: BacklogItem[]; backlogSha: string } | undefined;
    try {
      await this.git.fetch(backlogRepo.path, [`+refs/heads/main:refs/remotes/origin/main`]);
      const backlogSha = await this.git.revParse(backlogRepo.path, "origin/main^{commit}");
      if (!backlogSha) return idle("origin/main does not resolve in the backlog repo");
      const text = await this.git.show(backlogRepo.path, backlogSha, BACKLOG_PATH);
      if (text === null) return idle(`${BACKLOG_PATH} does not exist at origin/main`);
      const parsed = parseBacklog(text);
      if ("problem" in parsed) return idle(`backlog at ${backlogSha.slice(0, 12)}: ${parsed.problem}`);
      const views: ItemView[] = [];
      for (const item of parsed.items) {
        const view = await this.view(item, parsed.items);
        views.push(view);
        if (!picked && (view.status === "queued" || view.status === "retryable")) picked = { item, items: parsed.items, backlogSha };
      }
      this.selection = views;
    } catch (err) {
      return idle(this.githubFailure(err, "selection"));
    }
    if (!picked) return idle("no item is queued or retryable");

    // Base: the item repo's base branch, fetched now; the reservation commit is built on it.
    const repo = this.cfg.repos[picked.item.repo]!;
    try {
      await this.git.fetch(repo.path, [`+refs/heads/${repo.base}:refs/remotes/origin/${repo.base}`]);
    } catch (err) {
      return idle(`fetch of ${repo.github} ${repo.base} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    const baseSha = await this.git.revParse(repo.path, `origin/${repo.base}^{commit}`);
    const tree = baseSha ? await this.git.revParse(repo.path, `${baseSha}^{tree}`) : null;
    if (!baseSha || !tree) return idle(`origin/${repo.base} does not resolve in ${repo.path}`);
    const reservationId = randomUUID();
    const date = new Date(Math.floor(this.now().getTime() / 1000) * 1000).toISOString().replace(".000Z", "Z");
    const localSha = await this.git.commitTree(repo.path, { tree, parent: baseSha, message: reservationMessage(picked.item.id, RESERVATION_LANE, reservationId), ...RESERVATION_AUTHOR, date });
    let attempt: AutopilotAttempt;
    try {
      attempt = this.d.autopilot.reserve({
        itemId: picked.item.id, reservationId, reservationSha: localSha, repo: picked.item.repo, baseSha,
        reservationDate: date, itemRevision: itemRevision(picked.item.raw), backlogSha: picked.backlogSha,
      });
    } catch (err) {
      return idle(`intent refused: ${err instanceof Error ? err.message : String(err)}`);
    }
    this.log("info", `selected ${picked.item.id}: attempt ${attempt.attemptNo}, reservation ${reservationId}`);
    try {
      return await this.finishReservation(attempt);
    } catch (err) {
      return { action: "drove", attemptId: attempt.id, state: "reserving", detail: this.githubFailure(err, "reservation") };
    }
  }

  /** §C.3 derived status. Reads GitHub for the item's own PRs and ref, and its dependencies' PRs. */
  private async view(item: BacklogItem, items: BacklogItem[]): Promise<ItemView> {
    const v = (status: ItemView["status"], reason: string): ItemView => ({ itemId: item.id, status, reason });
    if (item.lane !== RESERVATION_LANE) return v("skipped", `lane ${item.lane}`);
    if (!item.night) return v("skipped", "not night-eligible");
    const repo = this.cfg.repos[item.repo];
    if (!repo) return v("skipped", `repo ${item.repo} is not in autopilot.repos`);
    if (!item.acceptance) return v("blocked", "no acceptance");
    const github = this.d.github!;
    const branch = `os/${item.id}`;
    const last = this.d.autopilot.attemptsOfItem(item.id)[0];

    // The latest attempt row first (§C.3).
    if (last && last.state !== "failed") return v(last.state === "published" ? "in review" : "blocked", `attempt ${last.attemptNo} is ${last.state}${last.reason ? ` (${last.reason})` : ""}`);
    if (last && last.attemptNo >= this.cfg.attemptsPerItem) return v("blocked", `attempts exhausted (${last.attemptNo} of ${this.cfg.attemptsPerItem})`);

    const prs = await github.listPullsForHead(repo.github, branch);
    const state = prState(prs);
    if (state === "merged") return v("done", `PR #${prs.find((p) => p.merged)!.number} merged`);
    if (state === "open") return v("in review", `PR #${prs.find((p) => p.state === "open")!.number} is open`);
    if (state === "closed") return v("blocked", "a closed, unmerged PR exists; needs itay");

    for (const dep of item.depends_on) {
      const depItem = items.find((i) => i.id === dep)!;
      const depRepo = this.cfg.repos[depItem.repo];
      if (!depRepo) return v("skipped", `depends on ${dep} in unconfigured repo ${depItem.repo}`);
      if (prState(await github.listPullsForHead(depRepo.github, `os/${dep}`)) !== "merged") return v("skipped", `waits on ${dep}`);
    }

    const head = await github.getBranchSha(repo.github, branch);
    if (head !== null && !last) return v("running", `${branch} exists with no PR and no plane attempt: a manual lane holds it`);
    if (head !== null && last && head !== last.reservationSha) return v("blocked", `${branch} carries work past attempt ${last.attemptNo}'s reservation; needs itay`);
    return last ? v("retryable", `attempt ${last.attemptNo} failed${last.reason ? ` (${last.reason})` : ""}`) : v("queued", "eligible");
  }

  /** The item as the attempt read it: the backlog at the attempt's own backlog commit. */
  private async itemAt(a: AutopilotAttempt): Promise<BacklogItem | undefined> {
    const backlogRepo = this.cfg.repos[this.cfg.backlogRepo];
    if (!backlogRepo || !a.backlogSha) return undefined;
    const text = await this.git.show(backlogRepo.path, a.backlogSha, BACKLOG_PATH);
    const parsed = text === null ? undefined : parseBacklog(text);
    return parsed && "items" in parsed ? parsed.items.find((i) => i.id === a.itemId) : undefined;
  }

  /** 401/403 stops the autopilot (`github-auth`, as for publications); anything else waits for the next tick. */
  private githubFailure(err: unknown, where: string): string {
    const msg = err instanceof Error ? err.message : String(err);
    if (err instanceof GitHubError && err.kind === "auth") {
      this.d.autopilot.halt("github-auth");
      this.log("error", `${where}: ${msg}; autopilot stopped (github-auth)`);
      return `github-auth: ${msg}`;
    }
    this.log("warn", `${where}: ${msg}`);
    return `${where} will retry: ${msg}`;
  }
}

function prState(prs: PullRequest[]): "merged" | "open" | "closed" | "none" {
  if (prs.some((p) => p.merged)) return "merged";
  if (prs.some((p) => p.state === "open")) return "open";
  return prs.length > 0 ? "closed" : "none";
}

function taskGoal(itemId: string, item: BacklogItem | undefined): string {
  if (!item) return `Backlog item ${itemId} (docs/progress/backlog.yaml).`;
  return [
    item.title,
    "",
    `Backlog item \`${item.id}\` (${item.phase}, size ${item.size}) from docs/progress/backlog.yaml.`,
    ...(item.notes ? ["", item.notes] : []),
    ...(item.source ? ["", `Source: ${item.source}`] : []),
  ].join("\n");
}

function taskConstraints(branch: string, item: BacklogItem | undefined): string[] {
  const out = [
    `This worktree is based on the reservation commit of ${branch}. Commit your work here; the plane checkpoints, accepts and publishes it. Do not push, open PRs or change branches.`,
    "Acceptance runs offline on a read-only snapshot of your checkpoint with commands from origin/main; changing tests or acceptance commands does not change what runs.",
  ];
  if (item?.files.length) out.push(`Expected files: ${item.files.join(", ")}.`);
  if (item?.acceptance?.commands.length) out.push(`Acceptance commands: ${item.acceptance.commands.map((c) => c.run).join(" && ")}.`);
  return out;
}
