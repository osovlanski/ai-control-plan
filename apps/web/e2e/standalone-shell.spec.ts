import { expect, test, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { boot, A, type Harness } from "./harness.js";

let h: Harness;
const captures = fileURLToPath(new URL("../../../docs/ui/assets/standalone-shell/", import.meta.url));
const capture = async (page: Page, name: string) => {
  mkdirSync(captures, { recursive: true });
  // The composer docks to the viewport; pin it in flow so full-page evidence never occludes the transcript.
  const pinned = await page.addStyleTag({ content: ".shell-dock { position: static; }" });
  await page.screenshot({ path: `${captures}${name}.png`, fullPage: true });
  await pinned.evaluate(node => (node as Element).remove());
};
test.beforeEach(async () => {
  h = await boot(4193, "standalone-shell", { [A]: { provider: "fake" } }, undefined, config => {
    config.policy.approvalMode = "prompt-on-escalation";
    config.execution = { harnessModes: { single: true } };
  });
});
test.afterEach(async () => { await h.close(); });

test("Shell route creates the same mission, retains draft, and reconciles the transcript after reload", async ({ context }) => {
  const page = await h.openApp(context);
  const errors: string[] = [];
  page.on("pageerror", e => errors.push(e.message));
  await page.getByRole("link", { name: "Shell mode", exact: true }).click();
  await expect(page).toHaveURL(/#\/shell$/);
  await expect(page.locator("#main-content")).toBeFocused();
  const goal = page.getByRole("textbox", { name: "What should Agentic OS do?" });
  await goal.fill("Inspect the workspace and summarize the result");
  await page.getByRole("link", { name: "Operator mode", exact: true }).click();
  await page.getByRole("link", { name: "Shell mode", exact: true }).click();
  await expect(goal).toHaveValue("Inspect the workspace and summarize the result");
  await page.setViewportSize({ width: 1440, height: 1000 });
  await capture(page, "new-mission-desktop");
  await goal.press("Control+Enter");
  await expect(page.getByRole("button", { name: "Run recommended", exact: true })).toBeVisible();
  const task = h.built.tasks.list()[0]!;
  expect(h.built.tasks.list()).toHaveLength(1);
  const api = await h.privileged();
  expect((await (await api.get(`/api/tasks/${task.id}`)).json()).runs).toHaveLength(0);
  await capture(page, "routing-preview");
  await page.getByRole("button", { name: "Run recommended", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`#/shell/${task.id}$`));
  await h.waitForState(task.id, "COMPLETED");
  await expect(page.getByRole("heading", { name: task.goal, exact: true })).toBeVisible();
  await expect(page.getByText("You · goal recorded in the kernel", { exact: true })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Follow-up to this mission" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Send", exact: true })).toHaveCount(0);
  await expect(page.getByLabel("Mission transcript")).toContainText("run · ended");
  const count = await page.getByLabel("Mission transcript").locator("p").count();
  await page.reload();
  await expect(page.getByLabel("Mission transcript").locator("p")).toHaveCount(count);
  await expect(page.getByRole("navigation", { name: "Mission history" }).getByRole("link")).toHaveAttribute("aria-current", "page");
  await capture(page, "completed-mission");
  await page.getByText("Orbit · this mission", { exact: true }).click();
  await expect(page.locator(".satellite.executing")).toHaveCount(0);
  await capture(page, "orbit");
  await page.getByRole("link", { name: "Mission, routing & traces", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`#/missions/${task.id}$`));
  await page.goBack();
  await expect(page.getByRole("heading", { name: task.goal, exact: true })).toBeVisible();
  expect(errors).toEqual([]);
  await api.dispose();
});

test("Shell durable approval, identity, context evidence and responsive keyboard controls", async ({ context }) => {
  const api = await h.privileged();
  const id = (await (await api.post("/api/tasks", { data: { goal: "Review the proposed migration [FAKE:APPROVAL]" } })).json()).taskId;
  await api.post(`/api/tasks/${id}/start`, { data: { assistantId: A } });
  await expect.poll(async () => (await (await api.get(`/api/tasks/${id}/sessions`)).json())[0]?.sessionState).toBe("AWAITING_APPROVAL");
  const page = await h.openApp(context);
  await page.goto(`${h.origin}/#/shell/${id}`);
  await page.reload();
  const approval = page.getByRole("group", { name: "Mission approval" });
  await expect(approval).toBeVisible();
  await expect(page.getByText(/Observed model:/)).toBeVisible();
  await page.setViewportSize({ width: 1440, height: 1000 });
  await capture(page, "approval-desktop");
  for (const [name, width, height] of [["laptop", 1280, 800], ["tablet", 900, 1000], ["mobile", 390, 844], ["narrow", 320, 800]] as const) {
    await page.setViewportSize({ width, height });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await capture(page, name);
  }
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.getByText("Orbit · this mission", { exact: true }).click();
  await expect(page.locator(".orbital-body.moving")).toHaveCount(0);
  expect(await page.evaluate(() => document.getAnimations().filter(a => a.playState === "running" && a.effect?.getTiming().iterations === Infinity).length)).toBe(0);
  await capture(page, "reduced-motion");
  await page.getByText("Context & quota evidence", { exact: true }).click();
  await expect(page.getByText("Occupancy unavailable", { exact: true })).toBeVisible();
  await approval.getByRole("button", { name: "Approve", exact: true }).focus();
  await expect(approval.getByRole("button", { name: "Approve", exact: true })).toBeFocused();
  await approval.getByRole("button", { name: "Approve", exact: true }).press("Enter");
  await h.waitForState(id, "COMPLETED");
  await expect(approval).toHaveCount(0);
  await expect(page.getByLabel("Mission transcript")).toContainText("run · ended");
  await api.dispose();
});

test("Shell distinguishes loading, empty, unavailable history and failed selected reads", async ({ context }) => {
  const page = await h.openApp(context);
  await page.goto(`${h.origin}/#/shell`);
  await expect(page.getByText("No missions recorded yet.", { exact: true })).toBeVisible();
  await capture(page, "empty");
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  // The release only unblocks the read; the request may already be cancelled by then.
  await context.route("**/api/tasks", async route => { await gate; await route.continue().catch(() => undefined); });
  await page.reload({ waitUntil: "domcontentloaded" });
  try {
    await expect(page.getByText("Reading history…", { exact: true })).toBeVisible();
    await capture(page, "loading");
  } finally { release(); }
  await context.unroute("**/api/tasks");
  await context.route("**/api/tasks", route => route.fulfill({ status: 503, json: { error: "Fixture history outage" } }));
  await page.reload();
  await expect(page.getByRole("alert")).toContainText("History unavailable");
  await capture(page, "history-unavailable");
  await context.unroute("**/api/tasks");
  const task = h.built.tasks.create({ goal: "Recover the canonical read" });
  await page.goto(`${h.origin}/#/shell/${task.taskId}`);
  await expect(page.getByRole("heading", { name: "Recover the canonical read", exact: true })).toBeVisible();
  await context.route(`**/api/tasks/${task.taskId}`, route => route.fulfill({ status: 503, json: { error: "Fixture selected read outage" } }));
  await expect(page.getByRole("heading", { name: "Mission unavailable", exact: true })).toBeVisible({ timeout: 10000 });
  await expect(page.getByRole("group", { name: "Mission approval" })).toHaveCount(0);
  await capture(page, "mission-unavailable");
  await context.unroute(`**/api/tasks/${task.taskId}`);
  await page.getByRole("button", { name: "Refresh mission", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Recover the canonical read", exact: true })).toBeVisible();
});

test("Shell reconciles after SSE reconnect and ignores unpersisted stream claims", async ({ context }) => {
  const task = h.built.tasks.create({ goal: "Reconcile streaming evidence" });
  let connections = 0;
  await context.route(`**/api/tasks/${task.taskId}/events/stream`, route => {
    connections++;
    if (connections === 1) return route.fulfill({ status: 200, contentType: "text/event-stream", body: 'retry: 100\ndata: {"kind":"notice","notice":{"level":"info","text":"Unpersisted stream claim"}}\n\n' });
    return route.continue();
  });
  const page = await h.openApp(context);
  await page.goto(`${h.origin}/#/shell/${task.taskId}`);
  await expect.poll(() => connections).toBeGreaterThanOrEqual(2);
  await expect(page.getByRole("heading", { name: "Reconcile streaming evidence", exact: true })).toBeVisible();
  await expect(page.getByLabel("Mission transcript")).not.toContainText("Unpersisted stream claim");
  h.built.tasks.transition(task.taskId, "ROUTING");
  h.built.bus.publish(task.taskId, { kind: "state", state: { state: "COMPLETED" } });
  // The deliberately inconsistent frame is only a refresh hint; canonical task state wins.
  await expect(page.locator(".shell-workspace .shell-conversation-head .badge")).toContainText("Choosing environment");
  const api = await h.privileged();
  expect((await (await api.get(`/api/tasks/${task.taskId}`)).json()).state).toBe("ROUTING");
  await api.dispose();
});
