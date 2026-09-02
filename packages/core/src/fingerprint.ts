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

import type { ExecutionRequest, VerificationPlan } from "./execution.js";

export const FINGERPRINT_ALGORITHM = "fnv1a128-canonical-v1";
export const VERIFICATION_PLAN_FINGERPRINT_ALGORITHM = "sha256-canonical-verification-plan-v1";

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
    ...(request.verificationPlan ? { verificationPlan: request.verificationPlan } : {}),
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

/** Small synchronous SHA-256 implementation keeps core provider/browser neutral. */
function sha256(value: string): string {
  const bytes = Array.from(textEncoder.encode(value));
  const bitLength = bytes.length * 8;
  bytes.push(0x80);
  while (bytes.length % 64 !== 56) bytes.push(0);
  const high = Math.floor(bitLength / 0x1_0000_0000);
  const low = bitLength >>> 0;
  for (let shift = 24; shift >= 0; shift -= 8) bytes.push((high >>> shift) & 0xff);
  for (let shift = 24; shift >= 0; shift -= 8) bytes.push((low >>> shift) & 0xff);

  const h = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
  const k = [
    0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
    0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
    0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
    0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
    0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
    0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
    0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
    0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2,
  ];
  const rotate = (n: number, bits: number) => (n >>> bits) | (n << (32 - bits));
  const w = new Array<number>(64);
  for (let offset = 0; offset < bytes.length; offset += 64) {
    for (let i = 0; i < 16; i += 1) {
      const p = offset + i * 4;
      w[i] = (((bytes[p]! << 24) | (bytes[p + 1]! << 16) | (bytes[p + 2]! << 8) | bytes[p + 3]!) >>> 0);
    }
    for (let i = 16; i < 64; i += 1) {
      const a = w[i - 15]!; const b = w[i - 2]!;
      const s0 = rotate(a, 7) ^ rotate(a, 18) ^ (a >>> 3);
      const s1 = rotate(b, 17) ^ rotate(b, 19) ^ (b >>> 10);
      w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) >>> 0;
    }
    let [a,b,c,d,e,f,g,hh] = h as [number,number,number,number,number,number,number,number];
    for (let i = 0; i < 64; i += 1) {
      const s1 = rotate(e, 6) ^ rotate(e, 11) ^ rotate(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (hh + s1 + ch + k[i]! + w[i]!) >>> 0;
      const s0 = rotate(a, 2) ^ rotate(a, 13) ^ rotate(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (s0 + maj) >>> 0;
      hh=g; g=f; f=e; e=(d+t1)>>>0; d=c; c=b; b=a; a=(t1+t2)>>>0;
    }
    h[0]=(h[0]!+a)>>>0; h[1]=(h[1]!+b)>>>0; h[2]=(h[2]!+c)>>>0; h[3]=(h[3]!+d)>>>0;
    h[4]=(h[4]!+e)>>>0; h[5]=(h[5]!+f)>>>0; h[6]=(h[6]!+g)>>>0; h[7]=(h[7]!+hh)>>>0;
  }
  return h.map((n) => n.toString(16).padStart(8, "0")).join("");
}

export function verificationPlanFingerprint(plan: VerificationPlan): { fingerprint: string; algorithm: typeof VERIFICATION_PLAN_FINGERPRINT_ALGORITHM } {
  const { planFingerprint: _fingerprint, fingerprintAlgorithm: _algorithm, ...projection } = plan;
  return {
    fingerprint: sha256(canonicalJson(projection)),
    algorithm: VERIFICATION_PLAN_FINGERPRINT_ALGORITHM,
  };
}
