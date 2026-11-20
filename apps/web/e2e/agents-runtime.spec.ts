/**
 * Agent Runtime Registry PR 5: the Agents app drives the agent-runtime v1 routes only. Disable
 * reaches the router (its reason shows in the routing preview), Test renders the plane's own
 * conformance result, and "Add a runtime" copies a config snippet without writing any config.
 */
import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { A, B, boot, type Harness, showDiagnostics } from "./harness.js";

let h: Harness;
test.beforeEach(async () => { h = await boot(4247, "agents-runtime", { [A]: { provider: "fake" }, [B]: { provider: "fake" } }); });
test.afterEach(async () => { await h.close(); });

test("disable reaches routing with its reason, re-enable clears only the overlay", async ({ context }, info) => {
  const page = await h.openApp(context);
  await showDiagnostics(page);
  await page.getByRole("navigation", { name: "System" }).getByRole("link", { name: "Agents", exact: true }).click();
  const card = page.getByRole("region", { name: `Assistant ${A}` });
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
  await expect(card.getByText(/^in-process \(no CLI\)/)).toBeVisible();
  await expect(card.getByText(/^passed · for CLI in-process · descriptor v1 · not required for routing/)).toBeVisible();
  await card.getByRole("button", { name: "Test", exact: true }).click();
  await expect(card.getByRole("region", { name: `Test result for ${A}` })).toContainText("Test pass");
  await page.screenshot({ path: info.outputPath("agents-test-result.png"), fullPage: true });
});

test("Add a runtime copies a config snippet and writes no config", async ({ context, browserName }, info) => {
  test.skip(browserName !== "chromium", "clipboard permissions are chromium-only here");
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const configPath = join(h.home, "personal", "config.yaml");
  const before = readFileSync(configPath, "utf8");
  const page = await h.openApp(context);
  await showDiagnostics(page);
  await page.goto(`${h.origin}/#/agents`);
  await page.getByText("Add a runtime", { exact: true }).click();
  const cursor = page.getByRole("region", { name: "Add Cursor CLI" });
  await expect(cursor).toContainText("scaffold (event mapping not proven)");
  await expect(cursor).toContainText("Enforces: auto-approve");
  // Configured providers are not offered again.
  await expect(page.getByRole("region", { name: "Add Fake (tests)" })).toHaveCount(0);
  await cursor.getByRole("button", { name: "Copy snippet", exact: true }).click();
  await expect(cursor.getByRole("status")).toHaveText("Copied.");
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  expect(copied).toBe("assistants:\n  cursor:\n    provider: cursor\n    enabled: true");
  await expect(cursor.getByLabel("Config snippet for Cursor CLI")).toHaveText(copied);
  expect(readFileSync(configPath, "utf8")).toBe(before);
  await page.screenshot({ path: info.outputPath("agents-add-runtime.png"), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  await page.screenshot({ path: info.outputPath("agents-add-runtime-390.png"), fullPage: true });
});
