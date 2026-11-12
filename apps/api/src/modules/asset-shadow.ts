/**
 * M6 S4: the asset shadow scorer's I/O (docs/agentic-os-m6-composition-telemetry.md §4).
 *
 * `record` runs once per composition attempt that reached stage 3, after the attempt row and
 * outside its transaction. It reads the ledger over the 30-day window, scores it with core's
 * asset-shadow/v1, compares the shadow rank with stage 3's computed choice and appends one
 * `asset_shadow_log` row. It never throws and never changes the attempt: a scorer error writes a
 * row with an error code, and a failed write is logged with the attempt id only. Nothing here is
 * read by the composer; there is no activation path (Q11).
 *
 * The read functions take a `Db` and only SELECT, so the report bin can use them on a read-only,
 * unmigrated handle.
 */
import {
  ASSET_SHADOW_FORMULA, ASSET_SHADOW_WINDOW_DAYS, assetShadow, scoreAssets, shadowView,
  type AssetScores, type AssetShadowObservation, type AssetShadowResult, type AssetShadowWindow, type ComposerInputs,
  type CompositionDecisionDraft, type AssetSessionOutcome, type AssetInvocationMethod, type AssetUsageKind,
} from "@agent-plane/core";
import { TASK_KINDS } from "@agent-plane/core";
import type { Db } from "../db/index.js";
import { HARNESS_APPROVAL_MODES, harnessOf } from "./composer/ports.js";
import { taskKindOf } from "./telemetry.js";

interface Logger { warn(obj: object, msg: string): void }

/** What the composer hands over for one attempt. */
export interface ShadowAttempt {
  attemptId: string;
  taskId: string;
  /** Stage 2's chosen assistant; its harness is the cohort's. */
  assistantId: string | undefined;
  decision: CompositionDecisionDraft;
  inputs: Pick<ComposerInputs, "registry" | "config">;
}

export type ShadowScorer = typeof assetShadow;

export interface AssetShadowOptions {
  now?: () => Date;
  /** Test seam: the scorer `record` calls. Defaults to core's `assetShadow`. */
  scorer?: ShadowScorer;
}

/** The window ending at `now`, as core compares it. */
export function shadowWindow(now: Date, days = ASSET_SHADOW_WINDOW_DAYS): AssetShadowWindow {
  return { start: new Date(now.getTime() - days * 86_400_000).toISOString(), end: now.toISOString() };
}

/** Ledger rows inside the window, with each session's task kind (TelemetryService's `taskKindOf`). */
export function readObservations(db: Db, window: AssetShadowWindow): AssetShadowObservation[] {
  const rows = db.prepare(
    `SELECT u.session_id, u.harness, u.asset_kind, u.asset_id, u.asset_digest, u.attached, u.invocation_method, u.invocation_count,
            u.session_outcome, u.verification_passed, u.at, t.goal, t.task_kind, t.classifier_version
       FROM asset_usage u JOIN tasks t ON t.id = u.task_id
      WHERE u.at >= ? AND u.at <= ?
      ORDER BY u.ingest_seq`,
  ).all(window.start, window.end) as Array<{
    session_id: string; harness: string; asset_kind: AssetUsageKind; asset_id: string; asset_digest: string; attached: number;
    invocation_method: AssetInvocationMethod; invocation_count: number | null; session_outcome: AssetSessionOutcome;
    verification_passed: number | null; at: string; goal: string; task_kind: string | null; classifier_version: number | null;
  }>;
  return rows.map((r) => ({
    sessionId: r.session_id,
    taskKind: taskKindOf(r),
    harness: r.harness,
    assetKind: r.asset_kind,
    assetId: r.asset_id,
    assetDigest: r.asset_digest,
    attached: r.attached === 1,
    invocationMethod: r.invocation_method,
    invocationCount: r.invocation_count,
    sessionOutcome: r.session_outcome,
    verificationPassed: r.verification_passed === null ? null : r.verification_passed === 1,
    at: r.at,
  }));
}

/** The §4.1 table, optionally narrowed to one task kind and/or harness. Pools are over what is shown. */
export function assetScores(db: Db, now: Date, filter: { taskKind?: string; harness?: string } = {}): AssetScores {
  const window = shadowWindow(now);
  const observations = readObservations(db, window)
    .filter((o) => (filter.taskKind === undefined || o.taskKind === filter.taskKind) && (filter.harness === undefined || o.harness === filter.harness));
  return scoreAssets(observations, window);
}

export interface ShadowLogEntry {
  attemptId: string;
  taskId: string;
  status: "scored" | "error";
  formula: string;
  taskKind: string | null;
  harness: string | null;
  actual: string[];
  shadow: string[] | null;
  wouldDiffer: boolean | null;
  filterViolations: number | null;
  overridden: boolean;
  scores: unknown;
  error: string | null;
  windowEnd: string;
  at: string;
}

interface LogRow {
  attempt_id: string; task_id: string; status: "scored" | "error"; formula: string; task_kind: string | null; harness: string | null;
  actual_json: string; shadow_json: string | null; would_differ: number | null; filter_violations: number | null; overridden: number;
  scores_json: string | null; error: string | null; window_end: string; at: string;
}

const entryOf = (r: LogRow): ShadowLogEntry => ({
  attemptId: r.attempt_id,
  taskId: r.task_id,
  status: r.status,
  formula: r.formula,
  taskKind: r.task_kind,
  harness: r.harness,
  actual: JSON.parse(r.actual_json) as string[],
  shadow: r.shadow_json === null ? null : (JSON.parse(r.shadow_json) as string[]),
  wouldDiffer: r.would_differ === null ? null : r.would_differ === 1,
  filterViolations: r.filter_violations,
  overridden: r.overridden === 1,
  scores: r.scores_json === null ? null : (JSON.parse(r.scores_json) as unknown),
  error: r.error,
  windowEnd: r.window_end,
  at: r.at,
});

export interface ShadowLogSummary {
  since: string | null;
  /** Attempts logged since `since`: scored and errored. */
  logged: number;
  scored: number;
  errors: number;
  wouldDiffer: number;
  /** wouldDiffer / scored, or null with nothing scored. */
  wouldDifferRate: number | null;
  filterViolations: number;
  /** The most recent would-differ attempts first, at most `limit`. */
  attempts: ShadowLogEntry[];
}

/** `GET /api/composition/shadow`: the would-differ attempts since `since`, with the counts around them. */
export function readShadowLog(db: Db, since: string | undefined, limit: number): ShadowLogSummary {
  const from = since ?? "";
  const counts = db.prepare(
    `SELECT COUNT(*) AS logged,
            COALESCE(SUM(status = 'scored'), 0) AS scored,
            COALESCE(SUM(status = 'error'), 0) AS errors,
            COALESCE(SUM(would_differ = 1), 0) AS would_differ,
            COALESCE(SUM(filter_violations), 0) AS filter_violations
       FROM asset_shadow_log WHERE at >= ?`,
  ).get(from) as { logged: number; scored: number; errors: number; would_differ: number; filter_violations: number };
  const attempts = (db.prepare(
    "SELECT * FROM asset_shadow_log WHERE at >= ? AND would_differ = 1 ORDER BY at DESC, rowid DESC LIMIT ?",
  ).all(from, limit) as LogRow[]).map(entryOf);
  return {
    since: since ?? null,
    logged: counts.logged,
    scored: counts.scored,
    errors: counts.errors,
    wouldDiffer: counts.would_differ,
    wouldDifferRate: counts.scored > 0 ? counts.would_differ / counts.scored : null,
    filterViolations: counts.filter_violations,
    attempts,
  };
}

/** Every logged row of one attempt-bearing task, oldest first (tests and drives). */
export function shadowRowsForTask(db: Db, taskId: string): ShadowLogEntry[] {
  return (db.prepare("SELECT * FROM asset_shadow_log WHERE task_id = ? ORDER BY rowid").all(taskId) as LogRow[]).map(entryOf);
}

// ---- route queries -----------------------------------------------------------

export const SHADOW_LOG_DEFAULT = 100;
export const SHADOW_LOG_MAX = 500;
const HARNESS_NAMES = Object.keys(HARNESS_APPROVAL_MODES);
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
const DIGITS = /^(0|[1-9]\d{0,5})$/;

export function parseScoresQuery(q: { taskKind?: unknown; harness?: unknown } | undefined):
  | { ok: true; taskKind?: string; harness?: string } | { ok: false; error: string } {
  const { taskKind, harness } = q ?? {};
  if (taskKind !== undefined && (typeof taskKind !== "string" || !(TASK_KINDS as readonly string[]).includes(taskKind))) {
    return { ok: false, error: `taskKind must be one of ${TASK_KINDS.join(", ")}` };
  }
  if (harness !== undefined && (typeof harness !== "string" || !HARNESS_NAMES.includes(harness))) {
    return { ok: false, error: `harness must be one of ${HARNESS_NAMES.join(", ")}` };
  }
  return { ok: true, ...(taskKind !== undefined ? { taskKind } : {}), ...(harness !== undefined ? { harness } : {}) };
}

/** `since` is an ISO-8601 UTC timestamp (compared as a string, as the log stores it); `limit` 1..500. */
export function parseShadowQuery(q: { since?: unknown; limit?: unknown } | undefined):
  | { ok: true; since?: string; limit: number } | { ok: false; error: string } {
  const { since, limit } = q ?? {};
  let sinceIso: string | undefined;
  if (since !== undefined) {
    if (typeof since !== "string" || !ISO_UTC.test(since) || Number.isNaN(Date.parse(since))) return { ok: false, error: "since must be an ISO-8601 UTC timestamp (YYYY-MM-DDTHH:MM:SS[.sss]Z)" };
    sinceIso = new Date(since).toISOString();
  }
  let n = SHADOW_LOG_DEFAULT;
  if (limit !== undefined) {
    if (typeof limit !== "string" || !DIGITS.test(limit) || Number(limit) < 1 || Number(limit) > SHADOW_LOG_MAX) return { ok: false, error: `limit must be an integer from 1 to ${SHADOW_LOG_MAX}` };
    n = Number(limit);
  }
  return { ok: true, ...(sinceIso !== undefined ? { since: sinceIso } : {}), limit: n };
}

export class AssetShadow {
  constructor(
    private readonly db: Db,
    private readonly registry: { manifest(id: string): Parameters<typeof harnessOf>[0] | null },
    private readonly log?: Logger,
    private readonly options: AssetShadowOptions = {},
  ) {}

  private now(): Date { return this.options.now ? this.options.now() : new Date(); }

  scores(filter: { taskKind?: string; harness?: string } = {}): AssetScores {
    return assetScores(this.db, this.now(), filter);
  }

  shadowLog(since: string | undefined, limit: number): ShadowLogSummary {
    return readShadowLog(this.db, since, limit);
  }

  /** Best-effort: appends at most one row for the attempt and never throws. */
  record(attempt: ShadowAttempt): void {
    try {
      this.recordOrThrow(attempt);
    } catch (err) {
      // The attempt id and the error class only: a message could quote stored content.
      this.log?.warn({ attemptId: attempt.attemptId, err: err instanceof Error ? err.name : "unknown" }, "asset shadow log write failed");
    }
  }

  private recordOrThrow(attempt: ShadowAttempt): void {
    const view = shadowView(attempt.decision, attempt.inputs);
    if (!view) return; // the pipeline stopped before stage 3: nothing to shadow
    const now = this.now();
    const window = shadowWindow(now);
    const base = { attemptId: attempt.attemptId, taskId: attempt.taskId, actual: view.actual, overridden: view.overridden, windowEnd: window.end, at: now.toISOString() };
    let taskKind: string | null = null;
    let harness: string | null = null;
    let result: AssetShadowResult | { status: "error"; error: string };
    try {
      const task = this.db.prepare("SELECT goal, task_kind, classifier_version FROM tasks WHERE id = ?")
        .get(attempt.taskId) as { goal: string; task_kind: string | null; classifier_version: number | null } | undefined;
      const manifest = attempt.assistantId !== undefined ? this.registry.manifest(attempt.assistantId) : null;
      harness = manifest ? harnessOf(manifest) ?? null : null;
      taskKind = task ? taskKindOf(task) : null;
      if (!task || !harness) {
        result = { status: "error", error: task ? "unknown_harness" : "unknown_task" };
      } else {
        const scores = scoreAssets(readObservations(this.db, window), window);
        const cohort = scores.cohorts.filter((c) => c.taskKind === taskKind && c.harness === harness);
        result = (this.options.scorer ?? assetShadow)(view, cohort);
      }
    } catch (err) {
      result = { status: "error", error: `scorer_threw:${err instanceof Error ? err.name : "unknown"}` };
    }
    this.insert({ ...base, taskKind, harness, result });
  }

  private insert(r: {
    attemptId: string; taskId: string; actual: string[]; overridden: boolean; windowEnd: string; at: string;
    taskKind: string | null; harness: string | null; result: AssetShadowResult | { status: "error"; error: string };
  }): void {
    const scored = r.result.status === "scored" ? r.result : undefined;
    // Plain INSERT: one row per attempt, and the 038 triggers stay in force.
    this.db.prepare(
      `INSERT INTO asset_shadow_log (attempt_id, task_id, status, formula, task_kind, harness, actual_json, shadow_json, would_differ,
         filter_violations, overridden, scores_json, error, window_end, at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      r.attemptId, r.taskId, scored ? "scored" : "error", ASSET_SHADOW_FORMULA, r.taskKind, r.harness, JSON.stringify(r.actual),
      scored ? JSON.stringify(scored.shadow) : null,
      scored ? (scored.wouldDiffer ? 1 : 0) : null,
      scored ? scored.filterViolations : null,
      r.overridden ? 1 : 0,
      scored ? JSON.stringify(scored.candidates) : null,
      r.result.status === "error" ? r.result.error : null,
      r.windowEnd, r.at,
    );
  }
}
