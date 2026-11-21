/**
 * Demo journey (backlog `demo-journey`, slice D1): goal to verified outcome in the Web UI and the
 * `aos` CLI, against a real in-process plane with deterministic fake providers and synthetic data.
 * No provider credentials, no model calls, no GitHub call. Every scene carries one on-screen label
 * (`REAL`, `SIM-PROVIDER`, `SIM-PR`, `ROADMAP`) in the words of docs/demo/demo-journey.md.
 *
 * Run: `pnpm demo:journey` (repo root). Writes `demo-out/`: scenes.json, one screenshot per scene,
 * the CLI transcripts, and the Playwright video and trace under demo-out/playwright/.
 *
 * DEMO_DWELL_MS (default 0) holds each scene on screen that long, for a paced recording. It is the
 * only wall-clock wait, and it only waits: the plane runs on the harness's injected clock.
 */
import { expect, test, type Page } from "@playwright/test";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateRawSync, inflateRawSync } from "node:zlib";
import { boot, A, B, type Harness } from "./harness.js";
import { fakeCockpit, FAKE_COCKPIT_TOKEN, type FakeCockpit } from "./fake-cockpit.js";
import { GitHubRestClient } from "../../api/src/modules/publications.js";
import { credentialPath, readCredential } from "../../api/src/auth/credential-file.js";
import { loadConfig } from "../../api/src/config.js";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, "..", "..", "..");
const OUT = join(ROOT, "demo-out");
const CLI_DIR = join(ROOT, "apps", "cli");
const PORT = 4263;
const DWELL = Number(process.env.DEMO_DWELL_MS ?? 0);
const FAKE_GH_TOKEN = "FAKE-demo-github-token-not-real";

export type Label = "REAL" | "SIM-PROVIDER" | "SIM-PR" | "ROADMAP";
interface Scene { id: string; label: string; caption: string; taskId: string | null; behind: string[] }

/** The masked scenes.json every run must produce (acceptance 5): ids and timestamps replaced. */
const EXPECTED_MASKED: Array<Omit<Scene, "taskId"> & { taskId: string | null }> = [
  { id: "1-agents", label: "REAL", caption: "Two agents are ready.", taskId: null, behind: ["GET /api/assistants", "aos runtimes ls"] },
  { id: "2-route-preview", label: "REAL", caption: "The route is explained before anything runs.", taskId: "<task-1>", behind: ["POST /api/tasks", "POST /api/tasks/<task-1>/route", "POST /api/tasks/<task-1>/compose"] },
  { id: "3-run", label: "REAL + SIM-PROVIDER", caption: "Agent output is scripted by the fake provider.", taskId: "<task-1>", behind: ["POST /api/tasks/<task-1>/start", "GET /api/tasks/<task-1>/events"] },
  { id: "4-approval", label: "REAL + SIM-PROVIDER", caption: "Approval is a boundary the plane enforces.", taskId: "<task-1>", behind: ["POST /api/tasks/<task-1>/input (approval)", "aos runtimes show fake-a", "ROADMAP: aos task show <task-1>"] },
  { id: "5-verification", label: "REAL + SIM-PROVIDER", caption: "Done means verified, not claimed.", taskId: "<task-1>", behind: ["GET /api/sessions/<run>/verification", "event test.result", "event verification.result"] },
  { id: "6-recovery", label: "REAL + SIM-PROVIDER", caption: "A quota hit becomes a handoff, not a failure.", taskId: "<task-2>", behind: ["POST /api/tasks/<task-2>/start", "handoff trigger quota fake-a -> fake-b", "aos runtimes show fake-a"] },
  { id: "7-publication", label: "SIM-PR", caption: "Autopilot publication against a fake GitHub. Interactive tasks don't open PRs yet.", taskId: null, behind: ["publications.publish (autopilot lane)", "GET /api/autopilot/publications"] },
  { id: "8-cli-task", label: "ROADMAP", caption: "Not built yet. Becomes a real scene after p1-3 slices 1 and 2.", taskId: null, behind: ["none: text card"] },
  { id: "9-not-built", label: "ROADMAP", caption: "What is not built yet.", taskId: null, behind: ["none: text card"] },
];

const scenes: Scene[] = [];
/** Every secret value the run saw, for the scan (acceptance 6). */
const secrets = new Set<string>();

let h: Harness;
let root: string;
let repo: string;
let cockpit: FakeCockpit;
let gh: Server;
const prs: Array<Record<string, unknown>> = [];

Object.assign(process.env, {
  GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "commit.gpgsign", GIT_CONFIG_VALUE_0: "false",
  GIT_AUTHOR_NAME: "Demo", GIT_AUTHOR_EMAIL: "demo@example.invalid", GIT_COMMITTER_NAME: "Demo", GIT_COMMITTER_EMAIL: "demo@example.invalid",
});
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
const bodyOf = (req: IncomingMessage) => new Promise<string>(r => { let s = ""; req.on("data", c => (s += c)); req.on("end", () => r(s)); });

/** A loopback stand-in for the three GitHub REST routes publication uses. It answers only the FAKE token. */
async function fakeGitHub(bare: string): Promise<string> {
  let num = 0;
  gh = createServer(async (req, res) => {
    const send = (code: number, json: unknown) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(json)); };
    if (req.headers.authorization !== `Bearer ${FAKE_GH_TOKEN}`) return send(401, { message: "Bad credentials" });
    const u = new URL(req.url!, "http://fake");
    const ref = /^\/repos\/demo\/demo-notes\/git\/ref\/heads\/(.+)$/.exec(u.pathname);
    if (req.method === "GET" && ref) {
      try { return send(200, { object: { sha: git(bare, "rev-parse", "--verify", `refs/heads/${decodeURIComponent(ref[1]!)}`) } }); } catch { return send(404, { message: "Not Found" }); }
    }
    if (u.pathname === "/repos/demo/demo-notes/pulls" && req.method === "GET") {
      const head = u.searchParams.get("head")!.split(":")[1];
      return send(200, prs.filter(p => (p.head as { ref: string }).ref === head));
    }
    if (u.pathname === "/repos/demo/demo-notes/pulls" && req.method === "POST") {
      const input = JSON.parse(await bodyOf(req)) as { title: string; head: string; base: string; body: string; draft: boolean };
      num += 1;
      const pr = { number: num, html_url: `https://github.invalid/demo/demo-notes/pull/${num}`, state: "open", merged_at: null, draft: input.draft, title: input.title, body: input.body,
        head: { ref: input.head, sha: git(bare, "rev-parse", `refs/heads/${input.head}`), repo: { full_name: "demo/demo-notes" } }, base: { ref: input.base } };
      prs.push(pr);
      return send(201, pr);
    }
    send(404, { message: "Not Found" });
  });
  await new Promise<void>(r => gh.listen(0, "127.0.0.1", r));
  return `http://127.0.0.1:${(gh.address() as { port: number }).port}`;
}

/**
 * Runs the real `aos` CLI against the demo plane and keeps the transcript. Provider env is stripped.
 * Asynchronous on purpose: the plane answering it runs in this process.
 */
async function aos(name: string, ...args: string[]): Promise<string> {
  const env: NodeJS.ProcessEnv = { ...process.env, AOS_API_URL: h.origin, AOS_CREDENTIAL_FILE: credentialPath(loadConfig({ AGENT_PLANE_HOME: h.home }).dir) };
  for (const k of Object.keys(env)) if (/^(ANTHROPIC|OPENAI|OPENROUTER)_/.test(k)) delete env[k];
  const r = await promisify(execFile)(join(CLI_DIR, "node_modules", ".bin", "tsx"), ["src/main.ts", ...args], { cwd: CLI_DIR, env, encoding: "utf8" })
    .then(o => ({ ...o, status: 0 }), (e: { stdout?: string; stderr?: string; code?: number }) => ({ stdout: e.stdout ?? "", stderr: e.stderr ?? String(e), status: e.code ?? 1 }));
  const transcript = `$ aos ${args.join(" ")}\n${r.stdout}${r.stderr}[exit ${r.status}]\n`;
  expect(r.status, transcript).toBe(0);
  mkdirSync(join(OUT, "cli"), { recursive: true });
  writeFileSync(join(OUT, "cli", `${name}.txt`), transcript);
  return transcript;
}

/** The on-screen label: a fixed overlay the spec owns, so it survives route changes inside the SPA. */
async function label(page: Page, sceneLabel: string, caption: string, extra: { terminal?: string; card?: string[] } = {}) {
  await page.evaluate(({ sceneLabel, caption, extra }) => {
    document.getElementById("demo-scene")?.remove();
    const box = document.createElement("aside");
    box.id = "demo-scene";
    box.setAttribute("aria-label", "Demo scene");
    const full = !!extra.card;
    box.style.cssText = `position:fixed;z-index:2147483647;font:14px/1.45 ui-monospace,Menlo,monospace;color:#f5f5f0;background:rgba(10,12,24,.94);border:2px solid #f5c542;border-radius:8px;padding:12px 14px;${full ? "inset:24px;overflow:auto;font-size:18px;padding:40px" : "right:16px;bottom:16px;max-width:min(560px,calc(100vw - 32px))"}`;
    const tag = document.createElement("p");
    tag.setAttribute("data-demo-label", sceneLabel);
    tag.style.cssText = "margin:0 0 6px;font-weight:700;letter-spacing:.06em;color:#f5c542";
    tag.textContent = sceneLabel;
    const cap = document.createElement("p");
    cap.setAttribute("data-demo-caption", "");
    cap.style.cssText = "margin:0";
    cap.textContent = caption;
    box.append(tag, cap);
    if (extra.terminal) {
      const pre = document.createElement("pre");
      pre.setAttribute("aria-label", "Terminal");
      pre.style.cssText = "margin:10px 0 0;padding:8px;background:#000;color:#b5f5b5;white-space:pre-wrap;max-height:300px;overflow:auto;font-size:12px";
      pre.textContent = extra.terminal;
      box.append(pre);
    }
    for (const line of extra.card ?? []) {
      const p = document.createElement("p");
      p.style.cssText = "margin:14px 0 0;white-space:pre-wrap";
      p.textContent = line;
      box.append(p);
    }
    document.body.append(box);
  }, { sceneLabel, caption, extra });
  const box = page.getByRole("complementary", { name: "Demo scene" });
  await expect(box).toBeVisible();
  await expect(box.locator("[data-demo-label]")).toHaveText(sceneLabel);
}

async function capture(page: Page, scene: Scene) {
  // Acceptance 3: the label is on screen in this scene's screenshot.
  await expect(page.getByRole("complementary", { name: "Demo scene" }).locator("[data-demo-label]")).toHaveText(scene.label);
  await expect(page.getByRole("complementary", { name: "Demo scene" }).locator("[data-demo-caption]")).toHaveText(scene.caption);
  if (DWELL) await page.waitForTimeout(DWELL);
  mkdirSync(join(OUT, "scenes"), { recursive: true });
  await page.screenshot({ path: join(OUT, "scenes", `${scene.id}.png`) });
  scenes.push(scene);
}

const caption = (id: string) => EXPECTED_MASKED.find(s => s.id === id)!;
const scene = (id: string, taskId: string | null, behind: string[]): Scene => ({ ...caption(id), taskId, behind });

test.beforeAll(async () => {
  // Playwright owns (and cleans) demo-out/playwright; the spec owns the rest.
  for (const f of ["scenes", "cli", "scenes.json"]) rmSync(join(OUT, f), { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });
  // No provider credential reaches the plane or the CLI.
  for (const k of Object.keys(process.env)) if (/^(ANTHROPIC|OPENAI|OPENROUTER)_/.test(k)) delete process.env[k];

  root = mkdtempSync(join(tmpdir(), "demo-journey-"));
  repo = join(root, "demo-notes");
  mkdirSync(repo);
  writeFileSync(join(repo, "README.md"), "# demo-notes\n\nSynthetic scratch repository for the demo journey.\n");
  git(repo, "init", "-q", "-b", "main");
  git(repo, "add", ".");
  git(repo, "commit", "-qm", "init");
  const tokenPath = join(root, "registry-credential");
  writeFileSync(tokenPath, FAKE_COCKPIT_TOKEN, { mode: 0o600 });
  cockpit = await fakeCockpit();
  const bare = join(root, "origin.git");
  git(root, "init", "-q", "--bare", "-b", "main", bare);
  const apiBase = await fakeGitHub(bare);

  h = await boot(PORT, "demo-journey", { [A]: { provider: "fake" }, [B]: { provider: "fake" } }, undefined, config => {
    config.repoAllowlist = [repo];
    config.composer.enabled = true;
    config.composer.policy.permitAmbient = true;
    config.composer.policy.budget = { maxTokens: 50_000 };
    config.registry.cockpit = { enabled: true, baseUrl: cockpit.url, tokenPath, maxCacheAgeHours: 48 };
    config.policy.approvalMode = "prompt-on-escalation";
    config.execution = { harnessModes: { single: true } };
  }, undefined, undefined, undefined, {
    autopilotGitHub: new GitHubRestClient({ apiBase, token: () => FAKE_GH_TOKEN, timeoutMs: 2000 }),
    publicationSleep: async () => {},
  });
  for (const s of readCredential(credentialPath(loadConfig({ AGENT_PLANE_HOME: h.home }).dir)).secrets) secrets.add(s.secret);
});

test.afterAll(async () => {
  await h?.close();
  await cockpit?.close();
  gh?.close();
  rmSync(root, { recursive: true, force: true });
});

const openShell = async (page: Page) => {
  const toggle = page.getByRole("group", { name: "Overview view" });
  await toggle.getByRole("button", { name: "Shell", exact: true }).click();
  const shell = page.getByRole("region", { name: "Shell view" });
  await expect(shell).toBeVisible();
  return shell;
};

test("demo journey: goal to verified outcome, Web and CLI, fakes only", async ({ context }) => {
  // Every configured assistant is the fake provider before the first scene.
  const api = await h.privileged();
  const assistants = await (await api.get("/api/assistants")).json() as Array<{ id: string; provider: string }>;
  expect(assistants.map(a => [a.id, a.provider]).sort()).toEqual([[A, "fake"], [B, "fake"]]);

  const page = await h.openApp(context);
  await page.setViewportSize({ width: 1440, height: 900 });
  for (const c of await context.cookies()) secrets.add(c.value);
  const nav = page.getByRole("navigation", { name: "System" });

  // 1 · REAL — the Agents app next to `aos runtimes ls`.
  await nav.getByRole("link", { name: "Agents", exact: true }).click();
  await expect(page.getByRole("region", { name: `Assistant ${A}` })).toBeVisible();
  await expect(page.getByRole("region", { name: `Assistant ${B}` })).toBeVisible();
  const ls = await aos("1-runtimes-ls", "runtimes", "ls");
  expect(ls).toContain(A);
  expect(ls).toContain(B);
  await label(page, "REAL", caption("1-agents").caption, { terminal: ls });
  await capture(page, scene("1-agents", null, caption("1-agents").behind));

  // 2 · REAL — the goal, its route preview and its composition preview, before anything runs.
  await nav.getByRole("link", { name: "Overview", exact: true }).click();
  const shell = await openShell(page);
  await shell.getByRole("combobox", { name: "Repository", exact: true }).selectOption(repo);
  const cmd = shell.getByRole("textbox", { name: /agentic-os/ });
  const goal1 = "Add a changelog entry for the retry fix [FAKE:APPROVAL]";
  await cmd.fill(goal1);
  await cmd.press("Tab");
  const preview = shell.getByLabel("Route preview");
  await expect(preview).toContainText("route →");
  await expect(preview.locator("b")).toHaveText(A);
  const composition = shell.getByRole("region", { name: "Composition preview" });
  await expect(composition).toContainText("Composed.");
  const task1 = h.built.tasks.list().find(t => t.goal === goal1)!.id;
  expect(h.built.tasks.get(task1)!.state).not.toBe("RUNNING");
  await expect(preview).toContainText(task1);
  await label(page, "REAL", caption("2-route-preview").caption);
  await capture(page, scene("2-route-preview", task1, caption("2-route-preview").behind.map(b => b.replaceAll("<task-1>", task1))));

  // 3 · REAL + SIM-PROVIDER — the run streams the fake's scripted events.
  await cmd.press("Enter");
  await expect(shell.locator(".sv-status")).toContainText(`started ${task1}`);
  const log = shell.getByRole("region", { name: "Event log" });
  await page.locator("body").click({ position: { x: 1, y: 1 } });
  await expect(log).toContainText("run.started");
  await expect(log).toContainText("approval.requested");
  await label(page, "REAL + SIM-PROVIDER", caption("3-run").caption);
  await capture(page, scene("3-run", task1, caption("3-run").behind.map(b => b.replaceAll("<task-1>", task1))));

  // 4 · REAL + SIM-PROVIDER — the inline approval, then approve it in the Web.
  const approval = shell.getByRole("group", { name: "Focused approval" });
  await expect(approval).toBeVisible();
  const show = await aos("4-runtimes-show-fake-a", "runtimes", "show", A);
  expect(show).toContain(A);
  const pid = shell.getByRole("region", { name: "Process list" }).locator('[aria-selected="true"]');
  await expect(pid).toContainText(task1);
  await label(page, "REAL + SIM-PROVIDER", caption("4-approval").caption, {
    terminal: `${show}\n# ROADMAP until p1-3 slice 1: aos task show ${task1}\n# (no such command yet; the id above is the one selected in the Web)`,
  });
  await capture(page, scene("4-approval", task1, caption("4-approval").behind.map(b => b.replaceAll("<task-1>", task1))));
  await page.keyboard.press("a");
  await h.waitForState(task1, "COMPLETED");

  // 5 · REAL + SIM-PROVIDER — verification evidence, then COMPLETED.
  await expect(log).toContainText("test.result");
  await expect(log).toContainText("verification.result");
  await page.keyboard.press("2");
  const verify = shell.getByRole("region", { name: "Verification" });
  await expect(verify).toContainText("verification");
  await expect(pid).toContainText("COMPLETED");
  await label(page, "REAL + SIM-PROVIDER", caption("5-verification").caption);
  await capture(page, scene("5-verification", task1, caption("5-verification").behind));
  await page.keyboard.press("1");

  // 6 · REAL + SIM-PROVIDER — task 2 hits the fake quota, checkpoints, hands off to fake-b.
  const goal2 = "Regenerate the API reference [FAKE:LIMIT]";
  await cmd.fill(goal2);
  await cmd.press("Tab");
  await expect(preview.locator("b")).toHaveText(A);
  const task2 = h.built.tasks.list().find(t => t.goal === goal2)!.id;
  await cmd.press("Enter");
  await expect(shell.locator(".sv-status")).toContainText(`started ${task2}`);
  await h.waitForState(task2, "COMPLETED");
  const runs = h.db.prepare("SELECT assistant_id, state FROM runs WHERE task_id = ? ORDER BY started_at").all(task2) as Array<{ assistant_id: string; state: string }>;
  expect(runs).toEqual([{ assistant_id: A, state: "ENDED_ERROR" }, { assistant_id: B, state: "ENDED_OK" }]);
  const handoff = h.db.prepare("SELECT trigger, checkpoint_id FROM handoffs WHERE task_id = ?").get(task2) as { trigger: string; checkpoint_id: string };
  expect(handoff.trigger).toBe("quota");
  expect(handoff.checkpoint_id).toBeTruthy();
  const decisions = h.db.prepare("SELECT COUNT(*) AS n FROM routing_decisions WHERE task_id = ?").get(task2) as { n: number };
  expect(decisions.n).toBeGreaterThanOrEqual(2);
  const row2 = shell.getByRole("region", { name: "Process list" }).getByRole("row").filter({ hasText: task2 });
  await row2.click();
  await expect(row2).toContainText(B);
  await expect(row2).toContainText("COMPLETED");
  const cooldown = await aos("6-runtimes-show-fake-a", "runtimes", "show", A);
  expect(cooldown.toLowerCase()).toContain("cooldown");
  await label(page, "REAL + SIM-PROVIDER", caption("6-recovery").caption, { terminal: cooldown });
  await capture(page, scene("6-recovery", task2, caption("6-recovery").behind.map(b => b.replaceAll("<task-2>", task2))));

  // 7 · SIM-PR — one draft PR through the autopilot lane, against the fake GitHub and a bare repo.
  const bare = join(root, "origin.git");
  const work = join(root, "autopilot-work");
  git(root, "clone", "-q", bare, work);
  git(work, "commit", "-q", "--allow-empty", "-m", "base");
  git(work, "push", "-q", "origin", "HEAD:main");
  const base = git(work, "rev-parse", "HEAD");
  const reservation = git(work, "commit-tree", `${base}^{tree}`, "-p", base, "-m", "aos-reservation item=demo-changelog lane=plane reservation=res-demo");
  git(work, "push", "-q", "origin", `${reservation}:refs/heads/os/demo-changelog`);
  git(work, "checkout", "-q", "-B", "os/demo-changelog", reservation);
  writeFileSync(join(work, "CHANGELOG.md"), "## Unreleased\n\n- Fix: retry the flaky upload once before failing.\n");
  git(work, "add", "CHANGELOG.md");
  git(work, "commit", "-qm", "Add a changelog entry for the retry fix");
  const verified = git(work, "rev-parse", "HEAD");
  h.db.prepare("UPDATE autopilot_state SET status='running', stop_reason=NULL WHERE id=1").run();
  const lane = h.built.tasks.create({ goal: "Autopilot: add a changelog entry", repoPath: work }).taskId;
  const at = h.clock.current.toISOString();
  h.db.prepare("INSERT INTO autopilot_attempts(id,item_id,attempt_no,reservation_id,reservation_sha,task_id,state,runtime_budget_ms,created_at,updated_at) VALUES(?,?,1,?,?,?,'accepted',5400000,?,?)")
    .run("apa_demo", "demo-changelog", "res-demo", reservation, lane, at, at);
  const intended = h.built.publications.intend({ attemptId: "apa_demo", repo: "demo/demo-notes", base: "main", repoPath: work, verifiedSha: verified, title: "Add a changelog entry for the retry fix", body: "Verdict: PASS" });
  const published = await h.built.publications.publish(intended.id);
  expect(published.state).toBe("published");
  expect(prs).toHaveLength(1);
  expect(prs[0]!.draft).toBe(true);
  expect(String(prs[0]!.body)).toContain(`aos-publication: ${intended.id}`);
  expect(git(bare, "rev-parse", "refs/heads/os/demo-changelog")).toBe(verified);
  const listed = await (await api.get("/api/autopilot/publications")).json() as { publications: Array<{ id: string; state: string; prNumber?: number }> };
  const row = listed.publications.find(p => p.id === intended.id)!;
  expect(row.state).toBe("published");
  await label(page, "SIM-PR", caption("7-publication").caption, { card: [
    "GET /api/autopilot/publications",
    `publication ${row.id} · ${row.state} · draft PR #${row.prNumber} on demo/demo-notes (fake GitHub)`,
    `head os/demo-changelog at the verified commit · body carries "aos-publication: ${row.id}"`,
    "Git push went to a local bare repo. The GitHub token is a FAKE-*-not-real value. No GitHub call was made.",
  ] });
  await capture(page, scene("7-publication", null, caption("7-publication").behind));

  // 8 · ROADMAP — the same task in the CLI. Text only: these commands do not exist yet.
  await label(page, "ROADMAP", caption("8-cli-task").caption, { card: [
    "$ aos task new \"Add a changelog entry for the retry fix\" --watch   (exits on the verdict)",
    "$ aos approvals",
    "Neither command exists in this build. This card calls no route.",
  ] });
  await capture(page, scene("8-cli-task", null, caption("8-cli-task").behind));

  // 9 · ROADMAP — what is not built.
  await label(page, "ROADMAP", caption("9-not-built").caption, { card: [
    "Chat-publish: \"Draft PR #N opened · PASS\" from an interactive task.",
    "Subtasks (vNext 10–13).",
    "Mobile approvals (U4).",
  ] });
  await capture(page, scene("9-not-built", null, caption("9-not-built").behind));
  await api.dispose();

  // scenes.json, and the masked form every run must match (acceptance 2 and 5).
  writeFileSync(join(OUT, "scenes.json"), `${JSON.stringify(scenes, null, 2)}\n`);
  expect(mask(scenes, { [task1]: "<task-1>", [task2]: "<task-2>" })).toEqual(EXPECTED_MASKED);
});

/** Replaces task ids by role, then any remaining id or timestamp, so two runs compare equal. */
function mask(list: Scene[], ids: Record<string, string>): unknown {
  let text = JSON.stringify(list);
  for (const [id, role] of Object.entries(ids)) text = text.replaceAll(id, role);
  text = text.replace(/\b(es|ses|sess)_[A-Za-z0-9]+/g, "<session>").replace(/\d{4}-\d\d-\d\dT[\d:.]+Z/g, "<ts>");
  return JSON.parse(text);
}

/** Minimal zip reader (stored and deflated entries), enough to scan the Playwright trace. */
function zipEntries(file: string): Array<{ name: string; data: Buffer }> {
  const buf = readFileSync(file);
  let eocd = buf.length - 22;
  while (eocd >= 0 && buf.readUInt32LE(eocd) !== 0x06054b50) eocd -= 1;
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out: Array<{ name: string; data: Buffer }> = [];
  for (let i = 0; i < count; i += 1) {
    const method = buf.readUInt16LE(p + 10);
    const size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString("utf8");
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const raw = buf.subarray(start, start + size);
    out.push({ name, data: method === 8 ? inflateRawSync(raw) : raw });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

const CRC = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = (b: Buffer) => { let c = 0xffffffff; for (const x of b) c = CRC[(c ^ x) & 0xff]! ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };

/** Writes entries back as a deflated zip, the format Playwright's trace viewer reads. */
function writeZip(file: string, entries: Array<{ name: string; data: Buffer }>) {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, "utf8");
    const packed = deflateRawSync(e.data);
    const crc = crc32(e.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6); local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(packed.length, 18); local.writeUInt32LE(e.data.length, 22); local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0x0800, 8); central.writeUInt16LE(8, 10);
    central.writeUInt32LE(crc, 16); central.writeUInt32LE(packed.length, 20); central.writeUInt32LE(e.data.length, 24); central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, packed);
    centrals.push(central, name);
    offset += 30 + name.length + packed.length;
  }
  const dir = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(dir.length, 12); end.writeUInt32LE(offset, 16);
  writeFileSync(file, Buffer.concat([...locals, dir, end]));
}

/**
 * The browser's session cookie, the bootstrap token and the plane's bearer travel in every traced
 * request, and Playwright records request headers. They are valid only for this run's temporary
 * plane, which is gone by now; they are still replaced in the trace before it is kept or scanned.
 */
function redactTrace(file: string, values: Set<string>) {
  const entries = zipEntries(file);
  const found = new Set(values);
  for (const e of entries) {
    const text = e.data.toString("latin1");
    for (const m of text.matchAll(/name=\\?"?token\\?"? value=\\?"([^"\\]+)/g)) found.add(m[1]!);
    for (const m of text.matchAll(/\btoken=([A-Za-z0-9._~%-]{16,})/g)) found.add(decodeURIComponent(m[1]!)).add(m[1]!);
  }
  const redacted = entries.map(e => {
    let text = e.data.toString("latin1");
    for (const v of found) if (v.length >= 8) text = text.replaceAll(v, "<redacted>");
    return { name: e.name, data: Buffer.from(text, "latin1") };
  });
  writeZip(file, redacted);
  for (const v of found) values.add(v);
}

const walk = (dir: string): string[] => !existsSync(dir) ? [] : readdirSync(dir).flatMap(f => {
  const full = join(dir, f);
  return statSync(full).isDirectory() ? walk(full) : [full];
});

// Runs after the journey has finished and Playwright has written its trace (workers: 1, file order).
test("demo journey: demo-out holds only FAKE-*-not-real tokens", async () => {
  const files = walk(OUT);
  expect(files.some(f => f.endsWith("scenes.json"))).toBe(true);
  expect(files.filter(f => f.startsWith(join(OUT, "scenes")) && f.endsWith(".png"))).toHaveLength(EXPECTED_MASKED.length);
  expect(files.filter(f => f.startsWith(join(OUT, "cli")))).toHaveLength(3);
  const traces = files.filter(f => f.endsWith("trace.zip"));
  expect(traces.length).toBeGreaterThanOrEqual(1);
  expect(files.some(f => f.endsWith(".webm"))).toBe(true);

  expect(secrets.size).toBeGreaterThan(0);
  for (const t of traces) redactTrace(t, secrets);

  const texts: Array<{ where: string; text: string }> = [];
  for (const f of files) {
    if (f.endsWith(".zip")) for (const e of zipEntries(f)) texts.push({ where: `${relative(OUT, f)}:${e.name}`, text: e.data.toString("latin1") });
    else if (/\.(json|txt|md|log)$/.test(f)) texts.push({ where: relative(OUT, f), text: readFileSync(f, "latin1") });
  }
  const findings: string[] = [];
  for (const { where, text } of texts) {
    for (const s of secrets) if (s && text.includes(s)) findings.push(`${where}: a credential or session value`);
    for (const m of text.matchAll(/FAKE-[A-Za-z0-9-]+/g)) if (!m[0].endsWith("-not-real") && !/-not-real/.test(text.slice(m.index!, m.index! + m[0].length + 40))) findings.push(`${where}: ${m[0]}`);
    for (const m of text.matchAll(/bearer\s+(?!FAKE-|<redacted>)[A-Za-z0-9._~+/=-]{12,}/gi)) findings.push(`${where}: a bearer value ${m[0].slice(0, 12)}…`);
    for (const m of text.matchAll(/__Host-acp_session=[A-Za-z0-9_-]{16,}/g)) findings.push(`${where}: a session cookie ${m[0].slice(0, 22)}…`);
  }
  expect(findings).toEqual([]);
});
