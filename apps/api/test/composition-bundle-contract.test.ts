import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  assembleBundle, BUNDLE_CONTRACT_DIR, computeBundleDigest, MAX_BUNDLE_BYTES, validateBundleRequest, validateBundleResponse,
  type BundleRequest, type BundleResponse,
} from "../src/bundle-contract.js";
import {
  checkComposition, COMPOSITION_CONTRACT_DIR, validateAgentSpec, validateCompositionDecision,
  type AgentSpec, type CompositionDecision,
} from "../src/composition-contract.js";

const read = (dir: string, path: string): unknown => JSON.parse(readFileSync(join(dir, "fixtures", path), "utf8"));
const bundleFixture = (path: string) => read(BUNDLE_CONTRACT_DIR, path);
const compFixture = (path: string) => read(COMPOSITION_CONTRACT_DIR, path);
const errorsOf = (result: { ok: boolean; errors?: string[] }) => (result.ok ? "" : (result.errors ?? []).join("\n"));

describe("bundle contract v1 conformance fixtures", () => {
  for (const name of ["zero-asset", "two-skill"]) {
    it(`accepts valid/${name} and the response answers its request`, () => {
      const request = validateBundleRequest(bundleFixture(`valid/${name}.request.json`));
      expect(request).toMatchObject({ ok: true });
      const response = validateBundleResponse(bundleFixture(`valid/${name}.response.json`), (request as { value: BundleRequest }).value);
      expect(errorsOf(response)).toBe("");
    });
  }

  const expectations: Record<string, [validate: (body: unknown) => { ok: boolean; errors?: string[] }, reason: RegExp]> = {
    "absolute-relpath.response.json": [(b) => validateBundleResponse(b), /\/files\/0\/relPath must NOT be valid \[#\/\$defs\/notAbsolute\/not\]/],
    "dotdot-relpath.response.json": [(b) => validateBundleResponse(b), /\/files\/0\/relPath must NOT be valid \[#\/\$defs\/noDotSegment\/not\]/],
    "output-path.request.json": [validateBundleRequest, /^\/ must NOT have additional properties \(outputDir\)/m],
  };

  it("has an expectation for every invalid fixture", () => {
    expect(readdirSync(join(BUNDLE_CONTRACT_DIR, "fixtures/invalid")).sort()).toEqual(Object.keys(expectations).sort());
  });

  for (const [file, [validate, reason]] of Object.entries(expectations)) {
    it(`rejects invalid/${file} for the stated reason`, () => {
      const result = validate(bundleFixture(`invalid/${file}`));
      expect(result.ok).toBe(false);
      expect(errorsOf(result)).toMatch(reason);
    });
  }
});

describe("bundle contract v1 rules beyond the schema", () => {
  const request = bundleFixture("valid/two-skill.request.json") as BundleRequest;
  const bundle = bundleFixture("valid/two-skill.response.json") as BundleResponse;
  const mutate = (fn: (b: BundleResponse) => void) => {
    const copy = structuredClone(bundle);
    fn(copy);
    return errorsOf(validateBundleResponse(copy, request));
  };

  it("bundles the same input to the same bundleDigest, whatever the input order", () => {
    const rendered = bundle.files.map(({ relPath, content }) => ({ relPath, content }));
    const input = { request, compiler: bundle.manifest.compiler, included: bundle.manifest.included, excluded: bundle.manifest.excluded };
    const first = assembleBundle({ ...input, rendered });
    const second = assembleBundle({ ...input, rendered: [...rendered].reverse() });
    expect(second.manifest.bundleDigest).toBe(first.manifest.bundleDigest);
    expect(first).toEqual(bundle);
    expect(computeBundleDigest([...bundle.files].reverse())).toBe(bundle.manifest.bundleDigest);
  });

  it("rejects a stale bundleDigest, a wrong file digest and unsorted files", () => {
    expect(mutate((b) => { b.files[0]!.content += "x"; })).toMatch(/\/files\/0 digest does not match its content/);
    expect(mutate((b) => { b.manifest.bundleDigest = `sha256:${"0".repeat(64)}`; })).toMatch(/bundleDigest .* does not match/);
    expect(mutate((b) => { b.files.reverse(); })).toMatch(/\/files is not strictly sorted by relPath/);
  });

  it("narrows the allowlist per harness", () => {
    expect(mutate((b) => { b.files[2]!.relPath = "AGENTS.md"; })).toMatch(/AGENTS\.md is not allowed for harness claude-code/);
    const codex = { ...request, harness: "codex" as const };
    const result = validateBundleResponse({ ...bundle, manifest: { ...bundle.manifest, harness: "codex" } }, codex);
    expect(errorsOf(result)).toMatch(/\.claude\/skills\/example-review\/SKILL\.md is not allowed for harness codex/);
  });

  it("rejects timestamps and absolute paths in content", () => {
    const withContent = (content: string) => mutate((b) => {
      b.files[1]!.content = content;
      b.files[1]!.digest = `sha256:${"0".repeat(64)}`;
    });
    expect(withContent("Generated 2026-10-05T10:00:00Z")).toMatch(/content contains a timestamp/);
    expect(withContent("See /home/example/notes.md")).toMatch(/content contains an absolute path/);
  });

  it("bounds the total size", () => {
    // Each file is under the per-file schema cap; together they are one byte over the total.
    const half = MAX_BUNDLE_BYTES / 2;
    const response = assembleBundle({
      request: { ...request, tokenBudget: 200000, model: { ...request.model, charsPerToken: 16 } },
      rendered: [
        { relPath: "CLAUDE.md", content: "a".repeat(half) },
        { relPath: ".claude/skills/example-review/SKILL.md", content: "b".repeat(half + 1) },
      ],
      compiler: bundle.manifest.compiler, included: bundle.manifest.included, excluded: bundle.manifest.excluded,
    });
    expect(errorsOf(validateBundleResponse(response))).toMatch(/exceeds 262144/);
  });

  it("requires the estimate to be recomputable and within budget", () => {
    expect(mutate((b) => { b.manifest.tokens.estimated += 1; })).toMatch(/estimated .* does not match/);
    const tight = { ...request, tokenBudget: 10 };
    const over = assembleBundle({
      request: tight, compiler: bundle.manifest.compiler, included: bundle.manifest.included, excluded: bundle.manifest.excluded,
      rendered: bundle.files.map(({ relPath, content }) => ({ relPath, content })),
    });
    expect(errorsOf(validateBundleResponse(over, tight))).toMatch(/exceeds budget 10/);
  });

  it("requires every requested input to be included or excluded exactly once", () => {
    expect(mutate((b) => { b.manifest.excluded = []; })).toMatch(/do not cover exactly the requested/);
    expect(mutate((b) => { b.manifest.excluded.push({ kind: "fragment", ref: "typescript-style", reason: "dup" }); })).toMatch(/more than once/);
  });

  it("renders skills only from the request, at the pinned digest", () => {
    // Codex round 1: a renderer must not be able to add a skill nobody selected.
    const rogue = "---\nname: unapproved\n---\n";
    const extra = { relPath: ".claude/skills/unapproved/SKILL.md", content: rogue, digest: `sha256:${"0".repeat(64)}` };
    expect(mutate((b) => { b.files.push(extra); b.files.sort((x, y) => (x.relPath < y.relPath ? -1 : 1)); }))
      .toMatch(/\.claude\/skills\/unapproved\/SKILL\.md is not named by an included skill/);
    expect(mutate((b) => { b.manifest.included.find((e) => e.kind === "skill")!.digest = `sha256:${"9".repeat(64)}`; }))
      .toMatch(/rendered sha256:9+, not the pinned/);
    expect(mutate((b) => { b.manifest.included = b.manifest.included.filter((e) => e.kind !== "skill"); }))
      .toMatch(/is not named by an included skill[\s\S]*do not cover exactly the requested/);
  });

  it("rejects an inline credential in rendered content", () => {
    expect(mutate((b) => {
      b.files[2]!.content += `\nexport API_KEY=${["fake", "value"].join("-")}\n`;
      b.files[2]!.digest = `sha256:${"0".repeat(64)}`;
    })).toMatch(/\/files\/2 content contains an inline credential/);
  });

  it("answers in the request's version", () => {
    expect(errorsOf(validateBundleResponse({ ...bundle, schemaVersion: "1.1" }, request))).toMatch(/does not answer request version 1.0/);
  });

  it("represents every request the request schema accepts (Codex round 2 bounds)", () => {
    const longId = `claude-skills:${"x".repeat(242)}`; // 256 characters, the registry assetId bound
    const big: BundleRequest = {
      ...request,
      fragments: Array.from({ length: 64 }, (_, i) => `f${String(i).padStart(2, "0")}`),
      memoryBundles: Array.from({ length: 64 }, (_, i) => ({ id: `m${String(i).padStart(2, "0")}`, digest: `sha256:${"d".repeat(64)}` })),
      skills: [{ id: longId, digest: `sha256:${"1".repeat(64)}` }],
    };
    expect(validateBundleRequest(big)).toMatchObject({ ok: true });
    const response = assembleBundle({
      request: big, compiler: bundle.manifest.compiler,
      rendered: [{ relPath: "CLAUDE.md", content: "# context\n" }, { relPath: ".claude/skills/long/SKILL.md", content: "skill\n" }],
      included: [
        ...big.fragments.map((ref) => ({ kind: "fragment" as const, ref, digest: `sha256:${"a".repeat(64)}`, reason: "requested" })),
        ...big.memoryBundles.map((m) => ({ kind: "memory_bundle" as const, ref: m.id, digest: m.digest, reason: "requested" })),
        { kind: "skill", ref: longId, digest: big.skills[0]!.digest, relPath: ".claude/skills/long/SKILL.md", reason: "selected" },
      ],
      excluded: [],
    });
    expect(errorsOf(validateBundleResponse(response, big))).toBe("");
  });

  it("rejects an unsorted request and an unknown request major", () => {
    expect(errorsOf(validateBundleRequest({ ...request, fragments: [...request.fragments].reverse() }))).toMatch(/\/fragments is not sorted/);
    expect(errorsOf(validateBundleRequest({ ...request, schemaVersion: "2.0" }))).toMatch(/unsupported schemaVersion "2.0"/);
    expect(errorsOf(validateBundleRequest({ ...request, schemaVersion: "1.1" }))).toMatch(/unsupported schemaVersion "1.1"/);
  });
});

describe("composition contract v1 conformance fixtures", () => {
  for (const name of ["zero-asset", "two-skill"]) {
    it(`accepts valid/${name}, and the spec, decision and bundle agree`, () => {
      const spec = validateAgentSpec(compFixture(`valid/${name}.agent-spec.json`));
      const decision = validateCompositionDecision(compFixture(`valid/${name}.decision.json`));
      expect(errorsOf(spec)).toBe("");
      expect(errorsOf(decision)).toBe("");
      const bundle = {
        request: bundleFixture(`valid/${name}.request.json`) as BundleRequest,
        response: bundleFixture(`valid/${name}.response.json`) as BundleResponse,
      };
      expect(checkComposition((spec as { value: AgentSpec }).value, (decision as { value: CompositionDecision }).value, bundle)).toEqual([]);
    });
  }

  it("zero optional assets is a valid, explained outcome", () => {
    const spec = compFixture("valid/zero-asset.agent-spec.json") as AgentSpec;
    const decision = compFixture("valid/zero-asset.decision.json") as CompositionDecision;
    expect([...spec.assets.skills, ...spec.assets.mcp_servers, ...spec.assets.subagents]).toEqual([]);
    const assets = decision.stages.find((s) => s.stage === "assets")!;
    expect(assets.chosen).toEqual([]);
    expect(assets.why).toMatch(/least-privilege/);
    expect(errorsOf(validateCompositionDecision({ ...decision, stages: decision.stages.map((s) => (s === assets ? { ...s, why: "" } : s)) }))).toMatch(/\/stages\/2\/why must NOT have fewer than 1 characters/);
  });

  const expectations: Record<string, RegExp> = {
    "inline-secret.agent-spec.json": /\/assets\/mcp_servers\/0\/secret_refs\/0 must be object \[.*registry-snapshot\.schema\.json#\/\$defs\/SecretRef\/type\]/,
    "asset-missing-digest.agent-spec.json": /\/assets\/skills\/0 must have required property 'digest'/,
    "mutable-asset-pointer.agent-spec.json": /\/assets\/skills\/0 must NOT have unevaluated properties \(version\)/,
  };

  it("has an expectation for every invalid fixture", () => {
    expect(readdirSync(join(COMPOSITION_CONTRACT_DIR, "fixtures/invalid")).sort()).toEqual(Object.keys(expectations).sort());
  });

  for (const [file, reason] of Object.entries(expectations)) {
    it(`rejects invalid/${file} for the stated reason`, () => {
      const result = validateAgentSpec(compFixture(`invalid/${file}`));
      expect(result.ok).toBe(false);
      expect(errorsOf(result)).toMatch(reason);
    });
  }
});

describe("composition contract v1 rules beyond the schema", () => {
  const spec = compFixture("valid/two-skill.agent-spec.json") as AgentSpec;
  const decision = compFixture("valid/two-skill.decision.json") as CompositionDecision;
  const specErrors = (fn: (s: AgentSpec) => void) => {
    const copy = structuredClone(spec);
    fn(copy);
    return errorsOf(validateAgentSpec(copy));
  };

  it("requires an opt-in for an asset outside the allowlist, pinned to its digest", () => {
    expect(specErrors((s) => { delete s.assets.skills[1]!.opt_in; })).toMatch(/\/assets\/skills\/1 must have required property 'opt_in'/);
    expect(specErrors((s) => { s.assets.skills[1]!.opt_in!.digest = `sha256:${"9".repeat(64)}`; })).toMatch(/opt_in pins .* not the attached digest/);
  });

  it("never records ambient as the result of an isolated request", () => {
    expect(specErrors((s) => { s.provisioning.achieved = "ambient"; })).toMatch(/silent fallback/);
    expect(specErrors((s) => { s.provisioning = { requested: "ambient", achieved: "ambient" }; })).toBe("");
  });

  it("rejects unsorted assets and workspace paths", () => {
    expect(specErrors((s) => { s.assets.skills.reverse(); })).toMatch(/\/assets\/skills is not sorted/);
    expect(specErrors((s) => { (s.workspace as Record<string, unknown>).worktree = "/home/example/wt"; })).toMatch(/additional properties \(worktree\)/);
  });

  it("rejects a decision that chooses a filtered or unknown candidate, or skips a stage", () => {
    const withAssets = (patch: Partial<CompositionDecision["stages"][number]>) =>
      errorsOf(validateCompositionDecision({ ...decision, stages: decision.stages.map((s) => (s.stage === "assets" ? { ...s, ...patch } : s)) }));
    expect(withAssets({ chosen: ["claude-skills:unknown"] })).toMatch(/chose claude-skills:unknown, which is not a candidate/);
    expect(withAssets({ filters: [{ filter: "allowlist", removed: ["claude-skills:example-tests"], reason: "not allowlisted" }] }))
      .toMatch(/chose claude-skills:example-tests, which a filter removed/);
    expect(errorsOf(validateCompositionDecision({ ...decision, stages: [...decision.stages].reverse() }))).toMatch(/\/stages must be intent,/);
  });

  it("detects a spec whose assets or bundle disagree with its decision", () => {
    const zeroDecision = compFixture("valid/zero-asset.decision.json") as CompositionDecision;
    expect(checkComposition(spec, { ...zeroDecision, id: decision.id, composition_revision_id: spec.composition_revision_id }))
      .toContain("assets stage chose [] but the spec attaches [claude-skills:example-review, claude-skills:example-tests]");
    const other = {
      request: bundleFixture("valid/zero-asset.request.json") as BundleRequest,
      response: bundleFixture("valid/zero-asset.response.json") as BundleResponse,
    };
    expect(checkComposition(spec, decision, other)).toContain("context.bundle_digest does not match the bundle");
  });

  it("compares input digests across spec, decision and bundle", () => {
    // Codex round 1: ids matching is not enough; the revisions must match too.
    const bundle = {
      request: bundleFixture("valid/two-skill.request.json") as BundleRequest,
      response: bundleFixture("valid/two-skill.response.json") as BundleResponse,
    };
    const drifted = structuredClone(spec);
    drifted.context.memory_bundles[0]!.digest = `sha256:${"7".repeat(64)}`;
    const memoryErrors = checkComposition(drifted, decision, bundle).join("\n");
    expect(memoryErrors).toMatch(/memory bundles \(id and digest\) do not match/);

    const changedSkill = structuredClone(spec);
    changedSkill.assets.skills[0]!.digest = `sha256:${"8".repeat(64)}`;
    const skillErrors = checkComposition(changedSkill, decision, bundle).join("\n");
    expect(skillErrors).toMatch(/assets candidate claude-skills:example-review has digest sha256:1+, but sha256:8+ is attached/);
    expect(skillErrors).toMatch(/attached skill claude-skills:example-review was not rendered/);
  });

  it("cannot finalize a revision whose bundle excluded an attached skill", () => {
    const request = bundleFixture("valid/two-skill.request.json") as BundleRequest;
    const response = structuredClone(bundleFixture("valid/two-skill.response.json") as BundleResponse);
    const tests = response.manifest.included.find((e) => e.ref === "claude-skills:example-tests")!;
    response.manifest.included = response.manifest.included.filter((e) => e !== tests);
    response.manifest.excluded.push({ kind: "skill", ref: tests.ref, reason: "over budget" });
    expect(checkComposition(spec, decision, { request, response })).toContain("attached skill claude-skills:example-tests was not rendered into the bundle");
  });

  it("accepts an older stored minor and rejects a newer one", () => {
    expect(errorsOf(validateAgentSpec({ ...spec, schema_version: "1.1" }))).toMatch(/unsupported schema_version "1.1"/);
    expect(errorsOf(validateAgentSpec(spec, "1.3"))).toBe("");
  });
});
