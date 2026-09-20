import { test, expect } from "@playwright/test";
import type { CatalogModel, TaskContext } from "../src/api.js";
import { boot, A, type Harness } from "./harness.js";

let h: Harness;
test.beforeEach(async () => {
  h = await boot(4187, "operator-closure", { [A]: { provider: "fake" } });
});
test.afterEach(async () => { await h.close(); });

const provenance = { source: "provider-discovery", tier: "provider-official" as const, observedAt: "2026-09-01T00:00:00Z" };
const model: CatalogModel = {
  modelKey: "test:recorded-model", modelId: "recorded-model", provider: "test",
  aliases: [], availableVia: [], status: "unknown", freshness: "stale", catalogRevision: "fixture-1",
  provenance,
  contextWindowTokens: { value: 200_000, provenance },
  capabilities: { value: { tools: true }, provenance: { ...provenance, source: "capability-evidence" } },
  pricing: [{
    inputPerMtok: 3, outputPerMtok: 15, currency: "USD", pricingVersion: "price-v2", freshness: "expired",
    appliesTo: { servingProvider: "test", accountKind: "api" },
    provenance: { source: "manual-price-snapshot", tier: "manual", observedAt: "2026-08-01T00:00:00Z" },
  }],
  benchmarkPriors: [{
    dimension: "coding", normalized: 0.7, raw: { metric: "coding", value: 70, unit: "index" },
    sourceModelId: "source-model", normalizationVersion: "fixture-v1", freshness: "stale",
    provenance: {
      source: "external:artificial-analysis", tier: "external-benchmark", observedAt: "2026-09-02T00:00:00Z",
      attribution: "Artificial Analysis fixture attribution",
      benchmark: { release: "index-4.1", category: "coding", publishedAt: "2026-08-20", modelReleaseDate: "2026-08-10" },
    },
  }],
};

test("catalog exposes each price's provenance and benchmark dates without granting availability", async ({ context }, info) => {
  await context.route("**/api/models", route => route.fulfill({ json: { models: [model] } }));
  const page = await h.openApp(context);
  await page.getByRole("link", { name: "Agents", exact: true }).click();
  await page.getByText("Model catalog & evidence", { exact: true }).click();
  const card = page.locator(".card").filter({ hasText: "Model catalog" });
  for (const text of ["manual-price-snapshot", "2026-08-01T00:00:00Z", "price-v2", "expired",
    "applies to test/api", "not an enforcement tariff", "no assistant advertises it", "unknown",
    "capability-evidence", "tools: true", "Artificial Analysis fixture attribution", "index-4.1",
    "benchmark published 2026-08-20", "model released 2026-08-10", "fetched 2026-09-02",
    "do not grant routing eligibility"]) await expect(card).toContainText(text);
  for (const width of [1100, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(card).toBeVisible();
    expect(await card.evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
    await page.screenshot({ path: info.outputPath(`catalog-${width}.png`), fullPage: true });
  }
});

test("catalog retains a model with unknown context, capabilities and price", async ({ context }) => {
  await context.route("**/api/models", route => route.fulfill({ json: { models: [{
    ...model, contextWindowTokens: undefined, capabilities: undefined, pricing: [], benchmarkPriors: [],
  }] } }));
  const page = await h.openApp(context);
  await page.getByRole("link", { name: "Agents", exact: true }).click();
  await page.getByText("Model catalog & evidence", { exact: true }).click();
  const card = page.locator(".card").filter({ hasText: "Model catalog" });
  for (const text of ["recorded-model", "advertised context unknown", "Capability evidence unavailable", "Price evidence unavailable"])
    await expect(card).toContainText(text);
});

test("catalog distinguishes pending, empty and failed reads", async ({ context }) => {
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  let failed = false;
  await context.route("**/api/models", async route => {
    await pending;
    await route.fulfill(failed ? { status: 503, json: { error: "fixture unavailable" } } : { json: { models: [] } });
  });
  const page = await h.openApp(context);
  await page.getByRole("link", { name: "Agents", exact: true }).click();
  await page.getByText("Model catalog & evidence", { exact: true }).click();
  const card = page.locator(".card").filter({ hasText: "Model catalog" });
  await expect(card).toContainText("Reading model catalog");
  await expect(card).not.toContainText("No catalog evidence yet");
  release();
  await expect(card).toContainText("No catalog evidence yet");
  failed = true;
  await page.reload();
  await page.getByRole("link", { name: "Agents", exact: true }).click();
  await page.getByText("Model catalog & evidence", { exact: true }).click();
  await expect(card).toContainText("Catalog unavailable");
  await expect(card).toContainText("Routing is unaffected");
  await expect(card).not.toContainText("No catalog evidence yet");
});

test("Context tab identifies its session and distinguishes K11 from provider compaction", async ({ context }, info) => {
  const task = h.built.tasks.create({ goal: "Inspect context evidence" });
  const observation: TaskContext = {
    status: "known", sessionId: "es_observed_successor",
    observation: { sequence: 1, observedAt: "2026-09-14T10:00:00Z", occupancyTokens: 82_000,
      occupancySource: "provider-reported", effectiveWindowTokens: 180_000, effectiveWindowSource: "provider-reported",
      advertisedMaxTokens: 1_000_000, pressure: 0.46, freshness: "live" },
    autoCompaction: { observed: true, count: 1 },
  };
  await context.route(`**/api/tasks/${task.taskId}/context`, route => route.fulfill({ json: observation }));
  const page = await h.openApp(context);
  await page.getByRole("button", { name: /Select task: Inspect context evidence/ }).click();
  const inspector = page.getByRole("region", { name: "Selected task inspector" });
  await inspector.getByRole("button", { name: "Context", exact: true }).click();
  await expect(inspector).toContainText("es_observed_successor");
  await expect(inspector).toContainText("46%");
  await expect(inspector).toContainText("Advertised model maximum: 1,000,000");
  await expect(inspector).toContainText("Implemented · K11");
  await expect(inspector).not.toContainText("Planned · K11");
  await expect(inspector).toContainText("not an Agentic OS action");
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(inspector.getByRole("meter", { name: "Context pressure" })).toBeVisible();
  await page.screenshot({ path: info.outputPath("context-mobile.png"), fullPage: true });
  observation.observation!.freshness = "stale";
  await expect(inspector.getByRole("meter")).toHaveCount(0, { timeout: 10000 });
  await expect(inspector).toContainText("Observation is stale");
});
