/**
 * Reference implementation of the bundle v1 contract (docs/contracts/bundle-v1.md): the
 * Cockpit ⇄ Control Plane wire for a rendered per-run bundle. The JSON Schemas under
 * contracts/bundle/v1 are the wire authority; this module adds the rules a schema cannot
 * express — sort order, digests, the per-harness relPath allowlist, the size bound, the token
 * estimate and manifest coverage — and a reference `assembleBundle` that produces a conforming
 * response from rendered files. Cockpit owns rendering; this is not a renderer.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Ajv2020, type ErrorObject } from "ajv/dist/2020.js";
import addFormatsImport from "ajv-formats";
import { canonicalJson, isCompatibleVersion, type ContractResult } from "./registry-contract.js";

// ajv-formats is CJS; under bundler resolution its default lands on `.default`.
const addFormats = ((addFormatsImport as unknown as { default?: unknown }).default ?? addFormatsImport) as (ajv: Ajv2020) => void;

export const BUNDLE_SCHEMA_VERSION = "1.0";
export const BUNDLE_CONTRACT_DIR = join(dirname(fileURLToPath(import.meta.url)), "../../../contracts/bundle/v1");
/** Total decoded UTF-8 bytes of all file contents. See "Limits" in the normative doc for why. */
export const MAX_BUNDLE_BYTES = 256 * 1024;

export type BundleHarness = "claude-code" | "codex";
export interface BundleRequest {
  schemaVersion: string;
  harness: BundleHarness;
  fragments: string[];
  memoryBundles: string[];
  model: { id: string; charsPerToken: number };
  tokenBudget: number;
}
export interface BundleFile { relPath: string; content: string; digest: string }
export type InputKind = "fragment" | "memory_bundle";
export interface ManifestIncluded { kind: InputKind; ref: string; digest: string; reason: string }
export interface ManifestExcluded { kind: InputKind; ref: string; reason: string }
export interface BundleManifest {
  harness: BundleHarness;
  bundleDigest: string;
  compiler: { name: string; version: string };
  included: ManifestIncluded[];
  excluded: ManifestExcluded[];
  tokens: { estimated: number; tokenMethod: "estimated"; charsPerToken: number; budget: number };
}
export interface BundleResponse { schemaVersion: string; files: BundleFile[]; manifest: BundleManifest }

/** The closed allowlist, per harness. The schema pattern is the union; this narrows it. */
const HARNESS_PATHS: Record<BundleHarness, RegExp> = {
  "claude-code": /^(CLAUDE\.md|\.claude\/skills\/[a-z0-9][a-z0-9-]{0,63}\/SKILL\.md)$/,
  codex: /^AGENTS\.md$/,
};
/** Guards for the determinism rule. They catch common leaks; the normative rule is the requirement. */
const CONTENT_GUARDS: Array<[RegExp, string]> = [
  [/\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/, "a timestamp"],
  [/(^|[\s"'`(=])(\/(home|Users|root|tmp|var|private)\/|~\/|[A-Za-z]:\\)/m, "an absolute path"],
];

const ajv = new Ajv2020({ allErrors: true, strict: true, strictRequired: false });
addFormats(ajv);
for (const file of ["bundle-request.schema.json", "bundle-response.schema.json"]) {
  ajv.addSchema(JSON.parse(readFileSync(join(BUNDLE_CONTRACT_DIR, file), "utf8")) as object, file);
}
const requestSchema = ajv.getSchema("bundle-request.schema.json")!;
const responseSchema = ajv.getSchema("bundle-response.schema.json")!;

const sha256 = (data: string) => createHash("sha256").update(data, "utf8").digest("hex");
const byteOrder = (a: string, b: string) => Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
const isStrictlySorted = (values: readonly string[]) => values.every((v, i) => i === 0 || byteOrder(values[i - 1]!, v) < 0);

/** Schema errors with the failing keyword location, so a rejection names its rule. */
export function formatSchemaErrors(errors: ErrorObject[] | null | undefined): string[] {
  return (errors ?? []).map((e) => {
    const p = e.params as { additionalProperty?: string; unevaluatedProperty?: string };
    const extra = p.additionalProperty ?? p.unevaluatedProperty;
    return `${e.instancePath || "/"} ${e.message ?? "invalid"}${extra ? ` (${extra})` : ""} [${e.schemaPath}]`;
  });
}

export const fileDigest = (content: string) => `sha256:${sha256(content)}`;

/** RFC 8785 canonical JSON of the files sorted by relPath bytes. */
export function computeBundleDigest(files: readonly BundleFile[]): string {
  const sorted = [...files].sort((a, b) => byteOrder(a.relPath, b.relPath));
  return `sha256:${sha256(canonicalJson(sorted))}`;
}

/** ceil(total Unicode code points / charsPerToken). Always `estimated`: no exact tokenizer exists. */
export function estimateTokens(files: ReadonlyArray<{ content: string }>, charsPerToken: number): number {
  const chars = files.reduce((n, f) => n + [...f.content].length, 0);
  return Math.ceil(chars / charsPerToken);
}

/** Reference assembly: sorts, digests and estimates. Produces exactly what the validator accepts. */
export function assembleBundle(input: {
  request: BundleRequest;
  rendered: ReadonlyArray<{ relPath: string; content: string }>;
  compiler: BundleManifest["compiler"];
  included: ManifestIncluded[];
  excluded: ManifestExcluded[];
}): BundleResponse {
  const files = input.rendered
    .map((f) => ({ relPath: f.relPath, content: f.content, digest: fileDigest(f.content) }))
    .sort((a, b) => byteOrder(a.relPath, b.relPath));
  const byInput = (a: { kind: string; ref: string }, b: { kind: string; ref: string }) => byteOrder(`${a.kind}\0${a.ref}`, `${b.kind}\0${b.ref}`);
  return {
    schemaVersion: BUNDLE_SCHEMA_VERSION,
    files,
    manifest: {
      harness: input.request.harness,
      bundleDigest: computeBundleDigest(files),
      compiler: input.compiler,
      included: [...input.included].sort(byInput),
      excluded: [...input.excluded].sort(byInput),
      tokens: {
        estimated: estimateTokens(files, input.request.model.charsPerToken),
        tokenMethod: "estimated",
        charsPerToken: input.request.model.charsPerToken,
        budget: input.request.tokenBudget,
      },
    },
  };
}

/** Cockpit-side: a request is accepted when its minor does not exceed the server's. */
export function validateBundleRequest(body: unknown, served = BUNDLE_SCHEMA_VERSION): ContractResult<BundleRequest> {
  const version = (body as { schemaVersion?: unknown } | null)?.schemaVersion;
  if (typeof version !== "string" || !isCompatibleVersion(served, version)) {
    return { ok: false, errors: [`unsupported schemaVersion ${JSON.stringify(version)}; server supports ${served}`] };
  }
  if (!requestSchema(body)) return { ok: false, errors: formatSchemaErrors(requestSchema.errors) };
  const request = body as BundleRequest;
  const errors: string[] = [];
  if (!isStrictlySorted(request.fragments)) errors.push("/fragments is not sorted");
  if (!isStrictlySorted(request.memoryBundles)) errors.push("/memoryBundles is not sorted");
  return errors.length ? { ok: false, errors } : { ok: true, value: request };
}

/**
 * Control-Plane-side. With `request`, also checks the response answers that request: same
 * harness, budget and ratio, and every requested input appears exactly once as included or
 * excluded.
 */
export function validateBundleResponse(body: unknown, request?: BundleRequest, supported = BUNDLE_SCHEMA_VERSION): ContractResult<BundleResponse> {
  const version = (body as { schemaVersion?: unknown } | null)?.schemaVersion;
  if (!isCompatibleVersion(version, supported)) return { ok: false, errors: [`unsupported schemaVersion ${JSON.stringify(version)}; client supports ${supported}`] };
  if (!responseSchema(body)) return { ok: false, errors: formatSchemaErrors(responseSchema.errors) };
  const bundle = body as BundleResponse;
  const { manifest } = bundle;
  const errors: string[] = [];

  if (!isStrictlySorted(bundle.files.map((f) => f.relPath))) errors.push("/files is not strictly sorted by relPath");
  let bytes = 0;
  bundle.files.forEach((f, i) => {
    if (!HARNESS_PATHS[manifest.harness].test(f.relPath)) errors.push(`/files/${i}/relPath ${f.relPath} is not allowed for harness ${manifest.harness}`);
    if (fileDigest(f.content) !== f.digest) errors.push(`/files/${i} digest does not match its content`);
    for (const [pattern, what] of CONTENT_GUARDS) if (pattern.test(f.content)) errors.push(`/files/${i} content contains ${what}`);
    bytes += Buffer.byteLength(f.content, "utf8");
  });
  if (bytes > MAX_BUNDLE_BYTES) errors.push(`/files total ${bytes} bytes exceeds ${MAX_BUNDLE_BYTES}`);
  const expectedDigest = computeBundleDigest(bundle.files);
  if (expectedDigest !== manifest.bundleDigest) errors.push(`/manifest/bundleDigest ${manifest.bundleDigest} does not match ${expectedDigest}`);

  const expectedTokens = estimateTokens(bundle.files, manifest.tokens.charsPerToken);
  if (manifest.tokens.estimated !== expectedTokens) errors.push(`/manifest/tokens/estimated ${manifest.tokens.estimated} does not match ${expectedTokens}`);
  if (manifest.tokens.estimated > manifest.tokens.budget) errors.push(`/manifest/tokens/estimated ${manifest.tokens.estimated} exceeds budget ${manifest.tokens.budget}`);

  const keys = [...manifest.included, ...manifest.excluded].map((e) => `${e.kind}:${e.ref}`);
  if (new Set(keys).size !== keys.length) errors.push("/manifest lists an input more than once across included and excluded");

  if (request) {
    if (request.harness !== manifest.harness) errors.push(`/manifest/harness ${manifest.harness} does not match requested ${request.harness}`);
    if (request.tokenBudget !== manifest.tokens.budget) errors.push("/manifest/tokens/budget does not match the request");
    if (request.model.charsPerToken !== manifest.tokens.charsPerToken) errors.push("/manifest/tokens/charsPerToken does not match the request");
    const requested = [
      ...request.fragments.map((r) => `fragment:${r}`),
      ...request.memoryBundles.map((r) => `memory_bundle:${r}`),
    ].sort();
    if (canonicalJson([...keys].sort()) !== canonicalJson(requested)) {
      errors.push("/manifest included and excluded do not cover exactly the requested fragments and memory bundles");
    }
  }
  return errors.length ? { ok: false, errors } : { ok: true, value: bundle };
}
