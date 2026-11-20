/**
 * Calm Overview (ux-01): the default Overview shows one current mission and one next action; the execution
 * field, scheduler counts, routing inspector and the full register sit behind a Diagnostics disclosure that
 * stays one click (or one key press) away. Driven against the real in-process API.
 */
import { expect, test, type Page } from "@playwright/test";
import { FakeAdapter } from "@agent-plane/adapters";
import { boot, A, B, type Harness } from "./harness.js";

let h: Harness;
let ids: { running: string; approval: string; waiting: string };

const overflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);

test.afterEach(async () => { await h.close(); });

async function seeded() {
  h = await boot(4262, "calm-overview", { [A]: { provider: "fake" }, [B]: { provider: "fake" } }, undefined, config => {
    config.policy.approvalMode = "prompt-on-escalation";
    config.execution = { harnessModes: { single: true } };
  }, new Map([[A, new FakeAdapter(A, { ok: true, delayMs: 600_000, events: [{ type: "message", summary: "Reconciling partitions", payload: { text: "…" } }] })]]));
  const api = await h.privileged();
  const create = async (data: object) => (await (await api.post("/api/tasks", { data })).json()).taskId as string;
  const running = await create({ goal: "Refactor the billing reconciliation" });
  await api.post(`/api/tasks/${running}/start`, { data: { assistantId: A } });
  const approval = await create({ goal: "Push the release branch [FAKE:APPROVAL]" });
  await api.post(`/api/tasks/${approval}/start`, { data: { assistantId: B } });
  await expect.poll(async () => (await (await api.get(`/api/tasks/${approval}/sessions`)).json())[0]?.sessionState).toBe("AWAITING_APPROVAL");
  const waiting = await create({ goal: "Publish the nightly digest", wait: { kind: "time", notBefore: new Date(h.clock.current.getTime() + 3_600_000).toISOString() } });
  ids = { running, approval, waiting };
  await api.dispose();
}

test("the default Overview is calm: one current mission, one next action, diagnostics closed", async ({ context }, info) => {
  await seeded();
  const page = await h.openApp(context);
  await page.setViewportSize({ width: 1440, height: 1000 });
  const current = page.getByRole("region", { name: "Current mission" });
  // The mission that needs a person comes first, and says what to do about it.
  await expect(current.getByRole("heading", { name: "Push the release branch [FAKE:APPROVAL]" })).toBeVisible();
  await expect(current.getByText("Approval required")).toBeVisible();
  await expect(current.getByText("Needs you", { exact: true })).toBeVisible();
  await expect(current.getByRole("button", { name: "Review and decide" })).toBeVisible();
  await expect(current.getByLabel("Mission counts")).toContainText("1 need you");
  await expect(current.getByLabel("Mission counts")).toContainText("1 running");
  // The composer stays the way to start work.
  await expect(page.getByRole("textbox", { name: "What should Agentic OS do?" })).toBeAttached();
  // Diagnostics are closed: no field, inspector, register or legend until asked for.
  const bar = page.getByRole("region", { name: "Diagnostics" });
  await expect(bar.getByRole("button", { name: "Show diagnostics" })).toHaveAttribute("aria-expanded", "false");
  for (const name of ["Task orbital map", "Selected task inspector", "System overview", "Task register"]) {
    await expect(page.getByRole("region", { name })).toHaveCount(0);
  }
  await expect(page.locator(".orbital-map, .map-legend")).toHaveCount(0);
  await page.screenshot({ path: info.outputPath("calm-desktop.png") });
  await page.screenshot({ path: info.outputPath("calm-desktop-full.png"), fullPage: true });
});

test("the next action opens the mission; other missions that need you are one click away", async ({ context }) => {
  await seeded();
  const api = await h.privileged();
  const verify = (await (await api.post("/api/tasks", { data: { goal: "Harden the webhook signature check" } })).json()).taskId as string;
  h.built.tasks.transition(verify, "ROUTING");
  h.built.tasks.transition(verify, "WAITING_INPUT", "verification_failed");
  await h.waitForState(verify, "WAITING_INPUT");
  const page = await h.openApp(context);
  const current = page.getByRole("region", { name: "Current mission" });
  await expect(current.getByLabel("Mission counts")).toContainText("2 need you");
  const first = await current.getByRole("heading").first().textContent();
  await current.getByRole("button", { name: "1 more mission needs you" }).click();
  await expect(current.getByRole("heading").first()).not.toHaveText(first!);
  await expect(current.getByRole("button", { name: "Review and decide" })).toBeVisible();
  // Picking a mission from the short list changes the current mission and nothing else.
  const list = page.getByRole("region", { name: "Missions" });
  await list.getByRole("button", { name: /Refactor the billing reconciliation/ }).click();
  await expect(current.getByRole("heading", { name: "Refactor the billing reconciliation" })).toBeVisible();
  await expect(current.getByRole("button", { name: "Watch this mission" })).toBeVisible();
  await current.getByRole("button", { name: "Watch this mission" }).click();
  await expect(page).toHaveURL(new RegExp(`#/missions/${ids.running}$`));
  await api.dispose();
});

test("diagnostics open on demand by mouse or keyboard, remember the choice, and close again", async ({ context }, info) => {
  await seeded();
  const page = await h.openApp(context);
  await page.setViewportSize({ width: 1440, height: 1000 });
  const bar = page.getByRole("region", { name: "Diagnostics" });
  const toggle = bar.getByRole("button", { name: "Show diagnostics" });
  await toggle.focus();
  await page.keyboard.press("Enter");
  await expect(bar.getByRole("button", { name: "Hide diagnostics" })).toHaveAttribute("aria-expanded", "true");
  await expect(bar.getByRole("button", { name: "Hide diagnostics" })).toBeFocused();
  await expect(page.getByRole("region", { name: "System overview" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Task orbital map" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Selected task inspector" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Task register" })).toBeVisible();
  await expect(page.locator("#overview-diagnostics")).toBeVisible();
  // Diagnostics replace the calm summary: the inspector already carries the selected mission.
  await expect(page.getByRole("region", { name: "Current mission" })).toHaveCount(0);
  await page.screenshot({ path: info.outputPath("diagnostics-open-full.png"), fullPage: true });
  // The preference is per-browser and survives a reload.
  await page.reload();
  await expect(page.getByRole("region", { name: "Task orbital map" })).toBeVisible();
  await page.getByRole("region", { name: "Diagnostics" }).getByRole("button", { name: "Hide diagnostics" }).click();
  await expect(page.getByRole("region", { name: "Task orbital map" })).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Current mission" })).toBeVisible();
});

test("an empty workspace offers one action that puts the cursor in the composer", async ({ context }) => {
  h = await boot(4262, "calm-overview-empty", { [A]: { provider: "fake" } });
  const page = await h.openApp(context);
  const current = page.getByRole("region", { name: "Current mission" });
  await expect(current.getByRole("heading", { name: "Your first mission starts here." })).toBeVisible();
  await page.getByRole("button", { name: "New mission", exact: true }).click();
  await current.getByRole("button", { name: "Describe a goal" }).click();
  await expect(page.getByRole("textbox", { name: "What should Agentic OS do?" })).toBeFocused();
});

test("calm and diagnostics layouts do not overflow at laptop, tablet and phone widths", async ({ context }, info) => {
  await seeded();
  const page = await h.openApp(context);
  for (const [name, width, height] of [["laptop", 1100, 800], ["tablet", 900, 1000], ["phone", 390, 844]] as const) {
    await page.setViewportSize({ width, height });
    await expect(page.getByRole("region", { name: "Current mission" })).toBeVisible();
    expect(await overflow(page), `${name} calm`).toBe(false);
    await expect(page.getByRole("button", { name: "Review and decide" })).toBeInViewport({ ratio: 0.9 });
    await page.screenshot({ path: info.outputPath(`calm-${name}.png`) });
  }
  await page.getByRole("button", { name: "Show diagnostics" }).click();
  for (const [name, width, height] of [["laptop", 1100, 800], ["phone", 390, 844]] as const) {
    await page.setViewportSize({ width, height });
    await expect(page.getByRole("region", { name: "Task orbital map" })).toBeVisible();
    expect(await overflow(page), `${name} diagnostics`).toBe(false);
  }
});
