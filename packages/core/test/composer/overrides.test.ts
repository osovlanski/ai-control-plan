import { describe, expect, it } from "vitest";
import { COMPOSER_STAGES, jcs, runComposer, type ComposerInputs, type ComposerOverrides } from "../../src/index.js";
import { baseInputs, deps, expectValid, fakeBundle, fakeHarnessModel, projection, skill, stageOf } from "./helpers.js";

const compose = (overrides?: ComposerOverrides, inputs: ComposerInputs = baseInputs()) => {
  const base = projection();
  const harness = fakeHarnessModel((req) => req.override?.model
    ? { ...base, ruleFired: "user-override", chosen: { ...base.chosen!, modelId: req.override.model, modelSource: "intent-override" } }
    : base);
  return runComposer({ ...inputs, ...(overrides ? { overrides } : {}) }, { harnessModel: harness, bundle: fakeBundle() }, deps);
};

const index = (stage: (typeof COMPOSER_STAGES)[number]) => COMPOSER_STAGES.indexOf(stage);

describe("overrides: stage k replaces chosen, k+1.. recompute, earlier stages never move", () => {
  const docs = skill("docs", { tags: ["content"] });
  const reg = baseInputs().registry as Extract<ComposerInputs["registry"], { status: "ok" }>;
  const inputs = baseInputs({ registry: { ...reg, assets: [...reg.assets, docs] }, config: { ...baseInputs().config, allowlist: [...baseInputs().config.allowlist, { id: docs.id, digest: docs.digest }] } });

  it.each<[string, ComposerOverrides, (typeof COMPOSER_STAGES)[number]]>([
    ["intent", { intent: { kind: "content", domains: [] } }, "intent"],
    ["harness_model", { harness_model: { model: "example-model-small" } }, "harness_model"],
    ["assets", { assets: { add: [docs.id], remove: ["claude-skills:pr-writer"] } }, "assets"],
    ["context", { context: { fragments: ["typescript-style"] } }, "context"],
    ["policy", { policy: { permission: "prompt-on-escalation" } }, "policy"],
  ])("%s", async (_name, overrides, stage) => {
    const plain = await compose(undefined, inputs);
    const over = await compose(overrides, inputs);
    expect(over.outcome).toEqual({ status: "composed" });
    expectValid(over);
    const k = index(stage);
    // Earlier stages are byte-identical.
    expect(jcs(over.decision.stages.slice(0, k))).toBe(jcs(plain.decision.stages.slice(0, k)));
    // The overridden stage records from = the un-overridden chosen, to = chosen.
    const s = over.decision.stages[k]!;
    expect(s.override).not.toBeNull();
    expect(s.override!.from).toEqual(plain.decision.stages[k]!.chosen);
    expect(s.override!.to).toEqual(s.chosen);
    expect(s.override!.actor).toBe("operator");
    expect(s.why).toMatch(/^operator override; pipeline chose /);
    // No other stage carries an override.
    over.decision.stages.forEach((x, i) => { if (i !== k) expect(x.override).toBeNull(); });
    expect(over.compositionDigest).not.toBe(plain.compositionDigest);
  });

  it("an intent override recomputes the assets stage from the new intent", async () => {
    const over = await compose({ intent: { kind: "content", domains: [] } }, inputs);
    expect(stageOf(over, "assets").chosen).toEqual([docs.id]);
    expect(over.specDraft!.intent).toEqual({ kind: "content", domains: [], complexity: "M", risk: "normal" });
  });

  it("a harness_model override reaches the bundle request", async () => {
    const over = await compose({ harness_model: { model: "example-model-small" } }, inputs);
    expect(over.bundle!.request.model.id).toBe("example-model-small");
    expect(over.specDraft!.model.primary.id).toBe("example-model-small");
  });

  it.each<[string, ComposerOverrides]>([
    ["loosening permission", { policy: { permission: "auto" } }],
    ["raising a cap", { policy: { budget: { max_tokens: 900000 } } }],
    ["attaching an unallowlisted asset", { assets: { add: ["claude-skills:not-there"] } }],
    ["a bad fragment name", { context: { fragments: ["Bad Name"] } }],
  ])("%s is refused: failed override_refused, nothing composed", async (_name, overrides) => {
    const strict = baseInputs({ workspacePolicy: { ...baseInputs().workspacePolicy, approvalMode: "prompt-on-escalation" } });
    const r = await compose(overrides, strict);
    expect(r.outcome).toMatchObject({ status: "failed", reason: "override_refused" });
    expect((r.outcome as { detail?: string }).detail).toBeTruthy();
    expect(r.specDraft).toBeUndefined();
    expectValid(r);
  });

  it("lowering a high risk to escape the risk map is refused", async () => {
    const risky = baseInputs({ task: { id: "AG-0042", goal: "deploy to production", constraints: [], storedKind: "coding" } });
    const r = await compose({ intent: { risk: "low" } }, risky);
    expect(r.outcome).toMatchObject({ status: "failed", reason: "override_refused" });
  });
});
