/**
 * ux-02: the Agents app is one scannable row per runtime. Lifecycle, the test report and models open
 * on request, every action stays on the row, and nothing the plane served is dropped from the page.
 */
import { expect, test, type Locator } from "@playwright/test";
import type { AssistantId } from "@agent-plane/core";
import { A, B, boot, type Harness } from "./harness.js";

const C = "fake-c" as AssistantId;
let h: Harness;
test.beforeEach(async () => { h = await boot(4252, "agents-compact", { [A]: { provider: "fake" }, [B]: { provider: "fake" }, [C]: { provider: "fake" } }); });
test.afterEach(async () => { await h.close(); });

const toggle = (card: Locator, id: string) => card.getByRole("button", { name: new RegExp(`^${id} `) });

test("rows start collapsed with standing, reasons and actions visible, details on demand", async ({ context }, info) => {
  const page = await h.openApp(context);
  await page.goto(`${h.origin}/#/agents`);
  const a = page.getByRole("region", { name: `Assistant ${A}` });
  const c = page.getByRole("region", { name: `Assistant ${C}` });
  await expect(page.getByText("3 agents · 3 ready")).toBeVisible();

  // Collapsed: standing chip, one-line digest and all three actions; the full lifecycle is not rendered.
  await expect(toggle(a, A)).toHaveAttribute("aria-expanded", "false");
  await expect(a.locator(".agent-chip", { hasText: /^Ready$/ })).toBeVisible();
  await expect(a.getByText("not probed yet · not tested")).toBeVisible();
  for (const name of ["Test", "Disable routing", "Sync"]) await expect(a.getByRole("button", { name, exact: true })).toBeVisible();
  await expect(a.getByText("config enabled · no operator override")).toBeHidden();
  expect((await a.boundingBox())!.height).toBeLessThan(110);

  // Disabling from the collapsed row changes the chip and puts the served reason on the row.
  await c.getByRole("button", { name: "Disable routing", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: `${C} is disabled for future routing` })).toBeVisible();
  await expect(c.locator(".agent-chip", { hasText: /^Disabled$/ })).toBeVisible();
  await expect(c.getByText(/^disabled by operator · not probed yet · not tested$/)).toBeVisible();
  await expect(page.getByText("3 agents · 2 ready · 1 disabled")).toBeVisible();
  await expect(toggle(c, C)).toHaveAttribute("aria-expanded", "false");

  // Test opens its own row so the result is never hidden behind a collapsed card.
  await a.getByRole("button", { name: "Test", exact: true }).click();
  await expect(a.getByRole("region", { name: `Test result for ${A}` })).toContainText("Test pass");
  await expect(toggle(a, A)).toHaveAttribute("aria-expanded", "true");
  await expect(a.getByText("config enabled · no operator override")).toBeVisible();
  await page.screenshot({ path: info.outputPath("agents-compact-1440.png"), fullPage: true });

  // Expand/collapse all, and the keyboard path: Enter opens, Space closes.
  await page.getByRole("button", { name: "Expand all", exact: true }).click();
  await expect(page.getByRole("list", { name: "Why not ready" })).toHaveText("disabled by operator");
  await page.getByRole("button", { name: "Collapse all", exact: true }).click();
  await expect(toggle(a, A)).toHaveAttribute("aria-expanded", "false");
  await toggle(a, A).focus();
  await page.keyboard.press("Enter");
  await expect(toggle(a, A)).toHaveAttribute("aria-expanded", "true");
  await expect(toggle(a, A)).toBeFocused();
  await page.keyboard.press("Space");
  await expect(toggle(a, A)).toHaveAttribute("aria-expanded", "false");
});

test("phone width keeps every action reachable without horizontal scroll", async ({ context }, info) => {
  const page = await h.openApp(context);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${h.origin}/#/agents`);
  const a = page.getByRole("region", { name: `Assistant ${A}` });
  await expect(a.getByRole("button", { name: "Disable routing", exact: true })).toBeVisible();
  await page.screenshot({ path: info.outputPath("agents-compact-390.png"), fullPage: true });
  await page.getByRole("button", { name: "Expand all", exact: true }).click();
  await a.getByRole("button", { name: "Test", exact: true }).click();
  await expect(a.getByRole("region", { name: `Test result for ${A}` })).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  await page.screenshot({ path: info.outputPath("agents-compact-390-open.png"), fullPage: true });
});
