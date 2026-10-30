/**
 * The UsageRecord ingestion boundary (plan §3.7; usage contract v1; M11 posts into it). Idempotent
 * on (provider, sessionRef, eventId), an absent sessionRef being its own key space: a replay
 * returns the stored row unchanged, and a different body under the same key is a conflict, never
 * an overwrite. Rows are immutable, except that a record with no run may gain one, once.
 *
 * Linking (phase 7 "one deduped usage stream"). Cockpit sends `runId: null` by design, so a record
 * with a `sessionRef` and no `runId` is bound to the one run whose assistant has the record's
 * provider and whose `provider_session_ref` is that `sessionRef`. Zero candidates (the session is not
 * a plane run, or not yet) or several (a resumed provider session spans runs, and a session-wide
 * total cannot be split between them) leave it unbound, and the answer says which. A body `runId`
 * that is not among the session's runs is a `run_conflict`, never stored. `backfillRunLinks`
 * applies the same rule to records already stored unbound, and is idempotent.
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
 * run or several runs have its session; or `none`, a record with neither runId nor sessionRef.
 */
export type RunLink = "body" | "session_ref" | "unmatched" | "ambiguous" | "none";

export type IngestResult =
  | { status: "created" | "replayed"; record: UsageRecord; link: RunLink; /** The record was bound to its run by this call. */ linkedNow: boolean }
  | { status: "conflict"; record: UsageRecord }
  | { status: "run_conflict"; sessionRuns: string[] }
  | { status: "unknown_run" };

export interface BackfillResult {
  linked: Array<{ provider: string; sessionRef: string; eventId: string; runId: string }>;
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

export class UsageLedger {
  constructor(private db: Db, private now: () => Date = () => new Date()) {}

  /** The runs a provider session belongs to, oldest first. */
  sessionRuns(provider: string, sessionRef: string): string[] {
    return (this.db.prepare(
      `SELECT r.id FROM runs r JOIN assistants a ON a.id = r.assistant_id
        WHERE r.provider_session_ref = ? AND a.provider = ? ORDER BY r.started_at, r.rowid`,
    ).all(sessionRef, provider) as Array<{ id: string }>).map((r) => r.id);
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
      const candidates = record.sessionRef ? this.sessionRuns(record.provider, record.sessionRef) : [];
      let runId = record.runId;
      let link: RunLink;
      if (record.runId) {
        if (candidates.length && !candidates.includes(record.runId)) return { status: "run_conflict", sessionRuns: candidates };
        link = "body";
      } else if (!record.sessionRef) link = "none";
      else if (candidates.length === 1) { runId = candidates[0]!; link = "session_ref"; }
      else link = candidates.length ? "ambiguous" : "unmatched";
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
   * a bound record is never revisited, and one still unmatched or ambiguous is counted again.
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

  private row(provider: string, sessionRef: string | null, eventId: string): Row | undefined {
    return this.db.prepare(
      "SELECT * FROM usage_records WHERE provider = ? AND ifnull(session_ref, '') = ? AND event_id = ?",
    ).get(provider, sessionRef ?? "", eventId) as Row | undefined;
  }

  /** A stored row's link, binding it now when it is unbound and its session has exactly one run. */
  private linkStored(row: Row): { row: Row; link: RunLink; linkedNow: boolean } {
    if (row.run_id) return { row, link: row.run_link ?? "body", linkedNow: false };
    if (!row.session_ref) return { row, link: "none", linkedNow: false };
    const candidates = this.sessionRuns(row.provider, row.session_ref);
    if (candidates.length !== 1) return { row, link: candidates.length ? "ambiguous" : "unmatched", linkedNow: false };
    // The 036 trigger admits exactly this write: NULL run to a run, with run_link session_ref.
    this.db.prepare(
      "UPDATE usage_records SET run_id = ?, run_link = 'session_ref' WHERE provider = ? AND ifnull(session_ref, '') = ? AND event_id = ? AND run_id IS NULL",
    ).run(candidates[0], row.provider, row.session_ref, row.event_id);
    return { row: { ...row, run_id: candidates[0]!, run_link: "session_ref" }, link: "session_ref", linkedNow: true };
  }
}
