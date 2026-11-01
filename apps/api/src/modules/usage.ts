/**
 * The UsageRecord ingestion boundary (plan §3.7; usage contract v1; M11 posts into it). Idempotent
 * on (provider, sessionRef, eventId), an absent sessionRef being its own key space: a replay
 * returns the stored row unchanged, and a different body under the same key is a conflict, never
 * an overwrite. Rows are immutable, except that a record with no run may gain one, once.
 *
 * Linking (phase 7 "one deduped usage stream"). Cockpit sends `runId: null` by design, so a record
 * with a `sessionRef` and no `runId` is bound to the one run whose assistant has the record's
 * provider and whose `provider_session_ref` is that `sessionRef`. Zero candidates (the session is not
 * a plane run, or not yet) leave it unbound (`unmatched`). Otherwise every candidate, one or several
 * (a resumed or continued provider session spans runs), is tested by time: the record binds to the
 * one run whose window [started_at, ended_at] holds its `observedAt` (a run not yet ended has no
 * end). A record outside every window (`outside_windows`) or inside two (`ambiguous`) stays unbound;
 * one record is never split across runs. Cockpit's records are per-message deltas stamped with the transcript line's
 * instant, so one record is one moment. A body `runId`
 * that is not among the session's runs is a `run_conflict`, never stored. `backfillRunLinks`
 * applies the same rule to records already stored unbound, and is idempotent. A record that arrives
 * before its run's session is known is bound when the run's `provider_session_ref` is stored: each
 * writer calls `runSessionRefStored`, and the plane's listener runs `linkRun` for that run.
 *
 * Source precedence (plan §3.7) is settlement's, in core `settleSession`: a run settles to
 * max(in-run, its records), never the sum. With in-run accounting `none` the in-run side measures
 * nothing, so the records are the source. With in-run accounting counted, in-run is primary and
 * the records reconcile it: they replace it only when they exceed it (in-run missed part of the
 * same session, e.g. a run killed before its result), so the same tokens never count twice and
 * none are dropped.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormatsImport from "ajv-formats";
import type { Db } from "../db/index.js";
import { formatSchemaErrors } from "../bundle-contract.js";
import type { ContractResult } from "../registry-contract.js";

const addFormats = ((addFormatsImport as unknown as { default?: unknown }).default ?? addFormatsImport) as (ajv: Ajv2020) => void;

export interface UsageRecord {
  eventId: string;
  runId: string | null;
  provider: string;
  sessionRef: string | null;
  source: string;
  assistantId: string;
  model: string;
  accounting: "delta" | "cumulative";
  tokensIn: number;
  tokensOut: number;
  cachedTokens: number;
  costUsd: number | null;
  apiEquivalentUsd: number;
  pricingVersion: string;
  observedAt: string;
}

export const USAGE_CONTRACT_DIR = join(dirname(fileURLToPath(import.meta.url)), "../../../../contracts/usage/v1");
/** The newest usage v1 minor this plane understands. The record is closed, so a newer minor cannot be honoured. */
const USAGE_MINOR = 0;

const ajv = new Ajv2020({ allErrors: true, strict: true });
addFormats(ajv);
// The wire schema is the contract file, not a copy. Validated here, not by Fastify, which would strip unknown fields and coerce types.
const usageSchema = ajv.compile(JSON.parse(readFileSync(join(USAGE_CONTRACT_DIR, "usage-record.schema.json"), "utf8")) as object);

export function validateUsageRecord(body: unknown): ContractResult<UsageRecord> {
  if (!usageSchema(body)) return { ok: false, errors: formatSchemaErrors(usageSchema.errors) };
  const b = body as Partial<UsageRecord> & Omit<UsageRecord, "runId" | "sessionRef" | "costUsd"> & { schemaVersion: string };
  if (Number(b.schemaVersion.split(".")[1]) > USAGE_MINOR) return { ok: false, errors: [`/schemaVersion ${b.schemaVersion} is newer than 1.${USAGE_MINOR}`] };
  // RFC 3339 admits instants Date cannot hold (leap seconds, `+HH` offsets) or prints as expanded years; refuse those.
  const instant = Date.parse(b.observedAt);
  const observedAt = Number.isNaN(instant) ? "" : new Date(instant).toISOString();
  if (!/^\d{4}-/.test(observedAt)) return { ok: false, errors: ["/observedAt is not a representable instant"] };
  // Fixed key order, and absent optionals as null, so equal records serialize (and digest) alike.
  // schemaVersion is the envelope, not the observation, so it is neither stored nor digested.
  return { ok: true, value: {
    eventId: b.eventId, runId: b.runId ?? null, provider: b.provider, sessionRef: b.sessionRef ?? null, source: b.source,
    assistantId: b.assistantId, model: b.model, accounting: b.accounting, tokensIn: b.tokensIn, tokensOut: b.tokensOut,
    cachedTokens: b.cachedTokens, costUsd: b.costUsd ?? null, apiEquivalentUsd: b.apiEquivalentUsd,
    pricingVersion: b.pricingVersion,
    // One spelling per instant, so a re-serialized retry (e.g. through Date#toISOString) replays instead of conflicting.
    observedAt,
  } };
}

/**
 * How a record stands against runs: bound from the body or by `sessionRef`; unbound because no
 * run has its session (`unmatched`), or no window of its session's runs holds it
 * (`outside_windows`) or two do (`ambiguous`); or `none`, a record with neither runId nor sessionRef.
 */
export type RunLink = "body" | "session_ref" | "unmatched" | "outside_windows" | "ambiguous" | "none";

export type IngestResult =
  | { status: "created" | "replayed"; record: UsageRecord; link: RunLink; /** The record was bound to its run by this call. */ linkedNow: boolean }
  | { status: "conflict"; record: UsageRecord }
  | { status: "run_conflict"; sessionRuns: string[] }
  | { status: "unknown_run" };

export interface BackfillResult {
  linked: Array<{ provider: string; sessionRef: string; eventId: string; runId: string }>;
  /** No run holds it: no run has its session, or none of the session's run windows holds it. */
  unmatched: number;
  ambiguous: number;
}

interface Row {
  provider: string; event_id: string; body_digest: string; run_id: string | null; session_ref: string | null; source: string;
  assistant_id: string; model: string; accounting: "delta" | "cumulative"; tokens_in: number; tokens_out: number;
  cached_tokens: number; cost_usd: number | null; api_equivalent_usd: number; pricing_version: string; observed_at: string;
  run_link: "body" | "session_ref" | null;
}
const fromRow = (r: Row): UsageRecord => ({
  eventId: r.event_id, runId: r.run_id, provider: r.provider, sessionRef: r.session_ref, source: r.source,
  assistantId: r.assistant_id, model: r.model, accounting: r.accounting, tokensIn: r.tokens_in, tokensOut: r.tokens_out,
  cachedTokens: r.cached_tokens, costUsd: r.cost_usd, apiEquivalentUsd: r.api_equivalent_usd,
  pricingVersion: r.pricing_version, observedAt: r.observed_at,
});

const sessionRefListeners = new WeakMap<Db, (runId: string) => void>();

/** Registers the one listener told when a run's provider_session_ref is written on this database. */
export function onRunSessionRef(db: Db, listener: (runId: string) => void): void {
  sessionRefListeners.set(db, listener);
}

/**
 * Called by every writer of runs.provider_session_ref, after the write. A failing listener never
 * fails the write: an unbound record still binds at the next replay or boot.
 */
export function runSessionRefStored(db: Db, runId: string): void {
  try { sessionRefListeners.get(db)?.(runId); } catch { /* the boot backfill binds it later */ }
}

export class UsageLedger {
  constructor(private db: Db, private now: () => Date = () => new Date()) {}

  /** The runs a provider session belongs to, oldest first. */
  sessionRuns(provider: string, sessionRef: string): string[] {
    return this.sessionWindows(provider, sessionRef).map((r) => r.id);
  }

  private sessionWindows(provider: string, sessionRef: string): Array<{ id: string; started_at: string; ended_at: string | null }> {
    return this.db.prepare(
      `SELECT r.id, r.started_at, r.ended_at FROM runs r JOIN assistants a ON a.id = r.assistant_id
        WHERE r.provider_session_ref = ? AND a.provider = ? ORDER BY r.started_at, r.rowid`,
    ).all(sessionRef, provider) as Array<{ id: string; started_at: string; ended_at: string | null }>;
  }

  /** The run a runId-less record of this session binds to, by the rule in the header; null with the reason when none. */
  private resolve(provider: string, sessionRef: string, observedAt: string): { runId: string | null; link: RunLink } {
    const runs = this.sessionWindows(provider, sessionRef);
    if (!runs.length) return { runId: null, link: "unmatched" };
    const at = Date.parse(observedAt);
    const holding = runs.filter((r) => Date.parse(r.started_at) <= at && (r.ended_at === null || at <= Date.parse(r.ended_at)));
    if (holding.length === 1) return { runId: holding[0]!.id, link: "session_ref" };
    return { runId: null, link: holding.length ? "ambiguous" : "outside_windows" };
  }

  /** `record` is the value of a successful validateUsageRecord. */
  ingest(record: UsageRecord): IngestResult {
    const digest = `sha256:${createHash("sha256").update(JSON.stringify(record), "utf8").digest("hex")}`;
    return this.db.transaction((): IngestResult => {
      const stored = this.row(record.provider, record.sessionRef, record.eventId);
      // A stored key answers by digest first, so a replay's answer never depends on runs that changed since.
      if (stored) {
        if (stored.body_digest !== digest) return { status: "conflict", record: fromRow(stored) };
        const linked = this.linkStored(stored);
        return { status: "replayed", record: fromRow(linked.row), link: linked.link, linkedNow: linked.linkedNow };
      }
      if (record.runId && !this.db.prepare("SELECT 1 FROM runs WHERE id = ?").get(record.runId)) return { status: "unknown_run" };
      let runId = record.runId;
      let link: RunLink;
      if (record.runId) {
        const candidates = record.sessionRef ? this.sessionRuns(record.provider, record.sessionRef) : [];
        if (candidates.length && !candidates.includes(record.runId)) return { status: "run_conflict", sessionRuns: candidates };
        link = "body";
      } else if (!record.sessionRef) link = "none";
      else ({ runId, link } = this.resolve(record.provider, record.sessionRef, record.observedAt));
      this.db.prepare(
        `INSERT INTO usage_records (provider, event_id, body_digest, run_id, session_ref, source, assistant_id, model, accounting,
           tokens_in, tokens_out, cached_tokens, cost_usd, api_equivalent_usd, pricing_version, observed_at, received_at, run_link)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        record.provider, record.eventId, digest, runId, record.sessionRef, record.source, record.assistantId, record.model,
        record.accounting, record.tokensIn, record.tokensOut, record.cachedTokens, record.costUsd, record.apiEquivalentUsd,
        record.pricingVersion, record.observedAt, this.now().toISOString(),
        link === "body" || link === "session_ref" ? link : null,
      );
      const row = this.row(record.provider, record.sessionRef, record.eventId)!;
      return { status: "created", record: fromRow(row), link, linkedNow: false };
    })();
  }

  /**
   * Binds every stored record that has a sessionRef and no run, by the ingestion rule. Idempotent:
   * a bound record is never revisited, and one still unbound is counted again (`outside_windows` under
   * `unmatched`).
   */
  backfillRunLinks(): BackfillResult {
    return this.db.transaction((): BackfillResult => {
      const result: BackfillResult = { linked: [], unmatched: 0, ambiguous: 0 };
      const rows = this.db.prepare(
        "SELECT * FROM usage_records WHERE run_id IS NULL AND session_ref IS NOT NULL ORDER BY received_at, rowid",
      ).all() as Row[];
      for (const row of rows) {
        const linked = this.linkStored(row);
        if (linked.linkedNow) result.linked.push({ provider: row.provider, sessionRef: row.session_ref!, eventId: row.event_id, runId: linked.row.run_id! });
        else if (linked.link === "ambiguous") result.ambiguous += 1;
        else result.unmatched += 1;
      }
      return result;
    })();
  }

  /**
   * Binds the unbound records of a run's (provider, session) by the ingestion rule, once the run's
   * provider_session_ref is stored. Returns how many it bound to the run; idempotent.
   */
  linkRun(runId: string): number {
    return this.db.transaction((): number => {
      const run = this.db.prepare(
        "SELECT r.provider_session_ref AS ref, a.provider FROM runs r JOIN assistants a ON a.id = r.assistant_id WHERE r.id = ?",
      ).get(runId) as { ref: string | null; provider: string } | undefined;
      if (!run?.ref) return 0;
      const rows = this.db.prepare(
        "SELECT * FROM usage_records WHERE run_id IS NULL AND provider = ? AND session_ref = ? ORDER BY received_at, rowid",
      ).all(run.provider, run.ref) as Row[];
      return rows.filter((row) => this.linkStored(row).linkedNow).length;
    })();
  }

  private row(provider: string, sessionRef: string | null, eventId: string): Row | undefined {
    return this.db.prepare(
      "SELECT * FROM usage_records WHERE provider = ? AND ifnull(session_ref, '') = ? AND event_id = ?",
    ).get(provider, sessionRef ?? "", eventId) as Row | undefined;
  }

  /** A stored row's link, binding it now when it is unbound and the rule names its run. A bound row is never revisited. */
  private linkStored(row: Row): { row: Row; link: RunLink; linkedNow: boolean } {
    if (row.run_id) return { row, link: row.run_link ?? "body", linkedNow: false };
    if (!row.session_ref) return { row, link: "none", linkedNow: false };
    const { runId, link } = this.resolve(row.provider, row.session_ref, row.observed_at);
    if (!runId) return { row, link, linkedNow: false };
    // The 036 trigger admits exactly this write: NULL run to a run, with run_link session_ref.
    this.db.prepare(
      "UPDATE usage_records SET run_id = ?, run_link = 'session_ref' WHERE provider = ? AND ifnull(session_ref, '') = ? AND event_id = ? AND run_id IS NULL",
    ).run(runId, row.provider, row.session_ref, row.event_id);
    return { row: { ...row, run_id: runId, run_link: "session_ref" }, link: "session_ref", linkedNow: true };
  }
}
