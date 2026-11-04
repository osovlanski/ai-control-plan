/**
 * Shell view (part A): the Overview as a Linux-style shell, driven keyboard-only against the real
 * in-process API. Two fake assistants, one running task, one awaiting approval and one waiting.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeCockpit, FAKE_COCKPIT_TOKEN, type FakeCockpit } from "./fake-cockpit.js";
import { expect, test, type Page } from "@playwright/test";
import type { CapabilityManifest } from "@agent-plane/core";
import { FakeAdapter } from "@agent-plane/adapters";
import { boot, A, B, type Harness } from "./harness.js";

/** A fake that reports one quota window, so the top panel has a bar to draw. */
class QuotaFake extends FakeAdapter {
  override async describe(): Promise<CapabilityManifest> {
    const m = await super.describe();
    return { ...m, core: { ...m.core, limits: [{ window: "5h", usedPercent: 62, source: "provider-api", observedAt: "2026-09-06T12:00:00.000Z" }] } };
  }
}

let h: Harness;
let root: string;
let repo: string;
let cockpit: FakeCockpit;
let ids: { running: string; approval: string; waiting: string };

test.beforeEach(async ({ context: _context }, info) => {
  const composerOn = info.title.startsWith("repository preview");
  root = mkdtempSync(join(tmpdir(), "shell-view-repository-"));
  repo = join(root, "ai-control-plan");
  mkdirSync(repo);
  writeFileSync(join(repo, "README.md"), "Scratch repository.\n");
  for (const args of [["init", "-q"], ["add", "."], ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "init"]]) {
    execFileSync("git", ["-C", repo, ...args]);
  }
  const tokenPath = join(root, "registry-credential");
  writeFileSync(tokenPath, FAKE_COCKPIT_TOKEN, { mode: 0o600 });
  cockpit = await fakeCockpit();
  h = await boot(4199, "shell-view", { [A]: { provider: "fake" }, [B]: { provider: "fake" } }, undefined, config => {
    config.repoAllowlist = [repo];
    config.composer.enabled = composerOn;
    config.composer.policy.permitAmbient = true;
    config.composer.policy.budget = { maxTokens: 50_000 };
    config.registry.cockpit = { enabled: composerOn, baseUrl: cockpit.url, tokenPath, maxCacheAgeHours: 48 };
    config.policy.approvalMode = "prompt-on-escalation";
    config.execution = { harnessModes: { single: true } };
  }, new Map([[A, new QuotaFake(A, { ok: true, delayMs: 600_000, events: [{ type: "message", summary: "Reconciling partitions", payload: { text: "…" } }] })]]));
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
});
test.afterEach(async () => { await h.close(); await cockpit.close(); rmSync(root, { recursive: true, force: true }); });

const openShell = async (page: Page) => {
  const toggle = page.getByRole("group", { name: "Overview view" });
  await toggle.getByRole("button", { name: "Shell", exact: true }).focus();
  await page.keyboard.press("Enter");
  const shell = page.getByRole("region", { name: "Shell view" });
  await expect(shell).toBeVisible();
  return shell;
};
const rowOf = (page: Page, id: string) => page.getByRole("region", { name: "Process list" }).getByRole("row").filter({ hasText: id });

test("keyboard drive: rows, log, inspector, approve, preview and run, remembered per browser", async ({ context }, info) => {
  const page = await h.openApp(context);
  const shell = await openShell(page);
  const top = shell.getByLabel("Top panel");
  await expect(top).toContainText(`${A} ▮▮▯▯ 62%`);
  await expect(top).toContainText(`${B} unknown`);
  await expect(top).toContainText("1 need you");

  const list = shell.getByRole("region", { name: "Process list" });
  await expect(list.getByRole("row")).toHaveCount(4);
  // NEEDS-YOU is pinned first and selected by default.
  await expect(list.getByRole("row").nth(1)).toContainText(ids.approval);
  await expect(rowOf(page, ids.approval)).toHaveAttribute("aria-selected", "true");
  await expect(rowOf(page, ids.approval)).toContainText("NEEDS-YOU");
  await expect(rowOf(page, ids.running)).toContainText("RUNNING");
  await expect(rowOf(page, ids.running)).toContainText(A);
  await expect(rowOf(page, ids.waiting)).toContainText("WAITING");
  // MODEL is the resolved model. Repo-less runs have no composition accounting, so TOKENS is unknown.
  await expect(rowOf(page, ids.running)).toContainText("fake-1");
  await expect(rowOf(page, ids.running)).toContainText("unknown");

  await page.locator("body").click({ position: { x: 1, y: 1 } });
  const log = shell.getByRole("region", { name: "Event log" });
  await expect(log).toContainText("approval.requested");
  await expect(log.getByRole("group", { name: "Focused approval" })).toBeVisible();
  await expect(rowOf(page, ids.approval)).toContainText(B);
  await page.screenshot({ path: info.outputPath("shell-dark-1280.png") });

  await page.keyboard.press("j");
  await expect(rowOf(page, ids.running)).toHaveAttribute("aria-selected", "true");
  await expect(log).toContainText("run.started Fake run started");
  await page.keyboard.press("k");
  await expect(rowOf(page, ids.approval)).toHaveAttribute("aria-selected", "true");

  await page.keyboard.press("Enter");
  await expect(shell.getByRole("region", { name: "Inspector", exact: true })).toBeVisible();
  await expect(shell.getByRole("region", { name: "Selected task inspector" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(shell.getByRole("region", { name: "Event log" })).toBeVisible();

  await page.keyboard.press("?");
  await expect(shell.getByRole("dialog", { name: "Keys" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(shell.getByRole("dialog", { name: "Keys" })).toHaveCount(0);

  await expect(shell.getByRole("group", { name: "Focused approval" })).toBeVisible();
  await page.keyboard.press("a");
  await h.waitForState(ids.approval, "COMPLETED");
  await expect(rowOf(page, ids.approval)).toContainText("COMPLETED");
  await expect(top).toContainText("0 need you");

  // Keys do not fire from the command line; Esc leaves it.
  await page.keyboard.press("/");
  const cmd = shell.getByRole("textbox", { name: /agentic-os \[.*\]\$/ });
  await expect(cmd).toBeFocused();
  await page.keyboard.type("jk fix the flaky schedule-queue test");
  await expect(cmd).toHaveValue("jk fix the flaky schedule-queue test");
  await expect(rowOf(page, ids.approval)).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Tab");
  const preview = shell.getByLabel("Route preview");
  await expect(preview).toContainText("route →");
  const created = h.built.tasks.list().find(t => t.goal === "jk fix the flaky schedule-queue test")!;
  expect(created.state).not.toBe("RUNNING");
  await expect(cmd).toBeFocused();
  await page.screenshot({ path: info.outputPath("shell-preview-1280.png") });
  await page.keyboard.press("Enter");
  await expect(shell.locator(".sv-status")).toContainText(`started ${created.id}`);
  await expect(cmd).toHaveValue("");
  await page.keyboard.press("Escape");
  await expect(cmd).not.toBeFocused();

  await page.reload();
  await expect(page.getByRole("region", { name: "Shell view" })).toBeVisible();
  await expect(page.getByRole("group", { name: "Overview view" }).getByRole("button", { name: "Shell", exact: true })).toHaveAttribute("aria-pressed", "true");
});

test("deny and cancel confirm inline; n backs out", async ({ context }) => {
  const page = await h.openApp(context);
  const shell = await openShell(page);
  await expect(rowOf(page, ids.approval)).toHaveAttribute("aria-selected", "true");
  await page.locator("body").click({ position: { x: 1, y: 1 } });
  await expect(shell.getByRole("group", { name: "Focused approval" })).toBeVisible();
  const status = shell.locator(".sv-status");
  await page.keyboard.press("d");
  await expect(status).toContainText(`deny`);
  await expect(status).toContainText("[y/n]");
  await page.keyboard.press("n");
  await expect(status).toContainText("deny not sent");
  expect(h.built.tasks.get(ids.approval)?.state).toBe("RUNNING");
  await page.keyboard.press("d");
  await page.keyboard.press("y");
  await h.waitForState(ids.approval, "FAILED");

  await page.keyboard.press("j");
  await page.keyboard.press("j");
  const target = await shell.getByRole("region", { name: "Process list" }).locator('[aria-selected="true"] .sv-pid').innerText();
  const id = target.replace(/^▸\s*/, "").trim();
  expect([ids.running, ids.waiting]).toContain(id);
  await page.keyboard.press("c");
  await expect(status).toContainText(`cancel ${id}? [y/n]`);
  await page.keyboard.press("Escape");
  await expect(status).toContainText("cancel not sent");
  await page.keyboard.press("c");
  await page.keyboard.press("y");
  await h.waitForState(id, "CANCELLED");
});

for (const scheme of ["light", "dark"] as const) test(`follows the ${scheme} system theme at 1280 and 390`, async ({ context }, info) => {
  const page = await h.openApp(context);
  await page.emulateMedia({ colorScheme: scheme });
  const shell = await openShell(page);
  await expect(rowOf(page, ids.running)).toContainText(A);
  await expect(shell.getByRole("region", { name: "Event log" })).toContainText("approval.requested");
  expect(await page.locator("body").evaluate(el => getComputedStyle(el).backgroundColor)).toBe(scheme === "light" ? "rgb(251, 251, 248)" : "rgb(4, 6, 16)");
  const bg = await shell.evaluate(el => getComputedStyle(el).backgroundColor);
  expect(bg).toBe(scheme === "light" ? "rgb(251, 251, 248)" : "rgb(7, 11, 22)");
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 860 });
    await expect(shell.getByRole("textbox", { name: /agentic-os \[.*\]\$/ })).toBeInViewport();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath(`shell-${scheme}-${width}.png`), fullPage: true });
  }
});


test("repository preview binds a composed run and cap; changing repository invalidates it", async ({ context }) => {
  const page = await h.openApp(context);
  const shell = await openShell(page);
  const picker = shell.getByRole("combobox", { name: "Repository", exact: true });
  const cmd = shell.getByRole("textbox", { name: /agentic-os/ });
  await expect(cmd).toHaveAccessibleName("agentic-os [no repo: route only]$");
  await picker.selectOption(repo);
  await expect(cmd).toHaveAccessibleName("agentic-os [ai-control-plan]$");
  await page.reload();
  await expect(picker).toHaveValue(repo);
  await cmd.fill("Inspect the scratch repository");
  await cmd.press("Tab");
  const composition = shell.getByRole("region", { name: "Composition preview" });
  await expect(composition).toContainText("Composed.");
  await expect(composition.locator(".comp-stage")).toHaveCount(6);
  await expect(composition).toContainText("50,000");
  const created = h.built.tasks.list().find(t => t.goal === "Inspect the scratch repository")!;
  const api = await h.privileged();
  const preview = await (await api.post(`/api/tasks/${created.id}/compose`, { data: {} })).json();
  await cmd.press("Enter");
  await expect(shell.locator(".sv-status")).toContainText(`started ${created.id}`);
  const detail = await (await api.get(`/api/tasks/${created.id}`)).json();
  expect(detail.repo_path).toBe(repo);
  expect(detail.runs).toHaveLength(1);
  const budget = await (await api.get(`/api/tasks/${created.id}/composition/budget`)).json();
  expect(budget.latestRevision.caps.max_tokens).toBe(50_000);
  const history = await (await api.get(`/api/tasks/${created.id}/composition`)).json();
  expect(history.attempts.at(-1).compositionDigest).toBe(preview.compositionDigest);
  await cmd.fill("A new preview");
  await cmd.press("Tab");
  await expect(composition).toBeVisible();
  await picker.selectOption("");
  await expect(composition).toHaveCount(0);
  await cmd.press("Tab");
  await expect(shell.getByLabel("Route preview")).toBeVisible();
  const routeOnly = h.built.tasks.list().filter(t => t.goal === "A new preview");
  expect(routeOnly).toHaveLength(2);
  expect(routeOnly.filter(t => t.repo_path === repo)).toHaveLength(1);
  await api.dispose();
});

test("Mission mode alias retains the legacy shell route", async ({ context }, info) => {
  const page = await h.openApp(context);
  await page.getByRole("banner").getByRole("link", { name: "Mission mode", exact: true }).click();
  await expect(page).toHaveURL(/#\/shell$/);
  await page.evaluate(() => { location.hash = "/mission"; });
  await expect(page).toHaveURL(/#\/mission$/);
  await expect(page.getByRole("region", { name: "Mission workspace" })).toBeVisible();
  await page.screenshot({ path: info.outputPath("mission-mode.png"), fullPage: true });
  await page.evaluate(() => { location.hash = "/shell"; });
  await expect(page.getByRole("region", { name: "Mission workspace" })).toBeVisible();
  await expect(page).toHaveTitle("Mission · Agentic OS");
});
