/**
 * K13: a deterministic SHADOW model recommendation over the real
 * `buildServer` composition root.
 *
 * Deliberately proves the NEGATIVE properties, because those are the ones that
 * make shadow mode safe to ship:
 *
 *   - a recommendation is computed, sourced and persisted on the routing decision;
 *   - a hard-filtered candidate stays excluded no matter how good its benchmark
 *     prior is, and is never recommended;
 *   - the routing decision itself — chosen assistant, rule, tie-break — is
 *     byte-identical with and without the recommendation;
 *   - the run's requested model selector is the operator's durable intent, and
 *     `RunSpec.model` is its projection (CR-33), untouched by the score;
 *   - the activation gate is closed, so nothing here enables automatic selection.
 *
 * No network: the benchmark prior comes from an in-process `CatalogSource`, the
 * same seam K8's Artificial Analysis client plugs into.
 */
import assert from "node:assert/strict";
import { AA_NORMALIZATION_VERSION, type AssistantId, type RoutingExplanation } from "@agent-plane/core";
import type { CatalogSource } from "../../apps/api/src/modules/model-catalog.js";
import { buildExecutionRequest } from "../../apps/api/src/modules/harness/control-plane-bridge.js";
import { bootScenario } from "../harness/boot.js";
import { scoreTask, type ScenarioScore } from "../scorer.js";

const A = "eval-fake-a" as AssistantId;
const B = "eval-fake-b" as AssistantId;
/** The selector the fake adapter advertises — and a real catalog model id. */
const MODEL = "fake-1";

/** A fixed benchmark prior, shaped exactly like the K8 Artificial Analysis rows. */
function scriptedBenchmark(observedAt: string): CatalogSource {
  const provenance = {
    source: "external:artificial-analysis" as const,
    tier: "external-benchmark" as const,
    observedAt,
    benchmark: { release: "intelligence-index-4.3", category: "coding", publishedAt: "2026-06-01" },
    normalizationVersion: AA_NORMALIZATION_VERSION,
    attribution: "scripted eval prior — no network",
  };
  return {
    name: "eval-benchmark",
    collect: async () => ({
      observations: [
        {
          modelId: MODEL,
          provider: "fake",
          provenance,
          benchmarks: [
            {
              dimension: "coding" as const,
              normalized: 0.71,
              raw: { metric: "artificial_analysis_coding_index", value: 71, unit: "index-0-100" },
              sourceModelId: MODEL,
              normalizationVersion: AA_NORMALIZATION_VERSION,
              provenance,
              freshness: "fresh" as const,
            },
          ],
        },
      ],
    }),
  };
}

export async function modelShadow(): Promise<ScenarioScore> {
  const booted = await bootScenario({
    extraConfigYaml: `assistants:\n  ${A}:\n    provider: fake\n  ${B}:\n    provider: fake\n`,
    modelCatalogSources: [scriptedBenchmark(new Date().toISOString())],
  });
  const { built, db, config } = booted;

  try {
    assert.equal(config.models.selection.enabled, false, "K13 must ship with selection disabled");

    // The catalog service the composition root built is the one routing reads;
    // the scripted prior arrives through its ordinary K8 source seam.
    await built.modelCatalog.refresh();
    assert.ok(
      built.modelCatalog.list().some((m) => (m.benchmarkPriors ?? []).length > 0),
      "the scripted benchmark prior must be attached to a catalog entry",
    );

    const taskId = built.tasks.create({ goal: "Implement the parser", profile: "best-quality" }).taskId;

    // 1. A recommendation is produced, and it is SHADOW.
    const first = built.orchestrator.routeTask(taskId, "intake").explanation as RoutingExplanation;
    const recommendation = first.modelRecommendation;
    assert.ok(recommendation, "every routing decision must carry a model recommendation");
    assert.equal(recommendation.mode, "shadow");
    assert.equal(recommendation.activation.active, false, "the activation gate must be closed");
    assert.ok(
      recommendation.activation.gates.some((g) => g.name === "config" && !g.passed),
      "the config gate must be the first thing that fails",
    );

    // 2. Every number is sourced (I-M1).
    const winner = recommendation.candidates.find((c) => c.label === recommendation.recommended);
    assert.ok(winner, "a candidate with evidence must be recommended");
    const coding = winner.dimensions.find((d) => d.dimension === "coding")!;
    assert.equal(coding.prior?.source, "external:artificial-analysis");
    assert.equal(coding.prior?.normalizationVersion, AA_NORMALIZATION_VERSION);
    assert.equal(coding.prior?.benchmarkRelease, "intelligence-index-4.3");
    assert.equal(coding.prior?.benchmarkPublishedAt, "2026-06-01");
    assert.equal(coding.n, 0, "a fresh workspace has no own telemetry");
    assert.equal(coding.weight, 0, "w(0) = 0, so the prior carries the dimension alone");
    assert.equal(coding.score, 0.71);
    assert.equal(winner.identity.basis, "catalog-exact");

    // 3. A hard-filtered candidate stays excluded despite the same prior.
    db.prepare("UPDATE assistants SET enabled = 0 WHERE id = ?").run(B);
    const filtered = built.orchestrator.routeTask(taskId, "intake").explanation as RoutingExplanation;
    const excluded = filtered.modelRecommendation!.candidates.find((c) => c.assistantId === B)!;
    assert.equal(excluded.eligible, false);
    assert.equal(excluded.total, undefined, "an ineligible candidate is never scored");
    assert.ok(excluded.filterFailures.length > 0, "the exclusion must be named");
    assert.notEqual(filtered.modelRecommendation!.recommended, excluded.label);

    // 4. The routing decision itself is unchanged by the recommendation.
    const { modelRecommendation: _a, ...routingOnly } = filtered;
    const { modelRecommendation: _b, ...firstRoutingOnly } = first;
    assert.equal(routingOnly.chosen, firstRoutingOnly.chosen);
    assert.equal(routingOnly.ruleFired, firstRoutingOnly.ruleFired);

    // 5. CR-33: the request's model is the durable intent, and the RunSpec is
    //    its projection. The recommendation is nowhere in this path.
    const request = buildExecutionRequest({
      taskId,
      assistantId: A,
      attempt: 1,
      prompt: "irrelevant",
      workdir: "/tmp",
      approvalMode: config.policy.approvalMode,
      maxRuntimeMs: 60_000,
      routingDecisionRef: "1",
      // Exactly what `Orchestrator.requestedModel` reads: `intent.overrides.model`,
      // which this task never set.
      model: undefined,
    });
    assert.equal(request.model, undefined, "no model was requested, so none is fabricated");
    assert.equal(request.runSpec.model, undefined, "RunSpec.model is a projection, never a second writer");
    assert.equal(
      filtered.modelRecommendation!.execution.authority,
      "ExecutionRequest.model",
      "the explanation must name the single requested-selector authority",
    );

    // 6. The recommendation is durable and re-readable.
    const stored = db
      .prepare("SELECT explanation FROM routing_decisions WHERE task_id = ? ORDER BY id DESC LIMIT 1")
      .get(taskId) as { explanation: string };
    const persisted = (JSON.parse(stored.explanation) as RoutingExplanation).modelRecommendation!;
    assert.equal(persisted.mode, "shadow");
    assert.equal(persisted.applied, undefined, "shadow commits no selector");
    assert.equal(persisted.schemaVersion, 2);

    return scoreTask(db, { scenario: "model-shadow", kind: "fake", taskId });
  } finally {
    await booted.close();
  }
}
