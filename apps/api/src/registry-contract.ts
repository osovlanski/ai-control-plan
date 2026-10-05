/**
 * Reference implementation of the Cockpit registry v1 contract
 * (docs/contracts/registry-v1.md). The JSON Schemas under contracts/registry/v1
 * are the wire authority; this module adds the normative rules a schema cannot
 * express — asset order, sorted arrays, snapshotDigest and content digests —
 * and the version-compatibility policy. Both the conformance fixtures and the
 * registry client run every response through it.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormatsImport from "ajv-formats";

// ajv-formats is CJS; under bundler resolution its default lands on `.default`.
const addFormats = ((addFormatsImport as unknown as { default?: unknown }).default ?? addFormatsImport) as (ajv: Ajv2020) => void;

/** The contract version this build was written against. */
export const REGISTRY_SCHEMA_VERSION = "1.0";
export const REGISTRY_VERSION_HEADER = "x-cockpit-registry-version";
/** Fields excluded from snapshotDigest because they change without the asset changing. */
export const VOLATILE_ASSET_FIELDS = ["installedAt", "lastUsedAt", "stats"] as const;

export const REGISTRY_CONTRACT_DIR = join(dirname(fileURLToPath(import.meta.url)), "../../../contracts/registry/v1");

export type AssetKind = "skill" | "plugin" | "agent" | "hook" | "mcp_server" | "rule";
export interface SecretRef { type: "env" | "keychain"; name: string }
export interface RegistryAsset {
  id: string;
  digest: string;
  kind: AssetKind;
  nativeKind: string;
  name: string;
  description: string;
  tags: string[];
  targets: string[];
  compatibility: { assistants: string[] };
  requirements: { secretRefs: SecretRef[]; commands?: string[] };
  conflicts: string[];
  lineage: { origin: string; sourceUrl?: string };
  enabled: boolean;
  mcp?: { transport: "stdio" | "remote"; command?: string; args?: string[]; url?: string; env: Record<string, SecretRef> };
  installedAt: string;
  lastUsedAt?: string;
  stats?: Record<string, unknown>;
  [extra: string]: unknown;
}
export interface RegistrySnapshot { schemaVersion: string; snapshotDigest: string; assets: RegistryAsset[] }
export interface ContentFile { path: string; size: number; digest: string; encoding: "utf8" | "base64"; content: string }
export interface RegistryAssetContent { schemaVersion: string; id: string; kind: AssetKind; digest: string; files: ContentFile[]; mcp?: RegistryAsset["mcp"] }

export type ContractResult<T> = { ok: true; value: T } | { ok: false; errors: string[] };

const ajv = new Ajv2020({ allErrors: true, strict: true, strictRequired: false });
addFormats(ajv);
for (const file of ["registry-snapshot.schema.json", "registry-asset-content.schema.json", "registry-error.schema.json"]) {
  ajv.addSchema(JSON.parse(readFileSync(join(REGISTRY_CONTRACT_DIR, file), "utf8")) as object, file);
}
const snapshotSchema = ajv.getSchema("registry-snapshot.schema.json")!;
const contentSchema = ajv.getSchema("registry-asset-content.schema.json")!;
const errorSchema = ajv.getSchema("registry-error.schema.json")!;

/** RFC 8785 (JCS) for the value space the contract uses: strings, booleans, integers, null, arrays, objects. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    if (typeof value === "number" && !Number.isSafeInteger(value)) throw new Error("canonicalJson: non-integer numbers are not part of the digested value space");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

const sha256 = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");

export function computeSnapshotDigest(assets: readonly RegistryAsset[]): string {
  const stable = assets.map((asset) => {
    const copy: Record<string, unknown> = { ...asset };
    for (const field of VOLATILE_ASSET_FIELDS) delete copy[field];
    return copy;
  });
  return `sha256:${sha256(canonicalJson(stable))}`;
}

/** Asset digest over a file set: sha256 of `<hex sha256(bytes)> <path>\n` lines sorted by path bytes. */
export function computeAssetDigest(files: ReadonlyArray<{ path: string; bytes: Buffer }>): string {
  const lines = files
    .map((f) => ({ path: f.path, key: Buffer.from(f.path, "utf8"), line: `${sha256(f.bytes)} ${f.path}\n` }))
    .sort((a, b) => Buffer.compare(a.key, b.key))
    .map((f) => f.line);
  return `sha256:${sha256(lines.join(""))}`;
}

/** Same major required; the client's minor must not exceed the server's. */
export function isCompatibleVersion(served: unknown, supported = REGISTRY_SCHEMA_VERSION): boolean {
  if (typeof served !== "string") return false;
  const parse = (v: string) => /^(\d+)\.(\d+)$/.exec(v);
  const s = parse(served);
  const c = parse(supported);
  if (!s || !c) return false;
  return s[1] === c[1] && Number(c[2]) <= Number(s[2]);
}

const isSorted = (values: readonly string[]) => values.every((v, i) => i === 0 || values[i - 1]! < v);

function schemaErrors(validate: typeof snapshotSchema): string[] {
  return (validate.errors ?? []).map((e) => `${e.instancePath || "/"} ${e.message ?? "invalid"}`);
}

export function validateSnapshot(body: unknown, supported = REGISTRY_SCHEMA_VERSION): ContractResult<RegistrySnapshot> {
  const version = (body as { schemaVersion?: unknown } | null)?.schemaVersion;
  if (!isCompatibleVersion(version, supported)) return { ok: false, errors: [`unsupported schemaVersion ${JSON.stringify(version)}; client supports ${supported}`] };
  if (!snapshotSchema(body)) return { ok: false, errors: schemaErrors(snapshotSchema) };
  const snapshot = body as RegistrySnapshot;
  const errors: string[] = [];
  snapshot.assets.forEach((asset, i) => {
    const prev = snapshot.assets[i - 1];
    if (prev && !(prev.id < asset.id)) errors.push(`/assets/${i} id ${asset.id} is not strictly after ${prev.id}`);
    for (const field of ["tags", "targets", "conflicts"] as const) {
      if (!isSorted(asset[field])) errors.push(`/assets/${i}/${field} is not sorted`);
    }
    if (!isSorted(asset.compatibility.assistants)) errors.push(`/assets/${i}/compatibility/assistants is not sorted`);
    if (asset.requirements.commands && !isSorted(asset.requirements.commands)) errors.push(`/assets/${i}/requirements/commands is not sorted`);
  });
  if (errors.length === 0) {
    const expected = computeSnapshotDigest(snapshot.assets);
    if (expected !== snapshot.snapshotDigest) errors.push(`snapshotDigest ${snapshot.snapshotDigest} does not match ${expected}`);
  }
  return errors.length ? { ok: false, errors } : { ok: true, value: snapshot };
}

export function validateContent(body: unknown, supported = REGISTRY_SCHEMA_VERSION): ContractResult<RegistryAssetContent> {
  const version = (body as { schemaVersion?: unknown } | null)?.schemaVersion;
  if (!isCompatibleVersion(version, supported)) return { ok: false, errors: [`unsupported schemaVersion ${JSON.stringify(version)}; client supports ${supported}`] };
  if (!contentSchema(body)) return { ok: false, errors: schemaErrors(contentSchema) };
  const content = body as RegistryAssetContent;
  const errors: string[] = [];
  const files = content.files.map((f, i) => {
    const bytes = Buffer.from(f.content, f.encoding === "base64" ? "base64" : "utf8");
    if (bytes.length !== f.size) errors.push(`/files/${i} size ${f.size} does not match ${bytes.length} bytes`);
    if (`sha256:${sha256(bytes)}` !== f.digest) errors.push(`/files/${i} digest does not match its bytes`);
    return { path: f.path, bytes };
  });
  if (new Set(files.map((f) => f.path)).size !== files.length) errors.push("/files has duplicate paths");
  if (content.kind === "mcp_server" && content.files[0]?.content !== canonicalJson(content.mcp)) errors.push("/files/0 server.json is not the canonical JSON of /mcp");
  const expected = computeAssetDigest(files);
  if (expected !== content.digest) errors.push(`digest ${content.digest} does not match ${expected}`);
  return errors.length ? { ok: false, errors } : { ok: true, value: content };
}

export function validateError(body: unknown): boolean {
  return errorSchema(body) as boolean;
}
