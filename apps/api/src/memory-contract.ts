/**
 * Reference implementation of the memory v1 contract (docs/contracts/memory-v1.md; O6 plan
 * docs/agentic-os-o6-memory-writeback.md §3). Two directions:
 *
 * - `MemoryBundleSnapshot`: Cockpit serves it (`GET /api/v1/registry/memory/bundles`), the plane
 *   consumes it (S3). Cockpit owns memory; the plane only reads health and digests.
 * - `MemoryProposalEvent` / page: the plane serves it (`GET /api/memory/proposals`, `memory.read`,
 *   S5), Cockpit consumes it (S6). A proposal is never a write.
 *
 * The JSON Schemas under contracts/memory/v1 are the wire authority; this module adds the rules a
 * schema cannot express (order, recomputable digests, counts that must agree, byte limits and the
 * content guards) and the version policy. No route serves either shape yet (S1 is contract only).
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormatsImport from "ajv-formats";
import { formatSchemaErrors } from "./bundle-contract.js";
import { canonicalJson, INLINE_SECRET, type ContractResult } from "./registry-contract.js";

// ajv-formats is CJS; under bundler resolution its default lands on `.default`.
const addFormats = ((addFormatsImport as unknown as { default?: unknown }).default ?? addFormatsImport) as (ajv: Ajv2020) => void;

export const MEMORY_SCHEMA_VERSION = "1.0";
export const MEMORY_CONTRACT_DIR = join(dirname(fileURLToPath(import.meta.url)), "../../../contracts/memory/v1");
/** The memory file limit (one fact per file), in UTF-8 bytes. */
export const MEMORY_PROPOSAL_BODY_MAX_BYTES = 4096;
export const MEMORY_PROPOSAL_PAGE_MAX = 100;
export const MEMORY_PROPOSAL_PAGE_DEFAULT = 100;

export interface MemoryBundleMember { path: string; digest: string }
export interface MemoryBundleHealth {
  members: number;
  staleMembers: number;
  oldestAgeDays: number | null;
  duplicatePairs: number;
  ghosts: number;
  oversized: number;
  findingsDigest: string;
}
export interface MemoryBundle {
  id: string;
  digest: string;
  tags: string[];
  repoScopes: string[];
  visibility: "repo_scoped" | "any_repo";
  members: MemoryBundleMember[];
  estimatedTokens: number;
  health: MemoryBundleHealth;
}
export interface MemoryBundleSnapshot { schemaVersion: string; snapshotDigest: string; observedAt: string; bundles: MemoryBundle[] }

export interface MemoryProposalEvent {
  schemaVersion: string;
  proposalId: string;
  seq: number;
  sessionId: string;
  taskId: string;
  compositionRevisionId: string;
  checkpointId: string;
  harness: "claude-code" | "codex" | "cursor" | "bedrock";
  model: string | null;
  kind: "decision" | "gotcha" | "fact";
  name: string;
  description: string;
  body: string;
  target: { bundleId: string; bundleDigest: string } | null;
  supersedes: string[];
  evidence: { outcome: "success"; verificationPassed: boolean | null; changedFiles: number };
  at: string;
}
export interface MemoryProposalPage { schemaVersion: string; events: MemoryProposalEvent[]; next: number }

const ajv = new Ajv2020({ allErrors: true, strict: true, strictRequired: false });
addFormats(ajv);
for (const name of ["memory-bundle-snapshot.schema.json", "memory-proposal-event.schema.json", "memory-proposal-page.schema.json"]) {
  ajv.addSchema(JSON.parse(readFileSync(join(MEMORY_CONTRACT_DIR, name), "utf8")) as object);
}
const BASE = "https://agent-plane.local/contracts/memory/v1/";
const snapshotSchema = ajv.getSchema(`${BASE}memory-bundle-snapshot.schema.json`)!;
const eventSchema = ajv.getSchema(`${BASE}memory-proposal-event.schema.json`)!;
const pageSchema = ajv.getSchema(`${BASE}memory-proposal-page.schema.json`)!;

const sha256 = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");
const byteOrder = (a: string, b: string) => Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
const strictlySorted = (values: readonly string[]) => values.every((v, i) => i === 0 || byteOrder(values[i - 1]!, v) < 0);

/**
 * Bundle digest from member digests: the registry v1 asset digest (`computeAssetDigest`), i.e.
 * sha256 of `<hex sha256(bytes)> <path>\n` lines sorted by path bytes. Equal to
 * `computeAssetDigest` over the same files, so one algorithm and its fixtures cover both.
 */
export function computeMemoryBundleDigest(members: readonly MemoryBundleMember[]): string {
  const lines = [...members]
    .sort((a, b) => byteOrder(a.path, b.path))
    .map((m) => `${m.digest.slice("sha256:".length)} ${m.path}\n`);
  return `sha256:${sha256(lines.join(""))}`;
}

/** sha256 over the RFC 8785 JSON of `bundles`. `observedAt` is outside it; health is inside it. */
export const computeMemorySnapshotDigest = (bundles: readonly MemoryBundle[]): string => `sha256:${sha256(canonicalJson(bundles))}`;

/** `"mp1_" + hex sha256(JCS({v: 1, sessionId, index, bodyDigest}))`, bodyDigest = `sha256:` + hex sha256 of the UTF-8 body. */
export function computeMemoryProposalId(sessionId: string, index: number, body: string): string {
  const bodyDigest = `sha256:${sha256(Buffer.from(body, "utf8"))}`;
  return `mp1_${sha256(canonicalJson({ v: 1, sessionId, index, bodyDigest }))}`;
}

/**
 * Content a memory proposal must never carry. A proposal that trips one is dropped by the plane,
 * never redacted (a redacted memory is a wrong memory); a reader refuses one that arrives anyway.
 * The absolute-path and credential guards are bundle v1's; the hostname guard is memory v1's.
 */
const PROPOSAL_GUARDS: Array<[RegExp, string]> = [
  [/(^|[\s"'`(=])(\/(home|Users|root|tmp|var|private|etc|opt|mnt)\/|~\/|[A-Za-z]:\\)/m, "an absolute path"],
  [INLINE_SECRET, "an inline credential"],
  [/\b(?:[a-z0-9-]+\.)+(?:internal|local|lan|corp|intra)\b|\b(?:localhost|127\.0\.0\.1|0\.0\.0\.0)(?::\d+)?\b|\b(?:\d{1,3}\.){3}\d{1,3}\b/i, "a hostname or address"],
];

/** The guards a proposal's text fields trip, as `<pointer> contains <what>`. */
export function memoryProposalGuardHits(e: Pick<MemoryProposalEvent, "name" | "description" | "body">, at = ""): string[] {
  const hits: string[] = [];
  for (const field of ["name", "description", "body"] as const) {
    for (const [pattern, what] of PROPOSAL_GUARDS) if (pattern.test(e[field])) hits.push(`${at}/${field} contains ${what}`);
  }
  return hits;
}

/** Same major, and no minor newer than the reader's: the objects are closed, so an older reader cannot honour a newer field. */
function readable(served: unknown, supported: string): boolean {
  if (typeof served !== "string") return false;
  const s = /^(\d+)\.(\d+)$/.exec(served);
  const r = /^(\d+)\.(\d+)$/.exec(supported);
  return !!s && !!r && s[1] === r[1] && Number(s[2]) <= Number(r[2]);
}
const versionError = (version: unknown, supported: string) =>
  `unsupported schemaVersion ${JSON.stringify(version)}; this reader supports ${supported}`;

function bundleRuleErrors(b: MemoryBundle, at: string): string[] {
  const errors: string[] = [];
  if (!strictlySorted(b.members.map((m) => m.path))) errors.push(`${at}/members are not strictly sorted by path`);
  if (!strictlySorted(b.tags)) errors.push(`${at}/tags are not sorted`);
  if (!strictlySorted(b.repoScopes)) errors.push(`${at}/repoScopes are not sorted`);
  if ((b.visibility === "repo_scoped") !== (b.repoScopes.length > 0)) errors.push(`${at}/repoScopes are empty exactly when visibility is any_repo`);
  const expected = computeMemoryBundleDigest(b.members);
  if (b.digest !== expected) errors.push(`${at}/digest ${b.digest} does not match its members (${expected})`);
  const h = b.health;
  if (h.members !== b.members.length) errors.push(`${at}/health/members is not the number of members`);
  if (h.staleMembers > h.members) errors.push(`${at}/health/staleMembers exceeds members`);
  if ((h.oldestAgeDays === null) !== (b.members.length === 0)) errors.push(`${at}/health/oldestAgeDays is null exactly when there are no members`);
  return errors;
}

/** Validates a bundle snapshot as the plane (its consumer) reads it. */
export function validateMemoryBundleSnapshot(body: unknown, supported = MEMORY_SCHEMA_VERSION): ContractResult<MemoryBundleSnapshot> {
  const version = (body as { schemaVersion?: unknown } | null)?.schemaVersion;
  if (!readable(version, supported)) return { ok: false, errors: [versionError(version, supported)] };
  if (!snapshotSchema(body)) return { ok: false, errors: formatSchemaErrors(snapshotSchema.errors) };
  const snapshot = body as MemoryBundleSnapshot;
  const errors: string[] = [];
  if (!strictlySorted(snapshot.bundles.map((b) => b.id))) errors.push("/bundles are not strictly sorted by id");
  snapshot.bundles.forEach((b, i) => errors.push(...bundleRuleErrors(b, `/bundles/${i}`)));
  if (errors.length === 0) {
    const expected = computeMemorySnapshotDigest(snapshot.bundles);
    if (snapshot.snapshotDigest !== expected) errors.push(`/snapshotDigest ${snapshot.snapshotDigest} does not match ${expected}`);
  }
  return errors.length ? { ok: false, errors } : { ok: true, value: snapshot };
}

function eventRuleErrors(e: MemoryProposalEvent, at = ""): string[] {
  const errors: string[] = [];
  if (Buffer.byteLength(e.body, "utf8") > MEMORY_PROPOSAL_BODY_MAX_BYTES) errors.push(`${at}/body exceeds ${MEMORY_PROPOSAL_BODY_MAX_BYTES} UTF-8 bytes`);
  if (e.target === null && e.supersedes.length > 0) errors.push(`${at}/supersedes names members of a bundle, so it is empty when target is null`);
  if (!strictlySorted(e.supersedes)) errors.push(`${at}/supersedes is not sorted`);
  errors.push(...memoryProposalGuardHits(e, at));
  return errors;
}

/** Validates one proposal as a reader of `supported` would; a newer minor is rejected (the object is closed). */
export function validateMemoryProposalEvent(body: unknown, supported = MEMORY_SCHEMA_VERSION): ContractResult<MemoryProposalEvent> {
  const version = (body as { schemaVersion?: unknown } | null)?.schemaVersion;
  if (!readable(version, supported)) return { ok: false, errors: [versionError(version, supported)] };
  if (!eventSchema(body)) return { ok: false, errors: formatSchemaErrors(eventSchema.errors) };
  const errors = eventRuleErrors(body as MemoryProposalEvent);
  return errors.length ? { ok: false, errors } : { ok: true, value: body as MemoryProposalEvent };
}

/** Validates a page: every proposal, strictly increasing `seq`, one version, and `next` as the cursor. */
export function validateMemoryProposalPage(body: unknown, supported = MEMORY_SCHEMA_VERSION): ContractResult<MemoryProposalPage> {
  const version = (body as { schemaVersion?: unknown } | null)?.schemaVersion;
  if (!readable(version, supported)) return { ok: false, errors: [versionError(version, supported)] };
  if (!pageSchema(body)) return { ok: false, errors: formatSchemaErrors(pageSchema.errors) };
  const page = body as MemoryProposalPage;
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
