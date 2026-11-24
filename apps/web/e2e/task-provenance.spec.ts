import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import type { TaskProvenance } from "../src/api.js";
import { A, B, boot, type Harness } from "./harness.js";

// tlm-03 (Web half): task detail shows the plane's provenance read and the task's links, as served.
let h: Harness;
let errors: string[];
test.beforeEach(async ({ context }) => {
  h = await boot(4201, "task-provenance", { [A]: { provider: "fake" }, [B]: { provider: "fake" } });
  errors = [];
  context.on("page", page => {
    page.on("pageerror", error => errors.push(error.message));
    page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
  });
});
test.afterEach(async () => { await h.close(); expect(errors).toEqual([]); });

const t0 = "2026-09-06T12:00:00.000Z";
const t1 = "2026-09-06T12:10:00.000Z";
const t2 = "2026-09-06T12:11:00.000Z";

/** A legacy run on A, a manual handoff (no run on its checkpoint), then a legacy run on B. */
function seedHandoff(taskId: string) {
  const db = h.db;
  db.prepare("INSERT INTO routing_decisions (task_id, chosen_assistant_id, explanation, at) VALUES (?, ?, ?, ?)")
    .run(taskId, A, JSON.stringify({ ruleFired: "auto", candidates: [] }), t0);
  db.prepare("INSERT INTO runs (id, task_id, assistant_id, state, started_at, ended_at) VALUES (?, ?, ?, 'ENDED_OK', ?, ?)")
    .run(`run_a_${taskId}`, taskId, A, t0, t1);
  db.prepare("INSERT INTO checkpoints (id, task_id, run_id, envelope_snapshot, reason, at) VALUES (?, ?, NULL, '{}', 'handoff', ?)")
    .run(`cp_${taskId}`, taskId, t1);
  db.prepare("INSERT INTO runs (id, task_id, assistant_id, state, started_at, ended_at) VALUES (?, ?, ?, 'ENDED_OK', ?, ?)")
    .run(`run_b_${taskId}`, taskId, B, t2, t2);
  db.prepare("INSERT INTO handoffs (id, task_id, from_run_id, to_run_id, checkpoint_id, trigger, at) VALUES (?, ?, NULL, ?, ?, 'manual', ?)")
    .run(`h_${taskId}`, taskId, `run_b_${taskId}`, `cp_${taskId}`, t1);
}

async function open(context: BrowserContext, taskId: string) {
  const page = await h.openApp(context);
  await page.goto(`${h.origin}/#/missions/${taskId}`);
  await page.locator(".task-detail").getByRole("button", { name: "Provenance", exact: true }).click();
  return page;
}
const panel = (page: Page) => page.getByRole("region", { name: "Task provenance", exact: true });

test("shows each run's joins with their sources, the handoff, and an operator link as a claim", async ({ context }, info) => {
  const task = h.built.tasks.create({ goal: "Trace where each run came from" });
  seedHandoff(task.taskId);
  const api = await h.privileged();
  const linked = await api.post(`/api/tasks/${task.taskId}/links`, {
    data: { url: "https://github.com/osovlanski/ai-control-plan/pull/9999", relation: "implements", note: "FAKE-link-not-real" },
  });
  expect(linked.ok()).toBe(true);
  const served = await (await api.get(`/api/tasks/${task.taskId}/provenance`)).json() as TaskProvenance;
  await api.dispose();

  const page = await open(context, task.taskId);
  const runs = panel(page).getByRole("region", { name: "Run provenance" });
  await expect(runs).toContainText(`Runs (${served.runs.length})`);
  // Every join the plane labelled is shown with that label, and the page adds none of its own.
  for (const r of served.runs) {
    const item = runs.getByRole("listitem", { name: `Run ${r.runId}` });
    await expect(item.locator(`[data-source="${r.routingDecision.source}"]`)).toHaveCount(1 + (r.continuedFrom?.source === r.routingDecision.source ? 1 : 0));
    if (r.continuedFrom) await expect(item.locator(`[data-source="${r.continuedFrom.source}"]`).first()).toBeVisible();
  }
  const sources = await panel(page).locator("[data-source]").evaluateAll(els => els.map(el => el.getAttribute("data-source")));
  const expected = [...served.runs.flatMap(r => [r.routingDecision.source, ...(r.continuedFrom ? [r.continuedFrom.source] : [])]),
    ...served.handoffs.map(x => x.from.source)];
  expect(sources.slice(0, expected.length).sort()).toEqual([...expected].sort());

  const handoff = panel(page).getByRole("region", { name: "Handoff provenance" });
  await expect(handoff).toContainText(`h_${task.taskId}`);
  await expect(handoff).toContainText("trigger manual");
  await expect(handoff.locator('[data-source="inferred"]')).toBeVisible();
  await expect(panel(page).getByRole("region", { name: "How joins are labelled" })).toContainText(served.inferenceRules.predecessor!);

  const links = panel(page).getByRole("region", { name: "Linked issues and PRs" });
  await expect(links.getByRole("link", { name: "osovlanski/ai-control-plan#9999" })).toHaveAttribute("href", "https://github.com/osovlanski/ai-control-plan/pull/9999");
  await expect(links).toContainText("Operator claim: implements (FAKE-link-not-real)");
  await expect(links).toContainText("not checked against GitHub");

  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1100 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath(`provenance-${width}.png`), fullPage: true });
  }
});

test("a task that has not started shows no runs, no handoffs and no links", async ({ context }) => {
  const task = h.built.tasks.create({ goal: "Nothing has run yet" });
  const page = await open(context, task.taskId);
  await expect(panel(page)).toContainText("No runs: the task has not started.");
  await expect(panel(page)).toContainText("No handoffs.");
  await expect(panel(page)).toContainText("No issue or PR is linked to this task.");
  await expect(panel(page).getByRole("region", { name: "How joins are labelled" })).toHaveCount(0);
});
