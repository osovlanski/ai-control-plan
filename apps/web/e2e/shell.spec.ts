import { expect, test } from "@playwright/test";
import { boot, A, type Harness } from "./harness.js";

let h: Harness;
test.beforeEach(async () => {
  h = await boot(4191, "conversational-shell", { [A]: { provider: "fake" } }, undefined, config => {
    config.policy.approvalMode = "prompt-on-escalation";
    config.execution = { harnessModes: { single: true } };
  });
});
test.afterEach(async () => { await h.close(); });

test("seven routes, keyboard focus, private draft retention, history and reload", async ({ context }) => {
  const page = await h.openApp(context);
  const nav = page.getByRole("navigation", { name: "System" });
  await expect(nav.getByRole("link")).toHaveCount(7);
  await page.keyboard.press("Tab");
  await expect(page.getByRole("link", { name: "Skip to workspace", exact: true })).toBeFocused();
  for (const label of ["Overview", "Agents", "Memory", "Routing", "Traces", "Tools", "Settings"]) {
    await page.keyboard.press("Tab");
    await expect(nav.getByRole("link", { name: label, exact: true })).toBeFocused();
  }
  const goal = page.getByRole("textbox", { name: "What should Agentic OS do?" });
  await goal.fill("Keep this private draft while I inspect my workspace");
  for (const label of ["Agents", "Memory", "Routing", "Traces", "Tools", "Settings"]) {
    const link = nav.getByRole("link", { name: label, exact: true });
    await link.focus(); await link.press("Enter");
    await expect(link).toHaveAttribute("aria-current", "page");
    await expect(page.getByRole("heading", { name: label, exact: true })).toBeVisible();
    await expect(page.locator("#main-content")).toBeFocused();
    if (label !== "Agents") {
      await expect(page.getByRole("heading", { name: "Available today" })).toBeVisible();
      await expect(page.getByRole("heading", { name: "Planned integration" })).toBeVisible();
    }
  }
  await page.goBack();
  await expect(nav.getByRole("link", { name: "Tools", exact: true })).toHaveAttribute("aria-current", "page");
  await page.goForward();
  await nav.getByRole("link", { name: "Overview", exact: true }).click();
  await expect(goal).toHaveValue("Keep this private draft while I inspect my workspace");
  await nav.getByRole("link", { name: "Memory", exact: true }).click();
  await page.reload();
  await expect(page.getByRole("heading", { name: "Memory", exact: true })).toBeVisible();
  await page.goto(`${h.origin}/#/not-a-page`);
  await expect(page.getByRole("heading", { name: "Page unavailable" })).toBeVisible();
});

test("inline preview never executes, starts real mission in orbit, and reload preserves diagnostics", async ({ context }, info) => {
  const page = await h.openApp(context);
  await page.getByRole("textbox", { name: "What should Agentic OS do?" }).fill("Inspect retry behavior");
  await page.getByText("Context & constraints", { exact: true }).click();
  await page.getByRole("textbox", { name: "Constraints (one per line)", exact: true }).fill("Keep API compatibility");
  await page.getByRole("button", { name: "Preview routing", exact: true }).click();
  await expect(page.getByRole("button", { name: "Run recommended", exact: true })).toBeVisible();
  const mission = h.built.tasks.list().find(t => t.goal === "Inspect retry behavior")!;
  const api = await h.privileged();
  expect((await (await api.get(`/api/tasks/${mission.id}`)).json()).runs).toHaveLength(0);
  await expect(page.getByRole("region", { name: "Task orbital map" })).toBeVisible();
  await page.getByText("Context & constraints", { exact: true }).click();
  const inspector = page.getByRole("region", { name: "Selected task inspector" });
  await expect(inspector.getByRole("heading", { name: "Inspect retry behavior", exact: true })).toBeVisible();
  await expect(inspector).not.toContainText("Reading routing and execution evidence…");
  await page.screenshot({ path: info.outputPath("inline-routing-preview.png"), fullPage: true });
  await page.getByRole("button", { name: "Run recommended", exact: true }).click();
  await h.waitForState(mission.id, "COMPLETED");
  await expect(page.getByRole("button", { name: "Selected mission", exact: true })).toBeFocused();
  await expect(page.locator('.orbital-body[aria-pressed="true"]')).toHaveAttribute("aria-label", new RegExp("Inspect retry behavior"));
  await expect(page.getByRole("region", { name: "Mission shell" })).toContainText("Inspect retry behavior");
  await expect(page.getByRole("region", { name: "Mission shell" })).toContainText("Free-text follow-ups are not supported");
  expect(h.built.tasks.envelope(mission.id).constraints).toContain("Keep API compatibility");
  await page.screenshot({ path: info.outputPath("mission-conversation.png"), fullPage: true });
  await page.getByRole("button", { name: "Open mission controls", exact: true }).click();
  await page.reload();
  await expect(page.getByRole("heading", { name: mission.id, exact: true })).toBeVisible();
  await api.dispose();
});

for (const decision of ["Approve", "Deny"] as const) test(`shell ${decision} uses durable approval state after reload`, async ({ context }, info) => {
  const api = await h.privileged();
  const id = (await (await api.post("/api/tasks", { data: { goal: "Review migration [FAKE:APPROVAL]" } })).json()).taskId;
  await api.post(`/api/tasks/${id}/start`, { data: { assistantId: A } });
  await expect.poll(async () => (await (await api.get(`/api/tasks/${id}/sessions`)).json())[0]?.sessionState).toBe("AWAITING_APPROVAL");
  const page = await h.openApp(context);
  await page.reload();
  await page.getByRole("button", { name: /Select task: Review migration/ }).click();
  await page.getByRole("button", { name: "Selected mission", exact: true }).click();
  const approval = page.getByRole("group", { name: "Mission approval" });
  await expect(approval).toBeVisible();
  await expect(page.locator(".orbital-body.moving")).toHaveCount(0);
  await page.screenshot({ path: info.outputPath("shell-approval.png"), fullPage: true });
  await approval.getByRole("button", { name: decision, exact: true }).click();
  await h.waitForState(id, decision === "Approve" ? "COMPLETED" : "FAILED");
  await expect(approval).toHaveCount(0);
  await api.dispose();
});

test("responsive empty shell and failed reads stay truthful with reduced motion", async ({ context }, info) => {
  const page = await h.openApp(context);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(page.getByRole("heading", { name: "Your first mission starts here." })).toBeVisible();
  for (const width of [1440, 1280, 900, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(page.getByRole("button", { name: "Preview routing", exact: true })).toBeInViewport();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    for (const link of await page.getByRole("navigation", { name: "System" }).getByRole("link").all()) await expect(link).toBeInViewport();
    await page.screenshot({ path: info.outputPath(`empty-${width}.png`), fullPage: true });
  }
  expect(await page.evaluate(() => document.getAnimations().filter(a => a.playState === "running" && a.effect?.getTiming().iterations === Infinity).length)).toBe(0);
  await context.route("**/api/tasks", route => route.fulfill({ status: 503, json: { error: "Test outage" } }));
  await page.reload();
  await expect(page.getByRole("alert")).toContainText("Task refresh failed");
  await expect(page.locator(".workspace-status")).not.toContainText("0 running");
});


test("missing mission and routing failure report errors without execution", async ({ context }) => {
  const page = await h.openApp(context);
  await page.getByRole("textbox", { name: "What should Agentic OS do?" }).fill("Keep the draft if routing is unavailable");
  await context.route("**/api/tasks/*/route", route => route.fulfill({ status: 503, json: { error: "Routing temporarily unavailable" } }));
  await page.getByRole("button", { name: "Preview routing", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Routing temporarily unavailable");
  await expect(page.getByRole("button", { name: "Run recommended", exact: true })).toHaveCount(0);
  expect(h.built.tasks.list()).toHaveLength(1);
  expect(h.built.orchestrator.isActive(h.built.tasks.list()[0]!.id)).toBe(false);
  await page.goto(`${h.origin}/#/missions/AG-missing`);
  await expect(page.getByRole("alert")).toContainText("Mission unavailable");
  await page.getByRole("button", { name: "Back to Overview", exact: true }).click();
  await expect(page.getByRole("region", { name: "Mission shell" })).toBeVisible();
});


test("unavailable task snapshots stop motion and returning to Overview refetches state", async ({ context }) => {
  const mission = h.built.tasks.create({ goal: "Check route ownership" });
  h.built.tasks.transition(mission.taskId, "ROUTING");
  const page = await h.openApp(context);
  await expect(page.locator(".orbital-body.moving")).toHaveCount(1);
  await context.route("**/api/tasks", route => route.fulfill({ status: 503, json: { error: "Snapshot unavailable" } }));
  await expect(page.getByRole("alert")).toContainText("Task refresh failed", { timeout: 10000 });
  await expect(page.locator(".orbital-body.moving")).toHaveCount(0);
  await expect(page.locator(".core-eyebrow")).toHaveText("Awaiting data");
  await page.getByRole("link", { name: "Memory", exact: true }).click();
  h.built.tasks.transition(mission.taskId, "FAILED");
  await context.unroute("**/api/tasks");
  await page.getByRole("link", { name: "Overview", exact: true }).click();
  await expect(page.locator(".orbital-body.state-FAILED")).toHaveCount(1);
  await expect(page.locator(".orbital-body.moving")).toHaveCount(0);
});
