import {
  DIMENSION_K,
  HARNESS_MAJOR,
  TASK_DIMENSIONS,
  classifyTask,
  evaluateActivationGate,
  modelKey,
  normalizeBenchmark,
  selectModel,
} from '@agent-plane/core';
import type {
  AssistantId,
  CandidateIdentity,
  DimensionEvidence,
  DimensionPrior,
  DimensionTelemetry,
  ModelCandidateInput,
  ModelCatalogEntry,
  ModelRecommendation,
  Provenance,
  RoutingExplanation,
  SelectionEvidenceSource,
  TaskDimension,
  TaskIntent,
} from '@agent-plane/core';
import type { ResolvedConfig } from '../config.js';
import type { Db } from '../db/index.js';
import { AA_SPEED_SCALE_MAX } from './artificial-analysis.js';
import type { ModelCatalogService } from './model-catalog.js';
import type { Registry } from './registry.js';
import { modelCohorts, type ModelCohort } from './telemetry.js';

/**
 * K13 assembly — the impure half of model selection (§4.4.3).
 *
 * It gathers what already exists on this machine (provider discovery manifests,
 * the K7 catalog with its K8 priors, this workspace's own runs) and hands a
 * fully sourced picture to the pure kernel in `@agent-plane/core`. It decides
 * nothing itself.
 *
 * SHADOW. Nothing here writes `ExecutionRequest.model`, `RunSpec.model`, the
 * chosen assistant, or anything the provider call reads. The recommendation is
 * persisted inside `routing_decisions.explanation.modelRecommendation` and is
 * read by the UI and by this module's own activation audit — nowhere else.
 */

/**
 * Cost normalization, `price-normalization-v1`. A fixed ABSOLUTE rescale, like
 * K8's benchmark normalization: no cross-model dataset is needed, so ties and
 * outliers have no degenerate case and an out-of-range price simply clamps.
 * Bump the version on ANY change to the mix or the scale.
 */
export const PRICE_NORMALIZATION_VERSION = 'price-normalization-v1';
/**
 * The reference token mix a cost prior is priced at. Agentic runs are strongly
 * input-heavy (repository context, transcripts, tool output), so a naive
 * input/output average would misrank a model with cheap input and dear output.
 * Fixed and provider-neutral: it is a property of how this plane runs work.
 */
export const COST_REFERENCE_MIX = { input: 0.9, output: 0.1 };
/** USD per Mtok at the reference mix that normalizes to 0.0. Above it clamps. */
export const COST_SCALE_USD_PER_MTOK = 50;
/** USD per completed task that normalizes to 0.0 for OWN cost telemetry. */
export const COST_SCALE_USD_PER_TASK = 1;

/** The cost prior's pinned source label — K7 price evidence, never a benchmark's pricing. */
const COST_PRIOR_SOURCE: SelectionEvidenceSource = 'k7:price-evidence';

export interface RecommendModelDeps {
  db: Db;
  config: ResolvedConfig;
  registry: Registry;
  catalog: ModelCatalogService;
  now?: () => Date;
}

/**
 * Build the shadow model recommendation for one routing decision.
 *
 * `assistantFilters` is the router's OWN per-assistant hard-filter verdict,
 * passed in rather than recomputed: auth, capability, workspace policy, quota
 * projection and cooldown are decided once, by `route()`, so model-level
 * filtering can never drift from assistant-level filtering (I-M4's rule applied
 * to filters). This function adds only the filters that are about a MODEL.
 */
export function recommendModel(
  deps: RecommendModelDeps,
  intent: TaskIntent,
  assistantFilters: RoutingExplanation['candidates'],
  /** The assistant this same routing decision chose, if any — see `SelectModelInput`. */
  chosenAssistantId?: AssistantId,
): ModelRecommendation {
  const now = deps.now ?? (() => new Date());
  const at = now();
  const classification = classifyTask(intent);
  const catalog = deps.catalog.list();
  const cohorts = modelCohorts(deps.db, { taskKind: classification.taskKind, harnessMajor: HARNESS_MAJOR, now });
  const failuresByAssistant = new Map(assistantFilters.map((c) => [String(c.assistantId), c.filterFailures]));

  // A workspace security policy that is about the RUN, not the model, but that
  // excludes every candidate when it bites: a read-only workspace may not
  // dispatch a task that will write to a repository.
  const securityFailure =
    deps.config.policy.approvalMode === 'read-only' && intent.repository
      ? 'security policy: the workspace approval mode is read-only and this task writes to a repository'
      : undefined;

  const candidates: ModelCandidateInput[] = [];
  for (const assistant of deps.registry.list()) {
    const manifest = assistant.manifestParsed;
    const assistantFailures = failuresByAssistant.get(assistant.id) ?? ['assistant was not evaluated by the router'];
    // No manifest = no advertised selector = no candidate to reason about. The
    // assistant's own failure is already recorded in the routing explanation.
    for (const model of manifest?.core.models ?? []) {
      const identity = resolveCandidateIdentity(deps.db, {
        assistantId: assistant.id,
        provider: assistant.provider,
        selector: model.id,
        catalog,
        now,
      });
      const entry = identity.resolvedModelKey
        ? catalog.find((e) => e.modelKey === identity.resolvedModelKey)
        : undefined;

      const filterFailures = [...assistantFailures];
      if (securityFailure) filterFailures.push(securityFailure);
      // Model compatibility: the selector must be one this assistant advertises.
      // (It is, by construction of this loop — the inverse case is the override
      // below, which names a selector nobody advertises.)
      if (intent.overrides?.assistantId && intent.overrides.assistantId !== assistant.id) {
        filterFailures.push(`excluded by the operator's explicit assistant override (${intent.overrides.assistantId})`);
      }
      if (intent.overrides?.model && intent.overrides.model !== model.id) {
        filterFailures.push(`excluded by the operator's explicit model override (${intent.overrides.model})`);
      }

      // Declared minimum context window. Unknown capacity is ADVISORY until the
      // task declares a minimum — then "we do not know" is not "big enough".
      const advisories: string[] = [];
      const capacity = entry?.contextWindowTokens?.value;
      const minContext = intent.requirements?.minContextTokens;
      if (minContext !== undefined) {
        if (capacity === undefined) {
          filterFailures.push(
            `context window unknown and the task declares a minimum of ${minContext} tokens`,
          );
        } else if (capacity < minContext) {
          filterFailures.push(
            `context window ${capacity} is below the task's declared minimum of ${minContext} tokens`,
          );
        }
      } else if (capacity === undefined) {
        advisories.push('context window unknown (advisory: the task declares no minimum)');
      }

      candidates.push({
        assistantId: assistant.id as AssistantId,
        provider: assistant.provider,
        selector: model.id,
        identity,
        filterFailures,
        advisories,
        evidence: gatherEvidence(entry, identity, cohorts, {
          servingProvider: assistant.provider,
          ...(deps.config.assistants[assistant.id]?.accountKind
            ? { accountKind: deps.config.assistants[assistant.id]!.accountKind! }
            : {}),
        }),
      });
    }
  }

  // An override that names a selector no assistant advertises must fail
  // truthfully rather than silently landing on something else, so it appears as
  // its own unavailable candidate.
  const override = intent.overrides?.model;
  if (override && !candidates.some((c) => c.selector === override)) {
    candidates.push({
      assistantId: (intent.overrides?.assistantId ?? 'unknown') as AssistantId,
      provider: 'unknown',
      selector: override,
      identity: { basis: 'unresolved', evidence: 'no configured assistant advertises this selector' },
      filterFailures: ['the operator named a model no configured assistant advertises'],
      advisories: [],
      evidence: {},
    });
  }

  return selectModel({
    classification,
    candidates,
    ...(override ? { userOverride: { selector: override, ...(intent.overrides?.assistantId ? { assistantId: intent.overrides.assistantId } : {}) } } : {}),
    activation: activationGate(deps, candidates, cohorts, at),
    ...(intent.overrides?.model ? { requestedModelSelector: intent.overrides.model } : {}),
    ...(chosenAssistantId ? { chosenAssistantId } : {}),
  });
}

// --- candidate identity -----------------------------------------------------

/**
 * Bind `assistant + runtime selector` to a catalog model identity, or refuse to.
 *
 * Two proofs are accepted, in order:
 *
 *  1. `catalog-exact` — the selector IS a model id the provider's own evidence
 *     established. Nothing to resolve.
 *  2. `observed-resolution` — this workspace's own runs on THIS assistant asked
 *     for THIS selector and the provider reported which model it served, and
 *     every such run agrees. That is a measurement, not an inference.
 *
 * An alias table is explicitly NOT a proof. `opus` is a moving CLI alias whose
 * meaning changes under us; binding it to today's catalog row is precisely the
 * historical-alias resolution I-M5 forbids, and it is how an AA reasoning-effort
 * or point-release score would end up attributed to a model it never described.
 * Unbound is a valid outcome: it yields `priorMissing`, never a guess.
 */
export function resolveCandidateIdentity(
  db: Db,
  input: {
    assistantId: string;
    provider: string;
    selector: string;
    catalog: ModelCatalogEntry[];
    now?: () => Date;
    windowDays?: number;
  },
): CandidateIdentity {
  const key = modelKey(input.provider, input.selector);
  const exact = input.catalog.find(
    // An entry established ONLY by external benchmark evidence cannot exist
    // (the catalog refuses it), so any hit here is provider/own evidence.
    (e) => e.modelKey === key,
  );
  if (exact) {
    return {
      basis: 'catalog-exact',
      resolvedModelKey: key,
      evidence: `the selector is a catalog model id for ${input.provider}, established by ${exact.provenance.source}`,
    };
  }

  const windowDays = input.windowDays ?? 30;
  const nowMs = (input.now?.() ?? new Date()).getTime();
  const since = new Date(nowMs - windowDays * 86_400_000).toISOString();
  const rows = db
    .prepare(
      `SELECT DISTINCT r.model_resolved AS model_resolved
         FROM runs r
        WHERE r.assistant_id = ? AND r.model_requested = ?
          AND r.model_resolved IS NOT NULL AND r.started_at >= ?`,
    )
    .all(input.assistantId, input.selector, since) as Array<{ model_resolved: string }>;

  if (rows.length === 1) {
    return {
      basis: 'observed-resolution',
      resolvedModelKey: modelKey(input.provider, rows[0]!.model_resolved),
      evidence:
        `this workspace's own runs on ${input.assistantId} requesting "${input.selector}" were all served as ` +
        `"${rows[0]!.model_resolved}" (provider-reported, last ${windowDays} days)`,
    };
  }
  if (rows.length > 1) {
    return {
      basis: 'unresolved',
      evidence:
        `"${input.selector}" resolved to ${rows.length} different models on ${input.assistantId} in the last ` +
        `${windowDays} days (${rows.map((r) => r.model_resolved).sort().join(', ')}) — an ambiguous selector carries no prior`,
    };
  }
  return {
    basis: 'unresolved',
    evidence:
      `"${input.selector}" is not a catalog model id for ${input.provider} and no run on ${input.assistantId} has ` +
      'reported what it resolves to; an alias is never resolved against today\'s catalog (I-M5)',
  };
}

// --- evidence gathering -----------------------------------------------------

/**
 * Attach the priors and own telemetry a bound candidate is entitled to. An
 * unbound candidate gets neither: external evidence about some other model is
 * not evidence about this one.
 */
function gatherEvidence(
  entry: ModelCatalogEntry | undefined,
  identity: CandidateIdentity,
  cohorts: Map<string, ModelCohort>,
  account: AccountIdentity,
): Partial<Record<TaskDimension, DimensionEvidence>> {
  const evidence: Partial<Record<TaskDimension, DimensionEvidence>> = {};
  for (const dimension of TASK_DIMENSIONS) evidence[dimension] = { priors: [] };
  if (!identity.resolvedModelKey) return evidence;

  // A candidate running under a non-default execution configuration is not the
  // thing the benchmark measured. K8 maps only base configurations, so any
  // declared execution setting withholds the prior rather than misattributing it.
  const configuredDifferently = Object.keys(identity.executionSettings ?? {}).length > 0;

  if (entry && !configuredDifferently) {
    for (const prior of entry.benchmarkPriors ?? []) {
      const target = evidence[prior.dimension];
      if (!target) continue;
      target.priors.push({
        value: prior.normalized,
        normalizationVersion: prior.normalizationVersion,
        provenance: prior.provenance,
        freshness: prior.freshness,
        raw: prior.raw,
      });
    }
    const costPrior = priceEvidencePrior(entry, account);
    if (costPrior) evidence.cost!.priors.push(costPrior);
  }

  const cohort = cohorts.get(identity.resolvedModelKey);
  if (cohort) {
    const coding = codingTelemetry(cohort);
    if ('telemetry' in coding) evidence.coding!.telemetry = coding.telemetry;
    else if (coding.withheld) evidence.coding!.telemetryWithheld = coding.withheld;
    const speed = speedTelemetry(cohort);
    if (speed) evidence.speed!.telemetry = speed;
    const cost = costTelemetry(cohort, entry, account);
    if (cost) evidence.cost!.telemetry = cost;
    else if (cohort.completedUsageRuns > 0) {
      evidence.cost!.telemetryWithheld =
        'own completed-task usage exists but no applicable K7 price row proves what it cost';
    }
  }
  return evidence;
}

/**
 * Who is actually being billed for this candidate's runs: the provider that
 * serves it, and the account kind the operator declared for that assistant.
 * `accountKind` absent = unproven, which is NOT a wildcard.
 */
interface AccountIdentity {
  servingProvider: string;
  accountKind?: string;
}

/**
 * Price applicability (§4.4.5). A tariff is evidence about a specific serving
 * provider and, usually, a specific kind of account — an Anthropic API price
 * says nothing about what a Claude subscription run costs. So a row is usable
 * only when it PROVES it applies here:
 *
 *  - `appliesTo` absent → applicability was never established. Not applicable.
 *  - `appliesTo.servingProvider` must equal the provider serving this candidate.
 *  - a row that declares an `accountKind` needs our account kind to be proven
 *    and equal; unknown account kind never matches an account-specific tariff.
 *
 * No applicable row is a valid outcome: the cost dimension then has no prior and
 * no telemetry, which is the honest answer, not a defect.
 */
export function priceApplicability(
  price: { appliesTo?: { servingProvider: string; accountKind?: string } },
  account: AccountIdentity,
): { applicable: boolean; reason: string } {
  const appliesTo = price.appliesTo;
  if (!appliesTo) {
    return { applicable: false, reason: 'the price row declares no appliesTo, so its applicability is not established' };
  }
  if (appliesTo.servingProvider !== account.servingProvider) {
    return {
      applicable: false,
      reason: `the price applies to serving provider ${appliesTo.servingProvider}, not ${account.servingProvider}`,
    };
  }
  if (appliesTo.accountKind !== undefined) {
    if (account.accountKind === undefined) {
      return {
        applicable: false,
        reason: `the price applies only to ${appliesTo.accountKind} accounts and this workspace has not proven its account kind`,
      };
    }
    if (appliesTo.accountKind !== account.accountKind) {
      return {
        applicable: false,
        reason: `the price applies to ${appliesTo.accountKind} accounts, not ${account.accountKind}`,
      };
    }
  }
  return {
    applicable: true,
    reason: `applies to ${appliesTo.servingProvider}${appliesTo.accountKind ? `/${appliesTo.accountKind}` : ''}`,
  };
}

/** Non-expired price rows proven to apply to this candidate's account, cheapest first. */
function applicablePrices(entry: ModelCatalogEntry, account: AccountIdentity) {
  return entry.pricing
    .filter((p) => p.freshness !== 'expired' && priceApplicability(p, account).applicable)
    .sort((a, b) => blendedPrice(a) - blendedPrice(b) || b.pricingVersion.localeCompare(a.pricingVersion));
}

/**
 * The cost PRIOR: K7 price evidence at a fixed reference mix. Artificial
 * Analysis also publishes prices; K8 deliberately does not read them and K13
 * deliberately does not accept them — a benchmark is never price authority.
 */
function priceEvidencePrior(entry: ModelCatalogEntry, account: AccountIdentity): DimensionPrior | undefined {
  // Deterministic pick: cheapest APPLICABLE non-expired row, then pricing
  // version, so two rows for the same model cannot flip the answer run to run.
  const price = applicablePrices(entry, account)[0];
  if (!price) return undefined;
  const perMtok = blendedPrice(price);
  const normalized = normalizeBenchmark({ value: perMtok, direction: 'lower', scaleMax: COST_SCALE_USD_PER_MTOK });
  if (normalized === undefined) return undefined;
  const provenance: Provenance = {
    ...price.provenance,
    source: COST_PRIOR_SOURCE,
    normalizationVersion: PRICE_NORMALIZATION_VERSION,
  };
  return {
    value: normalized,
    normalizationVersion: PRICE_NORMALIZATION_VERSION,
    provenance,
    freshness: price.freshness,
    raw: {
      metric: `blended price at ${COST_REFERENCE_MIX.input}/${COST_REFERENCE_MIX.output} input/output mix (${price.pricingVersion})`,
      value: perMtok,
      unit: `${price.currency}/Mtok`,
    },
  };
}

function blendedPrice(price: { inputPerMtok: number; outputPerMtok: number }): number {
  return COST_REFERENCE_MIX.input * price.inputPerMtok + COST_REFERENCE_MIX.output * price.outputPerMtok;
}

/**
 * The canonical coding metric is `success × test-pass × verification-pass`
 * (kernel-services §4.4.3) and there is no defined partial form of it. Omitting
 * an absent factor from the product is arithmetically identical to asserting it
 * is 1.0 — a perfect test-pass rate for a cohort that never ran a test — so a
 * cohort missing any factor yields NO coding telemetry and names what is
 * missing. The prior then carries the dimension alone, which is exactly what a
 * prior is for.
 */
function codingTelemetry(cohort: ModelCohort): { telemetry: DimensionTelemetry } | { withheld?: string } {
  if (cohort.reliabilityRuns === 0) return {};
  const missing = [
    ...(cohort.testPassRate === undefined ? ['test-pass'] : []),
    ...(cohort.verificationPassRate === undefined ? ['verification-pass'] : []),
  ];
  if (missing.length > 0) {
    return {
      withheld:
        `no coding telemetry: the canonical metric is success × test-pass × verification-pass and this cohort ` +
        `(${cohort.reliabilityRuns} run(s)) has no ${missing.join(' or ')} evidence — a missing factor is never treated as 1.0`,
    };
  }
  return {
    telemetry: {
      value: cohort.successRate * cohort.testPassRate! * cohort.verificationPassRate!,
      n: cohort.reliabilityRuns,
      metric: 'success × test-pass × verification-pass',
      cohort: cohortKey(cohort),
    },
  };
}

/**
 * Own output rate, normalized on the SAME absolute scale as the K8 speed prior
 * so the two are blendable at all. The metric name is explicit that this is a
 * whole-run wall-clock rate, which is not the provider-side generation rate the
 * benchmark measures — the difference is recorded, not hidden.
 */
function speedTelemetry(cohort: ModelCohort): DimensionEvidence['telemetry'] {
  if (cohort.outputRateRuns === 0 || cohort.medianOutputTokensPerSecond === undefined) return undefined;
  const value = normalizeBenchmark({
    value: cohort.medianOutputTokensPerSecond,
    direction: 'higher',
    scaleMax: AA_SPEED_SCALE_MAX,
  });
  if (value === undefined) return undefined;
  return {
    value,
    n: cohort.outputRateRuns,
    metric: `median own output tokens/s over run wall-clock (${cohort.medianOutputTokensPerSecond.toFixed(1)} tok/s)`,
    cohort: cohortKey(cohort),
  };
}

/**
 * Median cost per COMPLETED task: the cohort's own median usage over runs that
 * actually completed, priced with a K7 row proven applicable to this account.
 *
 * The completed-only sample is the point of the metric. A failed, timed-out or
 * cancelled run burns tokens without delivering a task, and a context-yield
 * predecessor is half of one task whose successor is billed again — averaging
 * any of them in would answer a different question than "what does this model
 * cost to finish a task like this?". With no applicable price row there is no
 * cost telemetry at all: an unpriced subscription run has no cost we can
 * honestly state (§4.4.5).
 */
function costTelemetry(
  cohort: ModelCohort,
  entry: ModelCatalogEntry | undefined,
  account: AccountIdentity,
): DimensionEvidence['telemetry'] {
  if (cohort.completedUsageRuns === 0 || !entry) return undefined;
  const price = applicablePrices(entry, account)[0];
  if (!price) return undefined;
  const inputTokens = cohort.medianInputTokens ?? 0;
  const outputTokens = cohort.medianOutputTokens ?? 0;
  if (inputTokens + outputTokens === 0) return undefined;
  const usd = (inputTokens * price.inputPerMtok + outputTokens * price.outputPerMtok) / 1_000_000;
  const value = normalizeBenchmark({ value: usd, direction: 'lower', scaleMax: COST_SCALE_USD_PER_TASK });
  if (value === undefined) return undefined;
  return {
    value,
    n: cohort.completedUsageRuns,
    metric: `median cost per completed task ($${usd.toFixed(4)} at pricing ${price.pricingVersion}, ${priceApplicability(price, account).reason})`,
    cohort: cohortKey(cohort),
  };
}

function cohortKey(cohort: ModelCohort) {
  return {
    resolvedModelKey: cohort.resolvedModelKey,
    taskKind: cohort.taskKind,
    harnessMajor: cohort.harnessMajor,
    windowDays: cohort.windowDays,
  };
}

// --- activation -------------------------------------------------------------

/**
 * Assemble the gate's inputs from durable state and evaluate it fail-closed.
 * Every input that cannot be proven is absent, and an absent input fails its
 * gate — so the default, on a workspace that has done nothing, is SHADOW.
 */
function activationGate(
  deps: RecommendModelDeps,
  candidates: ModelCandidateInput[],
  cohorts: Map<string, ModelCohort>,
  at: Date,
) {
  const selection = deps.config.models.selection;
  const atOrAboveK = candidates.filter((c) => {
    const cohort = c.identity.resolvedModelKey ? cohorts.get(c.identity.resolvedModelKey) : undefined;
    if (!cohort || c.filterFailures.length > 0) return false;
    return (
      cohort.reliabilityRuns >= DIMENSION_K.coding ||
      cohort.outputRateRuns >= DIMENSION_K.speed ||
      cohort.completedUsageRuns >= DIMENSION_K.cost
    );
  }).length;

  const shadowLog = deps.db
    .prepare(
      `SELECT MIN(at) AS since FROM routing_decisions
        WHERE json_extract(explanation, '$.modelRecommendation') IS NOT NULL`,
    )
    .get() as { since: string | null } | undefined;

  return evaluateActivationGate({
    configEnabled: selection.enabled,
    candidatesAtOrAboveK: atOrAboveK,
    ...(shadowLog?.since ? { shadowLogSince: shadowLog.since } : {}),
    ...(selection.shadowReviewedAt ? { shadowReviewedAt: selection.shadowReviewedAt } : {}),
    ...(selection.egressVerifiedAt ? { egressVerifiedAt: selection.egressVerifiedAt } : {}),
    // The audit covers the WHOLE shadow interval the gate is about, from the
    // first recorded recommendation to now — never a recent slice of it.
    hardFilterViolations: countHardFilterViolations(deps.db, shadowLog?.since ?? undefined),
    now: at,
  });
}

/**
 * Audit the shadow log for the one thing that must never have happened: a
 * recommendation naming a candidate that had failed a hard filter. It is
 * impossible by construction (`selectModel` scores only eligible candidates),
 * which is exactly why the gate checks the record rather than trusting the code.
 *
 * EVERY recommendation in the interval is audited. There is no row cap: a cap
 * makes the gate lossy rather than fail-closed — a violation would silently age
 * out of the window it is supposed to disqualify as soon as enough clean
 * decisions were recorded after it. Efficiency comes from doing the whole check
 * in SQL (`json_each` over each recommendation's candidates, no row leaves the
 * database) rather than from looking at fewer rows.
 */
export function countHardFilterViolations(db: Db, since?: string): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS violations FROM routing_decisions rd
        WHERE json_extract(rd.explanation, '$.modelRecommendation.recommended') IS NOT NULL
          AND (? IS NULL OR rd.at >= ?)
          AND NOT EXISTS (
            SELECT 1 FROM json_each(rd.explanation, '$.modelRecommendation.candidates') c
             WHERE json_extract(c.value, '$.label')
                   = json_extract(rd.explanation, '$.modelRecommendation.recommended')
               AND json_array_length(json_extract(c.value, '$.filterFailures')) = 0
          )`,
    )
    .get(since ?? null, since ?? null) as { violations: number };
  return row.violations;
}
