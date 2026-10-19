import { describe, expect, it } from "vitest";
import { jcs, runComposer, type ComposerInputs } from "../../src/index.js";
import { baseInputs, deps, fakeBundle, fakeHarnessModel, projection, skill, stageOf, expectValid, type RenderPlan } from "./helpers.js";

const run = (inputs: ComposerInputs = baseInputs(), plans: RenderPlan[] = [{}], harness = fakeHarnessModel()) => {
  const bundle = fakeBundle(...plans);
  return runComposer(inputs, { harnessModel: harness, bundle }, deps).then((result) => ({ result, bundle, harness }));
};

describe("runComposer: outcomes", () => {
  it("composes a revision draft, a decision and a digest", async () => {
    const { result, bundle } = await run();
    expect(result.outcome).toEqual({ status: "composed" });
    expectValid(result);
    expect(bundle.calls).toHaveLength(1);
    expect(result.compositionDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(result.specDraft).not.toHaveProperty("workspace");
    expect(result.specDraft).not.toHaveProperty("composition_revision_id");
    expect(result.specDraft).not.toHaveProperty("explanation_ref");
    expect(result.decision).not.toHaveProperty("id");
    expect(result.specDraft!.assets.skills.map((s) => s.id)).toEqual(["claude-skills:pr-writer", "claude-skills:ts-review"]);
    expect(stageOf(result, "confirm")).toMatchObject({ chosen: [], why: "awaiting confirmation" });
    expect(result.bundle!.request.skills.map((s) => s.id)).toEqual(["claude-skills:pr-writer", "claude-skills:ts-review"]);
  });

  it("zero assets is a valid composition: chosen [] with a why (invariant 7)", async () => {
    const docs = skill("docs-writer", { tags: ["content"] });
    const inputs = baseInputs({
      registry: { ...(baseInputs().registry as Extract<ComposerInputs["registry"], { status: "ok" }>), assets: [docs] },
      config: { ...baseInputs().config, allowlist: [{ id: docs.id, digest: docs.digest }] },
    });
    const { result } = await run(inputs);
    expect(result.outcome.status).toBe("composed");
    expectValid(result);
    const assets = stageOf(result, "assets");
    expect(assets.chosen).toEqual([]);
    expect(assets.why).toMatch(/^no optional asset fits/);
    expect(assets.filters).toEqual([{ filter: "no_tag_match", removed: ["claude-skills:docs-writer"], reason: "no tag matches the intent kind or domains" }]);
    expect(result.specDraft!.assets).toEqual({ skills: [], mcp_servers: [], subagents: [] });
  });

  it("no eligible candidate stops after stage 2 with no_candidate, and later stages say they did not run", async () => {
    const harness = fakeHarnessModel(projection({ chosen: undefined, ruleFired: "no-eligible-candidate" }));
    const { result, bundle } = await run(baseInputs(), [{}], harness);
    expect(result.outcome).toEqual({ status: "failed", reason: "no_candidate" });
    expectValid(result);
    expect(stageOf(result, "harness_model")).toMatchObject({ chosen: [], why: "no-eligible-candidate" });
    for (const stage of ["assets", "context", "policy", "confirm"] as const) {
      expect(stageOf(result, stage)).toMatchObject({ chosen: [], candidates: [], why: "not run: pipeline stopped at harness_model (no_candidate)" });
    }
    expect(bundle.calls).toHaveLength(0);
    expect(result.specDraft).toBeUndefined();
    expect(result.compositionDigest).toBeUndefined();
  });

  it.each(["cursor", "bedrock"] as const)("harness %s is skipped as unsupported_harness without a render", async (h) => {
    const p = projection();
    const harness = fakeHarnessModel({ ...p, chosen: { ...p.chosen!, harness: h } });
    const { result, bundle } = await run(baseInputs(), [{}], harness);
    expect(result.outcome).toEqual({ status: "skipped", reason: "unsupported_harness" });
    expectValid(result);
    expect(bundle.calls).toHaveLength(0);
    expect(stageOf(result, "assets").chosen).toEqual([]);
  });

  it("registry federation off: no candidates, and stage 4 fails disabled without a render", async () => {
    const { result, bundle } = await run(baseInputs({ registry: { status: "off" } }));
    expect(result.outcome).toEqual({ status: "failed", reason: "disabled" });
    expectValid(result);
    expect(stageOf(result, "assets")).toMatchObject({ candidates: [], chosen: [], why: "registry federation is off" });
    expect(bundle.calls).toHaveLength(0);
  });

  it("no snapshot after the api's sync attempt: the sync reason is the outcome", async () => {
    const { result } = await run(baseInputs({ registry: { status: "no_snapshot", reason: "unreachable" } }));
    expect(result.outcome).toEqual({ status: "failed", reason: "unreachable" });
    expect(stageOf(result, "assets").why).toBe("no registry snapshot yet (unreachable)");
  });

  it("a stale snapshot still composes and says so", async () => {
    const inputs = baseInputs();
    (inputs.registry as { stale: boolean }).stale = true;
    const { result } = await run(inputs);
    expect(result.outcome.status).toBe("composed");
    expect(result.specDraft!.registry.stale).toBe(true);
    expect(stageOf(result, "assets").why).toMatch(/registry snapshot is stale/);
  });

  it.each(["unreachable", "timeout", "unauthenticated", "unsupported_version", "payload_too_large", "invalid_response", "not_found"] as const)(
    "a bundle failure (%s) records chosen [] with the reason and writes no draft",
    async (reason) => {
      const { result } = await run(baseInputs(), [{ failure: { status: "failure", reason } }]);
      expect(result.outcome).toEqual({ status: "failed", reason });
      expectValid(result);
      expect(stageOf(result, "context")).toMatchObject({ chosen: [], why: `no bundle: ${reason}` });
      expect(stageOf(result, "policy").why).toBe(`not run: pipeline stopped at context (${reason})`);
      expect(result.specDraft).toBeUndefined();
    },
  );

  it("a start records confirm chosen [start] with the digest, and the digest equals the preview's", async () => {
    const preview = (await run()).result;
    const start = (await run(baseInputs({ confirm: { mode: "start", origin: "operator" } }))).result;
    expect(start.compositionDigest).toBe(preview.compositionDigest);
    expect(stageOf(start, "confirm")).toMatchObject({ chosen: ["start"], why: `operator confirmed ${preview.compositionDigest}` });
    expect(jcs(start.decision.stages.slice(0, 5))).toBe(jcs(preview.decision.stages.slice(0, 5)));
    const wake = (await run(baseInputs({ confirm: { mode: "start", origin: "wake" } }))).result;
    expect(stageOf(wake, "confirm").why).toBe("wake dispatch; intent confirmed at creation");
  });

  it("the digest moves when a stage moves", async () => {
    const a = (await run()).result;
    const b = (await run(baseInputs({ consumed: { tokens: 5, costUsd: 0, costMethod: "unknown", unknownCostSessions: 1, sessions: 1, recordCount: 0 } }))).result;
    expect(b.compositionDigest).not.toBe(a.compositionDigest);
  });
});

describe("runComposer: finalization (bundle v1 §Finalization)", () => {
  it("re-runs stage 3 without an excluded skill under excluded_by_renderer and renders once more", async () => {
    const { result, bundle } = await run(baseInputs(), [{ excludeSkills: { "claude-skills:ts-review": "not installed for this harness" } }, {}]);
    expect(result.outcome.status).toBe("composed");
    expectValid(result);
    expect(bundle.calls).toHaveLength(2);
    expect(bundle.calls[1]!.draft.assets.skills.map((s) => s.id)).toEqual(["claude-skills:pr-writer"]);
    const assets = stageOf(result, "assets");
    expect(assets.chosen).toEqual(["claude-skills:pr-writer"]);
    expect(assets.filters).toEqual([
      { filter: "excluded_by_renderer", removed: ["claude-skills:ts-review"], reason: "excluded by renderer: not installed for this harness" },
    ]);
    expect(stageOf(result, "context").why).toMatch(/second render/);
  });

  it("the re-run backfills the freed slot from the ranking", async () => {
    const reg = baseInputs().registry as Extract<ComposerInputs["registry"], { status: "ok" }>;
    const third = skill("ts-lint", { tags: ["typescript"] });
    const inputs = baseInputs({
      registry: { ...reg, assets: [...reg.assets, third] },
      config: { ...baseInputs().config, maxSkills: 2, allowlist: [...baseInputs().config.allowlist, { id: third.id, digest: third.digest }] },
    });
    const { result, bundle } = await run(inputs, [{ excludeSkills: { "claude-skills:pr-writer": "renderer refused" } }, {}]);
    expect(bundle.calls[0]!.draft.assets.skills.map((s) => s.id)).toEqual(["claude-skills:pr-writer", "claude-skills:ts-lint"]);
    expect(stageOf(result, "assets").chosen).toEqual(["claude-skills:ts-lint", "claude-skills:ts-review"]);
    expectValid(result);
  });

  it("a Cockpit reason that fails the text guard is withheld", async () => {
    const { result } = await run(baseInputs(), [{ excludeSkills: { "claude-skills:ts-review": "missing at /home/someone/.claude/skills" } }, {}]);
    expect(stageOf(result, "assets").filters[0]).toEqual({
      filter: "excluded_by_renderer", removed: ["claude-skills:ts-review"], reason: "excluded by renderer (reason withheld: failed text guard)",
    });
    expect(JSON.stringify(result.decision)).not.toContain("/home/");
  });

  it("a second not_final is an error: no third render", async () => {
    const reg = baseInputs().registry as Extract<ComposerInputs["registry"], { status: "ok" }>;
    const third = skill("ts-lint", { tags: ["typescript"] });
    const inputs = baseInputs({
      registry: { ...reg, assets: [...reg.assets, third] },
      config: { ...baseInputs().config, maxSkills: 2, allowlist: [...baseInputs().config.allowlist, { id: third.id, digest: third.digest }] },
    });
    const { result, bundle } = await run(inputs, [
      { excludeSkills: { "claude-skills:pr-writer": "refused" } },
      { excludeSkills: { "claude-skills:ts-review": "refused too" } },
    ]);
    expect(bundle.calls).toHaveLength(2);
    expect(result.outcome).toEqual({ status: "failed", reason: "not_final" });
    expectValid(result);
    expect(result.specDraft).toBeUndefined();
  });

  it("fragment exclusions go to the context stage, and do not trigger a re-render", async () => {
    const { result, bundle } = await run(baseInputs(), [{ excludeFragments: { "repo:example": "unknown fragment" } }]);
    expect(bundle.calls).toHaveLength(1);
    const context = stageOf(result, "context");
    expect(context.chosen).toEqual(["fragment:typescript-style"]);
    expect(context.filters).toEqual([{ filter: "excluded_by_renderer", removed: ["fragment:repo:example"], reason: "excluded by renderer: unknown fragment" }]);
    // The spec records what was requested, as checkComposition compares it with the request.
    expect(result.specDraft!.context.fragments).toEqual(["repo:example", "typescript-style"]);
    expectValid(result);
  });
});

describe("runComposer: text guard", () => {
  it("withholds a port string naming a forbidden hostname or a timestamp", async () => {
    const p = projection({
      ruleFired: "preserve-quota: most headroom on fixture-host.example",
      candidates: [{ assistantId: "personal-claude", modelId: "example-model", k13Shadow: { model: "example-model", rule: "until 2026-10-18T09:00" } }],
      filters: [],
    });
    const { result } = await run(baseInputs(), [{}], fakeHarnessModel(p));
    const stage = stageOf(result, "harness_model");
    expect(stage.why).toBe("why withheld: failed text guard");
    expect(stage.candidates[0]!.evidence).toEqual(["evidence withheld: failed text guard"]);
    expect(JSON.stringify(result.decision)).not.toMatch(/fixture-host|2026-10-18T09/);
  });

  it("filter reasons are built from blocker kinds only", async () => {
    const p = projection({ filters: [{ filter: "quota_blocked", assistantIds: ["work-codex"], kinds: ["rate_limit", "until 2026-10-18T09:00 (x)"] }] });
    const { result } = await run(baseInputs(), [{}], fakeHarnessModel(p));
    expect(stageOf(result, "harness_model").filters).toEqual([{ filter: "quota_blocked", removed: ["work-codex/example-codex-model"], reason: "quota blocked: rate_limit" }]);
  });
});
