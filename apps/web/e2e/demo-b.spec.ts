/**
 * Demo B — deterministic, repeatable end-to-end walkthrough of K13 model
 * intelligence in truthful SHADOW mode, driven through the Orbital operator UI
 * against a real in-process API + the deterministic FakeAdapter.
 *
 * No network: the benchmark and price priors come from scripted in-process
 * `CatalogSource`s — the same K8 seam Artificial Analysis plugs into. No real
 * provider, no wall-clock waits, no automatic model selection (the activation
 * gate stays closed and `models.selection.enabled` is never set).
 *
 * The flow the screenshots make legible, without reading a log:
 *
 *   user goal
 *     → routing / composition
 *     → candidate assistants/models around the Orbital
 *     → hard filter removes one candidate
 *     → K13 SHADOW recommends another
 *     → actual execution remains unchanged
 *
 * Three scenarios:
 *   1. deterministic recommendation — identity, one AA prior, own telemetry,
 *      n/k/weight, coding/speed/cost evidence, a recommended model, and a
 *      provider request that PROVES execution was untouched.
 *   2. a hard filter beats the benchmark — the excellent-scoring candidate is
 *      quota/enablement-filtered and cannot be recommended; a lower-scoring
 *      eligible candidate wins.
 *   3. a missing prior is honest — a runtime selector whose benchmark identity
 *      cannot be proven carries `priorMissing:coding`, never a fuzzy match, and
 *      execution still works.
 *
 * Run: `pnpm demo:b` (from repo root) or
 *      `pnpm --filter @agent-plane/web exec playwright test e2e/demo-b.spec.ts --project=demo-b`
 */
import { test, expect, type Page } from "@playwright/test";
import {
  AA_NORMALIZATION_VERSION,
  DIMENSION_K,
  HARNESS_MAJOR,
  type AssistantId,
  type RoutingExplanation,
  type RoutingProfile,
} from "@agent-plane/core";
import type { CatalogObservation, CatalogSource } from "../../api/src/modules/model-catalog.js";
import { boot, Clock, type Harness } from "./harness.js";

const A = "fake-a" as AssistantId; // advertises premium-max + swift-mini
const B = "fake-b" as AssistantId; // advertises swift-mini only
const C = "fake-c" as AssistantId; // advertises `nightly` — a moving alias, no AA row

const PREMIUM = "premium-max";
const SWIFT = "swift-mini";
const ALIAS = "nightly";

let h: Harness;

/** K8-shaped external benchmark rows for the catalog seam. */
function benchmarkSource(
  rows: Array<{ provider: string; modelId: string; coding?: number; speed?: number }>,
): CatalogSource {
  return {
    name: "demo-b-benchmark",
    collect: async () => {
      const observedAt = h.clock.current.toISOString();
      const observations: CatalogObservation[] = rows.map((row) => {
        const provenance = {
          source: "external:artificial-analysis" as const,
          tier: "external-benchmark" as const,
          observedAt,
          benchmark: { release: "intelligence-index-4.3", category: "coding", publishedAt: "2026-06-01" },
          normalizationVersion: AA_NORMALIZATION_VERSION,
          attribution: "scripted Demo B prior — no network",
        };
        return {
          modelId: row.modelId,
          provider: row.provider,
          provenance,
          benchmarks: [
            ...(row.coding !== undefined
              ? [{
                  dimension: "coding" as const,
                  normalized: row.coding,
                  raw: { metric: "artificial_analysis_coding_index", value: row.coding * 100, unit: "index-0-100" },
                  sourceModelId: row.modelId,
                  normalizationVersion: AA_NORMALIZATION_VERSION,
                  provenance,
                  freshness: "fresh" as const,
                }]
              : []),
            ...(row.speed !== undefined
              ? [{
                  dimension: "speed" as const,
                  normalized: row.speed,
                  raw: { metric: "median_output_tokens_per_second", value: row.speed * 200, unit: "tokens/second" },
                  sourceModelId: row.modelId,
                  normalizationVersion: AA_NORMALIZATION_VERSION,
                  provenance: { ...provenance, benchmark: { ...provenance.benchmark, category: "speed" } },
                  freshness: "fresh" as const,
                }]
              : []),
          ],
        };
      });
      return { observations };
    },
  };
}

/** One provider-official price row per model — the K7 cost-prior source. */
function priceSource(rows: Array<{ provider: string; modelId: string; inputPerMtok: number; outputPerMtok: number }>): CatalogSource {
  return {
    name: "demo-b-prices",
    collect: async () => ({
      observations: rows.map((row): CatalogObservation => {
        const provenance = {
          source: "provider-api" as const,
          tier: "provider-official" as const,
          observedAt: h.clock.current.toISOString(),
          normalizationVersion: "1.0",
          attribution: "scripted Demo B price — no network",
        };
        return {
          modelId: row.modelId,
          provider: row.provider,
          provenance,
          pricing: [{
            inputPerMtok: row.inputPerMtok,
            outputPerMtok: row.outputPerMtok,
            currency: "USD" as const,
            pricingVersion: "demo-b-prices-1",
            appliesTo: { servingProvider: "fake", accountKind: "api" },
            provenance,
          }],
        };
      }),
    }),
  };
}

/**
 * Insert a finished coding run that carries every canonical factor (success,
 * test-pass, verification-pass) so it joins the `fake:premium-max` coding
 * cohort. Cohorts are evidence from PAST work, so they hang off their own task.
 */
function recordCodingRun(taskId: string, assistantId: string, resolved: string): void {
  const db = h.db;
  const id = `run_${Math.random().toString(36).slice(2, 10)}`;
  const startedAt = new Date(h.clock.current.getTime() - 10_000).toISOString();
  db.prepare(
    `INSERT INTO runs (id, task_id, assistant_id, state, started_at, ended_at, usage, model_requested, model_resolved, model_resolved_source, harness_major)
     VALUES (?, ?, ?, 'ENDED_OK', ?, ?, ?, NULL, ?, 'run.started', ?)`,
  ).run(id, taskId, assistantId, startedAt, h.clock.current.toISOString(),
    JSON.stringify({ inputTokens: 4000, outputTokens: 400 }), resolved, HARNESS_MAJOR);
  db.prepare(
    `INSERT INTO execution_results (session_id, terminal_state, outcome, result, at) VALUES (?, 'COMPLETED', 'completed', ?, ?)`,
  ).run(id, JSON.stringify({ outcome: "completed" }), h.clock.current.toISOString());
  let seq = 0;
  const event = (type: string, payload: unknown) =>
    db.prepare("INSERT INTO events (run_id, seq, ts, type, payload) VALUES (?, ?, ?, ?, ?)")
      .run(id, (seq += 1), h.clock.current.toISOString(), type, JSON.stringify(payload));
  event("test.result", { passed: 1, failed: 0 });
  event("verification.result", { passed: true });
}

test.beforeAll(async () => {
  h = await boot(
    4179,
    "demo-b",
    {
      [A]: { provider: "fake", accountKind: "api", options: { models: [{ id: PREMIUM }, { id: SWIFT }] } },
      [B]: { provider: "fake", accountKind: "api", options: { models: [{ id: SWIFT }] } },
      [C]: { provider: "fake", accountKind: "api", options: { models: [{ id: ALIAS }] } },
    },
    new Clock(),
    (config) => {
      // K13 ships SHADOW. Demo B never flips this — the point is real evidence.
      config.models.selection.enabled = false;
      config.execution = { harnessModes: { single: true } };
    },
    new Map(),
    [
      benchmarkSource([
        // premium-max: excellent coding, modest speed. swift-mini: the inverse.
        { provider: "fake", modelId: PREMIUM, coding: 0.92, speed: 0.45 },
        { provider: "fake", modelId: SWIFT, coding: 0.55, speed: 0.9 },
        // No row for `nightly` — the alias must not fuzzy-match onto premium-max.
      ]),
      priceSource([
        { provider: "fake", modelId: PREMIUM, inputPerMtok: 15, outputPerMtok: 75 },
        { provider: "fake", modelId: SWIFT, inputPerMtok: 1, outputPerMtok: 4 },
      ]),
    ],
  );
  await h.built.modelCatalog.refresh();

  // A real coding cohort for fake-a on premium-max, at exactly k runs, so the
  // recommendation shows own telemetry blended against the AA prior.
  const past = h.built.tasks.create({ goal: "Implement the earlier parser milestone" });
  for (let i = 0; i < DIMENSION_K.coding; i += 1) recordCodingRun(past.taskId, A, PREMIUM);
});

test.afterAll(async () => h.close());

/** Route a fresh task at intake and hand back its persisted recommendation. */
function routeFresh(
  goal: string,
  opts: { profile?: RoutingProfile; overrides?: { assistantId?: AssistantId; model?: string } } = {},
) {
  const task = h.built.tasks.create({
    goal,
    ...(opts.profile ? { profile: opts.profile } : {}),
    ...(opts.overrides ? { overrides: opts.overrides } : {}),
  });
  const { explanation } = h.built.orchestrator.routeTask(task.taskId, "intake");
  return { taskId: task.taskId, explanation: explanation as RoutingExplanation };
}

/** Computed-style read of the two relationship strokes. ACTUAL must be solid
 *  (dash array none / all-zero), SHADOW must be dashed (non-empty) — asserted
 *  against getComputedStyle, never class presence (P1-3, §9-E). */
async function relationshipStrokes(page: Page) {
  return page.evaluate(() => {
    const solid = (v: string | null) => !v || v === "none" || /^(0px\s*)+$/.test(v.trim());
    const a = document.querySelector("path.rel-actual");
    const s = document.querySelector("path.rel-shadow");
    const da = a && getComputedStyle(a).strokeDasharray;
    const ds = s && getComputedStyle(s).strokeDasharray;
    return {
      hasActual: !!a,
      hasShadow: !!s,
      actualDash: da ?? null,
      shadowDash: ds ?? null,
      actualSolid: !!a && solid(da),
      shadowDashed: !!s && !solid(ds),
      pathActual: a?.getAttribute("d") ?? null,
      pathShadow: s?.getAttribute("d") ?? null,
    };
  });
}

/** Force / clear the executing visual state deterministically (no wall-clock
 *  wait on a real run) so the running relationship styling can be verified and
 *  captured. */
const forceExecuting = (page: Page) =>
  page.evaluate(() => document.querySelector(".sphere-scene")!.classList.add("is-executing"));
const clearExecuting = (page: Page) =>
  page.evaluate(() => document.querySelector(".sphere-scene")!.classList.remove("is-executing"));

async function selectAndOpenDecision(page: Page, taskId: string) {
  const inspector = page.getByRole("region", { name: "Selected task inspector" });
  await page.getByRole("textbox", { name: "Search tasks" }).fill(taskId);
  await page.getByRole("button", { name: new RegExp(taskId) }).first().click();
  await expect(inspector.getByRole("code")).toContainText(taskId);
  await inspector.getByRole("button", { name: "Decision", exact: true }).click();
  return inspector;
}

/**
 * Structural / perceptual convergence with `Agentic_OS_View.png`, asserted at
 * whatever viewport the caller has already set. Deliberately layout-level, not
 * pixel-level: the reference is design language, the Control Plane is truth.
 */
async function assertReferenceComposition(page: Page) {
  const composer = page.getByRole("textbox", { name: "What should Agentic OS do?" });
  // 1 + 18. The command composer is the primary surface and above the fold.
  await expect(composer).toBeInViewport();

  const main = await page.locator(".os-main").boundingBox();
  const map = await page.locator(".orbital-map").boundingBox();
  const scene = await page.locator(".sphere-scene").boundingBox();
  // 2. The Orbital region owns ~44%+ of the usable workspace width.
  expect(map!.width).toBeGreaterThan(main!.width * 0.44);
  // 3. The sphere dominates that region — not a small inset widget.
  expect(scene!.width).toBeGreaterThan(map!.width * 0.8);

  // 14. No horizontal overflow at this width.
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
}

// ===========================================================================
// SCENARIO 1 — DETERMINISTIC SHADOW RECOMMENDATION
// ===========================================================================
test("Demo B/1: deterministic SHADOW recommendation, and the provider request proves execution was untouched", async ({ context }, testInfo) => {
  const consoleErrors: string[] = [];
  const page = await h.openApp(context);
  page.on("console", (m) => m.type() === "error" && consoleErrors.push(m.text()));
  page.on("pageerror", (e) => consoleErrors.push(String(e)));
  await page.setViewportSize({ width: 1440, height: 900 });

  // 1a. Initial Overview / command state — the composer is the primary entry.
  await expect(page.getByRole("textbox", { name: "What should Agentic OS do?" })).toBeInViewport();
  await assertReferenceComposition(page);
  await page.screenshot({ path: testInfo.outputPath("demo-b-0-overview.png") });
  await page.screenshot({ path: testInfo.outputPath("demo-b-0-overview-command-state.png") });

  const { taskId, explanation } = routeFresh("Implement the streaming JSON parser", { profile: "best-quality" });
  const rec = explanation.modelRecommendation!;

  // --- backend truth the screenshot then shows -----------------------------
  expect(rec.mode).toBe("shadow");
  expect(rec.activation.active).toBe(false);
  expect(rec.recommended).toBe(`${A}/${PREMIUM}`);

  const winner = rec.candidates.find((c) => c.label === rec.recommended)!;
  expect(winner.identity.basis).toBe("catalog-exact");
  const coding = winner.dimensions.find((d) => d.dimension === "coding")!;
  expect(coding.prior?.source).toBe("external:artificial-analysis");
  expect(coding.prior?.normalizationVersion).toBe(AA_NORMALIZATION_VERSION);
  expect(coding.prior?.value).toBeCloseTo(0.92, 6);
  expect(coding.n).toBe(DIMENSION_K.coding);
  expect(coding.weight).toBeCloseTo(0.5, 6); // w(k) = k/(k+k) = 0.5
  expect(coding.telemetry?.metric).toContain("success");
  expect(winner.dimensions.find((d) => d.dimension === "speed")?.prior?.value).toBeCloseTo(0.45, 6);
  expect(winner.dimensions.find((d) => d.dimension === "cost")?.prior?.source).toBe("k7:price-evidence");

  // `nightly` cannot be scored: its benchmark identity is unproven.
  const aliasCandidate = rec.candidates.find((c) => c.assistantId === C)!;
  expect(aliasCandidate.dimensions.find((d) => d.dimension === "coding")?.missing).toContain("priorMissing:coding");

  // --- the operator surface ---------------------------------------------------
  const inspector = await selectAndOpenDecision(page, taskId);
  await expect(inspector.getByText("Shadow model recommendation")).toBeVisible();
  await expect(inspector.getByText(/Current execution:/)).toContainText("unchanged");
  await expect(inspector.getByText(/Because:/)).toBeVisible();
  await expect(inspector.getByText("external:artificial-analysis").first()).toBeVisible();
  await expect(inspector.getByText(/Identity: catalog-exact/)).toBeVisible();

  // Inspector states ACTUAL and SHADOW together, distinctly (§6, §17).
  const split = inspector.locator(".truth-split");
  await expect(split.locator(".truth-actual")).toContainText("Model: unspecified");
  await expect(split.locator(".truth-shadow")).toContainText("SHADOW");
  await expect(split.locator(".truth-shadow")).toContainText(`${A}/${PREMIUM}`);
  await expect(inspector.getByText("APPLIED", { exact: true })).toHaveCount(0);

  // --- the Orbital: model-level ACTUAL vs SHADOW, shown together -----------
  const shadowNode = page.locator(".model-node.is-shadow");
  // 5 + 6. SHADOW state is explicit and carries the MODEL selector, not just the assistant.
  await expect(shadowNode).toHaveCount(1);
  await expect(shadowNode).toContainText(`${A}/${PREMIUM}`);
  await expect(shadowNode).toContainText(PREMIUM);
  await expect(shadowNode).toContainText("SHADOW");
  // 11. The sibling model under the SAME assistant does NOT inherit the shadow style.
  const swiftNode = page.locator(".model-node", { hasText: `${A}/${SWIFT}` });
  await expect(swiftNode).toHaveCount(1);
  await expect(swiftNode).not.toHaveClass(/is-shadow/);
  // 4 + 7. ACTUAL execution state is explicitly present and uses a distinct class.
  const actualChip = page.locator(".model-node.model-actual-chip.is-actual");
  await expect(actualChip).toBeVisible();
  await expect(actualChip).toContainText(A);
  await expect(actualChip).toContainText("Model: unspecified");
  await expect(page.locator(".model-node.is-shadow.is-actual")).toHaveCount(0);
  // 8 + 9 + P1-3. Two relationship PATHS; ACTUAL solid, SHADOW dashed, verified
  // against computed style — pre-execution first.
  await expect(page.locator("path.rel-actual")).toHaveCount(1);
  await expect(page.locator("path.rel-shadow")).toHaveCount(1);
  await expect(page.locator(".satellite.executing")).toHaveCount(0);
  {
    const pre = await relationshipStrokes(page);
    expect(pre.hasActual && pre.hasShadow, "both relationships present pre-exec").toBe(true);
    expect(pre.actualSolid, `pre-exec ACTUAL stroke-dasharray="${pre.actualDash}" must be solid`).toBe(true);
    expect(pre.shadowDashed, `pre-exec SHADOW stroke-dasharray="${pre.shadowDash}" must be dashed`).toBe(true);
  }
  // …then while executing: ACTUAL must NOT convert to dashed (the P1-3 bug).
  await forceExecuting(page);
  {
    const run = await relationshipStrokes(page);
    expect(run.hasActual, "RUNNING: ACTUAL relationship still present").toBe(true);
    expect(run.actualSolid, `RUNNING ACTUAL stroke-dasharray="${run.actualDash}" must stay solid`).toBe(true);
    expect(run.shadowDashed, `RUNNING SHADOW stroke-dasharray="${run.shadowDash}" must stay dashed`).toBe(true);
  }
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: testInfo.outputPath("demo-b-running-unspecified.png") });
  await clearExecuting(page);

  await page.evaluate(() => window.scrollTo(0, 0));
  await assertReferenceComposition(page);
  await page.screenshot({ path: testInfo.outputPath("demo-b-1-viewport-1440x900.png") });
  // Hero: the product at 1440×900 telling the Demo B story — ACTUAL vs SHADOW,
  // model-level, on a dominant Orbital. No test/debug chrome.
  await page.screenshot({ path: testInfo.outputPath("demo-b-hero.png") });
  await page.screenshot({ path: testInfo.outputPath("demo-b-1-shadow-vs-actual.png"), fullPage: true });
  await page.screenshot({ path: testInfo.outputPath("demo-b-1-shadow-recommendation.png"), fullPage: true });

  // 1280×800 must also hold together with no horizontal overflow.
  await page.setViewportSize({ width: 1280, height: 800 });
  await expect(page.getByRole("textbox", { name: "What should Agentic OS do?" })).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await expect(page.locator(".model-node.is-shadow")).toHaveCount(1);
  await page.setViewportSize({ width: 1440, height: 900 });

  // 17. Reduced motion still renders coherently: composer above the fold,
  // both truths still legible, no overflow.
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(page.getByRole("textbox", { name: "What should Agentic OS do?" })).toBeInViewport();
  await expect(page.locator(".model-node.is-shadow")).toContainText("SHADOW");
  await expect(page.locator(".model-node.model-actual-chip")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.emulateMedia({ reducedMotion: null });

  // --- provider request proof: the shadow winner did NOT alter execution ---
  h.built.tasks.transition(taskId, "ROUTING");
  await h.built.orchestrator.startTask(taskId, A);
  await h.waitForState(taskId, "COMPLETED");

  const request = h.db
    .prepare("SELECT model FROM execution_requests WHERE task_id = ? ORDER BY attempt DESC LIMIT 1")
    .get(taskId) as { model: string | null } | undefined;
  expect(request?.model ?? null).toBeNull(); // the task named no model; none was fabricated
  const run = h.db
    .prepare("SELECT model_requested FROM runs WHERE task_id = ? ORDER BY started_at DESC LIMIT 1")
    .get(taskId) as { model_requested: string | null };
  expect(run.model_requested).toBeNull();

  // The persisted recommendation is durable and re-readable: it still says
  // shadow and commits nothing.
  const persisted = JSON.parse(
    (h.db
      .prepare(
        `SELECT explanation FROM routing_decisions
          WHERE task_id = ? AND json_extract(explanation, '$.modelRecommendation') IS NOT NULL
          ORDER BY id ASC LIMIT 1`,
      )
      .get(taskId) as { explanation: string }).explanation,
  ) as RoutingExplanation;
  expect(persisted.modelRecommendation!.mode).toBe("shadow");
  expect(persisted.modelRecommendation!.applied).toBeUndefined();
  expect(persisted.modelRecommendation!.execution.decidedBy).toBe("unchanged");

  expect(consoleErrors, `console errors: ${consoleErrors.join("\n")}`).toEqual([]);
});

// ===========================================================================
// SCENARIO 2 — HARD FILTER BEATS BENCHMARK
// ===========================================================================
test("Demo B/2: an excellent-scoring candidate that fails a hard filter cannot be recommended", async ({ context }, testInfo) => {
  const consoleErrors: string[] = [];
  const page = await h.openApp(context);
  page.on("console", (m) => m.type() === "error" && consoleErrors.push(m.text()));
  page.on("pageerror", (e) => consoleErrors.push(String(e)));
  await page.setViewportSize({ width: 1440, height: 900 });

  // fake-a (premium-max, AA coding 0.92 + own telemetry) is quota-exhausted.
  h.db.prepare(
    `INSERT INTO quota_snapshots (assistant_id, window, account, used_percent, resets_at, source, observed_at)
     VALUES (?, '5h', NULL, 100, NULL, 'provider-api', ?)`,
  ).run(A, h.clock.current.toISOString());
  try {
    const { taskId, explanation } = routeFresh("Implement the retry back-off policy", { profile: "best-quality" });
    const rec = explanation.modelRecommendation!;

    const blocked = rec.candidates.find((c) => c.label === `${A}/${PREMIUM}`)!;
    expect(blocked.eligible).toBe(false);
    expect(blocked.total).toBeUndefined();
    expect(blocked.filterFailures.join(" ")).toMatch(/quota/i);
    // The lower-scoring but eligible candidate wins.
    expect(rec.recommended).toBe(`${B}/${SWIFT}`);
    const winnerCoding = rec.candidates.find((c) => c.label === rec.recommended)!.dimensions.find((d) => d.dimension === "coding")!;
    expect(winnerCoding.prior!.value).toBeLessThan(blocked.dimensions.find((d) => d.dimension === "coding")!.prior!.value);

    const inspector = await selectAndOpenDecision(page, taskId);
    await expect(inspector.getByText("Hard-filtered alternatives:")).toBeVisible();
    await expect(inspector.getByText(`${A}/${PREMIUM}`)).toBeVisible();
    await expect(inspector.getByText(/never resurrects an excluded candidate/)).toBeVisible();
    await expect(inspector.getByText(`${B}/${SWIFT}`).first()).toBeVisible();

    // --- the Orbital reads the exclusion without opening a debug table -------
    // 10. The hard-filtered candidate has its own distinct style.
    const excluded = page.locator(".model-node.is-excluded", { hasText: `${A}/${PREMIUM}` });
    await expect(excluded).toHaveCount(1);
    await expect(excluded).toContainText("EXCLUDED");
    await expect(excluded).not.toHaveClass(/is-shadow/);
    await expect(excluded).not.toHaveClass(/is-actual/);
    // P1-4. The SHORT reason is legible in the hero itself — RENDERED text, not
    // tooltip-only — at 1440×900.
    await expect(excluded).toContainText("Quota exhausted");
    const excludedText = (await excluded.innerText()).replace(/\s+/g, " ").trim();
    expect(excludedText, `visible excluded text: "${excludedText}"`).toContain("Quota exhausted");
    // 13. The full technical routing/filter string is still carried in the title.
    await expect(excluded).toHaveAttribute("title", /quota/i);
    // 12. The excluded candidate is never simultaneously the active shadow winner.
    await expect(page.locator(".model-node.is-excluded.is-shadow")).toHaveCount(0);
    // The lower-scoring but eligible candidate carries SHADOW instead.
    const shadowNode = page.locator(".model-node.is-shadow");
    await expect(shadowNode).toHaveCount(1);
    await expect(shadowNode).toContainText(`${B}/${SWIFT}`);
    await expect(shadowNode).toContainText(SWIFT);

    await page.evaluate(() => window.scrollTo(0, 0));
    await assertReferenceComposition(page);
    await page.screenshot({ path: testInfo.outputPath("demo-b-2-viewport-1440x900.png") });
    await page.screenshot({ path: testInfo.outputPath("demo-b-2-hard-filter.png"), fullPage: true });
    await page.screenshot({ path: testInfo.outputPath("demo-b-2-hard-filter-beats-benchmark.png"), fullPage: true });
    expect(consoleErrors, `console errors: ${consoleErrors.join("\n")}`).toEqual([]);
  } finally {
    h.db.prepare("DELETE FROM quota_snapshots WHERE assistant_id = ?").run(A);
  }

  expect(consoleErrors, `console errors: ${consoleErrors.join("\n")}`).toEqual([]);
});

// ===========================================================================
// SCENARIO 3 — A MISSING PRIOR IS HONEST
// ===========================================================================
test("Demo B/3: a runtime selector whose benchmark identity is unproven shows priorMissing, and execution still works", async ({ context }, testInfo) => {
  const consoleErrors: string[] = [];
  const page = await h.openApp(context);
  page.on("console", (m) => m.type() === "error" && consoleErrors.push(m.text()));
  page.on("pageerror", (e) => consoleErrors.push(String(e)));
  await page.setViewportSize({ width: 1440, height: 900 });

  const { taskId, explanation } = routeFresh("Investigate the nightly build flake", { profile: "best-quality" });
  const rec = explanation.modelRecommendation!;
  const alias = rec.candidates.find((c) => c.label === `${C}/${ALIAS}`)!;

  // The selector resolves to a catalog id (discovery), but NO AA row joins it —
  // and K13 does not fuzzy-match it onto premium-max.
  for (const dim of ["coding", "speed"] as const) {
    expect(alias.dimensions.find((d) => d.dimension === dim)?.missing).toContain(`priorMissing:${dim}`);
  }
  expect(alias.dimensions.every((d) => d.prior === undefined)).toBe(true);

  const inspector = await selectAndOpenDecision(page, taskId);
  await expect(inspector.getByText("Decision", { exact: true })).toBeVisible();
  // The alias candidate is listed with priorMissing, not a borrowed score.
  await expect(inspector.getByText(/priorMissing:coding/).first()).toBeVisible();

  // On the Orbital the alias node stays present and eligible — "prior
  // unavailable", never an error, never a fuzzy-matched score.
  const aliasNode = page.locator(".model-node", { hasText: `${C}/${ALIAS}` });
  await expect(aliasNode).toHaveCount(1);
  await expect(aliasNode).toContainText("prior unavailable");
  await expect(aliasNode).not.toHaveClass(/is-excluded/);
  await expect(aliasNode).not.toHaveClass(/is-shadow/);

  await page.evaluate(() => window.scrollTo(0, 0));
  await assertReferenceComposition(page);
  await page.screenshot({ path: testInfo.outputPath("demo-b-3-viewport-1440x900.png") });
  await page.screenshot({ path: testInfo.outputPath("demo-b-3-missing-prior.png"), fullPage: true });
  await page.screenshot({ path: testInfo.outputPath("demo-b-3-missing-prior-is-honest.png"), fullPage: true });

  // Execution still works under current routing semantics.
  h.built.tasks.transition(taskId, "ROUTING");
  await h.built.orchestrator.startTask(taskId, C);
  await h.waitForState(taskId, "COMPLETED");

  expect(consoleErrors, `console errors: ${consoleErrors.join("\n")}`).toEqual([]);
});

// ===========================================================================
// SCENARIO 4 — ACTUAL + SHADOW ON THE SAME MODEL (P1-1)
// ===========================================================================
test("Demo B/4: ACTUAL and SHADOW that share one model stay independently visible", async ({ context }, testInfo) => {
  const consoleErrors: string[] = [];
  const page = await h.openApp(context);
  page.on("console", (m) => m.type() === "error" && consoleErrors.push(m.text()));
  page.on("pageerror", (e) => consoleErrors.push(String(e)));
  await page.setViewportSize({ width: 1440, height: 900 });

  // The operator pins premium-max; K13 SHADOW would choose the same model. That
  // is one candidate identity carrying TWO independent relationships.
  const { taskId, explanation } = routeFresh("Implement the checkpoint compaction path", {
    profile: "best-quality",
    overrides: { model: PREMIUM },
  });
  const rec = explanation.modelRecommendation!;
  expect(rec.mode).toBe("shadow");
  expect(rec.recommended).toBe(`${A}/${PREMIUM}`);
  expect(rec.execution.requestedModelSelector).toBe(PREMIUM);
  expect(rec.execution.decidedBy).toBe("operator-override");

  await selectAndOpenDecision(page, taskId);

  // ONE node for the shared destination — never duplicated into two fake nodes.
  const shared = page.locator(".model-node", { hasText: `${A}/${PREMIUM}` });
  await expect(shared).toHaveCount(1);
  await expect(shared).toHaveClass(/is-actual/);
  await expect(shared).toHaveClass(/is-shadow/);
  await expect(shared).toContainText("ACTUAL");
  await expect(shared).toContainText("SHADOW");
  // The identity IS the node — no separate assistant-level ACTUAL chip.
  await expect(page.locator(".model-node.model-actual-chip")).toHaveCount(0);
  // The sibling selector under the same assistant inherits neither relationship.
  const sibling = page.locator(".model-node", { hasText: `${A}/${SWIFT}` });
  await expect(sibling).not.toHaveClass(/is-actual/);
  await expect(sibling).not.toHaveClass(/is-shadow/);

  // Two separate relationship paths to the shared node, still visually distinct.
  await expect(page.locator("path.rel-actual")).toHaveCount(1);
  await expect(page.locator("path.rel-shadow")).toHaveCount(1);
  let strokes = await relationshipStrokes(page);
  expect(strokes.pathActual).not.toEqual(strokes.pathShadow); // not one overlapping line
  expect(strokes.actualSolid, `ACTUAL dash="${strokes.actualDash}"`).toBe(true);
  expect(strokes.shadowDashed, `SHADOW dash="${strokes.shadowDash}"`).toBe(true);

  // The Inspector still carries both truths, independently inspectable.
  const inspector = page.getByRole("region", { name: "Selected task inspector" });
  await expect(inspector.locator(".truth-split .truth-actual")).toContainText(PREMIUM);
  await expect(inspector.locator(".truth-split .truth-shadow")).toContainText(`${A}/${PREMIUM}`);

  await page.evaluate(() => window.scrollTo(0, 0));
  await assertReferenceComposition(page);
  await page.screenshot({ path: testInfo.outputPath("demo-b-4-same-model-viewport-1440x900.png") });
  await page.screenshot({ path: testInfo.outputPath("demo-b-4-same-model.png"), fullPage: true });

  // While executing, ACTUAL must stay solid even on the shared node.
  await forceExecuting(page);
  strokes = await relationshipStrokes(page);
  expect(strokes.actualSolid, `RUNNING same-model ACTUAL dash="${strokes.actualDash}"`).toBe(true);
  expect(strokes.shadowDashed).toBe(true);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: testInfo.outputPath("demo-b-running-same-model.png") });
  await clearExecuting(page);

  expect(consoleErrors, `console errors: ${consoleErrors.join("\n")}`).toEqual([]);
});

// ===========================================================================
// SCENARIO 5 — TERMINAL LIFECYCLE TRUTH (P1-2)
// ===========================================================================
test("Demo B/5: a cancelled mission never shows 'will execute' for ACTUAL", async ({ context }, testInfo) => {
  const consoleErrors: string[] = [];

  const { taskId } = routeFresh("Draft the migration rollback checklist", { profile: "best-quality" });
  // Real terminal lifecycle from canonical task state (mirrors review.spec's
  // ROUTING → RUNNING → terminal path) — never derived from visual state.
  h.built.tasks.transition(taskId, "ROUTING");
  h.built.tasks.transition(taskId, "RUNNING");
  h.built.tasks.transition(taskId, "CANCELLED");

  const page = await h.openApp(context);
  page.on("console", (m) => m.type() === "error" && consoleErrors.push(m.text()));
  page.on("pageerror", (e) => consoleErrors.push(String(e)));
  await page.setViewportSize({ width: 1440, height: 900 });

  await selectAndOpenDecision(page, taskId);

  const chip = page.locator(".model-node.model-actual-chip");
  await expect(chip).toBeVisible();
  await expect(chip).toContainText("Cancelled");
  const chipText = (await chip.innerText()).replace(/\s+/g, " ").trim();
  expect(chipText, `ACTUAL chip: "${chipText}"`).not.toMatch(/will execute/);
  expect(chipText).toContain("Model: unspecified");

  // The Inspector's ACTUAL panel agrees — terminal truth, no future-execution wording.
  const inspector = page.getByRole("region", { name: "Selected task inspector" });
  const actualPanel = (await inspector.locator(".truth-split .truth-actual").innerText()).replace(/\s+/g, " ");
  expect(actualPanel, `ACTUAL panel: "${actualPanel}"`).not.toMatch(/will execute/);

  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: testInfo.outputPath("demo-b-5-cancelled-viewport-1440x900.png") });
  await page.screenshot({ path: testInfo.outputPath("demo-b-cancelled.png"), fullPage: true });

  expect(consoleErrors, `console errors: ${consoleErrors.join("\n")}`).toEqual([]);
});
