/**
 * Agent Runtime Registry PR 5: the Agents app drives the agent-runtime v1 routes only. Disable
 * reaches the router (its reason shows in the routing preview), Test renders the plane's own
 * conformance result, and "Add a runtime" copies a config snippet without writing any config.
 */
import { expect, test, type Locator } from "@playwright/test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { A, B, boot, type Harness, showDiagnostics } from "./harness.js";

let h: Harness;
/** Rows are collapsed by default: open one by its toggle (named for the assistant id). */
const toggle = (card: Locator, id: string) => card.getByRole("button", { name: new RegExp(`^${id} `) });
test.beforeEach(async () => { h = await boot(4247, "agents-runtime", { [A]: { provider: "fake" }, [B]: { provider: "fake" } }); });
test.afterEach(async () => { await h.close(); });

test("disable reaches routing with its reason, re-enable clears only the overlay", async ({ context }, info) => {
  const page = await h.openApp(context);
  await showDiagnostics(page);
  await page.getByRole("navigation", { name: "System" }).getByRole("link", { name: "Agents", exact: true }).click();
  const card = page.getByRole("region", { name: `Assistant ${A}` });
  await expect(card.getByText("config enabled · no operator override")).toBeHidden();
  await toggle(card, A).click();
  await expect(card.getByText("config enabled · no operator override")).toBeVisible();
  await expect(card.getByRole("list", { name: "Why not ready" })).toHaveCount(0);

  await card.getByRole("button", { name: "Disable routing", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: `${A} is disabled for future routing` })).toBeVisible();
  await expect(card.getByRole("list", { name: "Why not ready" })).toHaveText("disabled by operator");
  await expect(card.getByText("config enabled · disabled by operator", { exact: false })).toBeVisible();
  await page.screenshot({ path: info.outputPath("agents-disabled.png"), fullPage: true });

  // The router, not the browser, excludes it: the routing preview carries the router's text.
  await page.getByRole("navigation", { name: "System" }).getByRole("link", { name: "Overview", exact: true }).click();
  await page.getByRole("textbox", { name: "What should Agentic OS do?" }).fill("Check the disabled runtime is skipped");
  await page.getByRole("button", { name: "Preview routing", exact: true }).click();
  const inspector = page.getByRole("region", { name: "Selected task inspector" });
  await expect(inspector.getByRole("region", { name: "Decision summary" })).toContainText(B);
  await inspector.getByRole("button", { name: "Decision", exact: true }).click();
  const excluded = inspector.locator(".candidate-list").first().locator("li").filter({ hasText: A });
  await expect(excluded).toContainText("Excluded");
  await expect(excluded).toContainText("disabled by operator");
  await expect(inspector.locator(".candidate-list").first().locator("li").filter({ hasText: B })).toContainText("Eligible");

  await page.getByRole("navigation", { name: "System" }).getByRole("link", { name: "Agents", exact: true }).click();
  await card.getByRole("button", { name: "Re-enable routing", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: `${A}: operator override cleared.` })).toBeVisible();
  await expect(card.getByRole("list", { name: "Why not ready" })).toHaveCount(0);
  await expect(card.getByRole("button", { name: "Disable routing", exact: true })).toBeVisible();
});

test("Test renders the plane's conformance result and its recorded state", async ({ context }, info) => {
  const page = await h.openApp(context);
  await showDiagnostics(page);
  await page.goto(`${h.origin}/#/agents`);
  const card = page.getByRole("region", { name: `Assistant ${A}` });
  await toggle(card, A).click();
  await expect(card.getByText(/^not tested · descriptor v1/)).toBeVisible();
  await expect(card.getByText(/^not probed yet/)).toBeVisible();
  await card.getByRole("button", { name: "Test", exact: true }).click();
  const report = card.getByRole("region", { name: `Test result for ${A}` });
  await expect(report).toContainText("Test pass");
  await expect(report).toContainText("recorded");
  const rows = report.getByRole("row");
  await expect(rows.filter({ hasText: "in-process-run" })).toContainText("pass");
  await expect(rows.filter({ hasText: "self-description" })).not.toContainText(/\bpass\b/);
  // Recorded, but no capability probe has observed a version yet, so the plane cannot match the
  // row to one: the lifecycle says stale and the card says why, rather than showing a pass.
  await expect(card.getByText(/^stale: /)).toBeVisible();
  await expect(card).toContainText("No capability probe has observed a version yet");
  // Once the probe runs (as the plane's boot and periodic sync do), the stored row matches.
  await h.built.registry.syncChanged(A);
  await page.reload();
  await toggle(card, A).click();
  await expect(card.getByText(/^in-process \(no CLI\)/)).toBeVisible();
  await expect(card.getByText(/^passed · for CLI in-process · descriptor v1 · not required for routing/)).toBeVisible();
  await card.getByRole("button", { name: "Test", exact: true }).click();
  await expect(card.getByRole("region", { name: `Test result for ${A}` })).toContainText("Test pass");
  await page.screenshot({ path: info.outputPath("agents-test-result.png"), fullPage: true });
});

test("Add a runtime guides one runtime at a time, reveals YAML on request and writes no config", async ({ context, browserName }, info) => {
  test.skip(browserName !== "chromium", "clipboard permissions are chromium-only here");
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const configPath = join(h.home, "personal", "config.yaml");
  const before = readFileSync(configPath, "utf8");
  const page = await h.openApp(context);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${h.origin}/#/agents`);
  await page.getByText("Add a runtime", { exact: true }).click();
  // Collapsed by default: a row per runtime, no YAML and no steps yet.
  const choice = (label: string) => page.getByRole("button", { name: new RegExp(`^${label} `) });
  await expect(choice("Cursor CLI")).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByRole("region", { name: "Add Cursor CLI" })).toHaveCount(0);
  await expect(page.locator(".runtime-snippet")).toHaveCount(0);
  // Configured providers are not offered again.
  await expect(choice("Fake \\(tests\\)")).toHaveCount(0);

  await choice("Cursor CLI").click();
  const cursor = page.getByRole("region", { name: "Add Cursor CLI" });
  await expect(cursor).toContainText("Scaffold: event mapping not proven.");
  await expect(cursor).toContainText("Enforces: auto-approve");
  await expect(cursor.getByRole("listitem").filter({ hasText: "Install Cursor CLI" })).toBeVisible();
  await expect(cursor.getByRole("listitem").filter({ hasText: "Restart the plane, then check" })).toBeVisible();
  await expect(cursor.getByLabel("Config snippet for Cursor CLI")).toHaveCount(0);

  // Copy works without revealing the YAML.
  await cursor.getByRole("button", { name: "Copy entry", exact: true }).click();
  await expect(cursor.getByRole("status")).toHaveText("Copied entry.");
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("  cursor:\n    provider: cursor\n    enabled: true");
  await cursor.getByRole("button", { name: "Copy snippet", exact: true }).click();
  await expect(cursor.getByRole("status")).toHaveText("Copied snippet.");
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  expect(copied).toBe("assistants:\n  cursor:\n    provider: cursor\n    enabled: true");

  // YAML on request, identical to what was copied.
  const show = cursor.getByRole("button", { name: "Show YAML", exact: true });
  await show.click();
  await expect(cursor.getByRole("button", { name: "Hide YAML", exact: true })).toHaveAttribute("aria-expanded", "true");
  await expect(cursor.getByLabel("Config snippet for Cursor CLI")).toHaveText(copied);
  await page.screenshot({ path: info.outputPath("agents-add-runtime.png"), fullPage: true });
  await cursor.getByRole("button", { name: "Hide YAML", exact: true }).click();
  await expect(cursor.getByLabel("Config snippet for Cursor CLI")).toHaveCount(0);

  // One at a time: picking another closes this one.
  await choice("Codex").first().click();
  await expect(page.getByRole("region", { name: "Add Cursor CLI" })).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Add Codex" })).toBeVisible();
  await expect(choice("Cursor CLI")).toHaveAttribute("aria-expanded", "false");

  await choice("Cursor CLI").click();
  await page.getByRole("button", { name: "Check now", exact: true }).click();
  expect(readFileSync(configPath, "utf8")).toBe(before);
  await page.setViewportSize({ width: 390, height: 844 });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  await page.getByRole("region", { name: "Add Cursor CLI" }).getByRole("button", { name: "Show YAML", exact: true }).click();
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
  await page.screenshot({ path: info.outputPath("agents-add-runtime-390.png"), fullPage: true });
});
