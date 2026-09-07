/**
 * Visual reference captures for the Orbital operator console. Boots the same
 * deterministic in-process API as Demo A, seeds one mission per K1–K3 state,
 * and screenshots the console at desktop, laptop and mobile widths.
 *
 * Run: `pnpm --filter @agent-plane/web visual`
 * Output: apps/web/test-results/visual-*-visual/*.png (git-ignored)
 */
import { test, expect } from "@playwright/test";
import type { AssistantId } from "@agent-plane/core";
import { FakeAdapter } from "@agent-plane/adapters";
import { boot, A, B, type Harness } from "./harness.js";

const SLOW = "fake-slow" as AssistantId;
let h: Harness;

test.beforeAll(async () => {
  h = await boot(4178, "visual", {
    [A]: { provider: "fake", options: { demoProbe: "ok" } },
    [B]: { provider: "fake", options: { demoProbe: "unsupported" } },
    [SLOW]: { provider: "fake" },
  }, undefined, (config) => {
    // Approvals pause the session for a human instead of auto-answering.
    config.policy.approvalMode = "prompt-on-escalation";
    config.execution = { harnessModes: { single: true } };
  }, new Map([[SLOW, new FakeAdapter(SLOW, {
    ok: true,
    delayMs: 600_000,
    events: [{ type: "message", summary: "Reconciling ledger partitions", phase: "editing", payload: { text: "…" } }],
  })]]));

});
test.afterAll(async () => h.close());

test("reference screenshots: active workspace, quota wait, laptop, mobile", async ({ context }, testInfo) => {
  const api = await h.privileged();
  const { built, clock } = h;
  const later = (ms: number) => new Date(clock.current.getTime() + ms).toISOString();
  const shot = async (name: string, page: Awaited<ReturnType<Harness["openApp"]>>, fullPage = false) => {
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(250);
    await page.screenshot({ path: testInfo.outputPath(`${name}.png`), fullPage });
  };

  // Seed — every state comes from the real kernel, never a frontend fixture.
  const running = built.tasks.create({ goal: "Refactor the billing reconciliation service" }).taskId;
  built.tasks.transition(running, "ROUTING");
  await built.orchestrator.startTask(running, SLOW);
  const running2 = built.tasks.create({ goal: "Generate release notes for 2.4" }).taskId;
  built.tasks.transition(running2, "ROUTING");
  await built.orchestrator.startTask(running2, SLOW);

  const timeWait = (await (await api.post("/api/tasks", {
    data: { goal: "Publish the nightly digest", wait: { kind: "time", notBefore: later(3_600_000) } },
  })).json()).taskId as string;

  // Every failover candidate is blocked, so K2 must checkpoint and park.
  built.cooldowns.penalize(B, "limit", "backup blocked", later(3_600_000));
  built.cooldowns.penalize(SLOW, "limit", "backup blocked", later(3_600_000));
  const quota = built.tasks.create({ goal: "Continue the warehouse migration [FAKE:LIMIT]" }).taskId;
  built.tasks.transition(quota, "ROUTING");
  await built.orchestrator.startTask(quota, A);

  // Session-level approval: the run pauses AWAITING_APPROVAL while the task stays RUNNING.
  const approval = built.tasks.create({ goal: "Review the deployment plan [FAKE:APPROVAL]" }).taskId;
  built.tasks.transition(approval, "ROUTING");
  await built.orchestrator.startTask(approval, A);
  // Task-level human wait: a failed verification lands in WAITING_INPUT for an operator call.
  const verify = built.tasks.create({ goal: "Harden the webhook signature check" }).taskId;
  built.tasks.transition(verify, "ROUTING");
  built.tasks.transition(verify, "WAITING_INPUT", "verification_failed");

  const done = built.tasks.create({ goal: "Index the design documents" }).taskId;
  built.tasks.transition(done, "ROUTING");
  await built.orchestrator.startTask(done, A);
  // ROUTING → FAILED is the kernel's own legal path (routing failure).
  const failed = built.tasks.create({ goal: "Rotate the access logs" }).taskId;
  built.tasks.transition(failed, "ROUTING");
  built.tasks.transition(failed, "FAILED");
  const cancelled = (await (await api.post("/api/tasks", {
    data: { goal: "Draft the quarterly summary", wait: { kind: "time", notBefore: later(7_200_000) } },
  })).json()).taskId as string;
  await h.waitForState(cancelled, "WAITING_RESOURCE");
  await api.post(`/api/tasks/${cancelled}/cancel`);

  await h.waitForState(running, "RUNNING");
  await h.waitForState(timeWait, "WAITING_RESOURCE");
  await h.waitForState(quota, "WAITING_RESOURCE");
  await h.waitForState(done, "COMPLETED");
  await h.waitForState(verify, "WAITING_INPUT");
  await h.waitForState(failed, "FAILED");
  await h.waitForState(cancelled, "CANCELLED");
  clock.advance(20 * 60_000);
  await built.quotaProbes.refresh();

  const consoleErrors: string[] = [];
  context.on("page", page => {
    page.on("console", (m) => m.type() === "error" && consoleErrors.push(m.text()));
    page.on("pageerror", (e) => consoleErrors.push(e.message));
  });
  const page = await h.openApp(context);
  const inspector = page.getByRole("region", { name: "Selected task inspector" });
  const select = async (id: string) => {
    await page.getByRole("button", { name: new RegExp(id) }).first().click();
    await expect(inspector.getByRole("code")).toContainText(id);
  };
  await page.setViewportSize({ width: 1440, height: 1000 });
  await expect(page.locator(".orbital-body.state-RUNNING").first()).toBeVisible();

  // 1. Desktop, active workspace: a running mission selected, execution tab.
  await select(running);
  await inspector.getByRole("button", { name: "Execution", exact: true }).click();
  await expect(page.locator(".satellite.executing")).toHaveCount(1);
  await shot("1-desktop-active", page);
  await shot("1-desktop-active-full", page, true);

  // 2. Desktop, WAITING_RESOURCE quota case with blocker evidence.
  await select(quota);
  await inspector.getByRole("button", { name: "Schedule", exact: true }).click();
  await expect(inspector.getByText("Quota wait · K2")).toBeVisible();
  await shot("2-desktop-quota-wait", page);
  await shot("2-desktop-quota-wait-full", page, true);

  // 3. Needs-you state: approval pending, distinct from resource waiting.
  await select(verify);
  await expect(inspector.getByText("Verification decision")).toBeVisible();
  await shot("3-desktop-needs-you", page);

  await select(approval);
  await expect(inspector.locator(".badge")).toHaveText("Approval required");
  await expect(page.locator(".orbital-body.state-AWAITING_APPROVAL")).not.toHaveClass(/moving/);
  await expect(page.locator(".satellite.executing")).toHaveCount(0);
  await shot("3b-desktop-approval", page);

  // 4. Laptop and 5. mobile — asserted free of horizontal overflow.
  await select(quota);
  await page.setViewportSize({ width: 1100, height: 800 });
  await shot("4-laptop", page);
  await shot("4-laptop-full", page, true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.setViewportSize({ width: 390, height: 844 });
  await shot("5-mobile", page);
  await shot("5-mobile-full", page, true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

  // 6. Reduced motion: the field must still read correctly without animation.
  await page.setViewportSize({ width: 1440, height: 1000 });
  expect(await page.evaluate(() => document.getAnimations().some(a => a.effect?.getTiming().iterations === Infinity))).toBe(true);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect.poll(() => page.evaluate(() => document.getAnimations().filter(a => a.playState === "running" && a.effect?.getTiming().iterations === Infinity).length)).toBe(0);
  await select(running);
  await shot("6-desktop-reduced-motion", page);

  // 7. Intake screen reached from the command bar.
  await page.getByRole("textbox", { name: "What should Agentic OS do?" }).fill("Audit the retry policy for idempotency");
  await page.getByRole("button", { name: "Route mission" }).click();
  await expect(page.getByRole("heading", { name: "New mission" })).toBeVisible();
  await shot("7-intake", page);

  // 8. Full controls & diagnostics and 9. the agent catalog keep the same shell.
  await page.getByRole("button", { name: "Orbital" }).click();
  await select(quota);
  await page.getByRole("button", { name: /Open full controls/ }).click();
  await expect(page.getByRole("heading", { name: quota })).toBeVisible();
  await shot("8-task-detail", page);
  await page.getByRole("button", { name: "Agents" }).click();
  await expect(page.getByText("What changed today")).toBeVisible();
  await shot("9-agents", page);

  expect(consoleErrors).toEqual([]);

  await api.dispose();
});
