/**
 * M5 bundle request path: the plane asks Cockpit to render a per-run bundle
 * (`POST /api/v1/registry/bundle`, bundle contract v1), validates the response against the
 * request, and persists it with its composition revision through `CompositionStore`.
 *
 * Transport rules are registry federation's (registry-federation.ts): loopback origin only, the
 * bearer token read from its file per request and held in memory only, a bounded read of the
 * body, and a classified reason on every failure. There is no fallback: the plane never builds
 * a bundle itself, so a Cockpit failure means no revision is written.
 */
import type { Db } from "../db/index.js";
import {
  BUNDLE_SCHEMA_VERSION, validateBundleRequest, validateBundleResponse, type BundleRequest, type BundleResponse,
} from "../bundle-contract.js";
import type { AgentSpec, CompositionDecision } from "../composition-contract.js";
import { CompositionError, CompositionStore, type CompositionRevision } from "./composition.js";
import { readBounded, readRegistryToken, RegistrySyncError, type RegistrySyncReason } from "./registry-federation.js";

/**
 * Bound on the encoded response. Content is capped at 256 KiB (bundle-v1.md §Limits), but JSON
 * writes a C0 control character as `\u00XX`, so conforming content can encode to 6x that; the
 * manifest's 384 reasons of up to 512 characters can add about 1 MiB more. 4 MiB holds any
 * conforming bundle and still stops a runaway body before it is buffered whole.
 */
export const MAX_BUNDLE_RESPONSE_BYTES = 4 * 1024 * 1024;
const LOOPBACK_HOSTS = ["127.0.0.1", "[::1]", "localhost"];

/** Registry federation's reasons, plus the two a render adds: a pin Cockpit cannot honour and a refused request. */
export type BundleRequestReason = RegistrySyncReason | "not_found" | "bad_request";

export class BundleRequestError extends Error {
  constructor(readonly reason: BundleRequestReason, readonly detail?: string) {
    super(detail ? `${reason}: ${detail}` : reason);
  }
}

export interface BundleSource { render(request: BundleRequest): Promise<BundleResponse> }

export class CockpitBundleClient implements BundleSource {
  constructor(
    private readonly baseUrl: string,
    private readonly tokenPath: string,
    private readonly fetcher: typeof fetch = fetch,
    private readonly timeoutMs = 10_000,
    private readonly maxBytes = MAX_BUNDLE_RESPONSE_BYTES,
  ) {
    // Config already refuses a non-loopback origin; the client refuses one too, so no caller can send the token off-host.
    const url = new URL(baseUrl);
    if (url.protocol !== "http:" || !LOOPBACK_HOSTS.includes(url.hostname)) throw new Error("Cockpit bundle origin must be an http loopback origin");
  }

  async render(request: BundleRequest): Promise<BundleResponse> {
    let token: string;
    try { token = readRegistryToken(this.tokenPath); } catch (err) { throw asBundleError(err); }
    let response: Response;
    try {
      response = await this.fetcher(new URL("/api/v1/registry/bundle", this.baseUrl), {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, accept: "application/json", "content-type": "application/json" },
        body: JSON.stringify(request),
        signal: AbortSignal.timeout(this.timeoutMs),
        redirect: "error",
      });
    } catch (err) {
      throw new BundleRequestError((err as Error)?.name === "TimeoutError" ? "timeout" : "unreachable");
    }
    // Error bodies are not read: the status is the classification, and nothing Cockpit says is echoed.
    const refused = STATUS_REASONS[response.status];
    if (refused) {
      await response.body?.cancel().catch(() => {});
      throw new BundleRequestError(refused);
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new BundleRequestError("http_error", String(response.status));
    }
    let text: string;
    try { text = await readBounded(response, this.maxBytes); } catch (err) { throw asBundleError(err); }
    let body: unknown;
    try { body = JSON.parse(text); } catch { throw new BundleRequestError("invalid_response", "not JSON"); }
    const result = validateBundleResponse(body, request);
    if (!result.ok) {
      const unsupported = result.errors.some((e) => e.startsWith("unsupported schemaVersion"));
      throw new BundleRequestError(unsupported ? "unsupported_version" : "invalid_response", result.errors.slice(0, 3).join("; "));
    }
    // The inline-credential guard knows shapes, not this value; a bundle echoing the bearer token is never persisted.
    if (text.includes(token)) throw new BundleRequestError("invalid_response", "response contains the bearer token");
    return result.value;
  }
}

const STATUS_REASONS: Partial<Record<number, BundleRequestReason>> = {
  400: "bad_request", 401: "unauthenticated", 404: "not_found", 413: "payload_too_large",
};

const asBundleError = (err: unknown) => new BundleRequestError(err instanceof RegistrySyncError ? err.reason : "unreachable");

/** An AgentSpec before its bundle exists: `context.bundle_digest` and `context.compiler` come from the response. */
export type AgentSpecDraft = Omit<AgentSpec, "context"> & { context: Pick<AgentSpec["context"], "fragments" | "memory_bundles"> };

export interface BundledCompositionInput {
  spec: AgentSpecDraft;
  decision: CompositionDecision;
  /** Per-model estimator ratio (plan §3.3 stage 4). */
  charsPerToken: number;
  /** Estimated-token ceiling for the whole bundle. */
  tokenBudget: number;
}

export type BundledCompositionResult =
  | { ok: true; revision: CompositionRevision }
  | { ok: false; reason: BundleRequestReason | "disabled"; detail?: string }
  /** Nothing was requested: bundle v1 renders for claude-code and codex only, or the draft makes an invalid request. */
  | { ok: false; reason: "unsupported_harness" | "invalid_request"; detail?: string }
  /** Cockpit excluded a selected skill. Not final (bundle-v1.md §Finalization): the Composer drops it and requests again. */
  | { ok: false; reason: "not_final"; excludedSkills: Array<{ ref: string; reason: string }> }
  | { ok: false; reason: "composition_rejected"; detail: string };

interface Logger { warn(obj: object, msg: string): void }
export interface BundledCompositionOptions {
  /** `registry.cockpit.enabled`: off means no request is sent, as for registry federation. */
  enabled: boolean;
  logger?: Logger;
}

/** The bundle request a spec draft makes: the same harness, model, fragments and pins, in the same order. */
export function bundleRequestFor(input: BundledCompositionInput): BundleRequest | { error: string } {
  const { spec } = input;
  if (spec.harness !== "claude-code" && spec.harness !== "codex") return { error: `bundle v1 has no harness ${spec.harness}` };
  return {
    schemaVersion: BUNDLE_SCHEMA_VERSION,
    harness: spec.harness,
    fragments: spec.context.fragments,
    memoryBundles: spec.context.memory_bundles.map(({ id, digest }) => ({ id, digest })),
    skills: spec.assets.skills.map(({ id, digest }) => ({ id, digest })),
    model: { id: spec.model.primary.id, charsPerToken: input.charsPerToken },
    tokenBudget: input.tokenBudget,
  };
}

export class BundledComposition {
  constructor(
    db: Db,
    private readonly source: BundleSource,
    private readonly options: BundledCompositionOptions,
    private readonly store = new CompositionStore(db),
  ) {}

  /** Requests the bundle, then persists the revision with it. On any failure nothing is written. */
  async compose(input: BundledCompositionInput): Promise<BundledCompositionResult> {
    if (!this.options.enabled) return { ok: false, reason: "disabled" };
    const request = bundleRequestFor(input);
    if ("error" in request) return { ok: false, reason: "unsupported_harness", detail: request.error };
    const checked = validateBundleRequest(request);
    if (!checked.ok) return { ok: false, reason: "invalid_request", detail: checked.errors.slice(0, 3).join("; ") };

    let response: BundleResponse;
    try {
      response = await this.source.render(request);
    } catch (err) {
      const reason = err instanceof BundleRequestError ? err.reason : "unreachable";
      // The reason only: a detail can quote validator output, and the token never reaches an error.
      this.options.logger?.warn({ source: "cockpit", reason, revision: input.spec.composition_revision_id }, "bundle request failed; no revision written");
      return { ok: false, reason, ...(err instanceof BundleRequestError && err.detail ? { detail: err.detail } : {}) };
    }
    const excludedSkills = response.manifest.excluded.filter((e) => e.kind === "skill").map(({ ref, reason }) => ({ ref, reason }));
    if (excludedSkills.length) return { ok: false, reason: "not_final", excludedSkills };

    const spec: AgentSpec = {
      ...input.spec,
      context: {
        ...input.spec.context,
        bundle_digest: response.manifest.bundleDigest,
        compiler: {
          name: response.manifest.compiler.name,
          version: response.manifest.compiler.version,
          tokens: response.manifest.tokens.estimated,
          token_method: response.manifest.tokens.tokenMethod,
          chars_per_token: response.manifest.tokens.charsPerToken,
        },
      },
    };
    try {
      return { ok: true, revision: this.store.persist({ spec, decision: input.decision, bundle: { request, response } }) };
    } catch (err) {
      if (!(err instanceof CompositionError)) throw err;
      return { ok: false, reason: "composition_rejected", detail: err.errors.slice(0, 5).join("; ") };
    }
  }
}
