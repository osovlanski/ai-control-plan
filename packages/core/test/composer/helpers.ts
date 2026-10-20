/**
 * Shared fixtures for the Composer tests: a base input set, fake ports, and the structural checks
 * apps/api's composition validators make (core tests cannot import them).
 */
import { expect } from "vitest";
import {
  COMPOSER_STAGES, COMPOSITION_SCHEMA_VERSION, jcs, NO_CONSUMPTION,
  type AgentSpecDraft, type BundlePort, type BundlePortResult, type BundleRenderDraft, type BundleRequest, type BundleResponse,
  type ComposeResult, type ComposerAsset, type ComposerDeps, type ComposerInputs, type CompositionDecisionDraft,
  type HarnessModelPort, type HarnessModelProjection, type HarnessModelRequest, type ManifestExcluded, type ManifestIncluded,
} from "../../src/index.js";

// Core has no node types; the hash is node's, reached without them.
const nodeCrypto = (await import("node:" + "crypto")) as { createHash(alg: string): { update(t: string, e: string): { digest(f: string): string } } };
export const sha256 = (text: string) => nodeCrypto.createHash("sha256").update(text, "utf8").digest("hex");
export const deps: ComposerDeps = { sha256 };
export const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
export const digestOf = (seed: string) => `sha256:${sha256(seed)}`;

export const skill = (name: string, over: Partial<ComposerAsset> = {}): ComposerAsset => ({
  id: `claude-skills:${name}`,
  digest: digestOf(`skill:${name}`),
  kind: "skill",
  enabled: true,
  tags: [],
  compatibility: { assistants: ["claude", "codex"] },
  requirements: { secretRefs: [] },
  conflicts: [],
  lineage: { origin: "library" },
  ...over,
});

export const PACKAGE_JSON = JSON.stringify({ name: "fixture", dependencies: { fastify: "^5.0.0" }, devDependencies: { typescript: "^5.9.0", vitest: "^3.2.0" } });

export function baseInputs(over: Partial<ComposerInputs> = {}): ComposerInputs {
  const tsReview = skill("ts-review", { tags: ["review", "typescript"] });
  const prWriter = skill("pr-writer", { tags: ["coding"] });
  return {
    task: { id: "AG-0042", goal: "Fix the flaky retry test in the scheduler", constraints: [], storedKind: "coding" },
    repoSignals: {
      status: "ok",
      baseCommit: "0123456789abcdef0123456789abcdef01234567",
      files: [
        { relPath: "package.json", content: PACKAGE_JSON, truncated: false },
        { relPath: "tsconfig.json", content: "{}", truncated: false },
      ],
    },
    registry: {
      status: "ok",
      snapshotDigest: digestOf("snapshot"),
      observedAt: "2026-10-18T08:00:00.000Z",
      stale: false,
      assets: [prWriter, tsReview],
    },
    optIns: [],
    environment: { envNames: [], commands: [] },
    config: {
      maxSkills: 3,
      allowlist: [{ id: tsReview.id, digest: tsReview.digest }, { id: prWriter.id, digest: prWriter.digest }],
      fragments: ["typescript-style", "repo:example"],
      memoryBundles: [],
      charsPerToken: 3.5,
      tokenBudget: 12000,
      policy: { riskPermission: { high: "prompt-on-escalation" }, permitAmbient: true, permitPartial: false },
      budget: { max_tokens: 200000, max_runtime_ms: 1800000 },
    },
    workspacePolicy: { policyId: "workspace-policy:personal", approvalMode: "auto-approve", toolAllowlist: [] },
    consumed: NO_CONSUMPTION,
    confirm: { mode: "preview" },
    forbiddenHostnames: ["fixture-host.example", "127.0.0.1"],
    ...over,
  };
}

export function projection(over: Partial<HarnessModelProjection> = {}): HarnessModelProjection {
  return {
    candidates: [
      { assistantId: "personal-claude", modelId: "example-model", quotaUsedPercent: 12, telemetryRuns: 4 },
      { assistantId: "personal-claude", modelId: "example-model-small" },
      { assistantId: "work-codex", modelId: "example-codex-model" },
    ],
    filters: [{ filter: "quota_blocked", assistantIds: ["work-codex"], kinds: ["rate_limit"] }],
    chosen: {
      assistantId: "personal-claude", modelId: "example-model", harness: "claude-code", modelSource: "manifest-first",
      acceptedApprovalModes: ["auto-approve", "prompt-on-escalation", "read-only"], usageReporting: false,
    },
    ruleFired: "preserve-quota: most headroom",
    ...over,
  };
}

export interface FakeHarnessModel extends HarnessModelPort { calls: HarnessModelRequest[] }
export function fakeHarnessModel(answer: HarnessModelProjection | ((req: HarnessModelRequest) => HarnessModelProjection) = projection()): FakeHarnessModel {
  const calls: HarnessModelRequest[] = [];
  return {
    calls,
    async select(req) {
      calls.push(clone(req));
      return typeof answer === "function" ? answer(req) : clone(answer);
    },
  };
}

export interface RenderPlan {
  /** Skills to exclude, by id, with Cockpit's reason. */
  excludeSkills?: Record<string, string>;
  excludeFragments?: Record<string, string>;
  failure?: BundlePortResult & { status: "failure" };
}

export function requestFor(draft: BundleRenderDraft, options: { charsPerToken: number; tokenBudget: number }): BundleRequest {
  return {
    schemaVersion: "1.0",
    harness: draft.harness,
    fragments: [...draft.context.fragments],
    memoryBundles: draft.context.memory_bundles.map(({ id, digest }) => ({ id, digest })),
    skills: draft.assets.skills.map(({ id, digest }) => ({ id, digest })),
    model: { id: draft.model.primary.id, charsPerToken: options.charsPerToken },
    tokenBudget: options.tokenBudget,
  };
}

/** A plausible Cockpit response for a request: every input included unless the plan excludes it. */
export function responseFor(request: BundleRequest, plan: RenderPlan = {}): BundleResponse {
  const included: ManifestIncluded[] = [];
  const excluded: ManifestExcluded[] = [];
  for (const f of request.fragments) {
    const reason = plan.excludeFragments?.[f];
    if (reason) excluded.push({ kind: "fragment", ref: f, reason });
    else included.push({ kind: "fragment", ref: f, digest: digestOf(`fragment:${f}`), reason: "requested" });
  }
  for (const m of request.memoryBundles) included.push({ kind: "memory_bundle", ref: m.id, digest: m.digest, reason: "pinned" });
  for (const s of request.skills) {
    const reason = plan.excludeSkills?.[s.id];
    if (reason) excluded.push({ kind: "skill", ref: s.id, reason });
    else included.push({ kind: "skill", ref: s.id, digest: s.digest, reason: "selected", relPath: `.claude/skills/${s.id.split(":")[1]}/SKILL.md` });
  }
  const content = `# bundle\n${included.map((i) => i.ref).join("\n")}\n`;
  return {
    schemaVersion: "1.0",
    files: [{ relPath: "CLAUDE.md", content, digest: digestOf(content) }],
    manifest: {
      harness: request.harness,
      bundleDigest: digestOf(jcs(request, "finite") + JSON.stringify(excluded)),
      compiler: { name: "cockpit-context-compiler", version: "1.0.0" },
      included,
      excluded,
      tokens: { estimated: 812, tokenMethod: "estimated", charsPerToken: request.model.charsPerToken, budget: request.tokenBudget },
    },
  };
}

export interface FakeBundle extends BundlePort { calls: Array<{ draft: BundleRenderDraft; options: { charsPerToken: number; tokenBudget: number } }> }
/** Renders per plan; `plans[i]` answers the i-th render (the last plan repeats). */
export function fakeBundle(...plans: RenderPlan[]): FakeBundle {
  const calls: FakeBundle["calls"] = [];
  return {
    calls,
    async render(draft, options) {
      calls.push({ draft: clone(draft), options: { ...options } });
      const plan = plans[Math.min(calls.length - 1, plans.length - 1)] ?? {};
      if (plan.failure) return plan.failure;
      const request = requestFor(draft, options);
      const response = responseFor(request, plan);
      const excludedSkills = response.manifest.excluded.filter((e) => e.kind === "skill").map(({ ref, reason }) => ({ ref, reason }));
      return excludedSkills.length ? { status: "not_final", response, excludedSkills } : { status: "ok", request, response };
    },
  };
}

const sorted = (values: readonly string[]) => values.every((v, i) => i === 0 || values[i - 1]! < v);

/** The structural rules of validateCompositionDecision, plus canonical order (§4.3). */
export function checkDecision(decision: CompositionDecisionDraft): string[] {
  const errors: string[] = [];
  if (decision.schema_version !== COMPOSITION_SCHEMA_VERSION) errors.push(`schema_version ${decision.schema_version}`);
  if (decision.stages.map((s) => s.stage).join(",") !== COMPOSER_STAGES.join(",")) errors.push("stage order");
  decision.stages.forEach((stage, i) => {
    const refs = stage.candidates.map((c) => c.ref);
    if (!sorted(refs)) errors.push(`${i} candidates not sorted and unique`);
    const known = new Set(refs);
    const removed = new Set(stage.filters.flatMap((f) => f.removed));
    for (const f of stage.filters) {
      if (!sorted(f.removed) || f.removed.length === 0) errors.push(`${i} filter ${f.filter} removed not sorted or empty`);
      if (!/^[a-z][a-z0-9_]{0,63}$/.test(f.filter)) errors.push(`${i} filter name ${f.filter}`);
      if (!f.reason || f.reason.length > 512) errors.push(`${i} filter reason length`);
    }
    for (const r of removed) if (!known.has(r)) errors.push(`${i} removed ${r} not a candidate`);
    if (!sorted(stage.chosen)) errors.push(`${i} chosen not sorted`);
    for (const r of stage.chosen) {
      if (!known.has(r)) errors.push(`${i} chose ${r}, not a candidate`);
      if (removed.has(r)) errors.push(`${i} chose ${r}, which a filter removed`);
    }
    if (!stage.why || stage.why.length > 2048) errors.push(`${i} why length`);
    for (const c of stage.candidates) for (const e of c.evidence ?? []) if (!e || e.length > 512) errors.push(`${i} evidence length`);
    if (stage.override) {
      for (const r of stage.override.from) if (!known.has(r)) errors.push(`${i} override from ${r} not a candidate`);
      if (JSON.stringify([...stage.override.to].sort()) !== JSON.stringify([...stage.chosen].sort())) errors.push(`${i} override to != chosen`);
      if (stage.override.actor !== "operator") errors.push(`${i} override actor`);
    }
  });
  return errors;
}

/** The spec rules of validateAgentSpec and checkComposition that a draft can already meet. */
export function checkSpec(spec: AgentSpecDraft, decision: CompositionDecisionDraft, bundle?: { request: BundleRequest; response: BundleResponse }): string[] {
  const errors: string[] = [];
  if (spec.schema_version !== COMPOSITION_SCHEMA_VERSION) errors.push("schema_version");
  if (!sorted(spec.intent.domains)) errors.push("domains");
  if (!sorted(spec.context.fragments)) errors.push("fragments");
  if (!sorted(spec.context.memory_bundles.map((m) => m.id))) errors.push("memory_bundles");
  if (!sorted(spec.policy.tool_allowlist)) errors.push("tool_allowlist");
  if (!sorted(spec.assets.skills.map((s) => s.id))) errors.push("skills");
  for (const s of spec.assets.skills) {
    if (!s.allowlisted && !s.opt_in) errors.push(`${s.id} unallowlisted without opt-in`);
    if (s.opt_in && s.opt_in.digest !== s.digest) errors.push(`${s.id} opt-in digest`);
  }
  if (!/^sha256:[0-9a-f]{64}$/.test(spec.policy.revision.digest)) errors.push("policy digest");
  const assets = decision.stages.find((s) => s.stage === "assets")!;
  if (assets.chosen.join("\n") !== spec.assets.skills.map((s) => s.id).join("\n")) errors.push("assets chosen != spec skills");
  for (const s of spec.assets.skills) if (assets.candidates.find((c) => c.ref === s.id)?.digest !== s.digest) errors.push(`${s.id} candidate digest`);
  if (bundle) {
    const { request, response } = bundle;
    if (response.manifest.bundleDigest !== spec.context.bundle_digest) errors.push("bundle digest");
    if (request.harness !== spec.harness) errors.push("bundle harness");
    if (request.model.id !== spec.model.primary.id) errors.push("bundle model");
    if (request.fragments.join("\n") !== spec.context.fragments.join("\n")) errors.push("bundle fragments");
    if (request.skills.map((s) => `${s.id}@${s.digest}`).join() !== spec.assets.skills.map((s) => `${s.id}@${s.digest}`).join()) errors.push("bundle skills");
    if (response.manifest.excluded.some((e) => e.kind === "skill")) errors.push("bundle not final");
    if (response.manifest.tokens.estimated !== spec.context.compiler.tokens) errors.push("tokens");
  }
  return errors;
}

export function expectValid(result: ComposeResult) {
  expect(checkDecision(result.decision)).toEqual([]);
  if (result.specDraft) expect(checkSpec(result.specDraft, result.decision, result.bundle)).toEqual([]);
}

export const stageOf = (result: ComposeResult, stage: (typeof COMPOSER_STAGES)[number]) => result.decision.stages.find((s) => s.stage === stage)!;
