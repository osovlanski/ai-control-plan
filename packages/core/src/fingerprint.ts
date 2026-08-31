/**
 * `requestFingerprint` canonicalization v1 (execution-harness §2).
 *
 * The persisted identity of an `ExecutionRequest` is a digest over a canonical
 * JSON projection of EVERY execution-affecting and authorization-relevant field
 * — the full `runSpec` included. The ONLY exclusions are purely observational
 * metadata: `correlation` and `schemaVersion` (§2). `executionRequestId` is kept
 * in the projection: it is the lookup key dedupe is keyed on, so its
 * contribution is constant for any given comparison and including it is harmless
 * and matches the spec's "only exclusions" clause.
 *
 * The raw prompt never enters the projection — a `promptDigest` stands in for it,
 * so no unredacted free text reaches the stored provenance. Exact byte replay is
 * a non-goal: replay is semantic (re-render from provenance) and `promptDigest`
 * is the integrity witness that the render matched what ran.
 *
 * The algorithm name and version travel beside every stored fingerprint so a
 * later algorithm change is detectable rather than silently mismatching.
 *
 * ponytail: non-crypto 128-bit FNV-1a (two seeded 64-bit passes). Fine for a
 * single-instance local idempotency/conflict key. Swap `digestString` for
 * SHA-256 if the fingerprint ever crosses a trust boundary.
 */

import type { ExecutionRequest } from "./execution.js";

export const FINGERPRINT_ALGORITHM = "fnv1a128-canonical-v1";

export interface RequestFingerprint {
  fingerprint: string;
  algorithm: string;
  /** Digest of the rendered prompt — the integrity witness for semantic replay. */
  promptDigest: string;
}

const textEncoder = new (globalThis as unknown as {
  TextEncoder: new () => { encode(input: string): Uint8Array };
}).TextEncoder();

const FNV_OFFSET = 14695981039346656037n;
const FNV_PRIME = 1099511628211n;
const U64 = (1n << 64n) - 1n;

function fnv1a64(bytes: Uint8Array, seed: bigint): bigint {
  let hash = seed;
  for (let i = 0; i < bytes.length; i += 1) {
    hash ^= BigInt(bytes[i]!);
    hash = (hash * FNV_PRIME) & U64;
  }
  return hash;
}

/** 128-bit hex digest of a string (two seeded FNV-1a passes concatenated). */
export function digestString(value: string): string {
  const bytes = textEncoder.encode(value);
  const a = fnv1a64(bytes, FNV_OFFSET);
  const b = fnv1a64(bytes, FNV_OFFSET ^ FNV_PRIME);
  return a.toString(16).padStart(16, "0") + b.toString(16).padStart(16, "0");
}

/**
 * Deterministic JSON: object keys sorted recursively, arrays kept in order
 * (verification order and redaction-rule order are semantically significant),
 * `undefined` omitted. No whitespace.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(sortValue);
  const source = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(source).sort()) {
    if (source[key] === undefined) continue;
    out[key] = sortValue(source[key]);
  }
  return out;
}

/**
 * The canonical projection of a request — every execution-affecting and
 * authorization-relevant field, with the prompt replaced by its digest. Exposed
 * so persistence can store the exact provenance object the fingerprint was taken
 * over (§10 `execution_requests`).
 */
export function canonicalRequestProjection(
  request: ExecutionRequest,
): { promptDigest: string; projection: Record<string, unknown> } {
  const promptDigest = digestString(request.runSpec.prompt);
  // The full runSpec, with the prompt swapped for its digest so no free text
  // reaches the stored provenance. Spreading keeps any future runSpec field
  // covered automatically. `prompt` and `secretEnv` (a transient launch-time
  // value, §3) are explicitly dropped — they never enter the fingerprint.
  const { prompt: _prompt, secretEnv: _secretEnv, ...runSpecRest } = request.runSpec;
  const projection: Record<string, unknown> = {
    executionRequestId: request.executionRequestId,
    taskId: request.taskId,
    attempt: request.attempt,
    assistantId: request.assistantId,
    model: request.model ?? null,
    compositionRevisionId: request.compositionRevisionId ?? null,
    routingDecisionRef: request.routingDecisionRef,
    runSpec: { ...runSpecRest, prompt: undefined, secretEnv: undefined, promptDigest },
    policy: request.policy,
    verification: request.verification,
    origin: request.origin,
    context: request.context,
  };
  return { promptDigest, projection };
}

export function requestFingerprint(request: ExecutionRequest): RequestFingerprint {
  const { promptDigest, projection } = canonicalRequestProjection(request);
  return {
    fingerprint: digestString(canonicalJson(projection)),
    algorithm: FINGERPRINT_ALGORITHM,
    promptDigest,
  };
}
