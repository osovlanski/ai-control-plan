/**
 * runComposer: stages 1 to 6 in order (plans/m2-composer.md §2). Pure apart from its two ports:
 * equal inputs and equal port answers give byte-equal canonical JSON (§4). A stage never throws
 * for a missing dependency; it records the reason, and the pipeline stops with that outcome.
 * An override on stage k replaces that stage's `chosen`, and stages k+1..6 recompute from it.
 */
import { COMPOSER_STAGES, COMPOSITION_SCHEMA_VERSION, type ComposerStage } from "../composition-types.js";
import { assetsStage, type RendererExclusion } from "./assets.js";
import { contextFailureStage, contextPlan, contextStage, isBundleHarness } from "./context.js";
import { jcs } from "../canonical-json.js";
import { buildDecision, compositionDigest, notRun, sha256Digest, type RawStage } from "./explain.js";
import { harnessModelStage } from "./harness-model.js";
import { intentStage } from "./intent.js";
import { policyStage } from "./policy.js";
import { createTextGuard } from "./text-guard.js";
import type {
  AgentSpecDraft, BundlePortResult, BundleRenderDraft, ComposeResult, ComposerDeps, ComposerInputs, ComposerOutcome, ComposerPorts,
} from "./types.js";

/** Renders per composition: the first, and one more after the renderer excludes a selected skill. */
export const MAX_RENDERS = 2;

/**
 * §4.2: the digest of everything the pipeline reads from its inputs, for the attempt row. Port
 * answers are not inputs; the decision records what they said.
 */
export function composerInputsDigest(inputs: ComposerInputs, deps: ComposerDeps): string {
  return sha256Digest(deps, jcs(inputs, "finite"));
}

export async function runComposer(inputs: ComposerInputs, ports: ComposerPorts, deps: ComposerDeps): Promise<ComposeResult> {
  const guard = createTextGuard(inputs.forbiddenHostnames);
  const stages: RawStage[] = [];
  const stop = (outcome: Exclude<ComposerOutcome, { status: "composed" }>, at: ComposerStage): ComposeResult => {
    const label = outcome.status === "skipped" ? `skipped (${outcome.reason})` : `${outcome.reason}`;
    for (const stage of COMPOSER_STAGES.slice(COMPOSER_STAGES.indexOf(at) + 1)) stages.push(notRun(stage, `not run: pipeline stopped at ${at} (${label})`));
    return { outcome, decision: buildDecision(stages, guard) };
  };
  const refusal = (detail: string, at: ComposerStage) => stop({ status: "failed", reason: "override_refused", detail }, at);

  // Stage 1.
  const intent = intentStage(inputs);
  stages.push(intent.stage);
  if (intent.refused) return refusal(intent.refused, "intent");

  // Stage 2.
  const harnessModel = await harnessModelStage(inputs, intent.intent, ports.harnessModel);
  stages.push(harnessModel.stage);
  const choice = harnessModel.chosen;
  if (!choice) return stop({ status: "failed", reason: "no_candidate" }, "harness_model");

  // Stage 3, and stage 4's render, with at most one re-run of stage 3 (bundle v1 §Finalization).
  const plan = contextPlan(inputs);
  const excluded: RendererExclusion[] = [];
  let assets = assetsStage(inputs, intent.intent, choice.harness, excluded);
  const assetsAt = () => stages.push(assets.stage);
  if (assets.refused) { assetsAt(); return refusal(assets.refused, "assets"); }
  if (plan.refused) { assetsAt(); stages.push(contextFailureStage(plan, `override refused: ${plan.refused}`)); return refusal(plan.refused, "context"); }

  const harness = choice.harness;
  if (!isBundleHarness(harness)) {
    assetsAt();
    stages.push(contextFailureStage(plan, `bundle v1 renders claude-code and codex only; harness ${harness} is route-only`));
    return stop({ status: "skipped", reason: "unsupported_harness" }, "context");
  }
  const registry = inputs.registry;
  if (registry.status !== "ok") {
    assetsAt();
    const reason = registry.status === "off" ? "disabled" : registry.reason;
    stages.push(contextFailureStage(plan, `no bundle: ${reason}`));
    return reason === "unsupported_harness"
      ? stop({ status: "skipped", reason }, "context")
      : stop({ status: "failed", reason }, "context");
  }

  const draft = (): BundleRenderDraft => ({
    schema_version: COMPOSITION_SCHEMA_VERSION,
    task_id: inputs.task.id,
    intent: intent.intent,
    harness,
    model: { primary: { id: choice.modelId }, fallbacks: [] },
    registry: { snapshot_digest: registry.snapshotDigest, observed_at: registry.observedAt, stale: registry.stale },
    assets: { skills: assets.skills, mcp_servers: assets.mcpServers, subagents: [] },
    context: { fragments: plan.fragments, memory_bundles: plan.memoryBundles.map(({ id, digest, reason }) => ({ id, digest, reason })) },
  });
  const options = { charsPerToken: plan.charsPerToken, tokenBudget: plan.tokenBudget };
  let rendered: BundlePortResult = await ports.bundle.render(draft(), options);
  let renders = 1;
  if (rendered.status === "not_final") {
    const requested = new Set(assets.skills.map((s) => s.id));
    for (const e of rendered.excludedSkills) if (requested.has(e.ref) && !excluded.some((x) => x.ref === e.ref)) excluded.push({ ref: e.ref, reason: e.reason });
    if (excluded.length === 0) {
      // Cockpit excluded nothing we asked for: re-rendering the same request cannot converge.
      assetsAt();
      stages.push(contextFailureStage(plan, "no bundle: the renderer excluded a skill that was not requested"));
      return stop({ status: "failed", reason: "invalid_response" }, "context");
    }
    assets = assetsStage(inputs, intent.intent, harness, excluded);
    if (assets.refused) { assetsAt(); return refusal(assets.refused, "assets"); }
    rendered = await ports.bundle.render(draft(), options);
    renders += 1;
  }
  assetsAt();
  if (rendered.status === "not_final") {
    stages.push(contextFailureStage(plan, `no bundle: the renderer still excluded a selected skill after ${MAX_RENDERS} renders; Cockpit and the plane disagree on the allowlist`));
    return stop({ status: "failed", reason: "not_final" }, "context");
  }
  if (rendered.status === "failure") {
    stages.push(contextFailureStage(plan, `no bundle: ${rendered.reason}`));
    return rendered.reason === "unsupported_harness"
      ? stop({ status: "skipped", reason: "unsupported_harness" }, "context")
      : stop({ status: "failed", reason: rendered.reason }, "context");
  }
  const { request, response } = rendered;
  stages.push(contextStage(plan, response, renders, harness, choice.modelId));

  // Stage 5. The adapter's `prepare` (no write) predicts the profile the revision binds (M3 S2).
  const composedContext = {
    ...draft().context,
    bundle_digest: response.manifest.bundleDigest,
    compiler: {
      name: response.manifest.compiler.name,
      version: response.manifest.compiler.version,
      tokens: response.manifest.tokens.estimated,
      token_method: response.manifest.tokens.tokenMethod,
      chars_per_token: response.manifest.tokens.charsPerToken,
    },
  };
  // Stage 3 kept only MCP servers whose launch shape it read from this snapshot.
  const launches = new Map(registry.assets.map((a) => [a.id, a]));
  const mcpServers = assets.mcpServers.map((ref) => ({ ref, launch: launches.get(ref.id)!.mcp! }));
  const prediction = ports.provisioning
    ? await ports.provisioning.predict({ assistantId: choice.assistantId, spec: { ...draft(), context: composedContext }, bundle: response, mcpServers })
    : { status: "unavailable" as const, reason: "no provisioning port" };
  const policy = policyStage(inputs, intent.intent, intent.computed, choice, deps, prediction);
  stages.push(policy.stage);
  if (policy.refused) return refusal(policy.refused, "policy");
  if (policy.failure || !policy.policy || !policy.provisioning) return stop({ status: "failed", reason: policy.failure ?? "policy_unenforceable" }, "policy");

  const specDraft: AgentSpecDraft = {
    ...draft(),
    context: composedContext,
    policy: policy.policy,
    provisioning: policy.provisioning,
  };

  // Stage 6. The digest excludes it, so the confirm entry can name the digest it confirms.
  const preliminary = buildDecision([...stages, notRun("confirm", "awaiting confirmation")], guard);
  const digest = compositionDigest(preliminary, specDraft, deps);
  const confirm = inputs.confirm;
  stages.push(confirm.mode === "preview"
    ? { stage: "confirm", candidates: [{ ref: "start" }], filters: [], chosen: [], why: "awaiting confirmation" }
    : {
      stage: "confirm", candidates: [{ ref: "start" }], filters: [], chosen: ["start"],
      why: confirm.origin === "operator" ? `operator confirmed ${digest}` : `${confirm.origin} dispatch; intent confirmed at creation`,
    });
  return { outcome: { status: "composed" }, decision: buildDecision(stages, guard), specDraft, bundle: { request, response }, compositionDigest: digest };
}
