/**
 * The UsageRecord ingestion boundary (plan §3.7; usage contract v1; M11 posts into it). Idempotent
 * on (provider, sessionRef, eventId), an absent sessionRef being its own key space: a replay
 * returns the stored row unchanged, and a different body under the same key is a conflict, never
 * an overwrite. Rows are immutable.
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

export type IngestResult =
  | { status: "created" | "replayed"; record: UsageRecord }
  | { status: "conflict"; record: UsageRecord }
  | { status: "unknown_run" };

interface Row {
  provider: string; event_id: string; body_digest: string; run_id: string | null; session_ref: string | null; source: string;
  assistant_id: string; model: string; accounting: "delta" | "cumulative"; tokens_in: number; tokens_out: number;
  cached_tokens: number; cost_usd: number | null; api_equivalent_usd: number; pricing_version: string; observed_at: string;
}
const fromRow = (r: Row): UsageRecord => ({
  eventId: r.event_id, runId: r.run_id, provider: r.provider, sessionRef: r.session_ref, source: r.source,
  assistantId: r.assistant_id, model: r.model, accounting: r.accounting, tokensIn: r.tokens_in, tokensOut: r.tokens_out,
  cachedTokens: r.cached_tokens, costUsd: r.cost_usd, apiEquivalentUsd: r.api_equivalent_usd,
  pricingVersion: r.pricing_version, observedAt: r.observed_at,
});

export class UsageLedger {
  constructor(private db: Db, private now: () => Date = () => new Date()) {}

  /**
   * Resolve attribution without rewriting the immutable observation. Cockpit's assistant ids
   * name environments (claude/codex), not this workspace's configured assistants. Only a unique
   * provider/session pair is sufficient: a resumed provider session can belong to several runs.
   */
  runIdFor(record: Pick<UsageRecord, "runId" | "provider" | "sessionRef">): string | null {
    if (record.runId) return record.runId;
    if (!record.sessionRef) return null;
    const matches = this.db.prepare(
      `SELECT r.id FROM runs r JOIN assistants a ON a.id = r.assistant_id
        WHERE a.provider = ? AND r.provider_session_ref = ? LIMIT 2`,
    ).all(record.provider, record.sessionRef) as Array<{ id: string }>;
    return matches.length === 1 ? matches[0]!.id : null;
  }

  /**
   * Read-time attribution also catches imports received before the run's session ref was
   * recorded. Shared-session imports remain ledger-only; never charge a session total twice.
   */
  recordsForRun(runId: string): UsageRecord[] {
    const run = this.db.prepare(
      `SELECT a.provider, r.provider_session_ref AS sessionRef
         FROM runs r JOIN assistants a ON a.id = r.assistant_id WHERE r.id = ?`,
    ).get(runId) as { provider: string; sessionRef: string | null } | undefined;
    const inferred = run ? this.runIdFor({ runId: null, ...run }) === runId : false;
    return (this.db.prepare(
      `SELECT * FROM usage_records WHERE run_id = ?
         OR (run_id IS NULL AND provider = ? AND session_ref = ? AND ?)
        ORDER BY received_at, rowid`,
    ).all(runId, run?.provider ?? null, run?.sessionRef ?? null, Number(inferred)) as Row[]).map(fromRow);
  }

  /** `record` is the value of a successful validateUsageRecord. */
  ingest(record: UsageRecord): IngestResult {
    const digest = `sha256:${createHash("sha256").update(JSON.stringify(record), "utf8").digest("hex")}`;
    if (record.runId && !this.db.prepare("SELECT 1 FROM runs WHERE id = ?").get(record.runId)) return { status: "unknown_run" };
    const inserted = this.db.prepare(
      `INSERT INTO usage_records (provider, event_id, body_digest, run_id, session_ref, source, assistant_id, model, accounting,
         tokens_in, tokens_out, cached_tokens, cost_usd, api_equivalent_usd, pricing_version, observed_at, received_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
    ).run(
      record.provider, record.eventId, digest, record.runId, record.sessionRef, record.source, record.assistantId, record.model,
      record.accounting, record.tokensIn, record.tokensOut, record.cachedTokens, record.costUsd, record.apiEquivalentUsd,
      record.pricingVersion, record.observedAt, this.now().toISOString(),
    );
    const row = this.db.prepare(
      "SELECT * FROM usage_records WHERE provider = ? AND ifnull(session_ref, '') = ? AND event_id = ?",
    ).get(record.provider, record.sessionRef ?? "", record.eventId) as Row;
    if (inserted.changes) return { status: "created", record: fromRow(row) };
    return { status: row.body_digest === digest ? "replayed" : "conflict", record: fromRow(row) };
  }
}
