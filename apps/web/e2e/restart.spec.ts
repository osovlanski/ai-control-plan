import { test, expect } from "@playwright/test";
import { boot, A, type Harness } from "./harness.js";

let h: Harness;
test.beforeEach(async () => {
  h = await boot(4193, "restart-web", { [A]: { provider: "fake" } }, undefined, config => {
    config.execution = { harnessModes: { single: true } };
    config.policy.approvalMode = "prompt-on-escalation";
  });
});
test.afterEach(async () => { await h.close(); });

test("restart requires a durable recovery decision and confirmation; conflicts keep their reason", async ({ context }) => {
  const api = await h.privileged();
  const { taskId } = await (await api.post("/api/tasks", { data: { goal: "Recover [FAKE:APPROVAL]" } })).json();
  await api.post(`/api/tasks/${taskId}/start`, { data: { assistantId: A } });
  await expect.poll(async () => (await (await api.get(`/api/tasks/${taskId}/sessions`)).json())[0]?.sessionState).toBe("AWAITING_APPROVAL");
  const [session] = await (await api.get(`/api/tasks/${taskId}/sessions`)).json();
  const page = await h.openApp(context);
  await page.goto(`${h.origin}/#/missions/${taskId}`);
  const detail = page.locator(".task-detail");
  await expect(detail.getByRole("button", { name: "Restart", exact: true })).toHaveCount(0);
  // Model the persisted result of recovery; the browser must read the audit, not infer from WAITING_INPUT.
  h.db.prepare("UPDATE tasks SET state = 'WAITING_INPUT', pause_kind = 'harness_error' WHERE id = ?").run(taskId);
  await page.reload();
  await expect(detail.getByRole("button", { name: "Restart", exact: true })).toHaveCount(0);
  h.db.prepare("INSERT INTO events (run_id, seq, ts, type, summary, payload) SELECT ?, COALESCE(MAX(seq), 0)+1, ?, 'recovery.decision', 'recovery: resume_offered', ? FROM events WHERE run_id = ?")
    .run(session.sessionId, h.clock.now().toISOString(), JSON.stringify({ action: "resume_offered" }), session.sessionId);
  await page.reload();
  await expect(detail.getByRole("button", { name: "Restart", exact: true })).toBeVisible();
  const conflict = await api.post(`/api/tasks/${taskId}/handoff`, { data: { to: A } });
  expect(conflict.status()).toBe(409);
  const conflictBody = await conflict.json();
  expect(conflictBody.error).toContain(`/api/tasks/${taskId}/restart`);
  await page.route(`**/api/tasks/${taskId}/handoff`, route => route.fulfill({ status: 409, json: conflictBody }));
  await detail.getByRole("button", { name: "Hand off", exact: true }).click();
  await expect(detail.getByText(new RegExp(`POST /api/tasks/${taskId}/restart`))).toBeVisible();
  await detail.getByRole("button", { name: "Sessions", exact: true }).click();
  await detail.getByRole("button", { name: session.sessionId, exact: true }).click();
  await detail.getByRole("group", { name: "Pending session approval" }).getByRole("button", { name: "Approve", exact: true }).click();
  await expect(detail.getByRole("alert")).toContainText(`/api/tasks/${taskId}/restart`);
  let calls = 0;
  const reason = "Recovery cannot release this session; use POST /api/tasks/example/restart";
  await page.route(`**/api/tasks/${taskId}/restart`, route => { calls++; return route.fulfill({ status: 409, json: { error: reason } }); });
  await detail.locator(".task-detail-toolbar").getByRole("button", { name: "Restart", exact: true }).click();
  expect(calls).toBe(0);
  await detail.getByRole("button", { name: "Keep waiting" }).click();
  expect(calls).toBe(0);
  await detail.locator(".task-detail-toolbar").getByRole("button", { name: "Restart", exact: true }).click();
  await detail.getByRole("button", { name: "Confirm restart" }).click();
  await expect(detail.getByRole("alert").filter({ hasText: reason })).toBeVisible();
  expect(calls).toBe(1);
  await page.goto(`${h.origin}/#/overview`);
  await page.getByRole("group", { name: "Overview view" }).getByRole("button", { name: "Shell", exact: true }).click();
  const shell = page.getByRole("region", { name: "Shell view", exact: true });
  await expect(shell.getByRole("button", { name: "Restart", exact: true })).toBeVisible();
  await expect(shell.getByRole("group", { name: "Focused approval" })).toBeVisible();
  await page.keyboard.press("a");
  await expect(shell.getByRole("status")).toContainText(`/api/tasks/${taskId}/restart`);
  await shell.getByRole("button", { name: "Restart", exact: true }).click();
  await shell.getByRole("button", { name: "Confirm restart" }).click();
  await expect(shell.getByRole("status")).toContainText(reason);
  expect(calls).toBe(2);
  await api.dispose();
});

test("composition cost basis accompanies its method and disappears when absent", async ({ context }) => {
  const api = await h.privileged();
  const { taskId } = await (await api.post('/api/tasks', { data: { goal: 'Cost evidence' } })).json();
  await api.post(`/api/tasks/${taskId}/start`, { data: { assistantId: A } });
  await h.waitForState(taskId, 'COMPLETED');
  const page = await h.openApp(context);
  await page.route('**/api/workspace', async route => { const r = await route.fetch(); const w = await r.json(); await route.fulfill({ json: { ...w, composer: { enabled: true } } }); });
  await page.route(`**/api/tasks/${taskId}/composition`, route => route.fulfill({ json: { revisions: [], attempts: [], optIns: [] } }));
  let basis: string | undefined = 'in_run';
  await page.route(`**/api/tasks/${taskId}/composition/budget`, route => route.fulfill({ json: {
    taskId, provisional: false, caps: {}, remaining: {}, latestRevision: null, exhausted: [], overruns: [],
    consumed: { tokens: 1650, costUsd: 0.025, costMethod: 'measured', sessions: 1, unknownCostSessions: 0, recordCount: 0 },
    runs: [{ runId: 'cost-run', assistantId: A, model: 'fake-1', tokens: 1650, source: 'in_run', inRunTokens: 1650, recordTokens: 0, recordCount: 0, regressed: [], cost: { usd: 0.025, method: 'measured', ...(basis ? { basis } : {}) } }],
  } }));
  for (basis of ['in_run', 'records', 'cache creation at the input rate: no cache-write price', undefined]) {
    await page.goto(`${h.origin}/#/missions/${taskId}`);
    await page.reload();
    const detail = page.locator('.task-detail');
    await detail.getByRole('button', { name: 'Composition', exact: true }).click();
    const row = detail.getByRole('row', { name: /cost-run/ });
    await expect(row.locator('.method-measured')).toHaveCount(2);
    if (basis) await expect(row.locator('.comp-note').filter({ hasText: basis })).toBeVisible();
    else await expect(row.locator('td').nth(2).locator('.comp-note')).toHaveCount(0);
  }
  await api.dispose();
});
