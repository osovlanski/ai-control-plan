/**
 * The UsageRecord ingestion boundary (plan §3.5; M11 posts into it). Idempotent on the
 * provider-qualified key (provider, eventId): a replay returns the stored row unchanged, and a
 * different body under the same key is a conflict, never an overwrite. Rows are immutable. An
 * eventId MUST be unique per provider, not only within a session.
 */
import { createHash } from "node:crypto";
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

// Ids must carry a non-space character; counts stay exact as doubles; USD is bounded so one bad import cannot poison a SUM.
const id = { type: "string", minLength: 1, maxLength: 256, pattern: "\\S" } as const;
const count = { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER } as const;
const usd = { type: "number", minimum: 0, maximum: 1_000_000 } as const;
/** The wire record: camelCase and closed. Validated here, not by Fastify, which would strip unknown fields and coerce types. */
const USAGE_RECORD_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["eventId", "provider", "source", "assistantId", "model", "accounting", "tokensIn", "tokensOut", "cachedTokens", "apiEquivalentUsd", "pricingVersion", "observedAt"],
  properties: {
    eventId: id, runId: { anyOf: [id, { type: "null" }] }, provider: id, sessionRef: { anyOf: [id, { type: "null" }] },
    source: id, assistantId: id, model: id, accounting: { enum: ["delta", "cumulative"] },
    tokensIn: count, tokensOut: count, cachedTokens: count, costUsd: { anyOf: [usd, { type: "null" }] }, apiEquivalentUsd: usd,
    pricingVersion: id, observedAt: { type: "string", format: "date-time" },
  },
} as const;
const ajv = new Ajv2020({ allErrors: true, strict: true });
addFormats(ajv);
const usageSchema = ajv.compile(USAGE_RECORD_SCHEMA);

export function validateUsageRecord(body: unknown): ContractResult<UsageRecord> {
  if (!usageSchema(body)) return { ok: false, errors: formatSchemaErrors(usageSchema.errors) };
  const b = body as Partial<UsageRecord> & Omit<UsageRecord, "runId" | "sessionRef" | "costUsd">;
  // RFC 3339 admits instants Date cannot hold (leap seconds, `+HH` offsets) or prints as expanded years; refuse those.
  const instant = Date.parse(b.observedAt);
  const observedAt = Number.isNaN(instant) ? "" : new Date(instant).toISOString();
  if (!/^\d{4}-/.test(observedAt)) return { ok: false, errors: ["/observedAt is not a representable instant"] };
  // Fixed key order, and absent optionals as null, so equal records serialize (and digest) alike.
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

  /** `record` is the value of a successful validateUsageRecord. */
  ingest(record: UsageRecord): IngestResult {
    const digest = `sha256:${createHash("sha256").update(JSON.stringify(record), "utf8").digest("hex")}`;
    if (record.runId && !this.db.prepare("SELECT 1 FROM runs WHERE id = ?").get(record.runId)) return { status: "unknown_run" };
    const inserted = this.db.prepare(
      `INSERT INTO usage_records (provider, event_id, body_digest, run_id, session_ref, source, assistant_id, model, accounting,
         tokens_in, tokens_out, cached_tokens, cost_usd, api_equivalent_usd, pricing_version, observed_at, received_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (provider, event_id) DO NOTHING`,
    ).run(
      record.provider, record.eventId, digest, record.runId, record.sessionRef, record.source, record.assistantId, record.model,
      record.accounting, record.tokensIn, record.tokensOut, record.cachedTokens, record.costUsd, record.apiEquivalentUsd,
      record.pricingVersion, record.observedAt, this.now().toISOString(),
    );
    const row = this.db.prepare("SELECT * FROM usage_records WHERE provider = ? AND event_id = ?").get(record.provider, record.eventId) as Row;
    if (inserted.changes) return { status: "created", record: fromRow(row) };
    return { status: row.body_digest === digest ? "replayed" : "conflict", record: fromRow(row) };
  }
}
