import { test, expect } from "@playwright/test";
import { createServer, type Server } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve, extname } from "node:path";
let server: Server;
const origin = "http://127.0.0.1:4187";
const goals = [
  "Repair the session recovery boundary",
  "Review workspace isolation",
  "Compare routing strategies",
  "Prepare the migration plan",
  "Validate provider evidence",
  "Reconcile task checkpoints",
  "Inspect artifact retention",
];
const states = [
  "RUNNING",
  "WAITING_INPUT",
  "LIMIT_PAUSED",
  "HANDING_OFF",
  "COMPLETED",
  "FAILED",
  "CREATED",
];
const rows = goals.map((goal, i) => ({
  id: `task-${i}`,
  goal,
  state: states[i],
  phase: null,
  profile: "auto",
  repoPath: null,
  createdAt: "2026-09-05T10:00:00Z",
  updatedAt: "2026-09-05T11:30:00Z",
}));
test.beforeAll(async () => {
  server = createServer(async (req, res) => {
    const path = req.url === "/" ? "/index.html" : req.url!;
    try {
      const body = await readFile(resolve("dist", `.${path}`));
      res.setHeader(
        "content-type",
        extname(path) === ".js"
          ? "text/javascript"
          : extname(path) === ".css"
            ? "text/css"
            : "text/html",
      );
      res.end(body);
    } catch {
      res.writeHead(404).end();
    }
  });
  await new Promise<void>((r) => server.listen(4187, "127.0.0.1", r));
});
test.afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});
test.beforeEach(async ({ page }) => {
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    let body: unknown = [];
    if (path === "/api/workspace")
      body = {
        workspace: "personal",
        assistants: ["local-codex"],
        repoAllowlist: [],
        failover: { auto: false, triggers: [], softThresholdPct: 85 },
      };
    else if (path === "/api/tasks") body = rows;
    else if (path === "/api/assistants")
      body = [
        {
          id: "local-codex",
          provider: "codex",
          enabled: true,
          manifest: null,
          manifestUpdatedAt: null,
        },
      ];
    else if (/^\/api\/tasks\/task-\d+$/.test(path)) {
      const row = rows[Number(path.split("-").at(-1))]!;
      body = {
        ...row,
        activity_phase: null,
        repo_path: null,
        branch: null,
        envelope: {
          goal: row.goal,
          constraints: [],
          status: { state: row.state },
          completed: [],
          remaining: [],
          decisions: [],
          artifacts: { changedFiles: [], testResults: [] },
        },
        runs: [
          {
            id: `run-${row.id}`,
            assistant_id: "local-codex",
            state: row.state,
            usage: null,
            started_at: row.createdAt,
            ended_at: null,
          },
        ],
        active: row.state === "RUNNING",
      };
    } else if (path.endsWith("/events"))
      body = [
        {
          run_id: `run-${path.split("/")[3]}`,
          seq: 1,
          ts: "2026-09-05T11:30:00Z",
          type: "tool.called",
          summary: "Inspecting workspace ownership checks",
          phase: null,
          payload: {},
          assistant_id: "local-codex",
        },
      ];
    else if (path.endsWith("/routing"))
      body = [
        {
          chosen: "local-codex",
          at: "2026-09-05T11:29:00Z",
          explanation: {
            chosen: "local-codex",
            ruleFired: "eligible_preferred",
            candidates: [
              {
                assistantId: "local-codex",
                passedFilters: true,
                filterFailures: [],
              },
              {
                assistantId: "local-claude",
                passedFilters: false,
                filterFailures: ["authentication unavailable"],
              },
            ],
          },
        },
      ];
    await route.fulfill({ json: body });
  });
});
test("orbital selection, operational evidence, responsive layout and screenshots", async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 1440, height: 1050 });
  await page.goto(origin);
  const inspector = page.getByRole("region", {
    name: "Selected task inspector",
  });
  await expect(
    inspector.getByRole("heading", { name: goals[0] }),
  ).toBeVisible();
  await expect(inspector.getByText("Unknown", { exact: true })).toBeVisible();
  await page.screenshot({
    path: info.outputPath("orbital-desktop.png"),
    fullPage: true,
  });
  await page
    .getByRole("button", { name: `Select task: ${goals[1]}`, exact: true })
    .click();
  await expect(
    inspector.getByRole("heading", { name: goals[1] }),
  ).toBeVisible();
  await inspector
    .getByRole("button", { name: "Decision", exact: true })
    .click();
  await expect(
    inspector.getByText("authentication unavailable", { exact: true }),
  ).toBeVisible();
  await inspector.getByRole("button", { name: "Context", exact: true }).click();
  await expect(
    inspector.getByText("No canonical ContextObservation", { exact: false }),
  ).toBeVisible();
  await inspector
    .getByRole("button", { name: "Schedule", exact: true })
    .click();
  await expect(
    inspector.getByText("Planned · K1", { exact: true }),
  ).toBeVisible();
  await page.getByRole("textbox", { name: "Search tasks" }).fill("retention");
  await expect(
    inspector.getByRole("heading", { name: goals[6] }),
  ).toBeVisible();
  await page.getByRole("textbox", { name: "Search tasks" }).fill("");
  await page.setViewportSize({ width: 1100, height: 800 });
  await page.screenshot({
    path: info.outputPath("orbital-laptop.png"),
    fullPage: true,
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: info.outputPath("orbital-mobile.png"),
    fullPage: true,
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await inspector
    .getByRole("button", { name: "Open task controls", exact: false })
    .click();
  await expect(
    page.getByRole("button", { name: "Checkpoint", exact: true }),
  ).toBeVisible();
});
test("empty, unavailable, and unknown states remain explicit", async ({
  page,
}) => {
  await page.route("**/api/tasks", (route) => route.fulfill({ json: [] }));
  await page.goto(origin);
  await expect(page.getByText("Your next task starts here.")).toBeVisible();
  await page.unroute("**/api/tasks");
  await page.route("**/api/tasks", (route) =>
    route.fulfill({ status: 503, json: { error: "offline" } }),
  );
  await page.reload();
  await expect(page.getByRole("alert")).toContainText("offline");
});
test("session approval and verification are separate from task state; partial reads stay usable", async ({
  page,
}) => {
  await page.route("**/api/tasks/task-0/sessions", (route) =>
    route.fulfill({
      json: [{ sessionId: "run-task-0", sessionState: "AWAITING_APPROVAL" }],
    }),
  );
  await page.route("**/api/tasks/task-0/routing", (route) =>
    route.fulfill({ status: 403, json: { error: "missing routing.read" } }),
  );
  await page.goto(origin);
  const inspector = page.getByRole("region", {
    name: "Selected task inspector",
  });
  await expect(
    inspector.getByText("AWAITING_APPROVAL", { exact: true }),
  ).toBeVisible();
  await expect(
    inspector.getByText("Unavailable reads: Routing."),
  ).toBeVisible();
  await expect(
    inspector.getByRole("button", { name: "Open task controls", exact: false }),
  ).toBeEnabled();
  await page.unroute("**/api/tasks/task-0/sessions");
  await page.route("**/api/tasks/task-0/sessions", (route) =>
    route.fulfill({
      json: [{ sessionId: "run-task-0", sessionState: "VERIFYING" }],
    }),
  );
  await page.reload();
  await expect(inspector.getByText("VERIFYING", { exact: true })).toBeVisible();
});
