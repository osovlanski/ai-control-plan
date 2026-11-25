import { writeFileSync } from "node:fs";
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
  await expect(panel(page).getByRole("region", { name: "How joins are labelled" })).toContainText(served.inferenceRules.predecessor);

  const links = panel(page).getByRole("region", { name: "Linked issues and PRs" });
  await expect(links.getByRole("link", { name: "osovlanski/ai-control-plan#9999" })).toHaveAttribute("href", "https://github.com/osovlanski/ai-control-plan/pull/9999");
  await expect(links).toContainText("Operator claim: implements (FAKE-link-not-real)");
  await expect(links).toContainText("not checked against GitHub");

  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 1100 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath(`provenance-${width}.png`), fullPage: true });
  }
});

/** Every label the plane served, in the order the panel prints them: runs, then handoffs. */
const servedSources = (served: TaskProvenance) => [
  ...served.runs.flatMap(r => [r.routingDecision.source, ...(r.continuedFrom ? [r.continuedFrom.source] : [])]),
  ...served.handoffs.map(x => x.from.source),
];

test("a real [FAKE:LIMIT] run that hands off to the other assistant shows the plane's joins as served", async ({ context }, info) => {
  // Nothing seeded: the plane runs fake-a, hits the scripted quota limit, checkpoints and hands off to fake-b.
  const task = h.built.tasks.create({ goal: "Regenerate the API reference [FAKE:LIMIT]" });
  const api = await h.privileged();
  const started = await api.post(`/api/tasks/${task.taskId}/start`, { data: { assistantId: A } });
  expect(started.ok(), await started.text()).toBe(true);
  await h.waitForState(task.taskId, "COMPLETED");
  const res = await api.get(`/api/tasks/${task.taskId}/provenance`);
  expect(res.ok()).toBe(true);
  const served = await res.json() as TaskProvenance;
  await api.dispose();
  writeFileSync(info.outputPath("provenance-limit-served.json"), JSON.stringify(served, null, 2));

  // The plane's own answer, so the panel is checked against a real handoff, not a fixture.
  expect(served.runs.map(r => r.assistantId)).toEqual([A, B]);
  expect(served.handoffs).toHaveLength(1);
  const [first, successor] = served.runs;
  const handoffServed = served.handoffs[0]!;
  expect(handoffServed).toMatchObject({ record: "handoff", closed: true, from: { runId: first!.runId, source: "handoff_record" }, to: { runId: successor!.runId } });

  const page = await open(context, task.taskId);
  const runs = panel(page).getByRole("region", { name: "Run provenance" });
  await expect(runs).toContainText("Runs (2)");
  await expect(runs.getByRole("listitem")).toHaveCount(2);
  for (const r of served.runs) {
    const item = runs.getByRole("listitem", { name: `Run ${r.runId}` });
    await expect(item).toContainText(r.assistantId);
    await expect(item).toContainText(r.executionPath === "harness" ? `Harness (request ${r.executionRequestId}` : "Legacy (no execution request)");
    const routing = item.locator("dd").filter({ has: page.locator(`[data-source="${r.routingDecision.source}"]`) }).first();
    if (r.routingDecision.id !== null) await expect(routing).toContainText(`Decision #${r.routingDecision.id} chose ${r.routingDecision.chosenAssistantId}`);
    if (r.continuedFrom) await expect(item).toContainText(`handoff ${r.continuedFrom.handoffId}`);
    else await expect(item).toContainText("Nothing (fresh start)");
  }
  await expect(runs.getByRole("listitem", { name: `Run ${successor!.runId}` })).toContainText(`Handoff (trigger ${handoffServed.trigger})`);
  const sources = await panel(page).locator("[data-source]").evaluateAll(els => els.map(el => el.getAttribute("data-source")));
  const expected = servedSources(served);
  expect(sources.slice(0, expected.length)).toEqual(expected);

  const handoff = panel(page).getByRole("listitem", { name: `Handoff ${handoffServed.id}` });
  await expect(handoff).toContainText(`trigger ${handoffServed.trigger}`);
  await expect(handoff).toContainText("closed");
  await expect(handoff.locator('[data-source="handoff_record"]')).toHaveText("via handoff_record");
  // The legend is there exactly when the plane inferred a join, with the plane's own rules.
  const legend = panel(page).getByRole("region", { name: "How joins are labelled" });
  if (expected.includes("inferred")) await expect(legend).toContainText(served.inferenceRules.routingDecision);
  else if (!expected.includes("unrecorded")) await expect(legend).toHaveCount(0);
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 1100 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath(`provenance-limit-${width}.png`), fullPage: true });
  }
});

test("either read failing leaves the other shown, and says why", async ({ context }) => {
  const task = h.built.tasks.create({ goal: "Trace where each run came from" });
  seedHandoff(task.taskId);
  const page = await h.openApp(context);
  // A plane older than API 2.12 answers the provenance route with 404; the links read still shows.
  await page.route("**/api/tasks/*/provenance", route => route.fulfill({ status: 404, contentType: "application/json", body: '{"error":"not found"}' }));
  await page.goto(`${h.origin}/#/missions/${task.taskId}`);
  await page.locator(".task-detail").getByRole("button", { name: "Provenance", exact: true }).click();
  await expect(panel(page)).toContainText("Provenance unavailable in this read (HTTP 404)");
  await expect(panel(page).getByRole("region", { name: "Run provenance" })).toHaveCount(0);
  await expect(panel(page).getByRole("region", { name: "Linked issues and PRs" })).toContainText("No issue or PR is linked to this task.");

  // And a links read of the wrong shape is refused while provenance still shows.
  await page.unroute("**/api/tasks/*/provenance");
  await page.route("**/api/tasks/*/links", route => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ taskId: task.taskId }) }));
  await page.reload();
  await page.locator(".task-detail").getByRole("button", { name: "Provenance", exact: true }).click();
  await expect(panel(page).getByRole("region", { name: "Run provenance" })).toContainText("Runs (2)");
  await expect(panel(page).getByRole("region", { name: "Linked issues and PRs" })).toContainText("not the API 2.13 shape, so none are shown: links is not a list");
  // The browser logs the intercepted 404 itself; that one is expected here, nothing else is.
  errors = errors.filter(e => !/status of 404/.test(e));
});

test("a task that has not started shows no runs, no handoffs and no links", async ({ context }) => {
  const task = h.built.tasks.create({ goal: "Nothing has run yet" });
  const page = await open(context, task.taskId);
  await expect(panel(page)).toContainText("No runs: the task has not started.");
  await expect(panel(page)).toContainText("No handoffs.");
  await expect(panel(page)).toContainText("No issue or PR is linked to this task.");
  await expect(panel(page).getByRole("region", { name: "How joins are labelled" })).toHaveCount(0);
});
