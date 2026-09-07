/**
 * Demo A.5 — deterministic, repeatable end-to-end walkthrough of the merged
 * K4 (dependency waits) and K5 (recurring schedules) kernel-scheduler
 * capabilities, driven through the Orbital operator UI against a real in-process
 * API + the deterministic FakeAdapter. No real provider, no wall-clock waits,
 * no real cron timer: the injected clock is advanced and `scheduler.tick()` is
 * called explicitly.
 *
 * The K6 Cockpit half (the plane schedule as a third Cockpit source, capability
 * gating, source isolation) is a separate deterministic command in the `cockpit`
 * repo — `npm run demo:a5` — because the two live servers a single automated
 * command would need are disproportionate for the slice (see
 * docs/demo/demo-a5-scheduling.md).
 *
 * Run: `pnpm demo:a5` (from repo root) or
 *      `pnpm --filter @agent-plane/web exec playwright test e2e/demo-a5.spec.ts --project=demo-a5`
 */
import { test, expect, request, type BrowserContext } from "@playwright/test";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantId } from "@agent-plane/core";
import { loadConfig } from "../../api/src/config.js";
import { openDb, type Db } from "../../api/src/db/index.js";
import { buildServer, type BuiltServer } from "../../api/src/server.js";
import { credentialPath, readCredential } from "../../api/src/auth/credential-file.js";
import { mintBootstrapToken } from "../../api/src/auth/bootstrap-token.js";

const PORT = 4178;
const apiOrigin = `http://127.0.0.1:${PORT}`;
const A = "fake-a" as AssistantId;

let home: string;
let db: Db;
let built: BuiltServer;
/** Fake clock. Every state change advances it explicitly; nothing sleeps. */
let clock = new Date("2026-09-06T12:00:00.000Z");
const setClock = (iso: string) => {
  clock = new Date(iso);
};

test.beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "demo-a5-"));
  const config = loadConfig({ AGENT_PLANE_HOME: home });
  config.api.port = PORT;
  config.assistants = { [A]: { provider: "fake" } };
  config.scheduler = { ...config.scheduler!, enabled: true };
  db = openDb(config.dbPath);
  built = buildServer({ config, db, now: () => clock });
  built.registry.init();
  await built.registry.syncAll();
  await built.app.listen({ host: "127.0.0.1", port: PORT });
});

test.afterAll(async () => {
  await built.app.close();
  if (db.open) db.close();
  rmSync(home, { recursive: true, force: true });
});

function currentSecret() {
  return readCredential(credentialPath(loadConfig({ AGENT_PLANE_HOME: home }).dir))
    .secrets.at(-1)!;
}

/** Ephemeral single-use launcher page that bootstraps the SPA session (mirrors auth.spec / demo-a). */
async function launcher(): Promise<{ url: string; server: Server }> {
  let served = false;
  const secret = currentSecret();
  const server = createServer((_, res) => {
    if (served) {
      res.writeHead(410).end();
      return;
    }
    served = true;
    const token = mintBootstrapToken(secret, {
      aud: apiOrigin,
      lo: url,
      cap: secret.capabilities,
      exp: Math.floor(clock.getTime() / 1000) + 30,
    });
    res.setHeader("content-type", "text/html");
    res.end(
      `<form method=POST action="${apiOrigin}/api/auth/bootstrap"><input name=token value="${token}"></form><script>document.forms[0].submit()</script>`,
    );
    server.close();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as { port: number };
  const url = `http://127.0.0.1:${port}`;
  return { url, server };
}

async function openApp(context: BrowserContext) {
  const l = await launcher();
  const page = await context.newPage();
  await page.goto(l.url);
  await expect(page.getByText("Agent Control Plane")).toBeVisible();
  await expect(page.getByRole("heading", { name: /Missions in orbit/ })).toBeVisible();
  return page;
}

function privileged() {
  return request.newContext({
    baseURL: apiOrigin,
    extraHTTPHeaders: { Authorization: `Bearer ${currentSecret().secret}` },
  });
}

const waitForState = async (id: string, expected: string) =>
  expect
    .poll(() => built.tasks.get(id)?.state, { timeout: 8000, intervals: [100] })
    .toBe(expected);

test("Demo A.5: K4 dependency wait + wake, K5 recurring schedule occurrence — through the Orbital UI", async ({
  context,
}, testInfo) => {
  const consoleErrors: string[] = [];
  const page = await openApp(context);
  page.on("console", (m) => {
    if (m.type() === "error") consoleErrors.push(m.text());
  });
  page.on("pageerror", (e) => consoleErrors.push(String(e)));

  const api = await privileged();
  const inspector = page.getByRole("region", { name: "Selected task inspector" });
  const selectTask = async (id: string) => {
    await page.getByRole("textbox", { name: "Search tasks" }).fill(id);
    await page.getByRole("button", { name: new RegExp(id) }).first().click();
    await expect(inspector.getByRole("code")).toContainText(id);
  };

  // ===========================================================================
  // SCENARIO B — DEPENDENCY WAIT (K4)
  //
  // Task B waits on Task A. Before A is terminal, B is parked in
  // WAITING_RESOURCE with the dependency task id and the failure policy on show.
  // A reaching a terminal state wakes B through the existing generation-aware
  // wake path — no operator action, no recreation of B.
  // ===========================================================================
  const taskA = await api.post("/api/tasks", {
    data: { goal: "Build the release candidate [demo A.5 dependency root]" },
  });
  expect(taskA.status()).toBe(201);
  const aId = (await taskA.json()).taskId as string;

  const taskB = await api.post("/api/tasks", {
    data: {
      goal: "Publish the release notes [demo A.5 dependant]",
      wait: { kind: "dependency", dependsOn: [aId], onDependencyFailure: "wait-input" },
    },
  });
  expect(taskB.status()).toBe(201);
  const bId = (await taskB.json()).taskId as string;
  await waitForState(bId, "WAITING_RESOURCE");

  // Self-dependency is rejected at attach — K4 guards the wait, not just the wake.
  const selfDep = await api.post(`/api/tasks/${bId}/wait`, {
    data: { kind: "dependency", dependsOn: [bId] },
  });
  expect(selfDep.status()).toBe(409);
  expect((await selfDep.json()).error).toMatch(/cannot depend on itself/i);

  await selectTask(bId);
  await inspector.getByRole("button", { name: "Schedule", exact: true }).click();
  await expect(inspector.getByText("Dependency wait · K4")).toBeVisible();
  await expect(inspector.getByText(new RegExp(`${aId}.*on failure: wait-input`))).toBeVisible();
  await expect(inspector.getByText(/Routing happens at wake, not now/)).toBeVisible();
  // The schedule surface now names K4 as implemented, not planned.
  await expect(inspector.getByText("Implemented · K4")).toBeVisible();
  await expect(inspector.getByText("Planned · K4")).toHaveCount(0);
  await expect(inspector.getByText("Planned · K5")).toHaveCount(0);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({
    path: testInfo.outputPath("demo-a5-1-dependency-waiting.png"),
    fullPage: true,
  });

  // Task A runs to completion on the deterministic FakeAdapter.
  built.tasks.transition(aId, "ROUTING");
  await built.orchestrator.startTask(aId, A);
  await waitForState(aId, "COMPLETED");

  // The terminal event alone wakes B (a defensive tick covers a missed microtask).
  await built.scheduler.tick();
  await waitForState(bId, "COMPLETED");

  await expect
    .poll(async () => {
      await selectTask(bId);
      return inspector.getByText("Completed").first().isVisible();
    }, { timeout: 8000 })
    .toBe(true);
  await inspector.getByRole("button", { name: "Schedule", exact: true }).click();
  await expect(inspector.getByText("dispatch.started")).toBeVisible();
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({
    path: testInfo.outputPath("demo-a5-2-dependency-released.png"),
    fullPage: true,
  });

  // ---------------------------------------------------------------------------
  // Failure policy — one representative case: onDependencyFailure = "cancel".
  // ---------------------------------------------------------------------------
  const failRoot = await api.post("/api/tasks", {
    data: { goal: "Run the flaky integration gate [demo A.5 fail root]" },
  });
  const frId = (await failRoot.json()).taskId as string;
  const cancelDependant = await api.post("/api/tasks", {
    data: {
      goal: "Ship if the gate is green [demo A.5 cancel-on-fail]",
      wait: { kind: "dependency", dependsOn: [frId], onDependencyFailure: "cancel" },
    },
  });
  const cdId = (await cancelDependant.json()).taskId as string;
  await waitForState(cdId, "WAITING_RESOURCE");

  // The gate task reaches a terminal FAILED state; the dependency wake then
  // applies onDependencyFailure = "cancel" without the dependant ever routing.
  built.tasks.transition(frId, "ROUTING");
  built.tasks.transition(frId, "FAILED");
  await built.scheduler.tick();
  await waitForState(cdId, "CANCELLED");

  await selectTask(cdId);
  await inspector.getByRole("button", { name: "Schedule", exact: true }).click();
  await expect(inspector.getByText(/dependency\.failed/)).toBeVisible();
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({
    path: testInfo.outputPath("demo-a5-3-dependency-failed-cancel.png"),
    fullPage: true,
  });
  // The dependant never executed.
  expect(
    db.prepare("SELECT COUNT(*) AS n FROM runs WHERE task_id = ?").get(cdId) as { n: number },
  ).toEqual({ n: 0 });

  // ===========================================================================
  // SCENARIO A — RECURRING SCHEDULE (K5)
  //
  // A schedule is created through the same POST /api/schedules + commands.write
  // path Cockpit uses. The Control Plane computes and owns nextFireAt. One
  // occurrence creates exactly one task; a duplicate tick creates nothing; the
  // task waits on the existing K1 time protocol and routes at execution time.
  // ===========================================================================
  const create = await api.post("/api/schedules", {
    data: { goal: "Post the nightly ops digest [demo A.5 recurring]", cron: "0 15 * * *", timezone: "UTC" },
  });
  expect(create.status()).toBe(201);
  const schedule = await create.json();
  // nextFireAt is the plane's, computed in the schedule timezone from the clock.
  expect(schedule.nextFireAt).toBe("2026-09-06T15:00:00.000Z");
  expect(schedule.overlap).toBe("skip");
  expect(schedule.enabled).toBe(true);
  // I-S1: the schedule row carries an intent, never a resolved assistant/model.
  expect(schedule.intent).toMatchObject({ goal: "Post the nightly ops digest [demo A.5 recurring]" });
  expect(schedule.intent.assistantId).toBeUndefined();

  const list = await api.get("/api/schedules");
  expect(list.status()).toBe(200);
  const listed = (await list.json()).find(
    (s: { scheduleId: string }) => s.scheduleId === schedule.scheduleId,
  );
  expect(listed.nextFireAt).toBe("2026-09-06T15:00:00.000Z");

  // The occurrence instant arrives; the scheduler fires it in one transaction:
  // insert the unique occurrence, create the task, dispatch it through the K1
  // durable-dispatch protocol, and advance next-fire.
  setClock("2026-09-06T15:00:00.000Z");
  await built.scheduler.tick();

  const detail = await (await api.get(`/api/schedules/${schedule.scheduleId}`)).json();
  expect(detail.occurrences).toHaveLength(1);
  expect(detail.occurrences[0]).toMatchObject({
    occurrenceAt: "2026-09-06T15:00:00.000Z",
    outcome: "created",
  });
  expect(detail.lastFiredAt).toBe("2026-09-06T15:00:00.000Z");
  expect(detail.nextFireAt).toBe("2026-09-07T15:00:00.000Z");
  const occurrenceTaskId = detail.occurrences[0].taskId as string;

  // A duplicate tick at the same instant is a no-op — the unique occurrence
  // constraint means no second task is ever created.
  const taskCountBefore = (
    db.prepare("SELECT COUNT(*) AS n FROM tasks").get() as { n: number }
  ).n;
  await built.scheduler.tick();
  const afterDup = await (await api.get(`/api/schedules/${schedule.scheduleId}`)).json();
  expect(afterDup.occurrences).toHaveLength(1);
  expect(
    (db.prepare("SELECT COUNT(*) AS n FROM tasks").get() as { n: number }).n,
  ).toBe(taskCountBefore);

  // The one occurrence task routes at fire time (routing at execution time, not
  // at schedule-creation time) and runs on the deterministic FakeAdapter.
  await waitForState(occurrenceTaskId, "COMPLETED");
  expect(built.scheduler.dispatches(occurrenceTaskId).length).toBeGreaterThanOrEqual(1);
  await expect
    .poll(async () => {
      await selectTask(occurrenceTaskId);
      return inspector.getByText("Completed").first().isVisible();
    }, { timeout: 8000 })
    .toBe(true);
  await inspector.getByRole("button", { name: "Schedule", exact: true }).click();
  await expect(inspector.getByText("dispatch.started")).toBeVisible();
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({
    path: testInfo.outputPath("demo-a5-4-schedule-occurrence-executed.png"),
    fullPage: true,
  });

  expect(consoleErrors, `console errors: ${consoleErrors.join("\n")}`).toEqual([]);
  await api.dispose();
});
