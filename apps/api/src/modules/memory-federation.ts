/**
 * O6 S3: memory bundle federation and the memory shadow log (docs/agentic-os-o6-memory-writeback.md
 * §2.2; contract docs/contracts/memory-v1.md).
 *
 * - `CockpitMemoryClient` reads `GET /api/v1/registry/memory/bundles` with the registry federation's
 *   token file, bounded reader and error vocabulary, and validates the body with memory v1
 *   (`validateMemoryBundleSnapshot`).
 * - `MemoryFederation` keeps the last snapshot that validated (migration 040). Cockpit down, a 401 or
 *   an invalid body records a classified reason and keeps it; it turns `stale` once its last good
 *   fetch is older than `registry.cockpit.maxCacheAgeHours`. Sync runs at boot and in the daily job,
 *   beside the registry snapshot.
 * - `MemoryShadowLog.record` runs once per composition attempt that reached stage 4, after the
 *   attempt row and outside its transaction (beside M6 S4's asset shadow). It reads the pins and
 *   what production did with them from the decision, applies core's `memory-shadow/v1` to the cached
 *   snapshot and appends one row per pinned bundle. It never throws and never changes the attempt:
 *   a scorer error writes one row with an error code. Nothing here is read by the composer; health
 *   never enters a decision, spec, `compositionDigest` or `inputs_digest`.
 */
import {
  MEMORY_SHADOW_RULE, memoryProduction, memoryShadow,
  type ComposerOutcome, type CompositionDecisionDraft, type MemoryProductionAction, type MemoryShadowAction, type MemoryShadowHealth,
} from "@agent-plane/core";
import type { ResolvedRegistryConfig } from "../config.js";
import type { Db } from "../db/index.js";
import { validateMemoryBundleSnapshot, type MemoryBundleSnapshot } from "../memory-contract.js";
import { readBounded, readRegistryToken, RegistrySyncError, type RegistrySyncReason } from "./registry-federation.js";

const SOURCE = "cockpit";
const MEMORY_BUNDLES_PATH = "/api/v1/registry/memory/bundles";
const MAX_SNAPSHOT_BYTES = 16 * 1024 * 1024;

interface Logger { warn(obj: object, msg: string): void }

export interface MemorySnapshotSource { snapshot(): Promise<MemoryBundleSnapshot> }

/** The registry federation client's rules, on the memory v1 route. */
export class CockpitMemoryClient implements MemorySnapshotSource {
  constructor(
    private readonly baseUrl: string,
    private readonly tokenPath: string,
    private readonly fetcher: typeof fetch = fetch,
    private readonly timeoutMs = 10_000,
    private readonly maxBytes = MAX_SNAPSHOT_BYTES,
  ) {}

  async snapshot(): Promise<MemoryBundleSnapshot> {
    const token = readRegistryToken(this.tokenPath);
    let response: Response;
    try {
      response = await this.fetcher(new URL(MEMORY_BUNDLES_PATH, this.baseUrl), {
        headers: { authorization: `Bearer ${token}`, accept: "application/json" },
        signal: AbortSignal.timeout(this.timeoutMs),
        redirect: "error",
      });
    } catch (err) {
      throw new RegistrySyncError((err as Error)?.name === "TimeoutError" ? "timeout" : "unreachable");
    }
    if (response.status === 401) throw new RegistrySyncError("unauthenticated");
    if (response.status === 413) throw new RegistrySyncError("payload_too_large");
    if (!response.ok) throw new RegistrySyncError("http_error", `${response.status}`);
    const text = await readBounded(response, this.maxBytes);
    let body: unknown;
    try { body = JSON.parse(text); } catch { throw new RegistrySyncError("invalid_response", "not JSON"); }
    // Before validation, whose errors quote the response. The decoded form catches a token written with JSON escapes.
    if (text.includes(token) || JSON.stringify(body).includes(token)) throw new RegistrySyncError("invalid_response", "response contains the bearer token");
    const result = validateMemoryBundleSnapshot(body);
    if (!result.ok) {
      const unsupported = result.errors.some((e) => e.startsWith("unsupported schemaVersion"));
      throw new RegistrySyncError(unsupported ? "unsupported_version" : "invalid_response");
    }
    return result.value;
  }
}

export interface MemoryFederationView {
  enabled: boolean;
  source: string;
  schemaVersion: string | null;
  snapshotDigest: string | null;
  /** Cockpit's observedAt: the time base of every age in the snapshot. */
  observedAt: string | null;
  /** The plane's clock: when this snapshot was last fetched and validated. */
  lastSeenAt: string | null;
  stale: boolean;
  maxCacheAgeHours: number;
  lastAttemptAt: string | null;
  lastFailure: string | null;
  snapshot: MemoryBundleSnapshot | null;
}

export type MemorySyncResult =
  | { ok: true; snapshotDigest: string; bundles: number }
  | { ok: false; reason: RegistrySyncReason | "disabled" };

interface SnapshotRow { snapshot_digest: string; schema_version: string; observed_at: string; snapshot_json: string; last_seen_at: string }

export class MemoryFederation {
  constructor(
    private readonly db: Db,
    private readonly config: ResolvedRegistryConfig["cockpit"],
    private readonly source: MemorySnapshotSource = new CockpitMemoryClient(config.baseUrl, config.tokenPath),
    private readonly now: () => Date = () => new Date(),
    private readonly logger?: Logger,
  ) {}

  async sync(): Promise<MemorySyncResult> {
    if (!this.config.enabled) return { ok: false, reason: "disabled" };
    const at = this.now().toISOString();
    let snapshot: MemoryBundleSnapshot;
    try {
      snapshot = await this.source.snapshot();
    } catch (err) {
      const reason = err instanceof RegistrySyncError ? err.reason : "unreachable";
      this.recordAttempt(at, reason);
      this.logger?.warn({ source: SOURCE, reason, stale: this.read().stale }, "memory bundle sync failed; keeping last snapshot");
      return { ok: false, reason };
    }
    this.db.transaction(() => {
      this.db.prepare(
        `INSERT INTO memory_bundle_snapshots (source, snapshot_digest, schema_version, observed_at, snapshot_json, bundle_count, first_seen_at, last_seen_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (source, snapshot_digest) DO UPDATE SET schema_version = excluded.schema_version, observed_at = excluded.observed_at,
           snapshot_json = excluded.snapshot_json, last_seen_at = excluded.last_seen_at`,
      ).run(SOURCE, snapshot.snapshotDigest, snapshot.schemaVersion, snapshot.observedAt, JSON.stringify(snapshot), snapshot.bundles.length, at, at);
      this.recordAttempt(at, null);
    })();
    return { ok: true, snapshotDigest: snapshot.snapshotDigest, bundles: snapshot.bundles.length };
  }

  private recordAttempt(at: string, failure: string | null): void {
    this.db.prepare(
      `INSERT INTO memory_sync_state (source, last_attempt_at, last_success_at, last_failure) VALUES (?, ?, ?, ?)
       ON CONFLICT (source) DO UPDATE SET last_attempt_at = excluded.last_attempt_at,
         last_success_at = COALESCE(excluded.last_success_at, memory_sync_state.last_success_at),
         last_failure = excluded.last_failure`,
    ).run(SOURCE, at, failure ? null : at, failure);
  }

  /** The last good snapshot and the sync state around it. */
  read(): MemoryFederationView {
    const snap = this.db.prepare(
      `SELECT snapshot_digest, schema_version, observed_at, snapshot_json, last_seen_at FROM memory_bundle_snapshots
        WHERE source = ? ORDER BY last_seen_at DESC, id DESC LIMIT 1`,
    ).get(SOURCE) as SnapshotRow | undefined;
    const state = this.db.prepare("SELECT last_attempt_at, last_failure FROM memory_sync_state WHERE source = ?").get(SOURCE) as
      | { last_attempt_at: string; last_failure: string | null } | undefined;
    const ageMs = snap ? this.now().getTime() - Date.parse(snap.last_seen_at) : Infinity;
    return {
      enabled: this.config.enabled,
      source: SOURCE,
      schemaVersion: snap?.schema_version ?? null,
      snapshotDigest: snap?.snapshot_digest ?? null,
      observedAt: snap?.observed_at ?? null,
      lastSeenAt: snap?.last_seen_at ?? null,
      stale: ageMs > this.config.maxCacheAgeHours * 3_600_000,
      maxCacheAgeHours: this.config.maxCacheAgeHours,
      lastAttemptAt: state?.last_attempt_at ?? null,
      lastFailure: state?.last_failure ?? null,
      snapshot: snap ? (JSON.parse(snap.snapshot_json) as MemoryBundleSnapshot) : null,
    };
  }
}

// ---- shadow log ---------------------------------------------------------------

/** What the composer hands over for one attempt. */
export interface MemoryShadowAttempt {
  attemptId: string;
  taskId: string;
  decision: CompositionDecisionDraft;
  outcome: ComposerOutcome;
}

export type MemoryShadowScorer = typeof memoryShadow;

export interface MemoryShadowOptions {
  now?: () => Date;
  /** Test seam: the rule `record` applies. Defaults to core's `memoryShadow`. */
  scorer?: MemoryShadowScorer;
}

export interface MemoryShadowRow {
  attemptId: string;
  taskId: string;
  bundleId: string | null;
  status: "scored" | "error";
  rule: string;
  pinnedDigest: string | null;
  snapshotBundleDigest: string | null;
  snapshotDigest: string | null;
  snapshotObservedAt: string | null;
  snapshotStale: boolean | null;
  production: { action: MemoryProductionAction; reason: string | null } | null;
  shadow: { action: MemoryShadowAction; reason: string } | null;
  health: MemoryShadowHealth | null;
  error: string | null;
  at: string;
}

interface LogRow {
  attempt_id: string; task_id: string; bundle_id: string | null; status: "scored" | "error"; rule: string; pinned_digest: string | null;
  snapshot_bundle_digest: string | null; snapshot_digest: string | null; snapshot_observed_at: string | null; snapshot_stale: number | null;
  production_action: MemoryProductionAction | null; production_reason: string | null; shadow_action: MemoryShadowAction | null; reason: string | null;
  members: number | null; stale_members: number | null; oldest_age_days: number | null; duplicate_pairs: number | null; ghosts: number | null;
  oversized: number | null; findings_digest: string | null; error: string | null; at: string;
}

const rowOf = (r: LogRow): MemoryShadowRow => ({
  attemptId: r.attempt_id,
  taskId: r.task_id,
  bundleId: r.bundle_id,
  status: r.status,
  rule: r.rule,
  pinnedDigest: r.pinned_digest,
  snapshotBundleDigest: r.snapshot_bundle_digest,
  snapshotDigest: r.snapshot_digest,
  snapshotObservedAt: r.snapshot_observed_at,
  snapshotStale: r.snapshot_stale === null ? null : r.snapshot_stale === 1,
  production: r.production_action === null ? null : { action: r.production_action, reason: r.production_reason },
  shadow: r.shadow_action === null || r.reason === null ? null : { action: r.shadow_action, reason: r.reason },
  health: r.members === null || r.findings_digest === null ? null : {
    members: r.members, staleMembers: r.stale_members ?? 0, oldestAgeDays: r.oldest_age_days, duplicatePairs: r.duplicate_pairs ?? 0,
    ghosts: r.ghosts ?? 0, oversized: r.oversized ?? 0, findingsDigest: r.findings_digest,
  },
  error: r.error,
  at: r.at,
});

export class MemoryShadowLog {
  constructor(
    private readonly db: Db,
    private readonly federation: Pick<MemoryFederation, "read">,
    private readonly log?: Logger,
    private readonly options: MemoryShadowOptions = {},
  ) {}

  private now(): Date { return this.options.now ? this.options.now() : new Date(); }

  /** Best-effort: appends the attempt's rows and never throws. */
  record(attempt: MemoryShadowAttempt): void {
    try {
      this.recordOrThrow(attempt);
    } catch (err) {
      // The attempt id and the error class only: a message could quote stored content.
      this.log?.warn({ attemptId: attempt.attemptId, err: err instanceof Error ? err.name : "unknown" }, "memory shadow log write failed");
    }
  }

  private recordOrThrow(attempt: MemoryShadowAttempt): void {
    const at = this.now().toISOString();
    const insert = this.db.prepare(
      `INSERT INTO memory_shadow_log (attempt_id, task_id, bundle_id, status, rule, pinned_digest, snapshot_bundle_digest, snapshot_digest,
         snapshot_observed_at, snapshot_stale, production_action, production_reason, shadow_action, reason, members, stale_members,
         oldest_age_days, duplicate_pairs, ghosts, oversized, findings_digest, error, at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    let rows: unknown[][];
    try {
      const production = memoryProduction(attempt.decision, attempt.outcome);
      if (production.length === 0) return; // nothing pinned, or the pipeline stopped before stage 4
      const view = this.federation.read();
      const snapshot = view.snapshot;
      const verdicts = (this.options.scorer ?? memoryShadow)(production.map(({ id, digest }) => ({ id, digest })), snapshot);
      rows = production.map((p) => {
        const v = verdicts.find((x) => x.bundleId === p.id && x.pinnedDigest === p.digest);
        if (!v) throw new Error("memory shadow: the rule returned no verdict for a pin");
        const h = v.health;
        return [
          attempt.attemptId, attempt.taskId, p.id, "scored", MEMORY_SHADOW_RULE, p.digest, v.snapshotBundleDigest,
          snapshot?.snapshotDigest ?? null, snapshot?.observedAt ?? null, view.stale ? 1 : 0,
          p.action, p.reason, v.action, v.reason,
          h?.members ?? null, h?.staleMembers ?? null, h?.oldestAgeDays ?? null, h?.duplicatePairs ?? null, h?.ghosts ?? null, h?.oversized ?? null,
          h?.findingsDigest ?? null, null, at,
        ];
      });
    } catch (err) {
      rows = [[
        attempt.attemptId, attempt.taskId, null, "error", MEMORY_SHADOW_RULE, null, null, null, null, null, null, null, null, null,
        null, null, null, null, null, null, null, `scorer_threw:${err instanceof Error ? err.name : "unknown"}`, at,
      ]];
    }
    // Plain INSERTs in their own transaction: the attempt's is already committed, and the 040 triggers stay in force.
    this.db.transaction(() => { for (const r of rows) insert.run(...r); })();
  }
}

/** Every logged row of one task, oldest first. */
export function memoryShadowRowsForTask(db: Db, taskId: string, limit = MEMORY_SHADOW_MAX): MemoryShadowRow[] {
  return (db.prepare("SELECT * FROM memory_shadow_log WHERE task_id = ? ORDER BY id LIMIT ?").all(taskId, limit) as LogRow[]).map(rowOf);
}

/** The newest rows across tasks, newest first. */
export function recentMemoryShadowRows(db: Db, limit: number): MemoryShadowRow[] {
  return (db.prepare("SELECT * FROM memory_shadow_log ORDER BY id DESC LIMIT ?").all(limit) as LogRow[]).map(rowOf);
}

// ---- route query --------------------------------------------------------------

export const MEMORY_SHADOW_DEFAULT = 100;
export const MEMORY_SHADOW_MAX = 500;
const TASK_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const DIGITS = /^(0|[1-9]\d{0,5})$/;

/** `taskId` names one task (its rows oldest first); without it, the newest rows. `limit` 1..500. */
export function parseMemoryShadowQuery(q: { taskId?: unknown; limit?: unknown } | undefined):
  | { ok: true; taskId?: string; limit: number } | { ok: false; error: string } {
  const { taskId, limit } = q ?? {};
  if (taskId !== undefined && (typeof taskId !== "string" || !TASK_ID.test(taskId))) return { ok: false, error: "taskId is not a task id" };
  let n = MEMORY_SHADOW_DEFAULT;
  if (limit !== undefined) {
    if (typeof limit !== "string" || !DIGITS.test(limit) || Number(limit) < 1 || Number(limit) > MEMORY_SHADOW_MAX) {
      return { ok: false, error: `limit must be an integer from 1 to ${MEMORY_SHADOW_MAX}` };
    }
    n = Number(limit);
  }
  return { ok: true, ...(taskId !== undefined ? { taskId } : {}), limit: n };
}

/** `GET /api/composition/memory-shadow`: the federation state (no snapshot body) and the rows. */
export function memoryShadowResponse(db: Db, federation: Pick<MemoryFederation, "read">, query: { taskId?: string; limit: number }) {
  const { snapshot, ...state } = federation.read();
  return {
    rule: MEMORY_SHADOW_RULE,
    federation: { ...state, bundles: snapshot ? snapshot.bundles.length : null },
    taskId: query.taskId ?? null,
    rows: query.taskId !== undefined ? memoryShadowRowsForTask(db, query.taskId, query.limit) : recentMemoryShadowRows(db, query.limit),
  };
}
