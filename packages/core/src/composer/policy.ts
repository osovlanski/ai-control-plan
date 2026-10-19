/**
 * Stage 5, policy and budget (plans/m2-composer.md §2 stage 5, §5).
 *
 * Permission only tightens: it is the stricter of the workspace approval mode and the risk map.
 * When the chosen harness refuses that mode the attempt fails `policy_unenforceable`; the Composer
 * never loosens permission to make a route work. An override may only tighten permission or a
 * cap. The budget is the task cap minus what the task consumed. Provisioning is `ambient` in M2,
 * so the workspace must permit ambient (invariant 3).
 */
import { jcs } from "../canonical-json.js";
import type { AgentSpec, CompositionPermission } from "../composition-types.js";
import { remainingBudget, roundUsd } from "./accounting.js";
import { byCodeUnit, overrideWhy, sha256Digest, sortedUnique, type RawCandidate, type RawFilter, type RawStage } from "./explain.js";
import type { ApprovalMode, BudgetCaps, ComposedIntent, ComposerDeps, ComposerInputs, HarnessModelChoice, IntentRisk } from "./types.js";

const STRICTNESS: Readonly<Record<CompositionPermission, number>> = { auto: 0, "prompt-on-escalation": 1, "read-only": 2 };
export const PERMISSIONS: readonly CompositionPermission[] = ["auto", "prompt-on-escalation", "read-only"];

/** Config `auto-approve` is spec `auto`; the other two modes keep their names. */
export const toPermission = (mode: ApprovalMode): CompositionPermission => (mode === "auto-approve" ? "auto" : mode);
export const toApprovalMode = (permission: CompositionPermission): ApprovalMode => (permission === "auto" ? "auto-approve" : permission);
const stricter = (a: CompositionPermission, b: CompositionPermission | undefined) => (b !== undefined && STRICTNESS[b] > STRICTNESS[a] ? b : a);

export type PolicyFailure = "policy_unenforceable" | "isolation_unavailable" | "budget_exhausted";

export interface PolicyStageResult {
  stage: RawStage;
  policy?: AgentSpec["policy"];
  provisioning?: AgentSpec["provisioning"];
  failure?: PolicyFailure;
  refused?: string;
}

/** The canonical workspace policy document whose sha256 is `policy.revision.digest`. */
export function policyDocument(inputs: ComposerInputs) {
  const risk = inputs.config.policy.riskPermission;
  return {
    approval_mode: inputs.workspacePolicy.approvalMode,
    allowlist: [...inputs.config.allowlist].map(({ id, digest }) => ({ id, digest })).sort((a, b) => byCodeUnit(a.id, b.id) || byCodeUnit(a.digest, b.digest)),
    risk_permission: Object.fromEntries((["low", "normal", "high"] as const).flatMap((r) => (risk[r] ? [[r, risk[r]]] : []))),
    permit_ambient: inputs.config.policy.permitAmbient,
    budget: { ...inputs.config.budget },
    tool_allowlist: sortedUnique(inputs.workspacePolicy.toolAllowlist),
  };
}

function permissionFor(inputs: ComposerInputs, risk: IntentRisk): { permission: CompositionPermission; riskMode?: ApprovalMode } {
  const riskMode = inputs.config.policy.riskPermission[risk];
  return { permission: stricter(toPermission(inputs.workspacePolicy.approvalMode), riskMode ? toPermission(riskMode) : undefined), ...(riskMode ? { riskMode } : {}) };
}

const isPositiveInteger = (n: unknown) => typeof n === "number" && Number.isSafeInteger(n) && n >= 1;
const isPositiveFinite = (n: unknown) => typeof n === "number" && Number.isFinite(n) && n > 0;

/** An override's caps, checked to only tighten. */
function tightenedCaps(caps: BudgetCaps, override: BudgetCaps | undefined): { caps: BudgetCaps; refused?: string } {
  if (!override) return { caps };
  const next: BudgetCaps = { ...caps };
  for (const key of ["max_tokens", "max_runtime_ms", "max_cost_usd"] as const) {
    const value = override[key];
    if (value === undefined) continue;
    const valid = key === "max_cost_usd" ? isPositiveFinite(value) : isPositiveInteger(value);
    if (!valid) return { caps, refused: `budget override ${key} must be a positive ${key === "max_cost_usd" ? "number" : "integer"}` };
    const cap = caps[key];
    if (cap !== undefined && value > cap) return { caps, refused: `budget override ${key} ${value} would raise the cap ${cap}; overrides only tighten` };
    next[key] = value;
  }
  return { caps: next };
}

const capRefs = (remaining: BudgetCaps) => [
  ...(remaining.max_tokens !== undefined ? [`max_tokens:${remaining.max_tokens}`] : []),
  ...(remaining.max_runtime_ms !== undefined ? [`max_runtime_ms:${remaining.max_runtime_ms}`] : []),
  ...(remaining.max_cost_usd !== undefined ? [`max_cost_usd:${remaining.max_cost_usd}`] : []),
];

export function policyStage(
  inputs: ComposerInputs,
  intent: ComposedIntent,
  computedIntent: ComposedIntent,
  choice: HarnessModelChoice,
  deps: ComposerDeps,
): PolicyStageResult {
  const { config, consumed, workspacePolicy } = inputs;
  const override = inputs.overrides?.policy;
  const baseline = permissionFor(inputs, computedIntent.risk);
  const actual = permissionFor(inputs, intent.risk);
  const workspace = toPermission(workspacePolicy.approvalMode);

  const permissionCandidates: RawCandidate[] = PERMISSIONS.map((p) => ({
    ref: `permission:${p}`,
    evidence: [
      ...(p === workspace ? [`workspace approval mode ${workspacePolicy.approvalMode}`] : []),
      ...(actual.riskMode && toPermission(actual.riskMode) === p ? [`risk ${intent.risk} maps to ${actual.riskMode}`] : []),
    ],
  }));
  const refuse = (detail: string): PolicyStageResult => ({
    stage: { stage: "policy", candidates: permissionCandidates, filters: [], chosen: [], why: `override refused: ${detail}` },
    refused: detail,
  });

  // A lowered intent risk must not loosen what the pipeline's own risk would have required.
  if (STRICTNESS[actual.permission] < STRICTNESS[baseline.permission]) {
    return refuse(`intent risk override ${computedIntent.risk} -> ${intent.risk} would loosen permission ${baseline.permission} to ${actual.permission}`);
  }
  if (override?.permission !== undefined) {
    if (STRICTNESS[override.permission] === undefined) return refuse("permission override is not a composition permission");
    if (STRICTNESS[override.permission] < STRICTNESS[actual.permission]) {
      return refuse(`permission override ${override.permission} would loosen ${actual.permission}; overrides only tighten`);
    }
  }
  const tightened = tightenedCaps(config.budget, override?.budget);
  if (tightened.refused) return refuse(tightened.refused);
  const permission = override?.permission ?? actual.permission;

  const computedBudget = remainingBudget(config.budget, consumed);
  const budget = remainingBudget(tightened.caps, consumed);
  const tokensEnforcement = choice.usageReporting
    ? `tokens: bounded (${choice.assistantId} declares usage reporting)`
    : `tokens: advisory (${choice.assistantId} declares no usage reporting)`;
  const unknownCost = consumed.unknownCostSessions > 0 ? [`consumed cost unknown for ${consumed.unknownCostSessions} sessions; not subtracted`] : [];
  const capCandidates = (caps: BudgetCaps, remaining: BudgetCaps): RawCandidate[] => [
    ...(remaining.max_tokens !== undefined
      ? [{ ref: `max_tokens:${remaining.max_tokens}`, evidence: [tokensEnforcement, `task cap ${caps.max_tokens}, consumed ${consumed.tokens}, remaining ${remaining.max_tokens}`] }]
      : []),
    ...(remaining.max_runtime_ms !== undefined ? [{ ref: `max_runtime_ms:${remaining.max_runtime_ms}`, evidence: ["runtime: hard (local clock)"] }] : []),
    ...(remaining.max_cost_usd !== undefined
      ? [{
        ref: `max_cost_usd:${remaining.max_cost_usd}`,
        evidence: [
          "cost: advisory until deferral #3 closes",
          choice.price ? `price evidence ${choice.price.pricingVersion}` : "no price evidence; cost is not computed",
          `task cap ${caps.max_cost_usd}, consumed ${roundUsd(consumed.costUsd)}, remaining ${remaining.max_cost_usd}`,
          ...unknownCost,
        ],
      }]
      : []),
  ];
  const ambient = config.policy.permitAmbient;
  const provisioningCandidate: RawCandidate = {
    ref: "provisioning:ambient",
    evidence: [ambient ? "isolation: ambient (M3 not shipped; workspace permits ambient)" : "isolation: unavailable (M3 not shipped; workspace does not permit ambient)"],
  };
  const permissionRef = `permission:${permission}`;
  const refused = !choice.acceptedApprovalModes.includes(toApprovalMode(permission));
  if (refused) permissionCandidates.find((c) => c.ref === permissionRef)!.evidence = [
    ...(permissionCandidates.find((c) => c.ref === permissionRef)!.evidence ?? []),
    `harness ${choice.harness} (${choice.assistantId}) does not enforce ${toApprovalMode(permission)}`,
  ];
  const candidates = [...permissionCandidates, ...capCandidates(config.budget, computedBudget.remaining), ...capCandidates(tightened.caps, budget.remaining), provisioningCandidate];

  const filters: RawFilter[] = [
    ...(refused ? [{ filter: "harness_refuses", removed: [permissionRef], reason: `harness ${choice.harness} refuses approval mode ${toApprovalMode(permission)}` }] : []),
    ...(!ambient ? [{ filter: "isolation_unavailable", removed: ["provisioning:ambient"], reason: "nothing provisions isolation until M3 and the workspace does not permit ambient" }] : []),
    ...(budget.exhausted.length
      ? [{ filter: "budget_exhausted", removed: capRefs(budget.remaining).filter((r) => budget.exhausted.some((k) => r.startsWith(`${k}:`))), reason: "the task has no budget remaining under its cap" }]
      : []),
  ];
  const failure: PolicyFailure | undefined = refused ? "policy_unenforceable" : !ambient ? "isolation_unavailable" : budget.exhausted.length ? "budget_exhausted" : undefined;

  const permissionWhy = `permission ${permission} (stricter of workspace ${workspacePolicy.approvalMode} and risk ${intent.risk} -> ${actual.riskMode ?? "no risk-map entry"}${override?.permission ? `; tightened by override from ${actual.permission}` : ""})`;
  const why = [
    permissionWhy,
    `tools: ${workspacePolicy.toolAllowlist.length ? sortedUnique(workspacePolicy.toolAllowlist).join(", ") : "none listed; the approval mode governs"}`,
    `budget: ${capRefs(budget.remaining).join(", ") || "no caps"}`,
    ...(budget.remaining.max_cost_usd !== undefined && !choice.price ? ["no price evidence; cost is not computed"] : []),
    ambient ? "provisioning ambient (M3 not shipped; workspace permits ambient)" : "isolation unavailable: the workspace does not permit ambient",
    ...(failure ? [`failed: ${failure}`] : []),
  ].join("; ");

  const computedChosen = [`permission:${actual.permission}`, ...capRefs(computedBudget.remaining), "provisioning:ambient"];
  const chosen = failure ? [] : [permissionRef, ...capRefs(budget.remaining), "provisioning:ambient"];
  const overridden = override !== undefined && (override.permission !== undefined || override.budget !== undefined);
  const stage: RawStage = {
    stage: "policy", candidates, filters, chosen,
    why: overridden ? overrideWhy(computedChosen, why) : why,
    ...(overridden ? { override: { from: computedChosen, to: chosen } } : {}),
  };
  if (failure) return { stage, failure };
  return {
    stage,
    policy: {
      revision: { id: workspacePolicy.policyId, digest: sha256Digest(deps, jcs(policyDocument(inputs), "finite")) },
      permission,
      tool_allowlist: sortedUnique(workspacePolicy.toolAllowlist),
      budget: budget.remaining,
    },
    provisioning: { requested: "ambient" },
  };
}
