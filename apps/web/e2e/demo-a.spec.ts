/**
 * Demo A — deterministic, repeatable end-to-end walkthrough of the merged
 * K1 (durable time dispatch), K2 (quota wait + checkpoint + resume) and
 * K3 (optional idle quota probe) kernel-scheduler capabilities, driven through
 * the Orbital operator UI against a real in-process API + the deterministic
 * FakeAdapter. No real provider, no wall-clock waits, no real quota exhaustion.
 *
 * Run: `pnpm demo:a` (from repo root) or
 *      `pnpm --filter @agent-plane/web exec playwright test e2e/demo-a.spec.ts --project=demo-a`
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
import type { QuotaProbeFn, ProbeOutcome } from "../../api/src/modules/quota-probe.js";
import { credentialPath, readCredential } from "../../api/src/auth/credential-file.js";
import { mintBootstrapToken } from "../../api/src/auth/bootstrap-token.js";

const PORT = 4177;
const apiOrigin = `http://127.0.0.1:${PORT}`;
const A = "fake-a" as AssistantId;
const B = "fake-b" as AssistantId;

let home: string;
let db: Db;
let built: BuiltServer;
let clock = new Date("2026-09-06T12:00:00.000Z");
const advance = (ms: number) => {
  clock = new Date(clock.getTime() + ms);
};

/** Deterministic K3 transport: fake-a exposes an idle endpoint, fake-b does not. */
const demoProbe: QuotaProbeFn = async (
  _provider,
  options,
): Promise<ProbeOutcome> => {
  if ((options as { demoProbe?: string }).demoProbe === "ok") {
    return {
      status: "ok",
      buckets: [
        {
          bucket: "five_hour",
          usedPercent: 37,
          resetsAt: new Date(clock.getTime() + 5 * 3_600_000).toISOString(),
        },
      ],
    };
  }
  return {
    status: "unsupported",
    buckets: [],
    detail: "no verified idle quota endpoint for fake (demo)",
  };
};

test.beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "demo-a-"));
  const config = loadConfig({ AGENT_PLANE_HOME: home });
  config.api.port = PORT; // server's own `origin` (bootstrap `aud`) is derived from config, not listen()
  config.assistants = {
    [A]: { provider: "fake", options: { demoProbe: "ok" } },
    [B]: { provider: "fake", options: { demoProbe: "unsupported" } },
  };
  config.scheduler = { ...config.scheduler!, enabled: true, quotaProbe: true };
  db = openDb(config.dbPath);
  built = buildServer({ config, db, now: () => clock, quotaProbeFn: demoProbe });
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

/** Ephemeral single-use launcher page that bootstraps the SPA session (mirrors auth.spec). */
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

test("Demo A: K1 durable time wait, K2 quota wait + resume, K3 idle probe — through the Orbital UI", async ({
  context,
}, testInfo) => {
  const page = await openApp(context);
  const api = await privileged();
  const inspector = page.getByRole("region", { name: "Selected task inspector" });
  const selectTask = async (id: string) => {
    await page.getByRole("textbox", { name: "Search tasks" }).fill(id);
    await page.getByRole("button", { name: new RegExp(id) }).first().click();
    await expect(inspector.getByRole("code")).toContainText(id);
  };

  // ---------------------------------------------------------------------------
  // A. DURABLE TIME WAIT — K1
  // ---------------------------------------------------------------------------
  const k1 = await api.post("/api/tasks", {
    data: {
      goal: "Publish the nightly digest [demo K1]",
      wait: {
        kind: "time",
        notBefore: new Date(clock.getTime() + 60_000).toISOString(),
      },
    },
  });
  expect(k1.status()).toBe(201);
  const k1Id = (await k1.json()).taskId as string;
  await waitForState(k1Id, "WAITING_RESOURCE");

  await selectTask(k1Id);
  await inspector.getByRole("button", { name: "Schedule", exact: true }).click();
  await expect(inspector.getByText("Time wait · K1")).toBeVisible();
  await expect(inspector.getByText(/generation 1/)).toBeVisible();
  await expect(
    inspector.getByText("Next eligible time", { exact: true }),
  ).toBeVisible();
  await expect(
    inspector.getByText(/The scheduler owns this task/).first(),
  ).toBeVisible();
  await expect(inspector.getByText("Implemented · K1").first()).toBeVisible();
  // No stale "Planned · K1" / "Deferred execution is unavailable" copy remains.
  await expect(page.getByText("Planned · K1")).toHaveCount(0);
  await expect(
    page.getByText("Deferred execution is unavailable in this backend"),
  ).toHaveCount(0);
  await page.setViewportSize({ width: 1440, height: 1024 });
  await page.evaluate(() => window.scrollTo(0, 0)); // sticky rail/field render at the top of full-page stills
  await page.screenshot({
    path: testInfo.outputPath("demo-a-1-k1-waiting.png"),
    fullPage: true,
  });

  // Timer wake: the scheduler owns the wake once the condition is due.
  advance(61_000);
  await built.scheduler.tick();
  await waitForState(k1Id, "COMPLETED");
  await expect
    .poll(async () => {
      await selectTask(k1Id);
      return inspector.getByText("Completed").first().isVisible();
    }, { timeout: 8000 })
    .toBe(true);
  await inspector.getByRole("button", { name: "Schedule", exact: true }).click();
  await expect(inspector.getByText("dispatch.started")).toBeVisible();

  // run-now override on a second task: operator wakes it before its time.
  const k1b = await api.post("/api/tasks", {
    data: {
      goal: "Rotate the access logs [demo K1 run-now]",
      wait: {
        kind: "time",
        notBefore: new Date(clock.getTime() + 3_600_000).toISOString(),
      },
    },
  });
  const k1bId = (await k1b.json()).taskId as string;
  await waitForState(k1bId, "WAITING_RESOURCE");
  await selectTask(k1bId);
  await inspector.getByRole("button", { name: "Schedule", exact: true }).click();
  await inspector.getByRole("button", { name: "Run now" }).click();
  await waitForState(k1bId, "COMPLETED");

  // cancel: a third task is retired from its wait without ever executing.
  const k1c = await api.post("/api/tasks", {
    data: {
      goal: "Draft the quarterly summary [demo K1 cancel]",
      wait: {
        kind: "time",
        notBefore: new Date(clock.getTime() + 3_600_000).toISOString(),
      },
    },
  });
  const k1cId = (await k1c.json()).taskId as string;
  await waitForState(k1cId, "WAITING_RESOURCE");
  await selectTask(k1cId);
  await inspector.getByRole("button", { name: "Schedule", exact: true }).click();
  await inspector.getByRole("button", { name: "Cancel task" }).click();
  await waitForState(k1cId, "CANCELLED");

  // ---------------------------------------------------------------------------
  // B. QUOTA WAIT + RESUME — K2  (deterministic FakeAdapter [FAKE:LIMIT] path)
  // ---------------------------------------------------------------------------
  built.cooldowns.penalize(
    B,
    "limit",
    "backup blocked",
    new Date(clock.getTime() + 60 * 60_000).toISOString(),
  );
  // No assistant override: the wake is free to re-route once fake-a is blocked.
  const k2Id = built.tasks.create({
    goal: "Continue the migration [demo K2] [FAKE:LIMIT]",
  }).taskId;
  built.tasks.transition(k2Id, "ROUTING");
  await built.orchestrator.startTask(k2Id, A);
  await waitForState(k2Id, "WAITING_RESOURCE");

  const wait = built.scheduler.condition(k2Id)!;
  expect(wait.kind).toBe("quota");
  expect(typeof wait.checkpointId).toBe("string");

  await selectTask(k2Id);
  await inspector.getByRole("button", { name: "Schedule", exact: true }).click();
  await expect(inspector.getByText("Quota wait · K2")).toBeVisible();
  await expect(
    inspector.getByText(/continuation resumes from here/),
  ).toBeVisible();
  await expect(inspector.getByText("Quota blocker evidence")).toBeVisible();
  await expect(inspector.getByText(/source runtime-probe/).first()).toBeVisible();
  await expect(
    inspector.getByText(/provenance provider-reported/).first(),
  ).toBeVisible();
  await expect(inspector.getByText("Implemented · K2")).toBeVisible();
  await page.evaluate(() => window.scrollTo(0, 0)); // sticky rail/field render at the top of full-page stills
  await page.screenshot({
    path: testInfo.outputPath("demo-a-2-k2-quota-wait.png"),
    fullPage: true,
  });

  // Fresh evidence: the blocked failover candidate recovers, operator wakes it.
  built.cooldowns.clear(B);
  await inspector.getByRole("button", { name: "Run now" }).click();
  await expect
    .poll(() => built.tasks.get(k2Id)?.state, { timeout: 15000, intervals: [150] })
    .toBe("COMPLETED");

  // The wake re-routed off the blocked fake-a and resumed on fake-b from the checkpoint.
  const k2Runs = db
    .prepare("SELECT assistant_id, state FROM runs WHERE task_id = ? ORDER BY started_at")
    .all(k2Id) as Array<{ assistant_id: string; state: string }>;
  expect(k2Runs.length).toBeGreaterThanOrEqual(2);
  const resumedOn = k2Runs.at(-1)!.assistant_id;
  expect(resumedOn).toBe(B);
  await expect
    .poll(async () => {
      await selectTask(k2Id);
      return inspector.getByText("Completed").first().isVisible();
    }, { timeout: 8000 })
    .toBe(true);
  await inspector.getByRole("button", { name: "Execution", exact: true }).click();
  // Identity grid resolves the post-wake assistant from the selected run's evidence.
  await expect(
    inspector.getByText(resumedOn, { exact: true }).first(),
  ).toBeVisible();

  // ---------------------------------------------------------------------------
  // C. IDLE QUOTA OBSERVATION — K3
  // ---------------------------------------------------------------------------
  advance(20 * 60_000); // make the idle probe due
  await built.quotaProbes.refresh();
  await selectTask(k2Id);
  await inspector.getByRole("button", { name: "Quota", exact: true }).click();
  await expect(inspector.getByText("Idle quota observation")).toBeVisible();
  const fakeARow = inspector.locator("li", { hasText: A });
  await expect(fakeARow.getByText("ok", { exact: true })).toBeVisible();
  await expect(fakeARow.getByText(/freshness (live|recent)/)).toBeVisible();
  const fakeBRow = inspector.locator("li", { hasText: B });
  await expect(fakeBRow.getByText("unsupported", { exact: true })).toBeVisible();
  await expect(
    fakeBRow.getByText(/no verified idle endpoint/),
  ).toBeVisible();
  await page.evaluate(() => window.scrollTo(0, 0)); // sticky rail/field render at the top of full-page stills
  await page.screenshot({
    path: testInfo.outputPath("demo-a-3-k3-idle-probe.png"),
    fullPage: true,
  });

  // ---------------------------------------------------------------------------
  // Responsive check — laptop + mobile, no horizontal overflow.
  // ---------------------------------------------------------------------------
  await page.setViewportSize({ width: 1100, height: 800 });
  await page.evaluate(() => window.scrollTo(0, 0)); // sticky rail/field render at the top of full-page stills
  await page.screenshot({
    path: testInfo.outputPath("demo-a-4-laptop.png"),
    fullPage: true,
  });
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
  ).toBe(true);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => window.scrollTo(0, 0)); // sticky rail/field render at the top of full-page stills
  await page.screenshot({
    path: testInfo.outputPath("demo-a-5-mobile.png"),
    fullPage: true,
  });
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
  ).toBe(true);

  await api.dispose();
});
