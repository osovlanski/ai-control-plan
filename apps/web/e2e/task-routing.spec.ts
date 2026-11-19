import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import type { ModelRecommendation } from "@agent-plane/core";
import type { RoutingExplanation } from "../src/api.js";
import { A, B, boot, type Harness } from "./harness.js";

let h: Harness;
let errors: string[];
test.beforeEach(async ({ context }, info) => {
  h = await boot(4199, "task-routing", { [A]: { provider: "fake" }, [B]: { provider: "fake" } });
  errors = [];
  context.on("page", page => {
    page.on("pageerror", error => errors.push(error.message));
    page.on("console", message => {
      // The unavailable-read test deliberately returns one routing 503.
      const expected503 = info.tags.includes("@routing-503") && /status of 503/.test(message.text())
        && /\/api\/tasks\/[^/]+\/routing$/.test(message.location().url);
      if (message.type() === "error" && !expected503) {
        errors.push(message.text());
      }
    });
  });
});
test.afterEach(async () => { await h.close(); expect(errors).toEqual([]); });

const at = "2026-09-06T12:00:00.000Z";
function recommendation(applied = false): ModelRecommendation {
  return {
    schemaVersion: 2, mode: applied ? "applied" : "shadow",
    classification: { taskKind: "coding", signals: [], weights: { coding: 1, speed: 0, cost: 0 } },
    recommended: `${A}/premium-max`, reason: "Best recorded coding evidence",
    missingEvidence: [],
    candidates: [{
      assistantId: A, selector: "premium-max", label: `${A}/premium-max`, eligible: true,
      filterFailures: [], advisories: [], total: 0.8, evidenceCoverage: 1,
      identity: { basis: "catalog-exact", resolvedModelKey: "fake:premium-max", evidence: "Exact catalog identity from the recorded fixture" },
      dimensions: [{ dimension: "coding", k: 10, n: 0, weight: 0, score: 0.8, excludedPriors: [],
        prior: { value: 0.8, source: "external:artificial-analysis", tier: "external-benchmark",
          normalizationVersion: "fixture-v1", observedAt: at, freshness: "fresh", selectedBecause: "recorded fixture" } }],
    }],
    activation: { active: applied, gates: [{ name: "enabled", passed: applied, detail: applied ? "Recorded activation enabled" : "Automatic selection is disabled" }] },
    ...(applied ? { applied: { assistantId: A, selector: "premium-max", label: `${A}/premium-max` } } : {}),
    execution: { authority: "ExecutionRequest.model", requestedModelSelector: applied ? "premium-max" : "swift-mini",
      decidedBy: applied ? "k13-recommendation" : "unchanged",
      detail: applied ? "Every activation gate passed; this decision commits premium-max" : "Activation is off; the recorded request is unchanged" },
  };
}
function explanation(modelRecommendation?: ModelRecommendation): RoutingExplanation {
  return { ruleFired: "auto: config preference order", candidates: [
    { assistantId: A, passedFilters: true, filterFailures: [] },
    { assistantId: B, passedFilters: false, filterFailures: ["quota exhausted"] },
  ], modelRecommendation };
}
function record(taskId: string, value: RoutingExplanation, chosen: string | null = A) {
  h.db.prepare("INSERT INTO routing_decisions (task_id, chosen_assistant_id, explanation, at) VALUES (?, ?, ?, ?)")
    .run(taskId, chosen, JSON.stringify(value), at);
}
function run(taskId: string, requested: string | null, resolved: string | null) {
  h.db.prepare(`INSERT INTO runs (id, task_id, assistant_id, state, started_at, ended_at,
    model_requested, model_resolved, model_resolved_source) VALUES (?, ?, ?, 'ENDED_OK', ?, ?, ?, ?, ?)`)
    .run(`run_${taskId}`, taskId, A, at, at, requested, resolved, resolved ? "run.started" : null);
  h.built.tasks.transition(taskId, "ROUTING");
  h.built.tasks.transition(taskId, "RUNNING");
  h.built.tasks.transition(taskId, "COMPLETED");
}
async function open(context: BrowserContext, taskId: string) {
  const page = await h.openApp(context);
  await page.goto(`${h.origin}/#/missions/${taskId}`);
  await page.locator(".task-detail").getByRole("button", { name: "Routing", exact: true }).click();
  return page;
}
const panel = (page: Page) => page.getByRole("region", { name: "Task routing", exact: true });
const latest = (page: Page) => panel(page).getByRole("region", { name: "Latest routing decision", exact: true });

test("a real route preview exposes its persisted decision without starting a run", async ({ context }) => {
  const task = h.built.tasks.create({ goal: "Explain routing for a code review" });
  const api = await h.privileged();
  const response = await api.post(`/api/tasks/${task.taskId}/route`, { data: {} });
  expect(response.ok()).toBe(true);
  const decision = await response.json() as RoutingExplanation;
  expect(decision.modelRecommendation?.mode).toBe("shadow");
  const page = await open(context, task.taskId);
  await expect(latest(page)).toContainText(decision.ruleFired);
  await expect(latest(page)).toContainText(decision.modelRecommendation!.reason);
  await expect(latest(page)).toContainText("SHADOW");
  await expect(panel(page)).toContainText("No run recorded");
  await api.dispose();
});

test("SHADOW keeps a different requested and served model separate; responsive summary and evidence", async ({ context }, info) => {
  const task = h.built.tasks.create({ goal: "Understand the recorded model recommendation" });
  record(task.taskId, explanation(recommendation()));
  run(task.taskId, "swift-mini", "swift-mini-2026-09");
  const page = await open(context, task.taskId);
  await page.emulateMedia({ reducedMotion: "reduce" });
  const summary = latest(page).getByRole("region", { name: "Decision summary" });
  await expect(summary.locator(".truth-actual")).toContainText(A);
  await expect(summary.locator(".truth-actual")).toContainText("Requested model: swift-mini");
  await expect(summary.locator(".truth-shadow")).toContainText(`${A}/premium-max`);
  await expect(summary).toContainText("SHADOW");
  await expect(summary).toContainText("did not change execution");
  await expect(summary).toContainText("Activation is off");
  const identity = panel(page).getByRole("region", { name: "Latest run model identity" });
  await expect(identity).toContainText("swift-mini-2026-09");
  await expect(identity).not.toContainText("premium-max");
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 1000 });
    for (const expanded of [false, true]) {
      await latest(page).locator(".decision-evidence").evaluate((el, open) => { (el as HTMLDetailsElement).open = open; }, expanded);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      expect(await panel(page).evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
      if (width !== 320) await page.screenshot({ path: info.outputPath(`routing-${width}-${expanded ? "evidence" : "summary"}.png`), fullPage: true });
    }
  }
  await expect(latest(page)).toContainText("external:artificial-analysis");
  await expect(latest(page)).toContainText("Own runs 0");
  await latest(page).getByText("Why this is shadow", { exact: false }).click();
  await expect(latest(page).getByText("Automatic selection is disabled", { exact: true })).toBeVisible();
});

test("APPLIED proves only a committed selector, with provider identity unknown", async ({ context }) => {
  const task = h.built.tasks.create({ goal: "Inspect a recorded applied decision" });
  record(task.taskId, explanation(recommendation(true)));
  run(task.taskId, "premium-max", null);
  const page = await open(context, task.taskId);
  const summary = latest(page).getByRole("region", { name: "Decision summary" });
  await expect(summary.locator(".truth-applied")).toContainText("APPLIED");
  await expect(summary).toContainText("Selector committed to execution request");
  await expect(summary).toContainText("Every activation gate passed");
  await expect(summary).toContainText("Check run evidence for the provider-reported model");
  await expect(panel(page).getByRole("region", { name: "Latest run model identity" })).toContainText("Unknown — provider did not report model identity");
  await latest(page).getByText("Routing and model evidence", { exact: true }).click();
  await expect(latest(page)).not.toContainText("Current execution: this model");
});

test("missing routing and missing recommendation remain distinct", async ({ context }) => {
  const task = h.built.tasks.create({ goal: "Inspect missing evidence" });
  const page = await open(context, task.taskId);
  await expect(panel(page)).toContainText("No routing decisions recorded");
  await expect(panel(page)).not.toContainText("No model recommendation");
  record(task.taskId, explanation());
  await page.reload();
  await page.locator(".task-detail").getByRole("button", { name: "Routing", exact: true }).click();
  await expect(latest(page)).toContainText("No model recommendation was recorded");
  await expect(latest(page)).toContainText("Selected assistant: fake-a");
  await expect(latest(page)).not.toContainText("SHADOW");
  await expect(panel(page)).toContainText("No run recorded");
});

test("insufficient evidence retains eligible unscored candidates without inventing a winner", async ({ context }) => {
  const task = h.built.tasks.create({ goal: "Inspect an unresolved selector" });
  const rec = recommendation();
  rec.recommended = undefined;
  rec.reason = "No eligible candidate has usable evidence";
  rec.missingEvidence = ["priorMissing:coding"];
  rec.execution.requestedModelSelector = undefined;
  rec.candidates[0] = { ...rec.candidates[0]!, total: undefined, evidenceCoverage: 0, dimensions: [],
    identity: { basis: "unresolved", evidence: "No observed resolution for this selector" } };
  record(task.taskId, explanation(rec));
  const page = await open(context, task.taskId);
  const summary = latest(page).getByRole("region", { name: "Decision summary" });
  await expect(summary).toContainText("No model recommended");
  await expect(summary).toContainText("Model: unspecified");
  await expect(summary).toContainText("No eligible candidate has usable evidence");
  await expect(summary).not.toContainText("fake-a/premium-max");
  await latest(page).getByText("Routing and model evidence", { exact: true }).click();
  await expect(latest(page).getByText("Eligible, but benchmark identity unproven:")).toBeVisible();
  await expect(latest(page)).toContainText("priorMissing:coding");
});

test("operator overrides and hard exclusions stay authoritative", async ({ context }) => {
  const task = h.built.tasks.create({ goal: "Inspect operator intent" });
  const rec = recommendation();
  rec.recommended = `${A}/swift-mini`;
  rec.candidates.push({ ...rec.candidates[0]!, selector: "swift-mini", label: `${A}/swift-mini` });
  rec.candidates[0] = { ...rec.candidates[0]!, eligible: false, total: undefined, filterFailures: ["operator model override: swift-mini"] };
  rec.userOverride = { selector: "swift-mini", satisfied: true, detail: "Operator intent outranks the recommendation" };
  rec.execution.decidedBy = "operator-override";
  rec.execution.detail = "The operator named a model; execution requests it unchanged";
  record(task.taskId, { ...explanation(rec), userOverride: A });
  const page = await open(context, task.taskId);
  await expect(latest(page).getByRole("region", { name: "Decision summary" })).toContainText("Operator override swift-mini");
  await expect(latest(page)).toContainText("Assistant override: fake-a");
  await latest(page).getByText("Routing and model evidence", { exact: true }).click();
  await expect(latest(page)).toContainText("quota exhausted");
  await expect(latest(page)).toContainText("operator model override: swift-mini");
  await expect(latest(page).locator("li").filter({ hasText: "fake-a/premium-max" })).toContainText("Excluded");
});

test("history preserves initial, failover and continuation decisions even with equal timestamps", async ({ context }) => {
  const task = h.built.tasks.create({ goal: "Inspect routing history" });
  record(task.taskId, { ...explanation(recommendation(true)), ruleFired: "initial selection" });
  record(task.taskId, { ...explanation(), origin: "failover", candidates: [
    { assistantId: A, passedFilters: false, filterFailures: ["assistant exhausted"] },
    { assistantId: B, passedFilters: true, filterFailures: [] },
  ] }, B);
  record(task.taskId, { ...explanation(), origin: "context-yield", candidates: [] }, null);
  const page = await open(context, task.taskId);
  await expect(latest(page)).toContainText("Context continuation");
  await expect(latest(page)).toContainText("None selected");
  await latest(page).getByText("Routing and model evidence", { exact: true }).click();
  await expect(latest(page)).toContainText("No assistant eligibility evidence was recorded");
  const old = panel(page).getByRole("region", { name: "Earlier decision 1", exact: true });
  await expect(old).not.toBeVisible();
  await panel(page).getByText("Earlier routing decisions (2)", { exact: true }).click();
  await expect(old).toBeVisible();
  await expect(old).toContainText("initial selection");
  await expect(old).toContainText("APPLIED");
  await expect(old).not.toContainText("Executing");
  const failover = panel(page).getByRole("region", { name: "Earlier decision 2", exact: true });
  await expect(failover).toContainText("Failover");
  await expect(failover).toContainText(`Selected assistant: ${B}`);
});

test("unavailable routing read does not claim empty history or fabricate a recommendation", { tag: "@routing-503" }, async ({ context }) => {
  const task = h.built.tasks.create({ goal: "Inspect unavailable routing" });
  record(task.taskId, explanation(recommendation()));
  await context.route(`**/api/tasks/${task.taskId}/routing`, route => route.fulfill({ status: 503, json: { error: "fixture unavailable" } }));
  const page = await open(context, task.taskId);
  await expect(panel(page)).toContainText("Routing evidence unavailable in this read");
  await expect(panel(page)).not.toContainText("No routing decisions recorded");
  await expect(panel(page)).not.toContainText("No model recommendation");
  await expect(panel(page)).not.toContainText("SHADOW");
});
