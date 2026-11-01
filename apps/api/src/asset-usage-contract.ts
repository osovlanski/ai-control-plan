/**
 * Reference implementation of the asset usage v1 contract (docs/contracts/asset-usage-v1.md): the
 * Control Plane's feed of M6 ledger rows, which Cockpit pulls (plan Q2). The JSON Schemas under
 * contracts/asset-usage/v1 are the wire authority; this module adds the rules a schema cannot
 * express (the five facts' consistency, page order and cursor) and serves the page.
 *
 * The event is the plane's own wire shape, not the ledger row: `body_digest` stays a storage
 * detail, and `ingest_seq` is published as `seq`, the cursor.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormatsImport from "ajv-formats";
import type { Db } from "./db/index.js";
import { formatSchemaErrors } from "./bundle-contract.js";
import type { ContractResult } from "./registry-contract.js";

// ajv-formats is CJS; under bundler resolution its default lands on `.default`.
const addFormats = ((addFormatsImport as unknown as { default?: unknown }).default ?? addFormatsImport) as (ajv: Ajv2020) => void;

export const ASSET_USAGE_SCHEMA_VERSION = "1.0";
export const ASSET_USAGE_CONTRACT_DIR = join(dirname(fileURLToPath(import.meta.url)), "../../../contracts/asset-usage/v1");
export const ASSET_USAGE_PAGE_MAX = 500;
export const ASSET_USAGE_PAGE_DEFAULT = 100;

export type AssetUsageInvocation =
  | { method: "tool_event"; count: number; failed: number }
  | { method: "not_applicable" | "not_observable"; count: null; failed: null };

export interface AssetUsageWireEvent {
  schemaVersion: string;
  eventId: string;
  seq: number;
  compositionRevisionId: string;
  sessionId: string;
  taskId: string;
  assetKind: "skill" | "mcp_server" | "memory_bundle" | "fragment";
  assetId: string;
  assetDigest: string;
  harness: string;
  fidelity: "full" | "partial" | "none";
  attached: boolean;
  validation: "runtime_confirmed" | "runtime_pending" | "rendered" | "files_verified" | "failed" | "none";
  invocation: AssetUsageInvocation;
  sessionOutcome: "success" | "error" | "neutral" | "not_run";
  verificationPassed: boolean | null;
  attributionMethod: string;
  deriverVersion: number;
  at: string;
}

export interface AssetUsagePage {
  schemaVersion: string;
  events: AssetUsageWireEvent[];
  next: number;
}

const ajv = new Ajv2020({ allErrors: true, strict: true, strictRequired: false });
addFormats(ajv);
for (const name of ["asset-usage-event.schema.json", "asset-usage-page.schema.json"]) {
  ajv.addSchema(JSON.parse(readFileSync(join(ASSET_USAGE_CONTRACT_DIR, name), "utf8")) as object);
}
const eventSchema = ajv.getSchema("https://agent-plane.local/contracts/asset-usage/v1/asset-usage-event.schema.json")!;
const pageSchema = ajv.getSchema("https://agent-plane.local/contracts/asset-usage/v1/asset-usage-page.schema.json")!;

/** Same major, and no minor newer than the reader's: the objects are closed, so an older reader cannot honour a newer field. */
function readable(served: unknown, supported: string): boolean {
  if (typeof served !== "string") return false;
  const s = /^(\d+)\.(\d+)$/.exec(served);
  const r = /^(\d+)\.(\d+)$/.exec(supported);
  return !!s && !!r && s[1] === r[1] && Number(s[2]) <= Number(r[2]);
}

const versionError = (version: unknown, supported: string) =>
  `unsupported schemaVersion ${JSON.stringify(version)}; this reader supports ${supported}`;

/** The rules between fields that the schema cannot state. */
function eventRuleErrors(e: AssetUsageWireEvent, at = ""): string[] {
  const errors: string[] = [];
  if (e.attached !== (e.validation !== "none")) errors.push(`${at}/validation is "none" exactly when the asset is not attached`);
  if (e.fidelity === "none" && e.attached) errors.push(`${at}/attached an ambient (fidelity none) session attaches nothing`);
  if (e.assetDigest === "excluded" && (e.assetKind !== "fragment" || e.attached)) errors.push(`${at}/assetDigest "excluded" names an unattached fragment only`);
  if (e.invocation.method === "tool_event" && e.invocation.failed > e.invocation.count) errors.push(`${at}/invocation failed calls are counted inside count`);
  return errors;
}

/** Validates one event as a reader of `supported` would; a newer minor is rejected (the object is closed). */
export function validateAssetUsageEvent(body: unknown, supported = ASSET_USAGE_SCHEMA_VERSION): ContractResult<AssetUsageWireEvent> {
  const version = (body as { schemaVersion?: unknown } | null)?.schemaVersion;
  if (!readable(version, supported)) return { ok: false, errors: [versionError(version, supported)] };
  if (!eventSchema(body)) return { ok: false, errors: formatSchemaErrors(eventSchema.errors) };
  const errors = eventRuleErrors(body as AssetUsageWireEvent);
  return errors.length ? { ok: false, errors } : { ok: true, value: body as AssetUsageWireEvent };
}

/** Validates a page: every event, strictly increasing `seq`, one version, and `next` as the cursor. */
export function validateAssetUsagePage(body: unknown, supported = ASSET_USAGE_SCHEMA_VERSION): ContractResult<AssetUsagePage> {
  const version = (body as { schemaVersion?: unknown } | null)?.schemaVersion;
  if (!readable(version, supported)) return { ok: false, errors: [versionError(version, supported)] };
  if (!pageSchema(body)) return { ok: false, errors: formatSchemaErrors(pageSchema.errors) };
  const page = body as AssetUsagePage;
  const errors: string[] = [];
  page.events.forEach((e, i) => {
    if (e.schemaVersion !== page.schemaVersion) errors.push(`/events/${i}/schemaVersion differs from the page's`);
    if (i > 0 && e.seq <= page.events[i - 1]!.seq) errors.push(`/events/${i}/seq is not after the previous event's`);
    errors.push(...eventRuleErrors(e, `/events/${i}`));
  });
  const last = page.events.at(-1);
  if (last && page.next !== last.seq) errors.push("/next is the last event's seq");
  return errors.length ? { ok: false, errors } : { ok: true, value: page };
}

export type FeedQuery = { ok: true; after: number; limit: number } | { ok: false; error: string };

const DIGITS = /^(0|[1-9][0-9]{0,15})$/;

/** `after` is a seq (default 0, the start); `limit` is 1..500 (default 100). Anything else is a 400. */
export function parseFeedQuery(query: { after?: unknown; limit?: unknown } | undefined): FeedQuery {
  const read = (name: string, raw: unknown, fallback: number, min: number, max: number): number | string => {
    if (raw === undefined) return fallback;
    if (typeof raw !== "string" || !DIGITS.test(raw)) return `${name} must be an integer from ${min} to ${max}`;
    const n = Number(raw);
    return n < min || n > max ? `${name} must be an integer from ${min} to ${max}` : n;
  };
  const after = read("after", query?.after, 0, 0, Number.MAX_SAFE_INTEGER);
  if (typeof after === "string") return { ok: false, error: after };
  const limit = read("limit", query?.limit, ASSET_USAGE_PAGE_DEFAULT, 1, ASSET_USAGE_PAGE_MAX);
  if (typeof limit === "string") return { ok: false, error: limit };
  return { ok: true, after, limit };
}

interface LedgerRow {
  event_id: string;
  ingest_seq: number;
  composition_revision_id: string;
  session_id: string;
  task_id: string;
  asset_kind: AssetUsageWireEvent["assetKind"];
  asset_id: string;
  asset_digest: string;
  harness: string;
  fidelity: AssetUsageWireEvent["fidelity"];
  attached: number;
  validation: AssetUsageWireEvent["validation"];
  invocation_method: AssetUsageInvocation["method"];
  invocation_count: number | null;
  invocation_failed: number | null;
  session_outcome: AssetUsageWireEvent["sessionOutcome"];
  verification_passed: number | null;
  attribution_method: string;
  deriver_version: number;
  at: string;
}

function toEvent(r: LedgerRow): AssetUsageWireEvent {
  const invocation: AssetUsageInvocation = r.invocation_method === "tool_event"
    ? { method: "tool_event", count: r.invocation_count ?? 0, failed: r.invocation_failed ?? 0 }
    : { method: r.invocation_method, count: null, failed: null };
  return {
    schemaVersion: ASSET_USAGE_SCHEMA_VERSION,
    eventId: r.event_id,
    seq: r.ingest_seq,
    compositionRevisionId: r.composition_revision_id,
    sessionId: r.session_id,
    taskId: r.task_id,
    assetKind: r.asset_kind,
    assetId: r.asset_id,
    assetDigest: r.asset_digest,
    harness: r.harness,
    fidelity: r.fidelity,
    attached: r.attached === 1,
    validation: r.validation,
    invocation,
    sessionOutcome: r.session_outcome,
    verificationPassed: r.verification_passed === null ? null : r.verification_passed === 1,
    attributionMethod: r.attribution_method,
    deriverVersion: r.deriver_version,
    at: r.at,
  };
}

/**
 * One page of the ledger after `after`, in `ingest_seq` order. Rows are append-only and a seq is
 * assigned once, so a cursor never skips or repeats an event, whatever is written between pages.
 * Only the listed columns are read: `body_digest` never leaves the plane.
 */
export function readAssetUsagePage(db: Db, after: number, limit: number): AssetUsagePage {
  const rows = db.prepare(
    `SELECT event_id, ingest_seq, composition_revision_id, session_id, task_id, asset_kind, asset_id, asset_digest,
       harness, fidelity, attached, validation, invocation_method, invocation_count, invocation_failed,
       session_outcome, verification_passed, attribution_method, deriver_version, at
     FROM asset_usage WHERE ingest_seq > ? ORDER BY ingest_seq LIMIT ?`,
  ).all(after, Math.min(Math.max(limit, 1), ASSET_USAGE_PAGE_MAX)) as LedgerRow[];
  const events = rows.map(toEvent);
  return { schemaVersion: ASSET_USAGE_SCHEMA_VERSION, events, next: events.at(-1)?.seq ?? after };
}
