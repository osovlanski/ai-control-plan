import { createHash } from "node:crypto";
import {
  deriveAssetUsage,
  type AgentSpec,
  type AssetUsageEvent,
  type AssetUsageRow,
  type BundleResponse,
  type ExecutionResult,
} from "@agent-plane/core";
import type { Db } from "../db/index.js";

const deps = { sha256: (text: string) => createHash("sha256").update(text, "utf8").digest("hex") };

interface Logger {
  warn(obj: object, msg: string): void;
  info(obj: object, msg: string): void;
}

export type ProjectOutcome =
  | { status: "projected"; rows: number; inserted: number; conflicts: number }
  | { status: "skipped"; reason: "no_session" | "no_revision" | "not_settled" }
  | { status: "error" };

/**
 * M6 S1: projects a settled, revision-bound session into `asset_usage` (plan §2.3). Called once
 * from the orchestrator's settle path, from a crash restart's release, and by the boot backfill.
 * A replay is a no-op; a different body under a key is a counted conflict and the stored row
 * stays. It never throws: telemetry must not fail a settle.
 */
export class AssetTelemetry {
  conflicts = 0;

  constructor(private db: Db, private log?: Logger) {}

  project(sessionId: string): ProjectOutcome {
    try {
      return this.projectOrThrow(sessionId);
    } catch (err) {
      // The session id and the error class only: an error message could quote stored content.
      this.log?.warn({ sessionId, err: err instanceof Error ? err.name : "unknown" }, "asset usage projection failed");
      return { status: "error" };
    }
  }

  /** Projects every settled revision-bound session with no ledger row: a crash between settle and projection, or a session settled before M6. */
  backfill(): { projected: number; inserted: number; conflicts: number } {
    const ids = this.db.prepare(
      `SELECT r.id FROM runs r JOIN execution_results er ON er.session_id = r.id
       WHERE r.composition_revision_id IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM asset_usage_sessions s WHERE s.session_id = r.id)
       ORDER BY er.at, r.id`,
    ).all() as Array<{ id: string }>;
    let projected = 0, inserted = 0, conflicts = 0;
    for (const { id } of ids) {
      const out = this.project(id);
      if (out.status !== "projected") continue;
      projected += 1;
      inserted += out.inserted;
      conflicts += out.conflicts;
    }
    if (projected) this.log?.info({ projected, inserted, conflicts }, "asset usage backfilled");
    return { projected, inserted, conflicts };
  }

  private projectOrThrow(sessionId: string): ProjectOutcome {
    const run = this.db.prepare(
      `SELECT r.task_id, r.composition_revision_id, r.provider_start_acked, er.result, er.at
       FROM runs r LEFT JOIN execution_results er ON er.session_id = r.id WHERE r.id = ?`,
    ).get(sessionId) as { task_id: string; composition_revision_id: string | null; provider_start_acked: number; result: string | null; at: string | null } | undefined;
    if (!run) return { status: "skipped", reason: "no_session" };
    if (!run.composition_revision_id) return { status: "skipped", reason: "no_revision" };
    if (!run.result || !run.at) return { status: "skipped", reason: "not_settled" };

    const revision = this.db.prepare("SELECT spec_json, bundle_response_json FROM agent_specs WHERE composition_revision_id = ?")
      .get(run.composition_revision_id) as { spec_json: string; bundle_response_json: string };
    const events = (this.db.prepare(
      `SELECT type, payload, raw FROM events WHERE run_id = ?
         AND type IN ('provisioning.verified', 'provisioning.ambient', 'run.started') ORDER BY seq`,
    ).all(sessionId) as Array<{ type: string; payload: string | null; raw: string | null }>)
      .map((e): AssetUsageEvent => ({
        type: e.type,
        ...(e.payload ? { payload: JSON.parse(e.payload) as unknown } : {}),
        ...(e.raw ? { raw: JSON.parse(e.raw) as unknown } : {}),
      }));

    const { rows, session } = deriveAssetUsage({
      spec: JSON.parse(revision.spec_json) as AgentSpec,
      bundleManifest: (JSON.parse(revision.bundle_response_json) as BundleResponse).manifest,
      sessionId,
      taskId: run.task_id,
      events,
      result: JSON.parse(run.result) as ExecutionResult,
      resultAt: run.at,
      startAcked: run.provider_start_acked === 1,
    }, deps);

    let inserted = 0, conflicts = 0;
    const insert = this.db.prepare(
      `INSERT INTO asset_usage (event_id, ingest_seq, composition_revision_id, session_id, task_id, asset_kind, asset_id,
         asset_digest, harness, fidelity, attached, validation, invocation_method, invocation_count, invocation_failed,
         session_outcome, verification_passed, attribution_method, deriver_version, body_digest, at)
       VALUES (?, (SELECT COALESCE(MAX(ingest_seq), 0) + 1 FROM asset_usage), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(event_id) DO NOTHING`,
    );
    const stored = this.db.prepare("SELECT body_digest FROM asset_usage WHERE event_id = ?");
    const conflict = (eventId: string, deriverVersion: number) => {
      conflicts += 1;
      this.conflicts += 1;
      this.log?.warn({ eventId, deriverVersion }, "asset usage conflict: a different body under a stored key; the stored row stays");
    };
    this.db.transaction(() => {
      for (const r of rows) {
        if (insert.run(...params(r)).changes) { inserted += 1; continue; }
        if ((stored.get(r.eventId) as { body_digest: string }).body_digest !== r.bodyDigest) conflict(r.eventId, r.deriverVersion);
      }
      const done = this.db.prepare(
        `INSERT INTO asset_usage_sessions (session_id, composition_revision_id, rows, deriver_version, body_digest, at)
         VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(session_id) DO NOTHING`,
      ).run(session.sessionId, session.compositionRevisionId, session.rows, session.deriverVersion, session.bodyDigest, session.at);
      if (!done.changes) {
        const prior = this.db.prepare("SELECT body_digest FROM asset_usage_sessions WHERE session_id = ?").get(sessionId) as { body_digest: string };
        if (prior.body_digest !== session.bodyDigest) conflict(`session:${sessionId}`, session.deriverVersion);
      }
    })();
    return { status: "projected", rows: rows.length, inserted, conflicts };
  }
}

const bit = (b: boolean | null) => (b === null ? null : b ? 1 : 0);

function params(r: AssetUsageRow): Array<string | number | null> {
  return [
    r.eventId, r.compositionRevisionId, r.sessionId, r.taskId, r.assetKind, r.assetId, r.assetDigest, r.harness, r.fidelity,
    bit(r.attached), r.validation, r.invocationMethod, r.invocationCount, r.invocationFailed, r.sessionOutcome,
    bit(r.verificationPassed), r.attributionMethod, r.deriverVersion, r.bodyDigest, r.at,
  ];
}
