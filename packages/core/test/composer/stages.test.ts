import { describe, expect, it } from "vitest";
import { intentStage } from "../../src/composer/intent.js";
import { assetsStage } from "../../src/composer/assets.js";
import { effectiveTokenBudget } from "../../src/composer/context.js";
import { policyStage } from "../../src/composer/policy.js";
import { harnessModelStage } from "../../src/composer/harness-model.js";
import { finalizeStage } from "../../src/composer/explain.js";
import { createTextGuard, harnessForProvider, type ComposedIntent, type ComposerAsset, type ComposerInputs, type HarnessModelChoice } from "../../src/index.js";
import { baseInputs, deps, digestOf, fakeHarnessModel, projection, skill } from "./helpers.js";

const guard = createTextGuard([]);
const okRegistry = (assets: ComposerAsset[]) => ({ ...(baseInputs().registry as Extract<ComposerInputs["registry"], { status: "ok" }>), assets });
const allow = (...assets: ComposerAsset[]) => assets.map(({ id, digest }) => ({ id, digest }));

describe("stage 1: intent", () => {
  it.each([
    ["stored label wins over the goal", { goal: "review the parser", storedKind: "coding" as const }, "coding", "stored classifier v1 label"],
    ["no stored label: v1 at read time", { goal: "review the parser", storedKind: undefined }, "review", "classifier v1 at read time (task predates stored labels)"],
    ["general is recorded, not remapped", { goal: "tidy up", storedKind: "general" as const }, "general", "stored classifier v1 label"],
  ])("kind: %s", (_name, task, kind, evidence) => {
    const r = intentStage(baseInputs({ task: { id: "AG-1", constraints: [], ...task } }));
    expect(r.intent.kind).toBe(kind);
    const c = finalizeStage(r.stage, guard).candidates.find((x) => x.ref === `kind:${kind}`)!;
    expect(c.evidence).toEqual([evidence]);
  });

  it.each([
    ["deploy → high", "Deploy the api", [], "coding", "high", ["rule explicit-high-risk: matched 'deploy'"]],
    ["constraint vocabulary counts", "Fix the test", ["never print the secret"], "coding", "high", ["rule explicit-high-risk: matched 'secret'"]],
    ["several terms, vocabulary order", "drop the table then deploy to production", [], "coding", "high",
      ["rule explicit-high-risk: matched 'deploy'", "rule explicit-high-risk: matched 'production'", "rule explicit-high-risk: matched 'drop'"]],
    ["force-push", "force-push the branch", [], "coding", "high", ["rule explicit-high-risk: matched 'force-push'"]],
    ["migrate data", "migrate the data to v2", [], "coding", "high", ["rule explicit-high-risk: matched 'migrate data'"]],
    ["review → low", "review the parser", [], "review", "low", ["rule kind-low-risk: kind review"]],
    ["research → low", "why is it slow", [], "research", "low", ["rule kind-low-risk: kind research"]],
    ["high beats a low-risk kind", "review the deploy credentials", [], "review", "high",
      ["rule explicit-high-risk: matched 'deploy'", "rule explicit-high-risk: matched 'credential'"]],
    ["default normal", "Fix the flaky test", [], "coding", "normal", ["rule default-normal: no high-risk term and kind is not review or research"]],
    ["whole words only", "redeployment of dropdown", [], "coding", "normal", ["rule default-normal: no high-risk term and kind is not review or research"]],
  ] as const)("risk: %s", (_name, goal, constraints, storedKind, risk, evidence) => {
    const r = intentStage(baseInputs({ task: { id: "AG-1", goal, constraints: [...constraints], storedKind } }));
    expect(r.intent.risk).toBe(risk);
    expect(finalizeStage(r.stage, guard).candidates.find((c) => c.ref === `risk:${risk}`)!.evidence).toEqual(evidence);
  });

  it.each([
    ["markers and dependencies", [{ relPath: "Cargo.toml", content: "", truncated: false }, { relPath: "go.mod", content: "", truncated: false }], ["go", "rust"]],
    ["package.json dependencies", [{ relPath: "package.json", content: JSON.stringify({ devDependencies: { react: "1", next: "1" } }), truncated: false }], ["nextjs", "node", "react"]],
    ["truncated package.json: marker only", [{ relPath: "package.json", content: "{\"dependencies\": {\"react\"", truncated: true }], ["node"]],
    ["unknown files are ignored", [{ relPath: "README.md", content: "typescript", truncated: false }], []],
  ])("domains: %s", (_name, files, domains) => {
    const r = intentStage(baseInputs({ repoSignals: { status: "ok", baseCommit: "abcdef0", files } }));
    expect(r.intent.domains).toEqual(domains);
    expect(r.intent.complexity).toBe("M");
  });

  it("a truncated package.json says so in the why", () => {
    const r = intentStage(baseInputs({ repoSignals: { status: "ok", baseCommit: "abcdef0", files: [{ relPath: "package.json", content: "{", truncated: true }] } }));
    expect(r.stage.why).toMatch(/package.json truncated at the read cap; dependencies not read/);
  });

  it.each(["no_repository", "git_unavailable", "base_unreadable"] as const)("no repository signals (%s): domains [] and the reason class", (reason) => {
    const r = intentStage(baseInputs({ repoSignals: { status: "unavailable", reason } }));
    expect(r.intent.domains).toEqual([]);
    expect(r.stage.why).toContain(`no repository signals: ${reason}`);
  });

  it("override: from is the computed chosen, to is chosen, and override-only refs become candidates", () => {
    const r = intentStage(baseInputs({ overrides: { intent: { kind: "planning", domains: ["rust"] } } }));
    const s = finalizeStage(r.stage, guard);
    expect(s.override!.from).toEqual(["complexity:M", "domain:fastify", "domain:node", "domain:typescript", "domain:vitest", "kind:coding", "risk:normal"]);
    expect(s.override!.to).toEqual(["complexity:M", "domain:rust", "kind:planning", "risk:normal"]);
    expect(s.chosen).toEqual(s.override!.to);
    expect(s.candidates.find((c) => c.ref === "kind:planning")!.evidence).toEqual(["operator override"]);
    expect(r.computed.kind).toBe("coding");
    expect(s.why).toMatch(/^operator override; pipeline chose /);
  });

  it("an override naming a bad domain is refused", () => {
    expect(intentStage(baseInputs({ overrides: { intent: { domains: ["/home/x"] } } })).refused).toMatch(/domain/);
  });
});

describe("stage 2: harness and model", () => {
  it.each([
    ["anthropic", "claude-code"], ["openai", "codex"], ["openrouter", "codex"], ["cursor", "cursor"], ["bedrock", "bedrock"], ["fake", undefined], ["toString", undefined],
  ])("provider %s → harness %s", (provider, harness) => {
    expect(harnessForProvider(provider)).toBe(harness);
  });

  it("expands an assistant filter to every model of it, in the fixed filter order", async () => {
    const p = projection({
      filters: [
        { filter: "cooldown", assistantIds: ["work-codex"], kinds: ["failed"] },
        { filter: "auth", assistantIds: ["work-codex"], kinds: ["expired"] },
      ],
      candidates: [...projection().candidates, { assistantId: "work-codex", modelId: "example-codex-mini" }, { assistantId: "no-manifest-one" }],
    });
    const r = await harnessModelStage(baseInputs(), intentStage(baseInputs()).intent, fakeHarnessModel(p));
    const s = finalizeStage(r.stage, guard);
    expect(s.filters).toEqual([
      { filter: "auth", removed: ["work-codex/example-codex-mini", "work-codex/example-codex-model"], reason: "auth expired" },
      { filter: "cooldown", removed: ["work-codex/example-codex-mini", "work-codex/example-codex-model"], reason: "cooldown: failed" },
    ]);
    expect(s.candidates.map((c) => c.ref)).toContain("no-manifest-one");
  });

  it("K13 shadow is evidence, and the model source is in the why", async () => {
    const p = projection({ candidates: [{ assistantId: "personal-claude", modelId: "example-model", k13Shadow: { model: "example-model-small", rule: "cheapest-capable" } }], filters: [] });
    const s = finalizeStage((await harnessModelStage(baseInputs(), intentStage(baseInputs()).intent, fakeHarnessModel(p))).stage, guard);
    expect(s.candidates[0]!.evidence).toEqual(["K13 shadow: example-model-small (cheapest-capable)"]);
    expect(s.why).toBe("preserve-quota: most headroom; harness claude-code; model example-model from the manifest's first model");
  });

  it("override: the port is called without it, then with it; from is the un-overridden choice", async () => {
    const base = projection();
    const port = fakeHarnessModel((req) => req.override
      ? { ...base, ruleFired: "user-override", chosen: { ...base.chosen!, modelId: "example-model-small", modelSource: "intent-override" } }
      : base);
    const inputs = baseInputs({ overrides: { harness_model: { model: "example-model-small" } } });
    const r = await harnessModelStage(inputs, intentStage(inputs).intent, port);
    expect(port.calls.map((c) => c.override)).toEqual([undefined, { model: "example-model-small" }]);
    const s = finalizeStage(r.stage, guard);
    expect(s.override).toEqual({ actor: "operator", from: ["personal-claude/example-model"], to: ["personal-claude/example-model-small"], reason: "operator override" });
    expect(s.chosen).toEqual(["personal-claude/example-model-small"]);
  });
});

describe("stage 3: assets, hard filters in fixed order", () => {
  const intent: ComposedIntent = { kind: "coding", domains: ["typescript"], complexity: "M", risk: "normal" };
  const table: Array<[string, ComposerAsset, Partial<ComposerInputs>, string]> = [
    ["mcp server", skill("srv", { kind: "mcp_server", tags: ["coding"] }), {}, "kind_not_attachable"],
    ["agent", skill("agt", { kind: "agent", tags: ["coding"] }), {}, "kind_not_attachable"],
    ["disabled", skill("off", { enabled: false, tags: ["coding"] }), {}, "disabled_in_producer"],
    ["incompatible", skill("cur", { compatibility: { assistants: ["cursor"] }, tags: ["coding"] }), {}, "incompatible_harness"],
    ["env unset", skill("env", { tags: ["coding"], requirements: { secretRefs: [{ type: "env", name: "EXAMPLE_SERVICE_ENV" }] } }), {}, "missing_requirement"],
    ["keychain", skill("kc", { tags: ["coding"], requirements: { secretRefs: [{ type: "keychain", name: "fake-item" }] } }), {}, "missing_requirement"],
    ["command missing", skill("cmd", { tags: ["coding"], requirements: { secretRefs: [], commands: ["rg"] } }), {}, "missing_requirement"],
    ["not allowlisted", skill("na", { tags: ["coding"] }), { config: { ...baseInputs().config, allowlist: [] } }, "not_allowlisted"],
    ["stale opt-in", skill("so", { tags: ["coding"] }), { config: { ...baseInputs().config, allowlist: [] }, optIns: [{ assetId: "claude-skills:so", digest: digestOf("other"), actor: "operator", at: "2026-10-18T08:00:00.000Z" }] }, "opt_in_stale"],
    ["no tag match", skill("nt", { tags: ["content"] }), {}, "no_tag_match"],
  ];
  it.each(table)("%s → %s", (_name, asset, over, filter) => {
    const config = over.config ?? { ...baseInputs().config, allowlist: allow(asset) };
    const r = assetsStage(baseInputs({ ...over, config, registry: okRegistry([asset]) }), intent, "claude-code", []);
    const s = finalizeStage(r.stage, guard);
    expect(s.filters.map((f) => [f.filter, f.removed])).toEqual([[filter, [asset.id]]]);
    expect(s.chosen).toEqual([]);
  });

  it("no_skill_path for codex, after harness compatibility", () => {
    const a = skill("x", { tags: ["coding"] });
    const s = finalizeStage(assetsStage(baseInputs({ registry: okRegistry([a]), config: { ...baseInputs().config, allowlist: allow(a) } }), intent, "codex", []).stage, guard);
    expect(s.filters).toEqual([{ filter: "no_skill_path", removed: [a.id], reason: "bundle v1 has no skill relPath for harness codex" }]);
  });

  it("a requirement that is met passes, and names no value", () => {
    const a = skill("env", { tags: ["coding"], requirements: { secretRefs: [{ type: "env", name: "EXAMPLE_SERVICE_ENV" }], commands: ["rg"] } });
    const r = assetsStage(baseInputs({ registry: okRegistry([a]), config: { ...baseInputs().config, allowlist: allow(a) }, environment: { envNames: ["EXAMPLE_SERVICE_ENV"], commands: ["rg"] } }), intent, "claude-code", []);
    expect(r.skills.map((s) => s.id)).toEqual([a.id]);
  });

  it("an opt-in at the digest attaches an unallowlisted asset with its opt_in", () => {
    const a = skill("oi", { tags: ["coding"] });
    const optIn = { assetId: a.id, digest: a.digest, actor: "operator", at: "2026-10-18T08:05:00.000Z" };
    const r = assetsStage(baseInputs({ registry: okRegistry([a]), config: { ...baseInputs().config, allowlist: [] }, optIns: [optIn] }), intent, "claude-code", []);
    expect(r.skills).toEqual([{ id: a.id, digest: a.digest, allowlisted: false, opt_in: { digest: a.digest, actor: "operator", at: optIn.at } }]);
    expect(finalizeStage(r.stage, guard).candidates[0]!.evidence).toContain("opted in at digest");
  });

  it("ranks by matched tags, ties by id, at most maxSkills; conflicts lose to the higher-ranked", () => {
    const both = skill("both", { tags: ["coding", "typescript"] });
    const a = skill("a-one", { tags: ["coding"] });
    const b = skill("b-one", { tags: ["typescript"], conflicts: ["claude-skills:both"] });
    const c = skill("c-one", { tags: ["coding"] });
    const assets = [a, b, both, c];
    const r = assetsStage(baseInputs({ registry: okRegistry(assets), config: { ...baseInputs().config, maxSkills: 2, allowlist: allow(...assets) } }), intent, "claude-code", []);
    const s = finalizeStage(r.stage, guard);
    expect(s.chosen).toEqual(["claude-skills:a-one", "claude-skills:both"]);
    expect(s.filters.map((f) => [f.filter, f.removed])).toEqual([["conflict", ["claude-skills:b-one"]], ["over_max_skills", ["claude-skills:c-one"]]]);
    expect(s.candidates.find((x) => x.ref === "claude-skills:both")!.evidence).toEqual(["tags matched: coding, typescript", "lineage: library", "allowlisted at digest"]);
  });

  it("override: add past a ranking filter and remove; from/to recorded and the filter no longer removes the added asset", () => {
    const a = skill("a-one", { tags: ["coding"] });
    const docs = skill("docs", { tags: ["content"] });
    const inputs = baseInputs({ registry: okRegistry([a, docs]), config: { ...baseInputs().config, allowlist: allow(a, docs) }, overrides: { assets: { add: [docs.id], remove: [a.id] } } });
    const s = finalizeStage(assetsStage(inputs, intent, "claude-code", []).stage, guard);
    expect(s.override).toMatchObject({ from: [a.id], to: [docs.id] });
    expect(s.chosen).toEqual([docs.id]);
    expect(s.filters).toEqual([]);
    expect(s.why).toMatch(/^operator override; pipeline chose claude-skills:a-one/);
  });

  it.each([
    ["an unallowlisted asset without an opt-in", { allowlist: [] as Array<{ id: string; digest: string }> }, /not_allowlisted/],
    ["an asset not in the snapshot", { add: ["claude-skills:nope"] }, /not in the registry snapshot/],
  ])("override: attaching %s is refused", (_name, over, message) => {
    const a = skill("a-one", { tags: ["coding"] });
    const inputs = baseInputs({
      registry: okRegistry([a]),
      config: { ...baseInputs().config, allowlist: "allowlist" in over ? over.allowlist! : allow(a) },
      overrides: { assets: { add: "add" in over ? over.add! : [a.id] } },
    });
    expect(assetsStage(inputs, intent, "claude-code", []).refused).toMatch(message);
  });
});

describe("stage 4: context budget", () => {
  it.each([
    [12000, undefined, 12000],
    [12000, 200000, 12000],
    [12000, 20000, 5000],
    [12000, 3, 1],
  ])("tokenBudget %s with cap %s → %s", (tokenBudget, cap, expected) => {
    expect(effectiveTokenBudget({ tokenBudget, budget: cap === undefined ? {} : { max_tokens: cap } })).toBe(expected);
  });
});

describe("stage 5: policy", () => {
  const choice = projection().chosen as HarnessModelChoice;
  const run = (over: Partial<ComposerInputs>, intentOver: Partial<ComposedIntent> = {}, ch: HarnessModelChoice = choice) => {
    const inputs = baseInputs(over);
    const computed = intentStage(inputs).computed;
    return policyStage(inputs, { ...computed, ...intentOver }, computed, ch, deps);
  };

  it.each([
    ["auto-approve", undefined, "normal", "auto"],
    ["auto-approve", "prompt-on-escalation", "high", "prompt-on-escalation"],
    ["read-only", "prompt-on-escalation", "high", "read-only"],
    ["prompt-on-escalation", "auto-approve", "high", "prompt-on-escalation"],
  ] as const)("workspace %s, risk map %s for %s risk → %s", (mode, riskMode, risk, permission) => {
    const config = { ...baseInputs().config, policy: { riskPermission: riskMode ? { [risk]: riskMode } : {}, permitAmbient: true, permitPartial: false } };
    const goal = risk === "high" ? "deploy it" : "fix it";
    const r = run({ config, workspacePolicy: { ...baseInputs().workspacePolicy, approvalMode: mode }, task: { id: "AG-1", goal, constraints: [], storedKind: "coding" } });
    expect(r.policy!.permission).toBe(permission);
  });

  it("a harness that refuses the mode fails policy_unenforceable; the Composer never loosens", () => {
    const r = run({ task: { id: "AG-1", goal: "deploy it", constraints: [], storedKind: "coding" } }, {}, { ...choice, harness: "codex", acceptedApprovalModes: ["auto-approve", "read-only"] });
    expect(r.failure).toBe("policy_unenforceable");
    const s = finalizeStage(r.stage, guard);
    expect(s.filters[0]).toMatchObject({ filter: "harness_refuses", removed: ["permission:prompt-on-escalation"] });
    expect(s.chosen).toEqual([]);
  });

  it("isolation_unavailable without permitAmbient (invariant 3)", () => {
    const r = run({ config: { ...baseInputs().config, policy: { riskPermission: {}, permitAmbient: false, permitPartial: false } } });
    expect(r.failure).toBe("isolation_unavailable");
  });

  describe("provisioning (M3 S2)", () => {
    const digest = `sha256:${"ab".repeat(32)}`;
    const planned = (fidelity: "full" | "partial", harness = choice.harness as "claude-code" | "codex") =>
      ({ status: "planned" as const, harness, fidelity, profileDigest: digest, visible: ["managed policy settings"] });
    const policy = (permitAmbient: boolean, permitPartial: boolean) => ({ config: { ...baseInputs().config, policy: { riskPermission: {}, permitAmbient, permitPartial } } });
    const runWith = (over: Partial<ComposerInputs>, prediction: Parameters<typeof policyStage>[5], ch: HarnessModelChoice = choice) => {
      const inputs = baseInputs(over);
      const computed = intentStage(inputs).computed;
      return policyStage(inputs, computed, computed, ch, deps, prediction);
    };

    it("a planned full profile binds requested isolated, achieved full and its digest, even where ambient is not permitted", () => {
      const r = runWith(policy(false, false), planned("full"));
      expect(r.failure).toBeUndefined();
      expect(r.provisioning).toEqual({ requested: "isolated", achieved: "full", profile_digest: digest });
      const s = finalizeStage(r.stage, guard);
      expect(s.chosen).toContain("provisioning:isolated");
      expect(s.candidates.find((c) => c.ref === "provisioning:isolated")).toMatchObject({ digest });
      expect(s.filters).toContainEqual(expect.objectContaining({ filter: "profile_planned", removed: ["provisioning:ambient"] }));
      expect(s.why).toContain(`provisioning isolated: full ${choice.harness} profile ${digest}`);
    });

    it.each([
      [true, false, "isolated"], [false, true, "isolated"], [false, false, "isolation_unavailable"],
    ] as const)("partial with permitAmbient %s, permitPartial %s → %s", (permitAmbient, permitPartial, expected) => {
      const r = runWith(policy(permitAmbient, permitPartial), planned("partial"));
      if (expected === "isolated") {
        expect(r.provisioning).toEqual({ requested: "isolated", achieved: "partial", profile_digest: digest });
      } else {
        expect(r.failure).toBe("isolation_unavailable");
        const s = finalizeStage(r.stage, guard);
        expect(s.filters.map((f) => f.filter)).toEqual(["partial_not_permitted", "isolation_unavailable"]);
        expect(s.why).toContain("the profile is partial and partial is not permitted");
      }
    });

    it("no profile is ambient only when the workspace permits it, and the decision says why", () => {
      const prediction = { status: "unavailable" as const, reason: "unsupported_transport: no lifecycle" };
      const ok = runWith(policy(true, false), prediction);
      expect(ok.provisioning).toEqual({ requested: "ambient" });
      expect(finalizeStage(ok.stage, guard).why).toContain("provisioning ambient: no profile (unsupported_transport: no lifecycle); workspace permits ambient");
      expect(runWith(policy(false, true), prediction).failure).toBe("isolation_unavailable");
    });

    it("a profile planned for another harness is not this composition's (risk 9)", () => {
      const other = choice.harness === "codex" ? "claude-code" : "codex";
      const r = runWith(policy(true, true), planned("full", other));
      expect(r.provisioning).toEqual({ requested: "ambient" });
      expect(finalizeStage(r.stage, guard).why).toContain(`adapter planned a ${other} profile for a ${choice.harness} composition`);
    });

    it("permitPartial changes the policy revision digest", () => {
      const a = runWith(policy(false, false), planned("full"));
      const b = runWith(policy(false, true), planned("full"));
      expect(a.policy!.revision.digest).not.toBe(b.policy!.revision.digest);
    });
  });

  it("the budget is the task cap minus consumption; at zero it is exhausted", () => {
    const consumed = { tokens: 150000, costUsd: 0, costMethod: "unknown" as const, unknownCostSessions: 1, sessions: 1, recordCount: 2 };
    expect(run({ consumed }).policy!.budget).toEqual({ max_tokens: 50000, max_runtime_ms: 1800000 });
    const r = run({ consumed: { ...consumed, tokens: 200000 } });
    expect(r.failure).toBe("budget_exhausted");
    expect(finalizeStage(r.stage, guard).filters).toEqual([{ filter: "budget_exhausted", removed: ["max_tokens:0"], reason: "the task has no budget remaining under its cap" }]);
  });

  it("cost cap evidence: advisory, and no price means not computed", () => {
    const r = run({ config: { ...baseInputs().config, budget: { max_cost_usd: 2.5 } } });
    const s = finalizeStage(r.stage, guard);
    expect(s.candidates.find((c) => c.ref === "max_cost_usd:2.5")!.evidence).toEqual([
      "cost: advisory until deferral #3 closes", "no price evidence; cost is not computed", "task cap 2.5, consumed 0, remaining 2.5",
    ]);
    expect(s.why).toContain("no price evidence; cost is not computed");
  });

  it("tokens are bounded only when the manifest declares usage reporting", () => {
    const evidence = (usageReporting: boolean) =>
      finalizeStage(run({}, {}, { ...choice, usageReporting }).stage, guard).candidates.find((c) => c.ref.startsWith("max_tokens:"))!.evidence![0];
    expect(evidence(false)).toBe("tokens: advisory (personal-claude declares no usage reporting)");
    expect(evidence(true)).toBe("tokens: bounded (personal-claude declares usage reporting)");
  });

  it("override tightens permission and caps, with from/to", () => {
    const r = run({ overrides: { policy: { permission: "read-only", budget: { max_tokens: 1000 } } } });
    expect(r.policy).toMatchObject({ permission: "read-only", budget: { max_tokens: 1000 } });
    const s = finalizeStage(r.stage, guard);
    expect(s.override).toMatchObject({
      from: ["max_runtime_ms:1800000", "max_tokens:200000", "permission:auto", "provisioning:ambient"],
      to: ["max_runtime_ms:1800000", "max_tokens:1000", "permission:read-only", "provisioning:ambient"],
    });
  });

  it.each([
    ["a looser permission", { permission: "auto" as const }, { goal: "deploy it" }],
    ["a larger cap", { budget: { max_tokens: 300000 } }, {}],
    ["a non-integer token cap", { budget: { max_tokens: 1.5 } }, {}],
  ])("override: %s is refused", (_name, policy, task) => {
    const r = run({ overrides: { policy }, task: { id: "AG-1", goal: "fix it", constraints: [], storedKind: "coding", ...task } });
    expect(r.refused).toBeDefined();
    expect(r.policy).toBeUndefined();
  });

  it("a lowered intent risk that would loosen permission is refused", () => {
    const r = run({ task: { id: "AG-1", goal: "deploy it", constraints: [], storedKind: "coding" } }, { risk: "normal" });
    expect(r.refused).toMatch(/would loosen permission prompt-on-escalation to auto/);
  });

  it("the policy revision digest is of the canonical policy document, independent of allowlist order", () => {
    const a = run({});
    const reversed = { ...baseInputs().config, allowlist: [...baseInputs().config.allowlist].reverse() };
    expect(run({ config: reversed }).policy!.revision.digest).toBe(a.policy!.revision.digest);
    expect(run({ config: { ...baseInputs().config, policy: { riskPermission: {}, permitAmbient: true, permitPartial: false } } }).policy!.revision.digest).not.toBe(a.policy!.revision.digest);
  });
});
