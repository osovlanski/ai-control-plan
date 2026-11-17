/**
 * P0-7b (docs/agentic-os-auto-copilot-plan.md §C.5 "Restore fails closed").
 *
 * A database the restore script put back is detected at boot by the `restored_at.json` marker the
 * script writes next to it (before it swaps the file, so a failed swap still boots fail-closed).
 * `detectRestore` runs inside `buildServer`, before any boot reconciliation or timer, and in ONE
 * transaction records the restore and stops the autopilot (`stop_reason = 'restored'`). The marker
 * is then moved aside; its digest is unique, so a crash before the move records it once.
 *
 * From then on, until a start clears it:
 * - every window that was open at detection admits nothing, even after a start (the launch check,
 *   acceptance and selection read `restoreInsideWindow`), so the first launch is in the next window;
 * - `POST /api/autopilot/start` is refused until ONE reconciliation produced a complete report and
 *   that report was read back through `autopilot.operate` (`GET /api/autopilot/restore/report`).
 *
 * The reconciliation (`reconcile`) reads GitHub and the disk; it never launches a provider:
 * - every `os/*` ref of each configured repo: the reservation commit at the root of its
 *   first-parent history names a reservation id. Known → reattached to its attempt (a `reserving`
 *   attempt gets the SHA recorded, as for an owned 422). Unknown, or no reservation commit →
 *   recorded in `autopilot_externals` and never re-run (the dispatcher reports the item blocked);
 * - every PR carrying an `aos-publication` marker: matched to its publication, or external;
 * - every worktree on disk that no task, run or live acceptance run of this database owns:
 *   quarantined (moved aside into `<root>/.quarantine/<restore id>/`), never deleted;
 * - every non-final attempt by its §C.2.1 rule: a `running` attempt whose session is gone is
 *   `suspended` (a cut session), everything else is left where its own driver picks it up;
 * - the agent user's slice: any process is reported; the host gate already stays closed for it.
 */
import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync } from "node:fs";
import { basename, join, sep } from "node:path";
import type { ResolvedConfig } from "../config.js";
import type { Db } from "../db/index.js";
import { NON_FINAL_ATTEMPT_STATES, restoreInsideWindow, type AutopilotService, type AutopilotStartGate } from "./autopilot.js";
import { parseReservation } from "./autopilot-dispatcher.js";
import { GitHubError, markerOf, type PullRequest, type ReconcileGitHub } from "./publications.js";

export const RESTORE_MARKER_FILE = "restored_at.json";
/** How far back the walk looks for a reservation commit before calling a ref foreign (same as the dispatcher). */
const WALK_LIMIT = 200;
const QUARANTINE_DIR = ".quarantine";

/** What the restore script writes. Every field is optional on read: a marker that exists always counts. */
export interface RestoreMarker { restoredAt: string; backup?: string; backupTakenAt?: string; backupSha256?: string }

interface RestoreRow {
  id: string; marker_digest: string; restored_at: string; backup_name: string | null; backup_taken_at: string | null; backup_sha256: string | null;
  detected_at: string; report_json: string | null; report_digest: string | null; report_complete: number | null; reconciled_at: string | null;
  reconcile_error: string | null; read_at: string | null; read_by: string | null; read_digest: string | null; cleared_at: string | null; cleared_by: string | null;
}

const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/;
const iso = (v: unknown): string | undefined => (typeof v === "string" && ISO.test(v) && Number.isFinite(Date.parse(v)) ? new Date(v).toISOString() : undefined);

/**
 * Boot (synchronous, before anything dispatches). A marker that exists but cannot be parsed still
 * counts as a restore: the plane cannot tell what happened, so it fails closed.
 */
export function detectRestore(db: Db, dir: string, now: () => Date = () => new Date(), log?: (msg: string) => void): { restoreId: string; recorded: boolean } | undefined {
  const path = join(dir, RESTORE_MARKER_FILE);
  let raw: Buffer;
  try {
    // O_NOFOLLOW: a symlink planted as the marker is refused (and then reported, below).
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      if (!fstatSync(fd).isFile()) throw Object.assign(new Error("not a regular file"), { code: "ENOTREG" });
      raw = readFileSync(fd);
    } finally { closeSync(fd); }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return undefined;
    // Present but unreadable: still a restore. Record it by the error, so it is not lost.
    raw = Buffer.from(`unreadable marker: ${code ?? "error"}`);
  }
  const digest = createHash("sha256").update(raw).digest("hex");
  let marker: Partial<RestoreMarker> = {};
  try { const parsed = JSON.parse(raw.toString("utf8")) as unknown; if (parsed && typeof parsed === "object") marker = parsed as Partial<RestoreMarker>; } catch { /* fail closed below */ }
  const at = now().toISOString();
  const restoredAt = iso(marker.restoredAt) ?? at;
  const backupName = typeof marker.backup === "string" ? basename(marker.backup).slice(0, 200) : null;
  const sha = typeof marker.backupSha256 === "string" && /^[0-9a-f]{64}$/.test(marker.backupSha256) ? marker.backupSha256 : null;

  const result = db.transaction(() => {
    const existing = db.prepare("SELECT id, cleared_at FROM autopilot_restores WHERE marker_digest = ?").get(digest) as { id: string; cleared_at: string | null } | undefined;
    if (existing) {
      // Seen before (a crash before the marker moved). Still uncleared → keep the autopilot stopped.
      if (!existing.cleared_at) db.prepare("UPDATE autopilot_state SET status = 'stopped', stop_reason = 'restored', updated_at = ? WHERE id = 1").run(at);
      return { restoreId: existing.id, recorded: false };
    }
    const id = `aprs_${randomUUID()}`;
    db.prepare(`INSERT INTO autopilot_restores(id, marker_digest, restored_at, backup_name, backup_taken_at, backup_sha256, detected_at) VALUES(?,?,?,?,?,?,?)`)
      .run(id, digest, restoredAt, backupName, iso(marker.backupTakenAt) ?? null, sha, at);
    db.prepare("UPDATE autopilot_state SET status = 'stopped', stop_reason = 'restored', updated_at = ? WHERE id = 1").run(at);
    return { restoreId: id, recorded: true };
  })();
  try {
    renameSync(path, join(dir, `${RESTORE_MARKER_FILE}.consumed-${result.restoreId}`));
  } catch (err) {
    log?.(`restore marker ${path} not moved aside (${(err as NodeJS.ErrnoException).code ?? "error"}); the next boot finds the same restore`);
  }
  return result;
}

/* ----------------------------------------------------------------- report -- */

export interface RestoreReport {
  restoreId: string;
  restoredAt: string;
  backup: { name: string | null; takenAt: string | null; sha256: string | null };
  detectedAt: string;
  generatedAt: string;
  /** Every section was read. An incomplete report never unlocks a start. */
  complete: boolean;
  problems: string[];
  refs: Array<{ repo: string; branch: string; sha: string; outcome: "reattached" | "external"; reservationId?: string; reservationSha?: string; itemId?: string; attemptId?: string; attemptState?: string; detail: string }>;
  pulls: Array<{ repo: string; number: number; head: string; state: string; merged: boolean; marker: string; outcome: "matched" | "external"; publicationId?: string; publicationState?: string }>;
  publications: Array<{ id: string; attemptId: string; repo: string; head: string; state: string; prNumber: number | null; markerPr: number | null; detail: string }>;
  worktrees: { scanned: string[]; kept: number; quarantined: Array<{ path: string; to: string; earlierRun?: true }>; failed: Array<{ path: string; error: string }> };
  attempts: Array<{ id: string; itemId: string; attemptNo: number; state: string; after: string; rule: string }>;
  agentSlice: { probed: boolean; empty?: boolean; detail: string };
  windows: Array<{ id: string; opensAt: string; closesAt: string }>;
}

export interface RestoreStatus {
  pending: boolean;
  restoreId?: string;
  restoredAt?: string;
  detectedAt?: string;
  backup?: string | null;
  reconciledAt?: string;
  reconcileError?: string;
  reportDigest?: string;
  reportComplete?: boolean;
  reportReadAt?: string;
  reportReadBy?: string;
  reportReadCurrent?: boolean;
  reconciling: boolean;
  startBlockedBy?: { setting: string; detail: string };
  summary?: { refs: Record<string, number>; pulls: Record<string, number>; quarantined: number; quarantineFailed: number; attempts: number; agentSliceEmpty: boolean | null; problems: number };
}

export interface RestoreDeps {
  db: Db;
  config: ResolvedConfig;
  autopilot: AutopilotService;
  /** Absent = no GitHub token: with repos configured, the report is incomplete. */
  github?: ReconcileGitHub;
  /** Worktree roots to census. `skip` names children that are other roots (the acceptance tree). */
  worktreeRoots: Array<{ root: string; skip?: string[] }>;
  /** The agent slice census; a throw is "could not probe". Absent = no agent user. */
  agentSlice?: () => { ok: true } | { ok: false; detail: string };
  now?: () => Date;
  log?: (level: "info" | "warn" | "error", msg: string) => void;
}

const LIVE_ACCEPTANCE = new Set(["preparing", "running"]);

export class AutopilotRestore implements AutopilotStartGate {
  private readonly db: Db;
  private readonly now: () => Date;
  private running?: Promise<RestoreStatus>;

  constructor(private readonly d: RestoreDeps) {
    this.db = d.db;
    this.now = d.now ?? (() => new Date());
  }

  private log(level: "info" | "warn" | "error", msg: string): void { this.d.log?.(level, `autopilot restore: ${msg}`); }

  /** The newest restore no start has cleared yet. */
  private pendingRow(): RestoreRow | undefined {
    return this.db.prepare("SELECT * FROM autopilot_restores WHERE cleared_at IS NULL ORDER BY detected_at DESC, rowid DESC LIMIT 1").get() as RestoreRow | undefined;
  }
  private latestRow(): RestoreRow | undefined {
    return this.db.prepare("SELECT * FROM autopilot_restores ORDER BY detected_at DESC, rowid DESC LIMIT 1").get() as RestoreRow | undefined;
  }

  /* --------------------------------------------------------- start gate -- */

  blocker(): { setting: string; detail: string } | undefined {
    const r = this.pendingRow();
    if (!r) return undefined;
    if (!r.report_json || !r.report_digest) {
      return { setting: "restore.reconcile", detail: `restore ${r.id}: this database was restored; no reconciliation report exists yet${r.reconcile_error ? ` (last try: ${r.reconcile_error})` : ""}. Run POST /api/autopilot/restore/reconcile` };
    }
    if (r.report_complete !== 1) {
      const problems = (JSON.parse(r.report_json) as RestoreReport).problems;
      return { setting: "restore.reconcile", detail: `restore ${r.id}: the reconciliation report is incomplete (${problems.slice(0, 3).join("; ")}). Fix it and reconcile again` };
    }
    if (r.read_digest !== r.report_digest) {
      return { setting: "restore.report", detail: `restore ${r.id}: read the reconciliation report back with GET /api/autopilot/restore/report (autopilot.operate) before starting` };
    }
    return undefined;
  }

  /** Inside the start's transaction: every pending restore is cleared by this start. */
  cleared(by: string): void {
    this.db.prepare("UPDATE autopilot_restores SET cleared_at = ?, cleared_by = ? WHERE cleared_at IS NULL").run(this.now().toISOString(), by);
  }

  /* -------------------------------------------------------------- reads -- */

  status(): RestoreStatus {
    const r = this.pendingRow() ?? this.latestRow();
    const pending = !!r && !r.cleared_at;
    if (!r) return { pending: false, reconciling: !!this.running };
    const report = r.report_json ? JSON.parse(r.report_json) as RestoreReport : undefined;
    const count = <T extends { outcome: string }>(xs: T[]) => xs.reduce<Record<string, number>>((m, x) => { m[x.outcome] = (m[x.outcome] ?? 0) + 1; return m; }, {});
    const blocked = pending ? this.blocker() : undefined;
    return {
      pending, restoreId: r.id, restoredAt: r.restored_at, detectedAt: r.detected_at, backup: r.backup_name,
      ...(r.reconciled_at ? { reconciledAt: r.reconciled_at } : {}),
      ...(r.reconcile_error ? { reconcileError: r.reconcile_error } : {}),
      ...(r.report_digest ? { reportDigest: r.report_digest, reportComplete: r.report_complete === 1 } : {}),
      ...(r.read_at ? { reportReadAt: r.read_at, reportReadBy: r.read_by ?? undefined, reportReadCurrent: r.read_digest === r.report_digest } : {}),
      reconciling: !!this.running,
      ...(blocked ? { startBlockedBy: blocked } : {}),
      ...(report ? {
        summary: {
          refs: count(report.refs), pulls: count(report.pulls),
          quarantined: report.worktrees.quarantined.length, quarantineFailed: report.worktrees.failed.length,
          attempts: report.attempts.length, agentSliceEmpty: report.agentSlice.probed ? !!report.agentSlice.empty : null, problems: report.problems.length,
        },
      } : {}),
    };
  }

  /**
   * `autopilot.operate`: the full report of the newest restore, and the read-back a start needs
   * (§C.5 "read back through autopilot.operate"). The read is recorded against this report's
   * digest; a later reconciliation makes a new report that needs its own read.
   */
  readReport(by: string): { report: RestoreReport; digest: string; pending: boolean } {
    const r = this.pendingRow() ?? this.latestRow();
    if (!r?.report_json || !r.report_digest) throw new RestoreRefused(r ? `restore ${r.id} has no reconciliation report yet` : "no restore was ever detected");
    if (!r.cleared_at) {
      this.db.prepare("UPDATE autopilot_restores SET read_at = ?, read_by = ?, read_digest = ? WHERE id = ?").run(this.now().toISOString(), by, r.report_digest, r.id);
    }
    return { report: JSON.parse(r.report_json) as RestoreReport, digest: r.report_digest, pending: !r.cleared_at };
  }

  /* ------------------------------------------------------ reconciliation -- */

  /** Boot: one reconciliation for a pending restore without a report. Never throws. */
  async reconcileIfPending(): Promise<void> {
    const r = this.pendingRow();
    if (!r || r.report_json) return;
    try { await this.reconcile(); } catch (err) { this.log("error", `boot reconciliation failed: ${err instanceof Error ? err.message : String(err)}`); }
  }

  /** Single-flight. Refused when no restore is pending, or the autopilot is not stopped. */
  reconcile(): Promise<RestoreStatus> {
    if (this.running) return this.running;
    const r = this.pendingRow();
    if (!r) return Promise.reject(new RestoreRefused("no restore is pending"));
    if (this.d.autopilot.runState() !== "stopped") return Promise.reject(new RestoreRefused("the autopilot is not stopped"));
    this.running = (async () => {
      try {
        const report = await this.build(r);
        const json = JSON.stringify(report);
        const digest = createHash("sha256").update(json).digest("hex");
        this.db.prepare("UPDATE autopilot_restores SET report_json = ?, report_digest = ?, report_complete = ?, reconciled_at = ?, reconcile_error = NULL WHERE id = ?")
          .run(json, digest, report.complete ? 1 : 0, report.generatedAt, r.id);
        this.log(report.complete ? "info" : "warn", `restore ${r.id} reconciled (${report.complete ? "complete" : `incomplete: ${report.problems.join("; ")}`})`);
      } catch (err) {
        this.db.prepare("UPDATE autopilot_restores SET reconcile_error = ? WHERE id = ?").run(String(err instanceof Error ? err.message : err).slice(0, 500), r.id);
        throw err;
      } finally {
        this.running = undefined;
      }
      return this.status();
    })();
    return this.running;
  }

  private async build(r: RestoreRow): Promise<RestoreReport> {
    const problems: string[] = [];
    const repos = Object.entries(this.d.config.autopilot.repos);
    const refs: RestoreReport["refs"] = [];
    const pulls: RestoreReport["pulls"] = [];
    const pullsByRepo = new Map<string, PullRequest[]>();
    const github = this.d.github;

    if (repos.length > 0 && !github) problems.push("autopilot.github.tokenFile is not configured: os/* refs and PRs could not be read");
    if (github) {
      for (const [, repo] of repos) {
        if (pullsByRepo.has(repo.github)) continue;
        try {
          const branches = await github.listBranches(repo.github, "os/");
          for (const b of branches.sort((a, c) => a.branch.localeCompare(c.branch))) refs.push(await this.judgeRef(github, repo.github, b.branch, b.sha, r.id));
          const prs = (await github.listPulls(repo.github)).filter((p) => p.headRef.startsWith("os/") && (!p.headRepo || p.headRepo === repo.github));
          pullsByRepo.set(repo.github, prs);
          for (const p of prs.sort((a, c) => a.number - c.number)) {
            const marker = markerOf(p.body);
            if (marker) pulls.push(this.judgePull(repo.github, p, marker, r.id));
          }
        } catch (err) {
          const why = err instanceof GitHubError ? `${err.kind}${err.status ? ` ${err.status}` : ""}: ${err.message}` : err instanceof Error ? err.message : String(err);
          problems.push(`GitHub ${repo.github}: ${why}`);
        }
      }
    }

    const publications = this.publicationsSection(pullsByRepo);
    for (const p of publications) if (p.state === "published" && p.markerPr === null && pullsByRepo.has(p.repo)) problems.push(`publication ${p.id} is published but no PR carries its marker`);
    const worktrees = this.worktreesSection(r.id);
    for (const f of worktrees.failed) problems.push(`worktree ${f.path} could not be quarantined: ${f.error}`);
    const attempts = this.attemptsSection(refs, pullsByRepo);
    const agentSlice = this.agentSliceSection();
    const windows = (this.db.prepare("SELECT id, opens_at, closes_at FROM autopilot_windows ORDER BY opens_at").all() as Array<{ id: string; opens_at: string; closes_at: string }>)
      .filter((w) => restoreInsideWindow(this.db, w.opens_at, w.closes_at) === r.id).map((w) => ({ id: w.id, opensAt: w.opens_at, closesAt: w.closes_at }));

    return {
      restoreId: r.id, restoredAt: r.restored_at, backup: { name: r.backup_name, takenAt: r.backup_taken_at, sha256: r.backup_sha256 },
      detectedAt: r.detected_at, generatedAt: this.now().toISOString(), complete: problems.length === 0, problems,
      refs, pulls, publications, worktrees, attempts, agentSlice, windows,
    };
  }

  /** §C.5 first bullet: the reservation commit at the root of the ref's first-parent history. */
  private async judgeRef(github: ReconcileGitHub, repo: string, branch: string, head: string, restoreId: string): Promise<RestoreReport["refs"][number]> {
    let sha: string | undefined = head;
    let root: { sha: string; itemId: string; lane: string; reservationId: string } | undefined;
    for (let i = 0; sha && i < WALK_LIMIT && !root; i++) {
      const commit = await github.getCommit(repo, sha);
      if (!commit) break;
      const parsed = parseReservation(commit.message);
      if (parsed) root = { sha: commit.sha, ...parsed };
      sha = commit.parents[0];
    }
    const attempt = root ? this.d.autopilot.attemptOfReservation(root.reservationId) : undefined;
    if (root && attempt && attempt.itemId === root.itemId && `os/${root.itemId}` === branch) {
      return { repo, branch, sha: head, outcome: "reattached", reservationId: root.reservationId, reservationSha: root.sha, itemId: root.itemId, attemptId: attempt.id, attemptState: attempt.state, detail: `reservation commit ${root.sha.slice(0, 12)} belongs to attempt ${attempt.attemptNo} of ${attempt.itemId}` };
    }
    const itemId = root?.itemId ?? branch.slice("os/".length);
    const detail = root
      ? `reservation ${root.reservationId} (lane ${root.lane}) is not in this database; never re-run`
      : `no reservation commit within ${WALK_LIMIT} first-parent commits; never re-run`;
    this.recordExternal({ kind: "reservation", repo, head: branch, itemId, sha: root?.sha ?? head, reservationId: root?.reservationId ?? null, prNumber: null, marker: null, detail, restoreId });
    return { repo, branch, sha: head, outcome: "external", ...(root ? { reservationId: root.reservationId, reservationSha: root.sha } : {}), itemId, detail };
  }

  private judgePull(repo: string, p: PullRequest, marker: string, restoreId: string): RestoreReport["pulls"][number] {
    const pub = this.db.prepare("SELECT id, state FROM autopilot_publications WHERE id = ?").get(marker) as { id: string; state: string } | undefined;
    const base = { repo, number: p.number, head: p.headRef, state: p.state, merged: p.merged, marker };
    if (pub) return { ...base, outcome: "matched", publicationId: pub.id, publicationState: pub.state };
    this.recordExternal({ kind: "publication", repo, head: p.headRef, itemId: p.headRef.slice("os/".length), sha: p.headSha, reservationId: null, prNumber: p.number, marker, detail: `PR #${p.number} carries marker ${marker}, which is not in this database`, restoreId });
    return { ...base, outcome: "external" };
  }

  /**
   * Records an external once per identity. A row itay dismissed (P0-7c) is reopened only by a
   * different restore: a re-run of the same reconciliation keeps his decision, a new restore is a
   * new decision point.
   */
  private recordExternal(e: { kind: "reservation" | "publication"; repo: string; head: string; itemId: string | null; sha: string | null; reservationId: string | null; prNumber: number | null; marker: string | null; detail: string; restoreId: string }): void {
    const at = this.now().toISOString();
    const known = this.db.prepare(`SELECT id, restore_id, resolved_at FROM autopilot_externals
      WHERE kind = ? AND repo = ? AND head = ? AND COALESCE(reservation_id, '') = ? AND COALESCE(pr_number, 0) = ?`)
      .get(e.kind, e.repo, e.head, e.reservationId ?? "", e.prNumber ?? 0) as { id: number; restore_id: string | null; resolved_at: string | null } | undefined;
    if (!known) {
      this.db.prepare(`INSERT INTO autopilot_externals(kind, repo, head, item_id, sha, reservation_id, pr_number, marker, detail, restore_id, recorded_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(e.kind, e.repo, e.head, e.itemId, e.sha, e.reservationId, e.prNumber, e.marker, e.detail, e.restoreId, at);
      return;
    }
    if (known.resolved_at && known.restore_id !== e.restoreId) {
      this.db.prepare(`UPDATE autopilot_externals SET item_id = ?, sha = ?, marker = ?, detail = ?, restore_id = ?, recorded_at = ?,
        resolved_at = NULL, resolved_by = NULL, resolution = NULL, resolution_note = NULL WHERE id = ?`)
        .run(e.itemId, e.sha, e.marker, e.detail, e.restoreId, at, known.id);
    }
  }

  private publicationsSection(pullsByRepo: Map<string, PullRequest[]>): RestoreReport["publications"] {
    const rows = this.db.prepare("SELECT id, attempt_id, repo, head, state, pr_number FROM autopilot_publications ORDER BY created_at").all() as
      Array<{ id: string; attempt_id: string; repo: string; head: string; state: string; pr_number: number | null }>;
    return rows.map((p) => {
      const prs = pullsByRepo.get(p.repo);
      const withMarker = prs?.find((x) => markerOf(x.body) === p.id);
      const detail = !prs ? "GitHub not read for this repo"
        : withMarker ? `PR #${withMarker.number} (${withMarker.merged ? "merged" : withMarker.state}) carries its marker${p.state === "publishing" || p.state === "publish_uncertain" ? "; the sweep adopts it" : ""}`
          : p.state === "publish_uncertain" ? "no PR carries its marker; it waits for itay's resolve"
            : p.state === "publishing" ? "no PR carries its marker; the publisher re-checks before any new mutation"
              : "no PR carries its marker";
      return { id: p.id, attemptId: p.attempt_id, repo: p.repo, head: p.head, state: p.state, prNumber: p.pr_number, markerPr: withMarker?.number ?? null, detail };
    });
  }

  /**
   * §C.5 third bullet. A child of a worktree root is owned when its name is a task id of this
   * database, or a task's, run's or acceptance run's recorded path is it or lies under it. An
   * acceptance snapshot is owned only while its run is live. Anything else is moved aside.
   */
  private worktreesSection(restoreId: string): RestoreReport["worktrees"] {
    const taskIds = new Set((this.db.prepare("SELECT id FROM tasks").all() as Array<{ id: string }>).map((t) => t.id));
    const paths = [
      ...(this.db.prepare("SELECT worktree_path AS p FROM tasks WHERE worktree_path IS NOT NULL AND worktree_path <> ''").all() as Array<{ p: string }>),
      ...(this.db.prepare("SELECT worktree_path AS p FROM runs WHERE worktree_path IS NOT NULL AND worktree_path <> ''").all() as Array<{ p: string }>),
      ...(this.db.prepare(`SELECT snapshot_path AS p FROM acceptance_runs WHERE snapshot_path IS NOT NULL AND state IN (${[...LIVE_ACCEPTANCE].map(() => "?").join(",")})`).all(...LIVE_ACCEPTANCE) as Array<{ p: string }>),
    ].map((r) => r.p);
    const owned = (child: string, name: string): boolean => taskIds.has(name) || paths.some((p) => p === child || p.startsWith(child + sep));
    const out: RestoreReport["worktrees"] = { scanned: [], kept: 0, quarantined: [], failed: [] };
    for (const { root, skip = [] } of this.d.worktreeRoots) {
      if (!existsSync(root)) continue;
      out.scanned.push(root);
      // What an earlier run of this restore's reconciliation already moved aside stays in the report.
      const earlier = join(root, QUARANTINE_DIR, restoreId);
      if (existsSync(earlier)) {
        for (const name of readdirSync(earlier).sort()) out.quarantined.push({ path: join(root, name), to: join(earlier, name), earlierRun: true });
      }
      for (const entry of readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        if (!entry.isDirectory() || entry.name.startsWith(".") || skip.includes(entry.name)) continue;
        const child = join(root, entry.name);
        if (owned(child, entry.name)) { out.kept++; continue; }
        const dest = join(root, QUARANTINE_DIR, restoreId);
        const to = join(dest, entry.name);
        try {
          // 0700, plane-owned: the agent user (group-writable root) cannot reach into the quarantine.
          mkdirSync(join(root, QUARANTINE_DIR), { recursive: true, mode: 0o700 });
          mkdirSync(dest, { recursive: true, mode: 0o700 });
          if (lstatSync(child).isSymbolicLink()) throw new Error("became a symlink");
          renameSync(child, to);
          out.quarantined.push({ path: child, to });
        } catch (err) {
          out.failed.push({ path: child, error: (err as NodeJS.ErrnoException).code ?? (err instanceof Error ? err.message : String(err)) });
        }
      }
    }
    return out;
  }

  /** §C.5 fourth bullet: each non-final attempt by its §C.2.1 rule. Nothing here launches a provider. */
  private attemptsSection(refs: RestoreReport["refs"], pullsByRepo: Map<string, PullRequest[]>): RestoreReport["attempts"] {
    const rows = this.db.prepare(`SELECT id FROM autopilot_attempts WHERE state IN (${NON_FINAL_ATTEMPT_STATES.map(() => "?").join(",")}) ORDER BY created_at`).all(...NON_FINAL_ATTEMPT_STATES) as Array<{ id: string }>;
    return rows.map(({ id }) => {
      const a = this.d.autopilot.attempt(id)!;
      const repo = a.repo ? this.d.config.autopilot.repos[a.repo]?.github : undefined;
      const head = `os/${a.itemId}`;
      const prs = repo ? pullsByRepo.get(repo)?.filter((p) => p.headRef === head) ?? [] : [];
      const prNote = prs.length > 0 ? ` PR ${prs.map((p) => `#${p.number}`).join(", ")} exists for ${head}; the publisher adopts it by marker or reports a conflict, never a second PR.` : "";
      let rule: string;
      switch (a.state) {
        case "reserving": {
          const ref = refs.find((x) => x.attemptId === a.id);
          if (ref?.reservationSha && this.d.autopilot.reattachReservation(a.id, ref.reservationSha)) rule = `reattached: ${head} holds its reservation; the dispatcher admits it after a start.`;
          else if (ref) rule = `reattached: ${head} holds its reservation (already recorded); the dispatcher admits it after a start.`;
          else rule = `no ${head} with its reservation; after a start the dispatcher finishes the reservation (create-if-absent, §C.2.2).`;
          break;
        }
        case "admitted": rule = "admitted: launches only after a start, in a window that opens after the restore."; break;
        case "running":
          rule = this.d.autopilot.suspendLostSession(a.id, "restored: the session did not survive the restore")
            ? "running with no live session: suspended, because its session did not survive the restore (a cut session); resumes in the next window and is charged there."
            : "running with a live session recorded: left running; the host gate stays closed while the agent slice holds a process.";
          break;
        case "suspended": rule = a.reason?.startsWith("restored:")
          ? "suspended by an earlier run of this reconciliation: its session did not survive the restore; resumes in the next window."
          : "suspended: resumes in the next window."; break;
        case "settled": rule = "settled: acceptance after a start, on a fresh snapshot, offline."; break;
        case "accepting": rule = "accepting: the boot marked an interrupted run crashed; it is replayed only if every command is replay-safe, else blocked."; break;
        case "accepted": rule = "accepted: the publication intent is made after a start; the publisher re-checks GitHub before any mutation."; break;
        case "publishing": rule = "publishing: no new mutation until a start; the sweep reconciles by marker first."; break;
        case "publish_uncertain": rule = "publish_uncertain: unchanged; waits for itay's resolve."; break;
        default: rule = `${a.state}: no rule.`;
      }
      return { id: a.id, itemId: a.itemId, attemptNo: a.attemptNo, state: a.state, after: this.d.autopilot.attempt(id)!.state, rule: rule + prNote };
    });
  }

  private agentSliceSection(): RestoreReport["agentSlice"] {
    if (!this.d.agentSlice) return { probed: false, detail: "no agent user configured" };
    try {
      const r = this.d.agentSlice();
      return r.ok ? { probed: true, empty: true, detail: "empty" } : { probed: true, empty: false, detail: `${r.detail}; the host gate stays closed until it exits` };
    } catch (err) {
      return { probed: false, detail: `unreadable: ${err instanceof Error ? err.message : String(err)}; the host gate refuses while it is` };
    }
  }
}

export class RestoreRefused extends Error {
  constructor(message: string) { super(message); this.name = "RestoreRefused"; }
}
