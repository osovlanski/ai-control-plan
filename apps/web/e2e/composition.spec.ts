/**
 * M7: New Task shows the whole CompositionDecision and the Task Detail "Composition" tab shows the
 * bound revision, attempts and budget. Runs a real in-process Control Plane with the Composer on, a
 * loopback fake Cockpit for the registry and bundle routes, and fake assistants: no credentials and
 * no quota spend.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { fileDigest } from "../../api/src/bundle-contract.js";
import { boot, A, B, composerProbe, type Harness } from "./harness.js";
import { fakeCockpit, FAKE_COCKPIT_TOKEN, type FakeCockpit } from "./fake-cockpit.js";

const SKILL = "claude-skills:ts-review";
const SKILL_BODY = "---\nname: ts-review\n---\nReview TypeScript.\n";
const GOAL = "Add a typed helper to the parser module";

let root: string;
let repo: string;
let cockpit: FakeCockpit;
let h: Harness;
let consoleErrors: string[];

function git(...args: string[]) {
  execFileSync("git", ["-C", repo, ...args], { env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid" } });
}

async function start(port: number, composerOn: boolean) {
  root = mkdtempSync(join(tmpdir(), "m7-composition-"));
  repo = join(root, "repo");
  mkdirSync(repo);
  writeFileSync(join(repo, "package.json"), JSON.stringify({ name: "x", devDependencies: { typescript: "^5.9.0" } }));
  writeFileSync(join(repo, "tsconfig.json"), "{}\n");
  git("init", "-q");
  git("add", ".");
  git("commit", "-q", "-m", "init");
  const tokenPath = join(root, "registry-token");
  writeFileSync(tokenPath, `${FAKE_COCKPIT_TOKEN}\n`, { mode: 0o600 });
  cockpit = await fakeCockpit();
  cockpit.skills.set(SKILL, { body: SKILL_BODY, tags: ["coding", "typescript"], assistants: ["claude"] });
  cockpit.fragments.set("typescript-style", "Use strict TypeScript.");
  consoleErrors = [];
  h = await boot(port, "m7-composition", { [A]: { provider: "fake" }, [B]: { provider: "fake" } }, undefined, (config) => {
    config.repoAllowlist = [repo];
    config.policy.approvalMode = "auto-approve";
    config.execution = { harnessModes: { single: true } };
    config.registry.cockpit = { enabled: composerOn, baseUrl: cockpit.url, tokenPath, maxCacheAgeHours: 48 };
    config.composer.enabled = composerOn;
    config.composer.assets.allowlist = [{ id: SKILL, digest: fileDigest(SKILL_BODY) }];
    config.composer.context.fragments.default = ["typescript-style"];
    config.composer.policy.permitAmbient = true;
    config.composer.policy.budget = { maxTokens: 50_000 };
  });
}

test.afterEach(async () => {
  await h.close();
  await cockpit.close();
  rmSync(root, { recursive: true, force: true });
  expect(consoleErrors).toEqual([]);
});

async function preview(page: Page, goal = GOAL) {
  await page.getByRole("textbox", { name: "What should Agentic OS do?" }).fill(goal);
  const shell = page.getByLabel("Mission shell");
  await shell.getByText("Context & constraints", { exact: true }).click();
  await shell.getByLabel(/^Repository path/).fill(repo);
  await shell.getByRole("button", { name: "Preview routing", exact: true }).click();
}

test.describe("Composer on", () => {
  test.beforeEach(async ({ context }) => {
    await start(4197, true);
    context.on("page", (page) => {
      page.on("console", (m) => { if (m.type() === "error" && !composerProbe(m)) consoleErrors.push(m.text()); });
      page.on("pageerror", (e) => consoleErrors.push(e.message));
    });
  });

  test("New Task shows all six stages with their why, the chosen skill with its digest and the method of each number", async ({ context }, info) => {
    const page = await h.openApp(context);
    await page.setViewportSize({ width: 1440, height: 1500 });
    await preview(page);
    const proposal = page.getByRole("region", { name: "Composition preview" });
    await expect(proposal).toBeVisible();
    const stages = proposal.locator(".comp-stage");
    await expect(stages).toHaveCount(6);
    await expect(stages.locator("h3")).toHaveText(["Intent", "Harness & model", "Assets", "Context", "Policy & budget", "Confirm"]);
    for (const stage of ["intent", "harness_model", "assets", "context", "policy"]) {
      await expect(proposal.locator(`[data-stage="${stage}"] .comp-why`)).not.toBeEmpty();
    }
    // Stage 6 is awaiting the operator, not decided for them.
    await expect(proposal.locator('[data-stage="confirm"]')).toContainText("awaiting your confirmation");
    // The chosen skill with its digest, which is the Cockpit digest the plane pinned.
    const assets = proposal.locator('[data-stage="assets"]');
    await expect(assets).toContainText(SKILL);
    await expect(assets.locator(".digest").first()).toHaveAttribute("title", fileDigest(SKILL_BODY));
    // Budget and policy: the cap is shown, and every derived number names its method.
    const spec = proposal.getByLabel("What this composition attaches and enforces");
    await expect(spec.locator("div", { has: page.locator("dt", { hasText: /^Token cap$/ }) }).first()).toContainText("50,000");
    await expect(spec.locator("div", { has: page.locator("dt", { hasText: /^Complexity$/ }) }).first().locator(".method-guessed")).toHaveText("guessed");
    await expect(spec.locator("div", { has: page.locator("dt", { hasText: /^Context$/ }) }).first().locator(".method-estimated")).toHaveText("estimated");
    // M3 predicts the profile during preview; this harness prepares a full isolated profile.
    await expect(spec.locator("div", { has: page.locator("dt", { hasText: /^Provisioning$/ }) }).first()).toContainText("full (requested isolated)");
    await expect(page.getByRole("region", { name: "Routing recommendation" }).getByRole("button", { name: "Run composed", exact: true })).toBeVisible();
    // A preview wrote an attempt, never a revision.
    const api = await h.privileged();
    const task = h.built.tasks.list().find((t) => t.goal === GOAL)!;
    const history = await (await api.get(`/api/tasks/${task.id}/composition`)).json();
    expect(history.revisions).toEqual([]);
    expect(history.attempts.map((a: { outcome: string }) => a.outcome)).toEqual(["previewed"]);
    await page.screenshot({ path: info.outputPath("new-task-composition.png"), fullPage: true });
  });

  test("Run composed confirms the previewed digest, binds the revision, and the Composition tab shows revision, attempts and budget", async ({ context }, info) => {
    const page = await h.openApp(context);
    await page.setViewportSize({ width: 1440, height: 1100 });
    await preview(page);
    const proposal = page.getByRole("region", { name: "Composition preview" });
    const shown = await proposal.locator(".comp-outcome .digest").getAttribute("title");
    expect(shown).toMatch(/^sha256:[0-9a-f]{64}$/);
    await page.getByRole("region", { name: "Routing recommendation" }).getByRole("button", { name: "Run composed", exact: true }).click();
    const task = h.built.tasks.list().find((t) => t.goal === GOAL)!;
    await h.waitForState(task.id, "COMPLETED");
    const api = await h.privileged();

    // The plane persisted the revision the operator confirmed and bound the run to it.
    const history = await (await api.get(`/api/tasks/${task.id}/composition`)).json();
    expect(history.revisions).toHaveLength(1);
    expect(history.attempts.map((a: { outcome: string }) => a.outcome)).toEqual(["previewed", "persisted"]);
    expect(history.attempts[0].compositionDigest).toBe(shown);
    const revisionId = history.revisions[0].compositionRevisionId as string;
    const detail = await (await api.get(`/api/tasks/${task.id}`)).json();
    expect(detail.runs.map((r: { compositionRevisionId: string }) => r.compositionRevisionId)).toEqual([revisionId]);

    await page.getByRole("button", { name: "Open mission controls" }).click();
    await page.getByRole("button", { name: "Composition", exact: true }).click();
    const panel = page.locator(".comp-panel");
    await expect(panel).toBeVisible();
    const bound = panel.getByRole("region", { name: "Bound revision" });
    await expect(bound).toContainText(revisionId);
    await expect(bound.locator(".comp-stage")).toHaveCount(6);
    await expect(bound.locator('[data-stage="confirm"]')).toContainText("operator confirmed");
    await expect(bound.locator('[data-stage="assets"]')).toContainText(SKILL);
    // Attempts: the preview and the persisted start, side by side.
    const attempts = panel.getByRole("table", { name: "Composition attempts" });
    await expect(attempts.locator("tbody tr")).toHaveCount(2);
    await expect(attempts).toContainText("previewed");
    await expect(attempts).toContainText("persisted");
    // Budget: the cap, what the fake run consumed (with its method) and an explicit remainder.
    const budget = panel.getByRole("table", { name: "Task budget" });
    await expect(budget.locator("tr", { has: page.getByRole("rowheader", { name: "Tokens" }) })).toContainText("50,000");
    await expect(budget.locator("tr", { has: page.getByRole("rowheader", { name: "Tokens" }) }).locator(".method-measured").first()).toBeVisible();
    // The fake provider carries no price evidence, so cost is unknown, never $0.
    const cost = budget.locator("tr", { has: page.getByRole("rowheader", { name: "Cost" }) });
    await expect(cost.locator(".method-unknown").first()).toBeVisible();
    await expect(cost).not.toContainText("$0");
    await expect(panel.getByRole("table", { name: "Per-run settlement" }).locator("tbody tr")).toHaveCount(1);
    await expect(panel.getByRole("table", { name: "Per-run settlement" })).toContainText(revisionId);
    await page.screenshot({ path: info.outputPath("task-detail-composition.png"), fullPage: true });
  });

  test("a composition that changed since the preview starts nothing and shows the new decision", async ({ context }) => {
    const page = await h.openApp(context);
    await preview(page);
    const proposal = page.getByRole("region", { name: "Composition preview" });
    const before = await proposal.locator(".comp-outcome .digest").getAttribute("title");
    // Cockpit's fragment changes between the preview and the run: the bundle digest, so the composition digest, differs.
    cockpit.fragments.set("typescript-style", "Use strict TypeScript. Prefer readonly.");
    await page.getByRole("region", { name: "Routing recommendation" }).getByRole("button", { name: "Run composed", exact: true }).click();
    await expect(page.getByRole("alert").filter({ hasText: "The composition changed since you previewed it" })).toBeVisible();
    await expect(proposal.locator(".comp-outcome .digest")).not.toHaveAttribute("title", before!);
    const task = h.built.tasks.list().find((t) => t.goal === GOAL)!;
    expect(task.state).toBe("CREATED");
    const api = await h.privileged();
    expect((await (await api.get(`/api/tasks/${task.id}`)).json()).runs).toEqual([]);
    // The browser logs the plane's 409 as a console error; it is the answer under test, not a defect.
    expect(consoleErrors).toEqual(["Failed to load resource: the server responded with a status of 409 (Conflict)"]);
    consoleErrors = [];
    // Running again confirms the new digest and starts.
    await page.getByRole("region", { name: "Routing recommendation" }).getByRole("button", { name: "Run composed", exact: true }).click();
    await h.waitForState(task.id, "COMPLETED");
  });

  test("composing on another assistant shows that composition and runs it there", async ({ context }) => {
    const page = await h.openApp(context);
    await preview(page);
    const proposal = page.getByRole("region", { name: "Composition preview" });
    const harness = proposal.locator('[data-stage="harness_model"]');
    await expect(harness.locator(".comp-chosen code").first()).toContainText(A);
    await page.getByLabel("Mission shell").getByText("Routing evidence & advanced overrides", { exact: true }).click();
    await page.getByRole("button", { name: `Compose on ${B} instead`, exact: true }).click();
    await expect(harness.locator(".comp-chosen code").first()).toContainText(B);
    await expect(harness).toContainText("overridden by operator");
    await page.getByRole("region", { name: "Routing recommendation" }).getByRole("button", { name: "Run composed", exact: true }).click();
    const task = h.built.tasks.list().find((t) => t.goal === GOAL)!;
    await h.waitForState(task.id, "COMPLETED");
    const api = await h.privileged();
    expect((await (await api.get(`/api/tasks/${task.id}`)).json()).runs.map((r: { assistant_id: string }) => r.assistant_id)).toEqual([B]);
  });

  test("the Inspector's Composition section reads the same revision", async ({ context }) => {
    const api = await h.privileged();
    const created = await (await api.post("/api/tasks", { data: { goal: GOAL, repoPath: repo } })).json();
    const started = await api.post(`/api/tasks/${created.taskId}/start`, { data: {} });
    expect(started.ok()).toBe(true);
    await h.waitForState(created.taskId, "COMPLETED");
    const page = await h.openApp(context);
    await page.getByRole("button", { name: new RegExp(`Select task: ${GOAL}`) }).click();
    const inspector = page.getByRole("region", { name: "Selected task inspector" });
    await inspector.getByRole("button", { name: "Decision", exact: true }).click();
    await inspector.getByText("Composition", { exact: true }).click();
    await expect(inspector.locator(".comp-panel .comp-stage")).toHaveCount(6);
    await expect(inspector.getByText("Planned", { exact: true })).toHaveCount(0);
  });
});

test.describe("Composer off", () => {
  test.beforeEach(async ({ context }) => {
    await start(4198, false);
    context.on("page", (page) => {
      page.on("console", (m) => { if (m.type() === "error" && !composerProbe(m)) consoleErrors.push(m.text()); });
      page.on("pageerror", (e) => consoleErrors.push(e.message));
    });
  });

  test("New Task and the Composition tab say the Composer is off, and routing still runs", async ({ context }) => {
    const page = await h.openApp(context);
    const compositionRequests: string[] = [];
    page.on("request", (request) => {
      if (/\/compose(?:$|\?)|\/composition(?:\/|$|\?)/.test(new URL(request.url()).pathname)) compositionRequests.push(request.url());
    });
    await preview(page);
    const proposal = page.getByRole("region", { name: "Routing recommendation" });
    await expect(proposal.getByText(/Composer is off for this workspace/)).toBeVisible();
    await expect(proposal.locator(".comp-stage")).toHaveCount(0);
    await proposal.getByRole("button", { name: "Run recommended", exact: true }).click();
    const task = h.built.tasks.list().find((t) => t.goal === GOAL)!;
    await h.waitForState(task.id, "COMPLETED");
    const inspector = page.getByRole("region", { name: "Selected task inspector" });
    await inspector.getByRole("button", { name: "Decision", exact: true }).click();
    await inspector.getByText("Composition", { exact: true }).click();
    await expect(inspector.getByRole("status").filter({ hasText: "The Composer is off for this workspace" })).toBeVisible();
    await page.getByRole("button", { name: "Open mission controls" }).click();
    await page.getByRole("button", { name: "Composition", exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: "The Composer is off for this workspace" })).toBeVisible();
    expect(compositionRequests).toEqual([]);
  });
});
