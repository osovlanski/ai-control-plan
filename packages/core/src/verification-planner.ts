import type { VerificationKind } from "./events.js";
import type { VerificationDecision, VerificationPlan, VerificationSpec } from "./execution.js";

export interface VerificationCapability extends VerificationSpec {
  checkId: string;
}

export interface VerificationPlanningInput {
  changedFiles: string[];
  acceptanceCriteria?: string[];
  taskMetadata?: { frontend?: boolean; api?: boolean; evaluation?: boolean; review?: boolean };
  explicitRequiredKinds?: VerificationKind[];
  /** Ordered, trusted operator/repository registry; commands are never accepted from task text. */
  capabilities: VerificationCapability[];
}

const FRONTEND_FILE = /\.(tsx|jsx|vue|svelte|css|scss|sass|less|html)$/i;
const FRONTEND_COMPONENT = /(^|\/)(components?|views?|screens?|styles?)\//i;
const API_FILE = /(^|\/)(api|routes?|controllers?|handlers?|openapi|swagger)(\/|\.|-)/i;
const API_SCHEMA = /(^|\/).*(openapi|swagger).*(\.ya?ml|\.json)$/i;
const API_CONTRACT = /\.(graphql|gql|proto|sql)$/i;
const SOURCE_FILE = /\.(tsx?|jsx?|mjs|cjs|py|rb|go|rs|java|kt|cs|php)$/i;
const TYPESCRIPT_FILE = /\.(ts|tsx)$/i;

function criteriaText(input: VerificationPlanningInput): string {
  return (input.acceptanceCriteria ?? []).join("\n").toLowerCase();
}

function capabilityIdentity(capability: VerificationCapability): string {
  return JSON.stringify({
    checkId: capability.checkId,
    kind: capability.kind,
    name: capability.name,
    provider: capability.provider ?? null,
    command: capability.command ?? null,
  });
}

function signalsFor(
  capability: VerificationCapability,
  input: VerificationPlanningInput,
  explicitChoices: ReadonlyMap<VerificationKind, string>,
): string[] {
  const kind = capability.kind;
  const files = input.changedFiles;
  const criteria = criteriaText(input);
  const signals: string[] = [];
  if (explicitChoices.get(kind) === capability.checkId) signals.push(`explicit:${kind}`);

  if (kind === "tests" && files.some((file) => SOURCE_FILE.test(file))) signals.push("changed:source");
  if (kind === "typecheck" && files.some((file) => TYPESCRIPT_FILE.test(file))) signals.push("changed:typescript");
  if (kind === "lint" && files.some((file) => SOURCE_FILE.test(file))) signals.push("changed:source");
  if (
    kind === "browser" &&
    (input.taskMetadata?.frontend ||
      files.some((file) => FRONTEND_FILE.test(file) || FRONTEND_COMPONENT.test(file)) ||
      /\b(ui|browser|page|screen|layout|visual|responsive|accessibility)\b/.test(criteria))
  ) signals.push("impact:frontend");
  if (
    kind === "api" &&
    (input.taskMetadata?.api ||
      files.some((file) => API_FILE.test(file) || API_SCHEMA.test(file) || API_CONTRACT.test(file)) ||
      /\b(api|endpoint|http|openapi|graphql|rpc|request|response|status code|migration)\b/.test(criteria))
  ) signals.push("impact:api");
  if (kind === "evaluator" && input.taskMetadata?.evaluation) signals.push("metadata:evaluation");
  if (kind === "review" && input.taskMetadata?.review) signals.push("metadata:review");
  return [...new Set(signals)].sort();
}

/** Pure, deterministic selection. Capability order is preserved in the resulting plan. */
export function planVerification(input: VerificationPlanningInput): VerificationPlan {
  const ids = new Set<string>();
  for (const capability of input.capabilities) {
    if (ids.has(capability.checkId)) throw new Error(`duplicate verification checkId: ${capability.checkId}`);
    ids.add(capability.checkId);
  }
  const availableKinds = new Set(input.capabilities.map((capability) => capability.kind));
  const explicitChoices = new Map<VerificationKind, string>();
  for (const kind of input.explicitRequiredKinds ?? []) {
    const capability = input.capabilities.find((candidate) => candidate.kind === kind);
    if (capability && !explicitChoices.has(kind)) explicitChoices.set(kind, capability.checkId);
  }
  const unmetRequirements = [...new Set(input.explicitRequiredKinds ?? [])]
    .filter((kind) => !availableKinds.has(kind))
    .sort();
  const decisions: VerificationDecision[] = input.capabilities.map((capability) => {
    const signals = signalsFor(capability, input, explicitChoices);
    return {
      checkId: capability.checkId,
      capabilityIdentity: capabilityIdentity(capability),
      selected: signals.length > 0,
      required: capability.required || explicitChoices.get(capability.kind) === capability.checkId,
      signals,
      reason: signals.length > 0 ? signals.join(", ") : "no matching deterministic signal",
    };
  });
  const byId = new Map(decisions.map((decision) => [decision.checkId, decision]));
  const checks = input.capabilities
    .filter((capability) => byId.get(capability.checkId)?.selected)
    .map((capability) => ({
      ...capability,
      required: byId.get(capability.checkId)!.required,
    }));
  return {
    schemaVersion: 1,
    checks,
    decisions,
    ...(unmetRequirements.length > 0 ? { unmetRequirements } : {}),
  };
}

/** Post-change revision may add checks, but never silently removes an earlier selection. */
export function reviseVerificationPlan(
  original: VerificationPlan,
  revised: VerificationPlan,
): VerificationPlan {
  const previouslyUnmet = new Set(original.unmetRequirements ?? []);
  const checks = new Map(original.checks.map((check) => [check.checkId, check]));
  for (const check of revised.checks) {
    const prior = checks.get(check.checkId);
    if (!prior) {
      checks.set(check.checkId, {
        ...check,
        required: check.required || previouslyUnmet.has(check.kind),
      });
      continue;
    }
    if (
      prior.kind !== check.kind ||
      prior.name !== check.name ||
      prior.command !== check.command ||
      prior.provider !== check.provider
    ) throw new Error(`verification check identity changed during revision: ${check.checkId}`);
    checks.set(check.checkId, { ...prior, required: prior.required || check.required });
  }
  const decisions = new Map(original.decisions.map((decision) => [decision.checkId, decision]));
  for (const decision of revised.decisions) {
    const prior = decisions.get(decision.checkId);
    if (!prior) {
      decisions.set(decision.checkId, decision);
      continue;
    }
    if (
      prior.capabilityIdentity !== undefined &&
      decision.capabilityIdentity !== undefined &&
      prior.capabilityIdentity !== decision.capabilityIdentity
    ) throw new Error(`verification capability identity changed during revision: ${decision.checkId}`);
    const signals = [...new Set([...prior.signals, ...decision.signals])].sort();
    decisions.set(decision.checkId, {
      ...prior,
      selected: prior.selected || decision.selected,
      required: prior.required || decision.required,
      signals,
      reason: signals.length > 0 ? signals.join(", ") : prior.reason,
    });
  }
  for (const check of checks.values()) {
    if (!check.required) continue;
    const decision = decisions.get(check.checkId);
    if (decision) decisions.set(check.checkId, { ...decision, required: true });
  }
  const unmetRequirements = [...new Set([
    ...(original.unmetRequirements ?? []),
    ...(revised.unmetRequirements ?? []),
  ])]
    .filter((kind) => ![...checks.values()].some((check) => check.kind === kind && check.required))
    .sort();
  return {
    schemaVersion: 1,
    checks: [...checks.values()],
    decisions: [...decisions.values()],
    ...(unmetRequirements.length > 0 ? { unmetRequirements } : {}),
  };
}
