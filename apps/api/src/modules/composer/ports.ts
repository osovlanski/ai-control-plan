/**
 * The M2 Composer's two ports over the api (plans/m2-composer.md §1).
 *
 * - Stage 2, `RouteHarnessModelPort`: the existing `route()`, over exactly the inputs `routeTask`
 *   builds (`routeInputs`). It routes without persisting; the service persists ONE routing row,
 *   for the outcome the composition used, through the same `persistRoutingDecision` path.
 * - Stage 4, `CockpitBundlePort`: #85's `BundledComposition.render`, which writes nothing. The
 *   Composer never builds a bundle itself (plan risk 6): nothing in this directory imports the
 *   bundle contract module, where the plane's reference renderer lives.
 */
import {
  harnessForProvider, type ApprovalMode, type AssistantId, type BundlePort, type BundlePortResult, type BundleRenderDraft,
  type CapabilityManifest, type Harness, type HarnessModelCandidate, type HarnessModelChoice, type HarnessModelFilter,
  type HarnessModelPort, type HarnessModelProjection, type HarnessModelRequest, type ModelPrice, type RoutingExplanation,
} from "@agent-plane/core";
import type { BundledComposition, RenderedBundle } from "../bundle-request.js";
import { COST_REFERENCE_MIX, priceApplicability, resolveCandidateIdentity } from "../model-selection.js";
import { explainRoute, persistRoutingDecision, route, routeInputs, type RouteDeps, type RouteInputs, type RouteOptions, type RouteOrigin } from "../router.js";

/**
 * The approval modes each harness's adapter enforces; it refuses the rest before a process starts
 * (PROJECT_MEMORY 2026-10-05 "adapters enforce or refuse the approval mode"). Manifests do not
 * declare this, so the port carries it, and `composer-preview.test.ts` checks it against the
 * adapters' own refusals.
 *
 * - claude-code: all three. `prompt-on-escalation` relays approvals through `canUseTool`;
 *   `read-only` runs in the SDK's default permission mode, which still allows rule-allowed tools
 *   (unchanged here, as today for a read-only workspace).
 * - codex (Codex SDK and app-server, so OpenRouter too): `auto-approve` → `workspace-write`,
 *   `read-only` → `read-only`; `prompt-on-escalation` is refused (no approval relay).
 * - cursor: `auto-approve` only (`agent -p` has write and shell access).
 * - bedrock: none. Tools run remotely and the adapter enforces no mode; claiming one would be
 *   false. Bundle v1 has no bedrock renderer, so the pipeline stops before stage 5 anyway.
 */
export const HARNESS_APPROVAL_MODES: Readonly<Record<Harness, readonly ApprovalMode[]>> = {
  "claude-code": ["auto-approve", "prompt-on-escalation", "read-only"],
  codex: ["auto-approve", "read-only"],
  cursor: ["auto-approve"],
  bedrock: [],
};

const HARNESSES = Object.keys(HARNESS_APPROVAL_MODES) as Harness[];

/**
 * The harness an assistant runs under. A fake assistant's test-only `providerDetail.harness` is
 * read only when the manifest's provider is `fake`: no real provider can set its harness.
 */
export function harnessOf(manifest: Pick<CapabilityManifest, "provider" | "providerDetail">): Harness | undefined {
  if (manifest.provider === "fake") {
    const declared = (manifest.providerDetail as { harness?: unknown } | undefined)?.harness;
    if (declared === undefined) return "claude-code";
    return HARNESSES.includes(declared as Harness) ? (declared as Harness) : undefined;
  }
  return harnessForProvider(manifest.provider);
}

/** route()'s filter texts, projected to the fixed stage-2 names. Kinds come from structured data, never from the text. */
function projectFilters(inputs: RouteInputs, explanation: RoutingExplanation): HarnessModelFilter[] {
  const filters: HarnessModelFilter[] = [];
  for (const candidate of explanation.candidates) {
    const id = String(candidate.assistantId);
    const manifest = inputs.candidates.find((c) => c.id === candidate.assistantId)?.manifest;
    for (const failure of candidate.filterFailures) {
      if (failure === "disabled in workspace config") filters.push({ filter: "disabled", assistantIds: [id] });
      else if (failure.startsWith("no capability manifest")) filters.push({ filter: "no_manifest", assistantIds: [id] });
      else if (failure.startsWith("auth ")) filters.push({ filter: "auth", assistantIds: [id], ...(manifest ? { kinds: [manifest.core.auth.state] } : {}) });
      else if (failure === "no filesystem capability") filters.push({ filter: "no_filesystem", assistantIds: [id] });
      else if (failure === "no shell capability") filters.push({ filter: "no_shell", assistantIds: [id] });
      else if (failure.startsWith("repository path not in workspace allowlist")) filters.push({ filter: "repo_not_allowlisted", assistantIds: [id] });
      // A cooldown's text is free-form; only the class is recorded, and route() has none yet.
      else if (failure.startsWith("cooldown")) filters.push({ filter: "cooldown", assistantIds: [id] });
      else if (failure.startsWith("quota blocked")) {
        const kinds = inputs.request.projections?.get(id)?.blockers.map((b) => b.kind) ?? [];
        filters.push({ filter: "quota_blocked", assistantIds: [id], kinds });
      } else if (failure === "quota exhausted") filters.push({ filter: "quota_exhausted", assistantIds: [id] });
    }
  }
  return filters;
}

const MAX_RULE_LENGTH = 256;

interface Routed { inputs: RouteInputs; explanation: RoutingExplanation & { origin: string } }

/**
 * Stage 2 over route(). One instance serves one composition (and its one `not_found` recompose):
 * route() runs at most once per distinct assistant override, so the pipeline's "without, then
 * with, the override" calls and the service's model lookup see one consistent answer. Nothing is
 * persisted until the service calls `persistUsed`.
 */
export class RouteHarnessModelPort implements HarnessModelPort {
  private readonly routed = new Map<string, Routed>();
  private used: Routed | undefined;

  constructor(
    private readonly deps: RouteDeps,
    private readonly taskId: string,
    private readonly origin: RouteOrigin,
    private readonly options: RouteOptions = {},
  ) {}

  private checkTask(taskId: string): void {
    if (taskId !== this.taskId) throw new Error(`harness-model port for ${this.taskId} asked about ${taskId}`);
  }

  private routeFor(assistantId: string | undefined): Routed {
    const key = assistantId ?? "";
    const cached = this.routed.get(key);
    if (cached) return cached;
    const options: RouteOptions = { ...this.options, ...(assistantId !== undefined ? { override: assistantId as AssistantId } : {}) };
    const inputs = routeInputs(this.deps, this.taskId, this.origin, options);
    const explanation = explainRoute(this.deps, inputs, route(inputs.request, inputs.candidates), this.origin, options);
    const routed = { inputs, explanation };
    this.routed.set(key, routed);
    return routed;
  }

  /** The projection for a request, without marking it as the outcome used. */
  peek(request: Pick<HarnessModelRequest, "taskId" | "override">): HarnessModelProjection {
    this.checkTask(request.taskId);
    return this.project(this.routeFor(request.override?.assistantId), request.override);
  }

  async select(request: HarnessModelRequest): Promise<HarnessModelProjection> {
    this.checkTask(request.taskId);
    const routed = this.routeFor(request.override?.assistantId);
    // The pipeline calls without the override first and with it last: the last call is the one used.
    this.used = routed;
    return this.project(routed, request.override);
  }

  /** The routing explanation of the outcome the composition used; undefined when stage 2 never ran. */
  usedExplanation(): (RoutingExplanation & { origin: string }) | undefined {
    return this.used?.explanation;
  }

  /** Persists the one routing row for the outcome used, through routeTask's own path. */
  persistUsed(): number | undefined {
    if (!this.used) return undefined;
    return persistRoutingDecision(this.deps.db, this.taskId, this.used.explanation);
  }

  private project({ inputs, explanation }: Routed, override: HarnessModelRequest["override"]): HarnessModelProjection {
    const recommendation = explanation.modelRecommendation;
    const candidates: HarnessModelCandidate[] = explanation.candidates.flatMap((c) => {
      const id = String(c.assistantId);
      const manifest = inputs.candidates.find((x) => x.id === c.assistantId)?.manifest;
      const base = {
        assistantId: id,
        ...(c.quota?.usedPercent !== undefined ? { quotaUsedPercent: c.quota.usedPercent } : {}),
        ...(inputs.request.scores?.get(id)?.runs !== undefined ? { telemetryRuns: inputs.request.scores.get(id)!.runs } : {}),
      };
      const models = manifest?.core.models ?? [];
      if (!models.length) return [base];
      return models.map((m) => ({
        ...base,
        modelId: m.id,
        ...(recommendation?.recommended === `${id}/${m.id}` ? { k13Shadow: { model: m.id, rule: `${recommendation.mode} mode` } } : {}),
      }));
    });
    const ruleFired = explanation.ruleFired.slice(0, MAX_RULE_LENGTH);
    const projection = { candidates, filters: projectFilters(inputs, explanation), ruleFired };
    const chosenId = explanation.chosen;
    if (!chosenId) return projection;
    const row = this.deps.registry.list().find((a) => a.id === chosenId);
    const manifest = inputs.candidates.find((c) => c.id === chosenId)?.manifest;
    const harness = manifest ? harnessOf(manifest) : undefined;
    if (!manifest || !harness) return { ...projection, ruleFired: `${ruleFired}; the chosen assistant has no known harness` };

    // Model order (§2 stage 2): the operator's stage-2 override, a selector K13 committed in
    // applied mode for this assistant, the task's model override, the manifest's first model.
    const applied = recommendation?.applied?.assistantId === chosenId ? recommendation.applied.selector : undefined;
    const intentModel = inputs.intent.overrides?.model;
    const pick: { modelId: string; modelSource: HarnessModelChoice["modelSource"] } | undefined =
      override?.model !== undefined ? { modelId: override.model, modelSource: "intent-override" }
        : applied !== undefined ? { modelId: applied, modelSource: "k13-applied" }
          : intentModel !== undefined ? { modelId: intentModel, modelSource: "intent-override" }
            : manifest.core.models[0] ? { modelId: manifest.core.models[0].id, modelSource: "manifest-first" }
              : undefined;
    if (!pick) return { ...projection, ruleFired: `${ruleFired}; the chosen assistant lists no model` };

    const price = row ? this.price(String(chosenId), row.provider, pick.modelId) : undefined;
    const chosen: HarnessModelChoice = {
      assistantId: String(chosenId),
      ...pick,
      harness,
      acceptedApprovalModes: HARNESS_APPROVAL_MODES[harness],
      usageReporting: manifest.harness?.usageReporting !== undefined,
      ...(price ? { price } : {}),
    };
    return { ...projection, chosen };
  }

  /**
   * K7 price evidence for the chosen model: the cheapest non-expired row proven to apply to this
   * assistant's serving provider and account (as K13's cost prior reads it). Never fails routing.
   */
  private price(assistantId: string, provider: string, selector: string): ModelPrice | undefined {
    const catalogService = this.deps.catalog;
    if (!catalogService) return undefined;
    try {
      const catalog = catalogService.list();
      const identity = resolveCandidateIdentity(this.deps.db, { assistantId, provider, selector, catalog, ...(this.deps.now ? { now: this.deps.now } : {}) });
      const entry = identity.resolvedModelKey ? catalog.find((e) => e.modelKey === identity.resolvedModelKey) : undefined;
      if (!entry) return undefined;
      const accountKind = this.deps.config.assistants[assistantId]?.accountKind;
      const account = { servingProvider: provider, ...(accountKind ? { accountKind } : {}) };
      const blended = (p: { inputPerMtok: number; outputPerMtok: number }) => COST_REFERENCE_MIX.input * p.inputPerMtok + COST_REFERENCE_MIX.output * p.outputPerMtok;
      const rows = entry.pricing
        .filter((p) => p.freshness !== "expired" && priceApplicability(p, account).applicable)
        .sort((a, b) => blended(a) - blended(b) || (a.pricingVersion < b.pricingVersion ? 1 : a.pricingVersion > b.pricingVersion ? -1 : 0));
      const best = rows[0];
      return best ? { pricingVersion: best.pricingVersion, inputPerMtok: best.inputPerMtok, outputPerMtok: best.outputPerMtok } : undefined;
    } catch {
      return undefined;
    }
  }
}

/**
 * Stage 4 over `BundledComposition.render`. Writes nothing; a failure is an answer. The last
 * rendered bundle is kept so a start (S5) can hand it to `persistRendered`, which accepts only a
 * bundle this same `BundledComposition` rendered.
 */
export class CockpitBundlePort implements BundlePort {
  private last: RenderedBundle | undefined;

  constructor(private readonly bundled: BundledComposition) {}

  lastRendered(): RenderedBundle | undefined {
    return this.last;
  }

  async render(draft: BundleRenderDraft, options: { charsPerToken: number; tokenBudget: number }): Promise<BundlePortResult> {
    const result = await this.bundled.render({ spec: draft, charsPerToken: options.charsPerToken, tokenBudget: options.tokenBudget });
    if (result.ok) {
      this.last = result.bundle;
      return { status: "ok", request: result.bundle.request, response: result.bundle.response };
    }
    if (result.reason === "not_final") return { status: "not_final", response: result.bundle.response, excludedSkills: result.excludedSkills };
    return { status: "failure", reason: result.reason };
  }
}
