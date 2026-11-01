/**
 * M7: the composition views format what the plane published and never recompute it. Every derived
 * number names its method, and a figure the plane could not supply stays visibly unknown.
 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { AgentSpecDraft, ComposerStage, DecisionStage } from "@agent-plane/core";
import type { BudgetRunSettlement, CompositionBudget, CompositionHistory } from "./api.js";
import { DecisionView } from "./Composition.js";
import { boundRevisions, budgetLines, chosenRefs, rejectedRefs, runCost, runTokens, shortDigest, specRows, stageState, unboundRevisions } from "./composition.js";

const D = (c: string) => `sha256:${c.repeat(64)}`;

const stage = (name: ComposerStage, over: Partial<DecisionStage> = {}): DecisionStage =>
  ({ stage: name, candidates: [], filters: [], chosen: [], why: `why ${name}`, override: null, ...over });

const stages = (): DecisionStage[] => [
  stage("intent", { candidates: [{ ref: "kind:coding", evidence: ["rule kind-coding: matched 'add'"] }, { ref: "complexity:M", evidence: ["rule complexity-unmeasured: K20 records no complexity"] }], chosen: ["complexity:M", "kind:coding"] }),
  stage("harness_model", { candidates: [{ ref: "fake-a/fake-1", evidence: ["quota 12% used"] }, { ref: "fake-b/fake-2" }], chosen: ["fake-a/fake-1"], filters: [{ filter: "cooldown", removed: ["fake-b/fake-2"], reason: "fake-b is cooling down" }] }),
  stage("assets", { candidates: [{ ref: "claude-skills:ts-review", digest: D("a"), evidence: ["tag coding matches"] }], chosen: ["claude-skills:ts-review"] }),
  stage("context", { candidates: [{ ref: "fragment:typescript-style" }], chosen: ["fragment:typescript-style"] }),
  stage("policy", { candidates: [{ ref: "permission:auto" }], chosen: ["permission:auto"] }),
  stage("confirm", { candidates: [{ ref: "start" }], why: "awaiting confirmation" }),
];

const spec = (over: Partial<AgentSpecDraft> = {}): AgentSpecDraft => ({
  schema_version: "1.1", task_id: "AG-1",
  intent: { kind: "coding", domains: ["typescript"], complexity: "M", risk: "normal" },
  harness: "claude-code",
  model: { primary: { id: "fake-1" }, fallbacks: [{ id: "fake-2" }] },
  registry: { snapshot_digest: D("b"), observed_at: "2026-10-19T10:00:00.000Z", stale: false },
  assets: { skills: [{ id: "claude-skills:ts-review", digest: D("a"), allowlisted: true }], mcp_servers: [], subagents: [] },
  context: { fragments: ["typescript-style"], memory_bundles: [], bundle_digest: D("c"), compiler: { name: "fake", version: "1", tokens: 1234, token_method: "estimated", chars_per_token: 4 } },
  policy: { revision: { id: "P-1", digest: D("d") }, permission: "auto", tool_allowlist: [], budget: { max_tokens: 50_000 } },
  provisioning: { requested: "ambient" },
  ...over,
});

describe("decision view model", () => {
  it("shortens a digest for display and says unknown when there is none", () => {
    expect(shortDigest(D("a"))).toBe("sha256:aaaaaaaaaaaa…");
    expect(shortDigest(null)).toBe("unknown");
    expect(shortDigest("not-a-digest")).toBe("not-a-digest");
  });

  it("separates a stage the pipeline never reached from one that chose nothing and one awaiting confirmation", () => {
    expect(stageState(stage("assets", { why: "not run: pipeline stopped at harness_model (no_candidate)" }))).toBe("not_run");
    expect(stageState(stage("assets", { why: "no optional asset fits" }))).toBe("empty");
    expect(stageState(stage("confirm", { why: "awaiting confirmation" }))).toBe("awaiting");
    expect(stageState(stage("confirm", { chosen: ["start"], why: "operator confirmed" }))).toBe("chosen");
  });

  it("pairs each chosen ref with its digest and evidence, and each rejected ref with the filter that removed it", () => {
    const [, harness, assets] = stages() as [DecisionStage, DecisionStage, DecisionStage];
    expect(chosenRefs(assets)).toEqual([{ ref: "claude-skills:ts-review", digest: D("a"), evidence: ["tag coding matches"] }]);
    expect(chosenRefs(harness)).toEqual([{ ref: "fake-a/fake-1", evidence: ["quota 12% used"] }]);
    expect(rejectedRefs(harness)).toEqual([{ ref: "fake-b/fake-2", filter: "cooldown", reason: "fake-b is cooling down" }]);
  });
});

describe("DecisionView", () => {
  it("renders all six stages in order, each with its why, and the chosen asset with its digest", () => {
    const html = renderToStaticMarkup(<DecisionView decision={{ stages: stages() }} outcome={{ status: "composed" }} spec={spec()} digest={D("e")} />);
    const order = ["intent", "harness_model", "assets", "context", "policy", "confirm"].map((s) => html.indexOf(`data-stage="${s}"`));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    for (const s of ["intent", "harness_model", "assets", "context", "policy"]) expect(html).toContain(`why ${s}`);
    expect(html).toContain("awaiting confirmation");
    expect(html).toContain("claude-skills:ts-review");
    expect(html).toContain(`title="${D("a")}"`);
    expect(html).toContain("awaiting your confirmation");
    expect(html).toContain("Composed.");
  });

  it("shows why a composition failed and what a start then does, instead of an empty decision", () => {
    const html = renderToStaticMarkup(<DecisionView decision={{ stages: stages().map((s, i) => (i > 2 ? stage(s.stage, { why: "not run: pipeline stopped at assets (disabled)" }) : s)) }}
      outcome={{ status: "failed", reason: "disabled" }} spec={null} digest={null} />);
    expect(html).toContain("Not composed");
    expect(html).toContain("registry federation is off");
    expect(html).toContain("A start runs on routing alone");
    expect(html).not.toContain("Attaches and enforces");
    expect(html).toContain("not run");
  });

  it("marks complexity and risk guessed, the token figure estimated and an unachieved provisioning unknown", () => {
    const rows = Object.fromEntries(specRows(spec()).map((r) => [r.label, r]));
    expect(rows.Complexity).toMatchObject({ value: "M", method: "guessed" });
    expect(rows.Risk).toMatchObject({ method: "guessed" });
    expect(rows.Context).toMatchObject({ value: "≈ 1,234 tokens at 4 chars/token", method: "estimated" });
    expect(rows.Provisioning).toMatchObject({ method: "unknown" });
    expect(rows["Cost cap"]).toMatchObject({ value: "no cap set" });
    expect(rows["Token cap"]).toMatchObject({ value: "50,000" });
    const html = renderToStaticMarkup(<DecisionView decision={{ stages: stages() }} spec={spec()} />);
    expect(html).toContain("method-guessed");
    expect(html).toContain("method-estimated");
    expect(html).toContain("method-unknown");
  });

  it("shows the plane's parallel share evidence beside that candidate's profile and budget", () => {
    const decision = stages().map((s) => s.stage === "policy" ? stage("policy", {
      candidates: [{ ref: "max_tokens:25000", evidence: ["task cap 50000, consumed 0, remaining 50000", "parallel share 1 of 2: 25000"] }],
      chosen: ["max_tokens:25000"],
    }) : s);
    const html = renderToStaticMarkup(<DecisionView decision={{ stages: decision }} spec={spec({
      policy: { ...spec().policy, budget: { max_tokens: 25_000 } },
      provisioning: { requested: "isolated", achieved: "partial" },
    })} />);
    expect(html).toContain("parallel share 1 of 2: 25000");
    expect(html).toContain("task cap 50000, consumed 0, remaining 50000");
    expect(html).toContain("25,000");
    expect(html).toContain("partial (requested isolated)");
    expect(html).toContain("claude-code");
  });

  it("says nothing is attached when no asset was chosen, rather than listing ambient tooling", () => {
    const html = renderToStaticMarkup(<DecisionView decision={{ stages: stages() }} spec={spec({ assets: { skills: [], mcp_servers: [], subagents: [] } })} />);
    expect(html).toContain("No skill, MCP server or subagent is attached");
  });
});

const run = (over: Partial<BudgetRunSettlement> = {}): BudgetRunSettlement => ({
  runId: "es_1", assistantId: "fake-a", compositionRevisionId: "CR-AG-1-1", model: "fake-1", accounting: "delta",
  tokens: 1000, source: "in_run", inRunTokens: 1000, recordTokens: 0, recordCount: 0, regressed: [], cost: { method: "estimated", usd: 0.01 }, ...over,
});
const budget = (runs: BudgetRunSettlement[], over: Partial<CompositionBudget> = {}): CompositionBudget => ({
  taskId: "AG-1", provisional: true, caps: { max_tokens: 10_000, max_cost_usd: 1 },
  consumed: { tokens: runs.reduce((n, r) => n + r.tokens, 0), costUsd: runs.reduce((n, r) => n + (r.cost.usd ?? 0), 0), costMethod: runs.length ? "estimated" : "none", unknownCostSessions: runs.filter((r) => r.cost.method === "unknown").length, sessions: runs.length, recordCount: 0 },
  remaining: { max_tokens: 10_000 - runs.reduce((n, r) => n + r.tokens, 0), max_cost_usd: 1 - runs.reduce((n, r) => n + (r.cost.usd ?? 0), 0) },
  exhausted: [], latestRevision: null, runs, overruns: [], ...over,
});

describe("budget figures", () => {
  it("never prints a zero for a task that has no runs", () => {
    const [tokens, cost] = budgetLines(budget([]));
    expect(tokens!.consumed).toEqual({ text: "no runs yet" });
    expect(cost!.consumed).toEqual({ text: "no runs yet" });
  });

  it("reads a measured token count and an estimated cost with their methods", () => {
    const [tokens, cost] = budgetLines(budget([run()]));
    expect(tokens).toMatchObject({ cap: "10,000", consumed: { text: "1,000", method: "measured" }, remaining: { text: "9,000", method: "measured" } });
    expect(cost).toMatchObject({ cap: "$1.00", consumed: { text: "$0.0100", method: "estimated" }, remaining: { text: "$0.9900", method: "estimated" } });
  });

  it("treats a run whose assistant reports no usage as unknown tokens, not zero spent", () => {
    const silent = run({ accounting: "none", tokens: 0, inRunTokens: 0 });
    expect(runTokens(silent)).toMatchObject({ text: "unknown", method: "unknown" });
    const [tokens] = budgetLines(budget([silent]));
    expect(tokens!.consumed).toMatchObject({ text: "unknown", method: "unknown" });
    // The remainder is an upper bound when an unreporting run sits next to a reporting one.
    const [mixed] = budgetLines(budget([run(), silent]));
    expect(mixed!.consumed).toMatchObject({ text: "at least 1,000" });
    expect(mixed!.remaining).toMatchObject({ text: "at most 9,000" });
  });

  it("keeps a session of unknown cost visibly unknown and bounds the remainder instead of subtracting it", () => {
    const unpriced = run({ runId: "es_2", cost: { method: "unknown" } });
    expect(runCost(unpriced)).toMatchObject({ text: "unknown", method: "unknown" });
    const [, only] = budgetLines(budget([unpriced]));
    expect(only!.consumed).toMatchObject({ text: "unknown", method: "unknown" });
    const [, cost] = budgetLines(budget([run(), unpriced]));
    expect(cost!.consumed).toMatchObject({ text: "at least $0.0100", note: "1 session(s) of unknown cost" });
    expect(cost!.remaining).toMatchObject({ text: "at most $0.9900" });
  });

  it("says no cap is set instead of rendering an infinite remainder", () => {
    const [tokens, cost] = budgetLines(budget([run()], { caps: {}, remaining: {} }));
    expect(tokens).toMatchObject({ cap: "no cap set", remaining: { text: "n/a" } });
    expect(cost).toMatchObject({ cap: "no cap set", remaining: { text: "n/a" } });
  });
});

describe("bound revisions", () => {
  const rev = (id: string) => ({ compositionRevisionId: id, bundleDigest: D("c"), createdAt: "2026-10-19T10:00:00.000Z", spec: spec() as never, decision: { schema_version: "1.1", id: `CD-${id}`, composition_revision_id: id, stages: stages() } });
  const history = (): CompositionHistory => ({ taskId: "AG-1", revisions: [rev("CR-1"), rev("CR-2"), rev("CR-3")], attempts: [], optIns: [] });

  it("orders revisions by the runs that bound them and reports the unbound ones", () => {
    const runs = [{ id: "es_1", compositionRevisionId: "CR-1" }, { id: "es_2", compositionRevisionId: "CR-2" }, { id: "es_3", compositionRevisionId: "CR-2" }, { id: "es_0", compositionRevisionId: null }];
    const bound = boundRevisions(history(), runs);
    expect(bound.map((b) => [b.revision.compositionRevisionId, b.runIds])).toEqual([["CR-1", ["es_1"]], ["CR-2", ["es_2", "es_3"]]]);
    expect(unboundRevisions(history(), bound).map((r) => r.compositionRevisionId)).toEqual(["CR-3"]);
  });

  it("binds nothing for a run with no revision, so the task reads as routing only", () => {
    expect(boundRevisions(history(), [{ id: "es_1" }, { id: "es_2", compositionRevisionId: null }])).toEqual([]);
  });
});

 describe("cost basis", () => {
  it("keeps the plane basis beside the existing method", () => {
    for (const basis of ["in_run", "records", "cache creation at the input rate: no cache-write price"]) {
      expect(runCost(run({ cost: { method: "measured", usd: 0.1, basis } }))).toMatchObject({ method: "measured", note: basis });
    }
    expect(runCost(run())).not.toHaveProperty("note");
  });
});
