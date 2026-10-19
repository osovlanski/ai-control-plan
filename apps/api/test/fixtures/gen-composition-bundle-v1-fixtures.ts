/**
 * Regenerates contracts/bundle/v1/fixtures and contracts/composition/v1/fixtures. Every value is
 * fake. Run with
 * `pnpm --filter @agent-plane/api exec tsx test/fixtures/gen-composition-bundle-v1-fixtures.ts`
 * after a contract change, then review the diff: the fixtures are the conformance suite both
 * repositories run, so a change here is a contract change.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { assembleBundle, BUNDLE_CONTRACT_DIR, type BundleRequest, type BundleResponse } from "../../src/bundle-contract.js";
import { COMPOSITION_CONTRACT_DIR, type AgentSpec, type CompositionDecision } from "../../src/composition-contract.js";

const digestOf = (seed: string) => `sha256:${seed.repeat(64).slice(0, 64)}`;
const compiler = { name: "cockpit-context-compiler", version: "1.0.0" };
const FAKE_SECRET = ["fake", "secret", "value", "not", "real"].join("-");

function write(dir: string, name: string, value: unknown) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), `${JSON.stringify(value, null, 2)}\n`);
}

// ---- bundles ---------------------------------------------------------------

const claudeMd = "# Project context\n\n## typescript-style\n\nUse strict TypeScript. Prefer named exports.\n";
const zeroRequest: BundleRequest = {
  schemaVersion: "1.0", harness: "claude-code", fragments: ["typescript-style"], memoryBundles: [], skills: [],
  model: { id: "example-model", charsPerToken: 3.7 }, tokenBudget: 8000,
};
const zeroBundle = assembleBundle({
  request: zeroRequest, compiler,
  rendered: [{ relPath: "CLAUDE.md", content: claudeMd }],
  included: [{ kind: "fragment", ref: "typescript-style", digest: digestOf("a"), reason: "requested by the composition" }],
  excluded: [],
});

const reviewSkill = { id: "claude-skills:example-review", digest: digestOf("1") };
const testsSkill = { id: "claude-skills:example-tests", digest: digestOf("2") };
const memoryNotes = { id: "mem-example-notes", digest: digestOf("d") };
const twoRequest: BundleRequest = {
  schemaVersion: "1.0", harness: "claude-code", fragments: ["repo:example", "typescript-style"],
  memoryBundles: [memoryNotes], skills: [reviewSkill, testsSkill],
  model: { id: "example-model", charsPerToken: 3.7 }, tokenBudget: 8000,
};
const skill = (name: string, body: string) => `---\nname: ${name}\ndescription: Example skill for the composition v1 fixtures.\n---\n\n${body}\n`;
const twoBundle = assembleBundle({
  request: twoRequest, compiler,
  // Deliberately unsorted: assembly sorts by relPath bytes.
  rendered: [
    { relPath: ".claude/skills/example-review/SKILL.md", content: skill("example-review", "Review the diff before committing.") },
    { relPath: "CLAUDE.md", content: `${claudeMd}\n## repo:example\n\nRun the gate before a PR.\n` },
    { relPath: ".claude/skills/example-tests/SKILL.md", content: skill("example-tests", "Write a failing test first.") },
  ],
  included: [
    { kind: "fragment", ref: "typescript-style", digest: digestOf("a"), reason: "requested by the composition" },
    { kind: "fragment", ref: "repo:example", digest: digestOf("b"), reason: "linked from the repository" },
    { kind: "skill", ref: reviewSkill.id, digest: reviewSkill.digest, relPath: ".claude/skills/example-review/SKILL.md", reason: "selected by the composition" },
    { kind: "skill", ref: testsSkill.id, digest: testsSkill.digest, relPath: ".claude/skills/example-tests/SKILL.md", reason: "selected by the composition" },
  ],
  excluded: [{ kind: "memory_bundle", ref: "mem-example-notes", reason: "over the token budget after required fragments" }],
});

const bundleDir = join(BUNDLE_CONTRACT_DIR, "fixtures");
write(join(bundleDir, "valid"), "zero-asset.request.json", zeroRequest);
write(join(bundleDir, "valid"), "zero-asset.response.json", zeroBundle);
write(join(bundleDir, "valid"), "two-skill.request.json", twoRequest);
write(join(bundleDir, "valid"), "two-skill.response.json", twoBundle);

const withFirstPath = (relPath: string): BundleResponse => {
  const copy = structuredClone(twoBundle);
  copy.files[0]!.relPath = relPath;
  return copy;
};
write(join(bundleDir, "invalid"), "absolute-relpath.response.json", withFirstPath("/home/example/.claude/skills/example-review/SKILL.md"));
write(join(bundleDir, "invalid"), "dotdot-relpath.response.json", withFirstPath(".claude/skills/../../outside/SKILL.md"));
write(join(bundleDir, "invalid"), "output-path.request.json", { ...zeroRequest, outputDir: "worktree/.claude" });

// ---- compositions ----------------------------------------------------------

const base = (id: string, bundle: BundleResponse, request: BundleRequest): Omit<AgentSpec, "assets"> => ({
  schema_version: "1.0",
  composition_revision_id: id,
  task_id: "AG-0001",
  intent: { kind: "coding", domains: ["fastify", "typescript"], complexity: "M", risk: "normal" },
  harness: "claude-code",
  model: { primary: { id: "example-model" }, fallbacks: [] },
  registry: { snapshot_digest: digestOf("c"), observed_at: "2026-10-01T09:00:00.000Z", stale: false },
  context: {
    fragments: request.fragments,
    memory_bundles: request.memoryBundles.map((m) => ({ ...m, reason: "linked from repo notes" })),
    bundle_digest: bundle.manifest.bundleDigest,
    compiler: { ...compiler, tokens: bundle.manifest.tokens.estimated, token_method: "estimated", chars_per_token: request.model.charsPerToken },
  },
  policy: { revision: { id: "workspace-policy:example", digest: `sha256:${"9".repeat(64)}` }, permission: "prompt-on-escalation", tool_allowlist: ["Edit", "Read"], budget: { max_tokens: 200000, max_runtime_ms: 1800000 } },
  workspace: { repository_id: "repo-example", branch: "task/AG-0001", worktree_id: "wt-example" },
  provisioning: { requested: "isolated" },
  explanation_ref: `${id}.decision`,
});

const stages = (id: string, assets: Omit<CompositionDecision["stages"][number], "stage" | "override">): CompositionDecision => ({
  schema_version: "1.0",
  id: `${id}.decision`,
  composition_revision_id: id,
  stages: [
    { stage: "intent", candidates: [{ ref: "coding" }, { ref: "review" }], filters: [], chosen: ["coding"], why: "prompt asks for a code change", override: null },
    { stage: "harness_model", candidates: [{ ref: "claude-code/example-model" }], filters: [], chosen: ["claude-code/example-model"], why: "routing decision", override: null },
    { stage: "assets", ...assets, override: null },
    { stage: "context", candidates: [{ ref: "typescript-style" }], filters: [], chosen: ["typescript-style"], why: "repository language", override: null },
    { stage: "policy", candidates: [{ ref: "prompt-on-escalation" }], filters: [], chosen: ["prompt-on-escalation"], why: "workspace default for normal risk", override: null },
    { stage: "confirm", candidates: [{ ref: "operator" }], filters: [], chosen: ["operator"], why: "confirmed before start", override: null },
  ],
});

const zeroSpec: AgentSpec = { ...base("CR-0001-1", zeroBundle, zeroRequest), assets: { skills: [], mcp_servers: [], subagents: [] } };
const zeroDecision = stages("CR-0001-1", {
  candidates: [{ ref: "claude-skills:example-deploy", digest: digestOf("e"), evidence: ["tag deploy does not match intent coding"] }],
  filters: [{ filter: "compatibility", removed: ["claude-skills:example-deploy"], reason: "requires a command the worktree does not provide" }],
  chosen: [],
  why: "no optional asset fits this task; attaching none is the least-privilege composition",
});

const twoSpec: AgentSpec = {
  ...base("CR-0002-1", twoBundle, twoRequest),
  assets: {
    skills: [
      { ...reviewSkill, allowlisted: true },
      { ...testsSkill, allowlisted: false, opt_in: { digest: testsSkill.digest, actor: "operator", at: "2026-10-01T09:05:00.000Z" } },
    ],
    mcp_servers: [],
    subagents: [],
  },
};
const twoDecision = stages("CR-0002-1", {
  candidates: [
    { ref: "claude-skills:example-review", digest: digestOf("1"), evidence: ["tag review matches"] },
    { ref: "claude-skills:example-tests", digest: digestOf("2"), evidence: ["tag testing matches"] },
  ],
  filters: [],
  chosen: ["claude-skills:example-review", "claude-skills:example-tests"],
  why: "both match the coding intent; example-tests is outside the allowlist and was opted in by digest",
});

// 1.1 added intent kind `general` and permission `read-only`. It is rendered with the zero-asset bundle.
const generalId = "CR-0003-1";
const generalSpec: AgentSpec = {
  ...zeroSpec,
  schema_version: "1.1",
  composition_revision_id: generalId,
  task_id: "AG-0003",
  intent: { ...zeroSpec.intent, kind: "general", domains: [] },
  policy: { ...zeroSpec.policy, permission: "read-only", tool_allowlist: ["Read"] },
  workspace: { ...zeroSpec.workspace, branch: "task/AG-0003" },
  explanation_ref: `${generalId}.decision`,
};
const zeroAssets = zeroDecision.stages.find((s) => s.stage === "assets")!;
const generalDecision: CompositionDecision = {
  ...stages(generalId, { candidates: zeroAssets.candidates, filters: zeroAssets.filters, chosen: [], why: zeroAssets.why }),
  schema_version: "1.1",
};
generalDecision.stages[0] = { stage: "intent", candidates: [{ ref: "coding" }, { ref: "general" }], filters: [], chosen: ["general"], why: "no coding, review or research signal; the classifier's fallback", override: null };
generalDecision.stages[4] = { stage: "policy", candidates: [{ ref: "read-only" }], filters: [], chosen: ["read-only"], why: "workspace approval mode is read-only", override: null };

const compDir = join(COMPOSITION_CONTRACT_DIR, "fixtures");
write(join(compDir, "valid"), "zero-asset.agent-spec.json", zeroSpec);
write(join(compDir, "valid"), "zero-asset.decision.json", zeroDecision);
write(join(compDir, "valid"), "two-skill.agent-spec.json", twoSpec);
write(join(compDir, "valid"), "two-skill.decision.json", twoDecision);
write(join(compDir, "valid"), "general-read-only.agent-spec.json", generalSpec);
write(join(compDir, "valid"), "general-read-only.decision.json", generalDecision);

write(join(compDir, "invalid"), "general-read-only-at-1.0.agent-spec.json", { ...generalSpec, schema_version: "1.0" });
const mcpSpec = (secretRef: unknown) => ({
  ...structuredClone(twoSpec),
  assets: { ...twoSpec.assets, mcp_servers: [{ id: "mcp:example-server", digest: digestOf("3"), allowlisted: true, tools_allowed: ["search"], secret_refs: [secretRef] }] },
});
write(join(compDir, "invalid"), "inline-secret.agent-spec.json", mcpSpec(FAKE_SECRET));
const { digest: _dropped, ...noDigest } = twoSpec.assets.skills[0]!;
write(join(compDir, "invalid"), "asset-missing-digest.agent-spec.json", { ...twoSpec, assets: { ...twoSpec.assets, skills: [noDigest, twoSpec.assets.skills[1]] } });
write(join(compDir, "invalid"), "mutable-asset-pointer.agent-spec.json", {
  ...twoSpec,
  assets: { ...twoSpec.assets, skills: [{ ...twoSpec.assets.skills[0]!, version: "latest" }, twoSpec.assets.skills[1]] },
});
