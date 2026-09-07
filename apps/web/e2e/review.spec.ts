import { FakeAdapter } from "@agent-plane/adapters";
import { writeFileSync } from "node:fs";
import { test, expect } from "@playwright/test";
import { boot, A, type Harness } from "./harness.js";

let h: Harness;
let consoleErrors: string[];
let expectedReadFailures = false;
test.beforeEach(async ({ context }, info) => {
  consoleErrors = [];
  expectedReadFailures = false;
  context.on("page", page => {
    page.on("console", m => { if (m.type() === "error") consoleErrors.push(m.text()); });
    page.on("pageerror", e => consoleErrors.push(e.message));
  });
  h = await boot(4179, "pr26-review", { [A]: { provider: "fake" } }, undefined, (config) => {
    if (info.title.includes("partial")) config.assistants.offline = { provider: "fake", enabled: false };
    config.policy.approvalMode = "prompt-on-escalation";
    config.execution = { harnessModes: { single: !info.title.includes("legacy") } };
  }, info.title.includes("geometry") ? new Map([[A, new FakeAdapter(A, { ok: true, delayMs: 600_000, events: [{ type: "message", summary: "Working" }] })]]) : undefined);
});
test.afterEach(async () => {
  await h.close();
  expect(consoleErrors.filter(message => !(expectedReadFailures && /status of 503/.test(message)))).toEqual([]);
});

test("Intake never starts a stale goal or constraints after editing a preview", async ({ context }) => {
  const page = await h.openApp(context);
  await page.getByRole("textbox", { name: "What should Agentic OS do?" }).fill("Original goal");
  await page.getByRole("textbox", { name: "What should Agentic OS do?" }).press("Enter");
  await expect(page.getByRole("button", { name: "Run recommended", exact: true })).toBeVisible();
  await page.getByRole("textbox", { name: "Goal", exact: true }).fill("Revised goal");
  await page.getByRole("textbox", { name: /^Constraints/ }).fill("Do not modify production");
  await expect(page.getByRole("button", { name: "Run recommended", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Preview routing", exact: true }).click();
  await expect(page.getByRole("button", { name: "Run recommended", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Run recommended", exact: true }).click();
  await expect.poll(() => h.built.tasks.list().find(t => t.goal === "Revised goal")?.state).toBe("COMPLETED");
  const task = h.built.tasks.list().find(t => t.goal === "Revised goal")!;
  expect(h.built.tasks.envelope(task.id).constraints).toContain("Do not modify production");
});

for (const decision of ["Approve", "Deny"] as const) test(`real Harness approval survives reload with durable ${decision} controls, without execution motion`, async ({ context }, info) => {
  const api = await h.privileged();
  const id = (await (await api.post("/api/tasks", { data: { goal: "Review deployment [FAKE:APPROVAL]" } })).json()).taskId;
  await api.post(`/api/tasks/${id}/start`, { data: { assistantId: A } });
  await expect.poll(async () => (await (await api.get(`/api/tasks/${id}/sessions`)).json())[0]?.sessionState).toBe("AWAITING_APPROVAL");
  // Attention must remain workspace-wide while an unrelated draft is selected.
  await api.post("/api/tasks", { data: { goal: "Unstarted draft" } });
  const page = await h.openApp(context);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole("button", { name: /Select task: Unstarted draft/ }).click();
  await expect(page.locator(".workspace-status .tone-human")).toContainText("1 need you");
  const body = page.getByRole("button", { name: /Select task: Review deployment/ });
  await expect(body).not.toHaveClass(/moving/);
  await body.focus();
  await body.press("Enter");
  const inspector = page.getByRole("region", { name: "Selected task inspector" });
  await expect(inspector.locator(".badge")).toHaveText("Approval required");
  await expect(inspector.locator(".decision-strip")).toContainText("Waits for your approval");
  await expect(page.locator(".satellite.executing")).toHaveCount(0);
  await page.screenshot({ path: info.outputPath("approval.png"), fullPage: true });
  await page.getByRole("button", { name: /Open full controls/ }).click();
  await page.getByRole("button", { name: "Sessions", exact: true }).click();
  await page.getByRole("button", { name: /es_/ }).click();
  const pending = page.getByRole("group", { name: "Pending session approval" });
  await expect(pending).toBeVisible();
  await expect(pending.getByRole("button", { name: "Approve", exact: true })).toBeEnabled();
  await expect(pending.getByRole("button", { name: "Deny", exact: true })).toBeEnabled();
  // Reload discards all transient SSE/UI state; recover the pending request from storage.
  await page.reload();
  await expect(page.locator(".workspace-status .tone-human")).toContainText("1 need you");
  await page.getByRole("button", { name: /Select task: Review deployment/ }).click();
  await expect(inspector.locator(".badge")).toHaveText("Approval required");
  await expect(page.locator(".orbital-body.moving")).toHaveCount(0);
  await expect(page.locator(".satellite.executing")).toHaveCount(0);
  await page.getByRole("button", { name: /Open full controls/ }).click();
  await page.getByRole("button", { name: "Sessions", exact: true }).click();
  await page.getByRole("button", { name: /es_/ }).click();
  await expect(pending).toBeVisible();
  await page.screenshot({ path: info.outputPath("approval-controls.png"), fullPage: true });
  await pending.getByRole("button", { name: decision, exact: true }).click();
  await h.waitForState(id, decision === "Approve" ? "COMPLETED" : "FAILED");
  await expect(pending).toHaveCount(0);
  await api.dispose();
});

test("scale, keyboard, responsive detail, and reduced motion review", async ({ context }, info) => {
  const page = await h.openApp(context);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.screenshot({ path: info.outputPath("scale-0.png") });
  for (const count of [1, 6, 20, 100]) {
    while (h.built.tasks.list().length < count) {
      h.built.tasks.create({ goal: `Mission ${h.built.tasks.list().length + 1}: inspect scheduling and recovery evidence` });
    }
    await expect(page.locator(".task-row")).toHaveCount(count, { timeout: 10000 });
    expect(await page.locator(".orbital-body").count()).toBeLessThanOrEqual(Math.min(8, count));
    await page.screenshot({ path: info.outputPath(`scale-${count}.png`) });
  }
  // Selecting a mission outside the bounded field must bring it into the field.
  const oldest = h.built.tasks.list().at(-1)!;
  await page.getByRole("textbox", { name: "Search tasks" }).fill(oldest.id);
  const row = page.locator(".task-row").first();
  await row.focus();
  await row.press("Enter");
  await expect(page.locator('.orbital-body[aria-pressed="true"]')).toHaveAttribute("aria-label", new RegExp(oldest.goal.slice(0, 9)));
  await page.emulateMedia({ reducedMotion: "reduce" });
  expect(await page.evaluate(() => document.getAnimations().filter(a => a.playState === "running" && a.effect?.getTiming().iterations === Infinity).length)).toBe(0);
  await page.getByRole("button", { name: /Open full controls/ }).click();
  await expect(page.getByRole("heading", { name: oldest.id })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: info.outputPath("mobile-task-detail.png"), fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});

test("runtime geometry and selection remain readable across eight active missions", async ({ context }, info) => {
  for (let i = 0; i < 8; i++) {
    const id = h.built.tasks.create({ goal: `Mission ${i + 1}: investigate scheduler and routing` }).taskId;
    h.built.tasks.transition(id, "ROUTING");
    await h.built.orchestrator.startTask(id, A);
  }
  const page = await h.openApp(context);
  const evidence = [];
  for (const width of [1440, 1100]) {
    await page.setViewportSize({ width, height: 1000 });
    await expect(page.locator(".orbital-body.moving").first()).toBeVisible();
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.waitForTimeout(150);
    const overlaps = await page.locator(".body-label").evaluateAll(labels => {
      const boxes = labels.map(label => { const r = label.getBoundingClientRect(); return { x: r.x, y: r.y, right: r.right, bottom: r.bottom }; });
      return boxes.flatMap((a, i) => boxes.slice(i + 1).filter(b => a.x < b.right && b.x < a.right && a.y < b.bottom && b.y < a.bottom).map(b => ({ a, b })));
    });
    evidence.push({ width, overlaps });
    expect(overlaps).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    await page.screenshot({ path: info.outputPath(`eight-running-${width}.png`) });
  }
  writeFileSync(info.outputPath("geometry.json"), JSON.stringify(evidence, null, 2));
});

test("legacy execution without durable sessions reports unknown instead of claiming approval safety", async ({ context }) => {
  const id = h.built.tasks.create({ goal: "Legacy approval [FAKE:APPROVAL]" }).taskId;
  h.built.tasks.transition(id, "ROUTING");
  await h.built.orchestrator.startTask(id, A);
  const page = await h.openApp(context);
  await expect(page.locator(".workspace-status")).toContainText("1 runtime unknown");
  await expect(page.locator(".orbital-body.moving")).toHaveCount(0);
  await expect(page.locator(".inspector .badge")).toHaveText("Runtime unknown");
});

test("limit, handoff, and terminal states keep distinct shapes and truthful next actions", async ({ context }, info) => {
  const ids: Record<string, string> = {};
  for (const state of ["LIMIT_PAUSED", "HANDING_OFF", "COMPLETED", "FAILED", "CANCELLED"]) {
    const id = h.built.tasks.create({ goal: `${state} presentation check` }).taskId;
    h.built.tasks.transition(id, "ROUTING");
    h.built.tasks.transition(id, "RUNNING");
    h.built.tasks.transition(id, state as "LIMIT_PAUSED");
    ids[state] = id;
  }
  const page = await h.openApp(context);
  await page.setViewportSize({ width: 1440, height: 1000 });
  for (const state of Object.keys(ids)) {
    await page.getByRole("textbox", { name: "Search tasks" }).fill(ids[state]!);
    await expect(page.locator(".orbital-body")).toHaveCount(1);
    await expect(page.locator(".orbital-body")).toHaveClass(new RegExp(`state-${state}`));
    await expect(page.locator(".inspector .task-id")).toHaveText(ids[state]!);
    if (state === "LIMIT_PAUSED") {
      await expect(page.locator(".arc-blocker")).toHaveCount(1);
      await expect(page.locator(".decision-strip")).not.toContainText("budget exhausted");
    }
    if (["COMPLETED", "FAILED", "CANCELLED"].includes(state)) await expect(page.locator(".orbital-body")).not.toHaveClass(/moving/);
    await page.screenshot({ path: info.outputPath(`${state}.png`) });
  }
});

test("partial and failed reads are explicit; loading and disabled providers remain honest", async ({ context }, info) => {
  expectedReadFailures = true;
  h.built.tasks.create({ goal: "Read availability check" });
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await context.route("**/api/tasks", async route => { await gate; await route.continue(); });
  const page = await h.openApp(context);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await expect(page.getByRole("heading", { name: "Reading your workspace…" })).toBeVisible();
  await page.screenshot({ path: info.outputPath("loading.png") });
  release();
  await expect(page.locator(".task-row")).toHaveCount(1);
  await context.unroute("**/api/tasks");
  await expect(page.locator(".satellite.unavailable")).toContainText("disabled");
  await page.screenshot({ path: info.outputPath("disabled-provider.png") });
  await context.route(/\/api\/(assistants|cooldowns|scheduler\/status)$/, route => route.fulfill({ status: 503, contentType: "application/json", body: '{"error":"Review read outage"}' }));
  await expect(page.getByText(/Unavailable reads: Provider discovery, Cooldowns/)).toBeVisible({ timeout: 10000 });
  await expect(page.locator(".satellite")).toHaveCount(0);
  await page.screenshot({ path: info.outputPath("partial-reads.png") });
  await context.route("**/api/tasks", route => route.fulfill({ status: 503, contentType: "application/json", body: '{"error":"Review task outage"}' }));
  await expect(page.getByRole("alert").filter({ hasText: "Task refresh failed" })).toContainText("last successful snapshot", { timeout: 10000 });
  await page.screenshot({ path: info.outputPath("stale-tasks.png") });
});
