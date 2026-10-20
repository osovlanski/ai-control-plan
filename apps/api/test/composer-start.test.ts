/**
 * M2 Composer S5: `POST /api/tasks/:id/start` confirms a composition (plans/m2-composer.md §2
 * stage 6). With the composer on, start re-runs the pipeline with the preview's overrides, answers
 * 409 on drift, persists the revision once the worktree identity exists, binds the run, and builds
 * the ExecutionRequest's approval mode and caps from the revision. With no revision possible it
 * starts route-only with an attempt row saying why (Q3), or 422 with `composer.requireRevision`.
 */
import { execFileSync } from "node:child_process";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentSpec, CompositionDecision, ExecutionPolicy } from "@agent-plane/core";
import { credentialPath, readCredential } from "../src/auth/credential-file.js";
import { assembleBundle, fileDigest, type BundleRequest } from "../src/bundle-contract.js";
import { validateAgentSpec, validateCompositionDecision } from "../src/composition-contract.js";
import { loadConfig, type ResolvedConfig } from "../src/config.js";
import { openDb, type Db } from "../src/db/index.js";
import { composedExecutionPolicy } from "../src/modules/harness/control-plane-bridge.js";
import type { PreviewResponse } from "../src/modules/composer/service.js";
import { computeSnapshotDigest, REGISTRY_VERSION_HEADER, type RegistryAsset } from "../src/registry-contract.js";
import { createTaskWorktree } from "../src/repo/git.js";
import { buildServer, type BuiltServer } from "../src/server.js";

const TOKEN = "FAKE-cockpit-registry-token-not-real-s5";
const HOST = "fake-host-s5.example";
const digestOf = (text: string) => fileDigest(text);

// ---- a loopback stand-in for Cockpit's registry and bundle routes -----------

interface FakeSkill { body: string; tags: string[]; assistants: string[]; enabled?: boolean }
interface FakeCockpit {
  url: string;
  skills: Map<string, FakeSkill>;
  agents: string[];
  fragments: Map<string, string>;
  /** Fragment name → the free-text reason Cockpit gives for excluding it. */
  excludeFragments: Map<string, string>;
  requests: Array<{ method?: string; url?: string; body: string }>;
  close(): Promise<void>;
}

function assetsOf(c: FakeCockpit): RegistryAsset[] {
  const skills = [...c.skills].map(([id, s]): RegistryAsset => ({
    id, digest: digestOf(s.body), kind: "skill", nativeKind: "claude-skills", name: id.split(":")[1]!, description: "a skill",
    tags: [...s.tags].sort(), targets: ["claude"], compatibility: { assistants: [...s.assistants].sort() },
    requirements: { secretRefs: [] }, conflicts: [], lineage: { origin: "library" }, enabled: s.enabled ?? true,
    installedAt: "2026-10-01T09:00:00.000Z",
  }));
  const agents = c.agents.map((id): RegistryAsset => ({
    id, digest: digestOf(id), kind: "agent", nativeKind: "claude-agents", name: id, description: "an agent",
    tags: ["coding"], targets: ["claude"], compatibility: { assistants: ["claude"] },
    requirements: { secretRefs: [] }, conflicts: [], lineage: { origin: "manual" }, enabled: true, installedAt: "2026-10-01T09:00:00.000Z",
  }));
  return [...skills, ...agents].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

function render(c: FakeCockpit, request: BundleRequest): { status: number; body: unknown } {
  for (const pin of request.skills) {
    const skill = c.skills.get(pin.id);
    if (!skill || digestOf(skill.body) !== pin.digest) return { status: 404, body: { error: { code: "not_found", message: "skill not installed at that digest" } } };
  }
  if (request.memoryBundles.length) return { status: 404, body: { error: { code: "not_found", message: "no memory store" } } };
  for (const name of request.fragments) if (!c.fragments.has(name)) return { status: 404, body: { error: { code: "not_found", message: "unknown fragment" } } };
  const included: Parameters<typeof assembleBundle>[0]["included"] = [];
  const excluded: Parameters<typeof assembleBundle>[0]["excluded"] = [];
  const sections: string[] = [];
  for (const name of request.fragments) {
    const reason = c.excludeFragments.get(name);
    if (reason !== undefined) { excluded.push({ kind: "fragment", ref: name, reason }); continue; }
    sections.push(c.fragments.get(name)!);
    included.push({ kind: "fragment", ref: name, digest: digestOf(c.fragments.get(name)!), reason: "requested by the composition" });
  }
  const rendered = [{ relPath: request.harness === "codex" ? "AGENTS.md" : "CLAUDE.md", content: sections.join("\n\n") || "# Project context" }];
  for (const pin of request.skills) {
    const relPath = `.claude/skills/${pin.id.split(":")[1]}/SKILL.md`;
    rendered.push({ relPath, content: c.skills.get(pin.id)!.body });
    included.push({ kind: "skill", ref: pin.id, digest: pin.digest, relPath, reason: "selected by the composition" });
  }
  return { status: 200, body: assembleBundle({ request, rendered, compiler: { name: "fake-cockpit", version: "1.0.0" }, included, excluded }) };
}

async function fakeCockpit(): Promise<FakeCockpit> {
  const state: FakeCockpit = {
    url: "", skills: new Map(), agents: [], fragments: new Map(), excludeFragments: new Map(), requests: [], close: async () => {},
  };
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let body = "";
    req.on("data", (chunk: Buffer) => { body += chunk.toString("utf8"); });
    req.on("end", () => {
      state.requests.push({ method: req.method, url: req.url, body });
      const send = (status: number, payload: unknown, headers: Record<string, string> = {}) => {
        res.writeHead(status, { "content-type": "application/json", ...headers });
        res.end(JSON.stringify(payload));
      };
      if (req.headers.authorization !== `Bearer ${TOKEN}`) return send(401, { error: { code: "unauthenticated", message: "no" } });
      if (req.method === "GET" && req.url === "/api/v1/registry/assets") {
        const assets = assetsOf(state);
        return send(200, { schemaVersion: "1.0", snapshotDigest: computeSnapshotDigest(assets), assets }, { [REGISTRY_VERSION_HEADER]: "1.0" });
      }
      if (req.method === "POST" && req.url === "/api/v1/registry/bundle") {
        const out = render(state, JSON.parse(body) as BundleRequest);
        return send(out.status, out.body);
      }
      return send(404, { error: { code: "not_found", message: "no route" } });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  state.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  state.close = () => new Promise((resolve) => { server.closeAllConnections(); server.close(() => resolve()); });
  return state;
}

// ---- fixtures --------------------------------------------------------------

const TS_REVIEW = "claude-skills:ts-review";

let root: string;
let home: string;
let plane: string;
let repo: string;
let cockpit: FakeCockpit;
let db: Db;
let built: BuiltServer | undefined;
let configDir: string;

const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid" };
function git(args: string[]): string {
  return execFileSync("git", ["-C", repo, ...args], { env: GIT_ENV }).toString("utf8").trim();
}
function commit(file: string, content: string) {
  writeFileSync(join(repo, file), content);
  git(["add", "."]);
  git(["commit", "-q", "-m", `edit ${file}`]);
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "composer-start-"));
  home = join(root, "home");
  plane = join(root, "plane");
  repo = join(root, "repo");
  mkdirSync(join(home, ".cockpit"), { recursive: true });
  mkdirSync(plane);
  mkdirSync(repo);
  writeFileSync(join(home, ".cockpit", "registry-token"), `${TOKEN}\n`, { mode: 0o600 });
  writeFileSync(join(repo, "package.json"), JSON.stringify({ name: "x", devDependencies: { typescript: "^5.9.0" } }));
  writeFileSync(join(repo, "tsconfig.json"), "{}\n");
  git(["init", "-q"]);
  git(["add", "."]);
  git(["commit", "-q", "-m", "init"]);

  cockpit = await fakeCockpit();
  cockpit.skills.set(TS_REVIEW, { body: "---\nname: ts-review\n---\nReview TypeScript.\n", tags: ["coding", "typescript"], assistants: ["claude", "codex"] });
  cockpit.fragments.set("typescript-style", "Use strict TypeScript.");
});

afterEach(async () => {
  await built?.app.close();
  built = undefined;
  db?.close();
  await cockpit.close();
  rmSync(root, { recursive: true, force: true });
});

interface Setup {
  enabled?: boolean;
  harness?: boolean;
  requireRevision?: boolean;
  assistants?: ResolvedConfig["assistants"];
  approvalMode?: ResolvedConfig["policy"]["approvalMode"];
  budget?: ResolvedConfig["composer"]["policy"]["budget"];
}

async function boot(setup: Setup = {}): Promise<BuiltServer> {
  const config = loadConfig({ AGENT_PLANE_HOME: plane });
  config.assistants = setup.assistants ?? { "fake-claude": { provider: "fake" } };
  config.repoAllowlist = [repo];
  config.policy.approvalMode = setup.approvalMode ?? "auto-approve";
  config.execution.harnessModes.single = setup.harness ?? true;
  config.registry.cockpit = { enabled: true, baseUrl: cockpit.url, tokenPath: join(home, ".cockpit", "registry-token"), maxCacheAgeHours: 48 };
  config.composer.enabled = setup.enabled ?? true;
  config.composer.requireRevision = setup.requireRevision ?? false;
  config.composer.assets.allowlist = [{ id: TS_REVIEW, digest: digestOf(cockpit.skills.get(TS_REVIEW)!.body) }];
  config.composer.context.fragments.default = ["typescript-style"];
  config.composer.policy.permitAmbient = true;
  config.composer.policy.budget = setup.budget ?? {};
  configDir = config.dir;
  db = openDb(config.dbPath);
  built = buildServer({ config, db, composerHostname: HOST });
  built.registry.init();
  await built.registry.syncAll();
  await built.app.ready();
  return built;
}

const auth = () => ({ authorization: `Bearer ${readCredential(credentialPath(configDir)).secrets[0]!.secret}` });
const count = (table: string) => (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
const renders = () => cockpit.requests.filter((r) => r.url === "/api/v1/registry/bundle").length;

function task(goal: string, withRepo = true): string {
  return built!.tasks.create({ goal, ...(withRepo ? { repoPath: repo } : {}) }).taskId;
}

type ComposeBody = PreviewResponse & { error?: string; reason?: string };
async function compose(taskId: string, body: unknown = {}) {
  const res = await built!.app.inject({ method: "POST", url: `/api/tasks/${taskId}/compose`, headers: auth(), payload: body as object });
  return { status: res.statusCode, body: res.json() as ComposeBody };
}

interface StartBody {
  runId?: string;
  assistantId?: string;
  explanation?: { chosen?: string };
  composition?: { attemptId: string; outcome: string; reason: string | null; compositionDigest: string | null; compositionRevisionId: string | null } | null;
  error?: string;
  reason?: string;
  preview?: ComposeBody;
}
async function start(taskId: string, body: unknown = {}) {
  const res = await built!.app.inject({ method: "POST", url: `/api/tasks/${taskId}/start`, headers: auth(), payload: body as object });
  return { status: res.statusCode, body: res.json() as StartBody, raw: res.body };
}

function attempts(taskId: string) {
  return db.prepare("SELECT id, origin, routing_decision_id, composition_digest, inputs_digest, outcome, reason, composition_revision_id FROM composition_attempts WHERE task_id = ? ORDER BY rowid").all(taskId) as Array<{
    id: string; origin: string; routing_decision_id: number | null; composition_digest: string | null; inputs_digest: string | null;
    outcome: string; reason: string | null; composition_revision_id: string | null;
  }>;
}

interface StoredRequest { id: string; composition_revision_id: string | null; routing_decision_ref: string; policy: ExecutionPolicy; repository_id: string | null; worktree_id: string | null }
function executionRequest(taskId: string): StoredRequest {
  const row = db.prepare("SELECT id, composition_revision_id, routing_decision_ref, policy, repository_id, worktree_id FROM execution_requests WHERE task_id = ?").get(taskId) as Omit<StoredRequest, "policy"> & { policy: string };
  return { ...row, policy: JSON.parse(row.policy) as ExecutionPolicy };
}
const runRow = (runId: string) => db.prepare("SELECT task_id, composition_revision_id, execution_request_id FROM runs WHERE id = ?").get(runId) as { task_id: string; composition_revision_id: string | null; execution_request_id: string };
async function history(taskId: string) {
  return (await built!.app.inject({ method: "GET", url: `/api/tasks/${taskId}/composition`, headers: auth() })).json() as {
    revisions: Array<{ compositionRevisionId: string; spec: AgentSpec; decision: CompositionDecision }>;
    attempts: Array<{ id: string; origin: string; outcome: string; compositionRevisionId: string | null; compositionDigest: string | null; inputsDigest: string | null; routingDecisionId: number | null }>;
  };
}
const stage = (decision: { stages: Array<{ stage: string }> }, name: string) => decision.stages.find((s) => s.stage === name) as CompositionDecision["stages"][number];

// ---- tests -------------------------------------------------------------------

describe("POST /api/tasks/:id/start with composer.enabled false", () => {
  it("answers exactly as before: no composition key, no Cockpit request, no attempt, today's ExecutionRequest policy", async () => {
    await boot({ enabled: false });
    const id = task("Add a typed helper to the parser module");
    // The S5 body fields mean nothing with the composer off; they are ignored, as any unknown key always was.
    const res = await start(id, { compositionDigest: `sha256:${"a".repeat(64)}`, overrides: { policy: { permission: "read-only" } } });
    expect(res.status).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual(["assistantId", "explanation", "runId"]);
    expect(await built!.orchestrator.waitForSettled(id)).toBe("COMPLETED");
    expect(cockpit.requests.filter((r) => r.url === "/api/v1/registry/bundle")).toEqual([]);
    expect(count("composition_attempts")).toBe(0);
    expect(count("agent_specs")).toBe(0);
    expect(runRow(res.body.runId!).composition_revision_id).toBeNull();
    const request = executionRequest(id);
    expect(request.composition_revision_id).toBeNull();
    expect(request.policy).toEqual({
      budget: { enforcement: "advisory" }, timeout: { hardMs: 30 * 60 * 1000 }, approval: { mode: "auto-approve" },
      tools: { mode: "audit" }, checkpoint: { onSoftLimit: true }, isolation: { required: "ambient" },
    });
    // The serialized body is the pre-S5 shape: route explanation, chosen assistant, run.
    expect(res.raw).toBe(JSON.stringify({ runId: res.body.runId, assistantId: "fake-claude", explanation: res.body.explanation }));
  });
});

describe("POST /api/tasks/:id/start with the composer on", () => {
  it("confirms the previewed digest: persists the revision with the worktree identity, an attempt, and binds the run", async () => {
    await boot();
    const id = task("Add a typed helper to the parser module");
    const preview = await compose(id);
    expect(preview.body.outcome).toEqual({ status: "composed" });
    const digest = preview.body.compositionDigest!;
    const head = git(["rev-parse", "HEAD"]);

    const res = await start(id, { compositionDigest: digest });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      assistantId: "fake-claude", explanation: { chosen: "fake-claude" },
      composition: { attemptId: `CA-${id}-2`, outcome: "persisted", reason: null, compositionDigest: digest, compositionRevisionId: `CR-${id}-1` },
    });
    expect(await built!.orchestrator.waitForSettled(id)).toBe("COMPLETED");

    // The revision and its decision, through the M1 store (validated there) and the history route.
    const shown = await history(id);
    expect(shown.revisions).toHaveLength(1);
    const [revision] = shown.revisions;
    expect(revision!.compositionRevisionId).toBe(`CR-${id}-1`);
    expect(validateAgentSpec(revision!.spec)).toMatchObject({ ok: true });
    expect(validateCompositionDecision(revision!.decision)).toMatchObject({ ok: true });
    expect(revision!.spec).toMatchObject({ composition_revision_id: `CR-${id}-1`, explanation_ref: `CD-${id}-1`, task_id: id });
    expect(revision!.decision).toMatchObject({ id: `CD-${id}-1`, composition_revision_id: `CR-${id}-1` });
    expect(stage(revision!.decision, "confirm")).toMatchObject({ chosen: ["start"], why: `operator confirmed ${digest}` });
    // Stages intent..policy are exactly what the operator previewed.
    expect(revision!.decision.stages.slice(0, 5)).toEqual(preview.body.decision.stages.slice(0, 5));
    expect(shown.attempts.map((a) => [a.origin, a.outcome])).toEqual([["preview", "previewed"], ["start", "persisted"]]);
    const persisted = shown.attempts[1]!;
    expect(persisted).toMatchObject({ id: `CA-${id}-2`, compositionRevisionId: `CR-${id}-1`, compositionDigest: digest, inputsDigest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/) });

    // The workspace is the worktree identity the ExecutionRequest carries, never a path.
    const request = executionRequest(id);
    const taskRow = built!.tasks.get(id)!;
    expect(revision!.spec.workspace).toEqual({ repository_id: request.repository_id, branch: `task/${id}`, worktree_id: request.worktree_id });
    expect(JSON.stringify(revision!.spec)).not.toContain(root);
    // The worktree branches from the commit the composition's repo signals were read at.
    expect(taskRow.base_ref).toBe(head);
    expect(stage(revision!.decision, "intent").why).toContain(head);

    // One routing row for the start, shared by its attempt, the run's request and the response.
    expect(request.routing_decision_ref).toBe(String(persisted.routingDecisionId));
    expect(request.composition_revision_id).toBe(`CR-${id}-1`);
    const run = runRow(res.body.runId!);
    expect(run).toMatchObject({ task_id: id, composition_revision_id: `CR-${id}-1`, execution_request_id: request.id });
    const taskView = (await built!.app.inject({ method: "GET", url: `/api/tasks/${id}`, headers: auth() })).json() as { runs: Array<{ compositionRevisionId: string | null }> };
    expect(taskView.runs.map((r) => r.compositionRevisionId)).toEqual([`CR-${id}-1`]);
    // runs.composition_revision_id is write-once.
    expect(() => db.prepare("UPDATE runs SET composition_revision_id = NULL WHERE id = ?").run(res.body.runId)).toThrow();
  });

  it("starts without a digest when none is sent, and numbers revisions per task", async () => {
    await boot();
    const id = task("Add a typed helper to the parser module");
    const res = await start(id);
    expect(res.status).toBe(200);
    expect(res.body.composition).toMatchObject({ outcome: "persisted", compositionRevisionId: `CR-${id}-1`, attemptId: `CA-${id}-1` });
    expect(await built!.orchestrator.waitForSettled(id)).toBe("COMPLETED");
    const other = task("Add a typed helper to the lexer module");
    expect((await start(other)).body.composition).toMatchObject({ compositionRevisionId: `CR-${other}-1` });
    await built!.orchestrator.waitForSettled(other);
  });

  it("answers 409 with the new preview when the composition drifted, and writes no revision and no run", async () => {
    await boot();
    const id = task("Add a typed helper to the parser module");
    const preview = await compose(id);
    const before = preview.body.compositionDigest!;
    // The base commit moves: the repo signals the composition rests on are no longer the previewed ones.
    commit("README.md", "hello\n");

    const res = await start(id, { compositionDigest: before });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ reason: "composition_drift" });
    const drift = res.body.preview!;
    expect(drift.outcome).toEqual({ status: "composed" });
    expect(drift.compositionDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(drift.compositionDigest).not.toBe(before);
    expect(stage(drift.decision, "confirm")).toMatchObject({ chosen: [], why: "awaiting confirmation" });
    expect(count("agent_specs")).toBe(0);
    expect(count("composition_decisions")).toBe(0);
    expect(count("runs")).toBe(0);
    expect(count("execution_requests")).toBe(0);
    expect(built!.tasks.get(id)!.state).toBe("CREATED");
    // The 409's preview is what /compose shows for the same state, and is recorded as one.
    const fresh = await compose(id);
    expect(fresh.body.compositionDigest).toBe(drift.compositionDigest);
    expect(fresh.body.decision).toEqual(drift.decision);
    expect(attempts(id).map((a) => [a.origin, a.outcome])).toEqual([["preview", "previewed"], ["start", "previewed"], ["preview", "previewed"]]);

    // One more click: the new digest starts.
    const again = await start(id, { compositionDigest: drift.compositionDigest });
    expect(again.status).toBe(200);
    expect(again.body.composition).toMatchObject({ outcome: "persisted", compositionDigest: drift.compositionDigest });
    await built!.orchestrator.waitForSettled(id);
  });

  it("starts route-only when Cockpit is unreachable, with a failed attempt saying why; a sent digest is drift", async () => {
    await boot({ budget: { maxTokens: 5000 } });
    expect((await built!.registryFederation.sync()).ok).toBe(true);
    const id = task("Add a typed helper to the parser module");
    const preview = await compose(id);
    expect(preview.body.outcome).toEqual({ status: "composed" });
    await cockpit.close();

    // The confirmed composition cannot be rendered any more: drift, not a silent route-only start.
    const confirmed = await start(id, { compositionDigest: preview.body.compositionDigest });
    expect(confirmed.status).toBe(409);
    expect(confirmed.body.preview).toMatchObject({ outcome: { status: "failed", reason: "unreachable" }, compositionDigest: null });

    const res = await start(id);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ assistantId: "fake-claude", composition: { outcome: "failed", reason: "unreachable", compositionRevisionId: null, compositionDigest: null } });
    expect(await built!.orchestrator.waitForSettled(id)).toBe("COMPLETED");
    expect(runRow(res.body.runId!).composition_revision_id).toBeNull();
    expect(count("agent_specs")).toBe(0);
    // Route-only: today's request, no revision and no caps, whatever the composer config says.
    const request = executionRequest(id);
    expect(request.composition_revision_id).toBeNull();
    expect(request.policy.budget).toEqual({ enforcement: "advisory" });
    expect(request.policy.approval).toEqual({ mode: "auto-approve" });
    const last = attempts(id).at(-1)!;
    expect(last).toMatchObject({ origin: "start", outcome: "failed", reason: "unreachable", composition_revision_id: null, routing_decision_id: Number(request.routing_decision_ref) });
    expect(last.inputs_digest).toMatch(/^sha256:/);
  });

  it("answers 422 with composer.requireRevision when no revision is possible, and starts nothing", async () => {
    await boot({ requireRevision: true });
    expect((await built!.registryFederation.sync()).ok).toBe(true);
    await cockpit.close();
    const id = task("Add a typed helper to the parser module");
    const res = await start(id);
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ reason: "unreachable", composition: { outcome: "failed", reason: "unreachable" } });
    expect(count("runs")).toBe(0);
    expect(count("execution_requests")).toBe(0);
    expect(built!.tasks.get(id)!.state).toBe("CREATED");
    expect(attempts(id)).toEqual([expect.objectContaining({ origin: "start", outcome: "failed", reason: "unreachable" })]);
  });

  it("tightens the approval mode and carries the caps into the ExecutionRequest; never loosens", async () => {
    await boot({ budget: { maxTokens: 5000, maxRuntimeMs: 60_000, maxCostUsd: 2.5 } });
    // "deploy" is high risk, and the default risk map takes high to prompt-on-escalation.
    const id = task("Deploy the parser module to production");
    const res = await start(id);
    expect(res.status).toBe(200);
    expect(res.body.composition).toMatchObject({ outcome: "persisted" });
    const revision = (await history(id)).revisions[0]!.spec;
    expect(revision.intent.risk).toBe("high");
    expect(revision.policy).toMatchObject({ permission: "prompt-on-escalation", budget: { max_tokens: 5000, max_runtime_ms: 60_000, max_cost_usd: 2.5 } });

    const request = executionRequest(id);
    expect(request.policy.approval).toEqual({ mode: "prompt-on-escalation" });
    // Fake declares no usageReporting, and a cost cap is never bounded: both caps are advisory.
    expect(request.policy.budget).toEqual({ maxTokens: 5000, maxCostUsd: 2.5, enforcement: "advisory" });
    expect(request.policy.timeout).toEqual({ hardMs: 60_000 });
    const stored = db.prepare("SELECT canonical_projection FROM execution_requests WHERE task_id = ?").get(id) as { canonical_projection: string };
    expect(stored.canonical_projection).toContain(`CR-${id}-1`);
    await built!.orchestrator.waitForSettled(id);
  });

  it("composedExecutionPolicy only tightens and bounds tokens only where Prepare would accept it", () => {
    const policy = (permission: AgentSpec["policy"]["permission"], budget: AgentSpec["policy"]["budget"] = {}): AgentSpec["policy"] =>
      ({ revision: { id: "p", digest: `sha256:${"0".repeat(64)}` }, permission, tool_allowlist: [], budget });
    const ws = (approvalMode: ResolvedConfig["policy"]["approvalMode"]) => ({ approvalMode, maxRuntimeMs: 1_800_000 });
    const reporting = { usageAccounting: "cumulative" as const, usageReporting: { maxUnreportedTokens: 100 } } as never;
    expect(composedExecutionPolicy(policy("auto"), ws("prompt-on-escalation"), undefined).approvalMode).toBe("prompt-on-escalation");
    expect(composedExecutionPolicy(policy("auto"), ws("read-only"), undefined).approvalMode).toBe("read-only");
    expect(composedExecutionPolicy(policy("read-only"), ws("auto-approve"), undefined).approvalMode).toBe("read-only");
    expect(composedExecutionPolicy(policy("prompt-on-escalation"), ws("read-only"), undefined).approvalMode).toBe("read-only");
    // Runtime: the stricter of config and the cap.
    expect(composedExecutionPolicy(policy("auto", { max_runtime_ms: 9_999_999 }), ws("auto-approve"), undefined).maxRuntimeMs).toBe(1_800_000);
    expect(composedExecutionPolicy(policy("auto", { max_runtime_ms: 1_000 }), ws("auto-approve"), undefined).maxRuntimeMs).toBe(1_000);
    // Bounded needs a token cap, usage accounting, proven reporting and no cost cap.
    expect(composedExecutionPolicy(policy("auto", { max_tokens: 10 }), ws("auto-approve"), reporting).budget).toEqual({ maxTokens: 10, enforcement: "bounded" });
    expect(composedExecutionPolicy(policy("auto", { max_tokens: 10, max_cost_usd: 1 }), ws("auto-approve"), reporting).budget.enforcement).toBe("advisory");
    expect(composedExecutionPolicy(policy("auto", { max_tokens: 10 }), ws("auto-approve"), { usageAccounting: "cumulative" } as never).budget.enforcement).toBe("advisory");
    expect(composedExecutionPolicy(policy("auto", { max_tokens: 10 }), ws("auto-approve"), { usageAccounting: "none", usageReporting: {} } as never).budget.enforcement).toBe("advisory");
    expect(composedExecutionPolicy(policy("auto"), ws("auto-approve"), reporting).budget).toEqual({ enforcement: "advisory" });
  });

  it("gives Codex + a high-risk goal policy_unenforceable and starts route-only (the Composer never loosens)", async () => {
    await boot({ assistants: { "fake-codex": { provider: "fake", options: { harness: "codex" } } } });
    const id = task("Deploy the parser module to production");
    const res = await start(id);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ assistantId: "fake-codex", composition: { outcome: "failed", reason: "policy_unenforceable", compositionRevisionId: null } });
    expect(count("agent_specs")).toBe(0);
    // Route-only means today's request: the workspace mode, no revision.
    const request = executionRequest(id);
    expect(request.composition_revision_id).toBeNull();
    expect(request.policy.approval).toEqual({ mode: "auto-approve" });
    await built!.orchestrator.waitForSettled(id);
  });

  it("refuses an override that loosens permission: 400, nothing written, nothing started", async () => {
    await boot({ approvalMode: "prompt-on-escalation" });
    const id = task("Add a typed helper to the parser module");
    const res = await start(id, { overrides: { policy: { permission: "auto" } } });
    expect(res).toMatchObject({ status: 400, body: { error: "override refused", reason: expect.stringMatching(/would loosen/) } });
    for (const body of [{ overrides: { confirm: {} } }, { compositionDigest: "sha256:nope" }, { other: 1 }, { assistantId: "nobody" },
      { assistantId: "fake-claude", overrides: { harness_model: { assistantId: "fake-other" } } }]) {
      expect({ body, status: (await start(id, body)).status }).toEqual({ body, status: 400 });
    }
    expect({ routing: count("routing_decisions"), attempts: count("composition_attempts"), runs: count("runs"), specs: count("agent_specs") })
      .toEqual({ routing: 0, attempts: 0, runs: 0, specs: 0 });
    expect(built!.tasks.get(id)!.state).toBe("CREATED");
  });

  it("starts with the same override the preview carried, and the override is in the persisted decision", async () => {
    await boot({ approvalMode: "auto-approve" });
    const id = task("Add a typed helper to the parser module");
    const overrides = { policy: { permission: "read-only" } };
    const preview = await compose(id, { overrides });
    const res = await start(id, { compositionDigest: preview.body.compositionDigest, overrides });
    expect(res.status).toBe(200);
    expect(executionRequest(id).policy.approval).toEqual({ mode: "read-only" });
    const decision = (await history(id)).revisions[0]!.decision;
    expect(stage(decision, "policy").override).toMatchObject({ actor: "operator", to: ["permission:read-only", "provisioning:ambient"] });
    // The same digest without the override is a different composition.
    const other = task("Add a typed helper to the parser module");
    const otherPreview = await compose(other, { overrides });
    expect((await start(other, { compositionDigest: otherPreview.body.compositionDigest })).status).toBe(409);
    await built!.orchestrator.waitForSettled(id);
  });

  it("does not compose a start that cannot carry a revision: legacy path or no repository", async () => {
    await boot({ harness: false });
    const id = task("Add a typed helper to the parser module");
    const confirmed = await start(id, { compositionDigest: `sha256:${"b".repeat(64)}` });
    expect(confirmed).toMatchObject({ status: 422, body: { reason: "revision_unbindable", composition: { outcome: "skipped", reason: "legacy_execution_path" } } });
    const before = renders();
    const res = await start(id);
    expect(res.status).toBe(200);
    expect(res.body.composition).toMatchObject({ outcome: "skipped", reason: "legacy_execution_path" });
    expect(renders()).toBe(before);
    expect(await built!.orchestrator.waitForSettled(id)).toBe("COMPLETED");
    expect(runRow(res.body.runId!).composition_revision_id).toBeNull();
  });

  it("records no_repository for a repo-less task on the Harness path and runs it route-only", async () => {
    await boot();
    const id = task("Summarise the meeting notes", false);
    const res = await start(id);
    expect(res.status).toBe(200);
    expect(res.body.composition).toMatchObject({ outcome: "skipped", reason: "no_repository" });
    expect(await built!.orchestrator.waitForSettled(id)).toBe("COMPLETED");
  });

  it("leaks no hostname, home path or token into the database", async () => {
    await boot();
    const id = task("Add a typed helper to the parser module");
    const preview = await compose(id);
    expect((await start(id, { compositionDigest: preview.body.compositionDigest })).status).toBe(200);
    await built!.orchestrator.waitForSettled(id);
    db.pragma("wal_checkpoint(PASSIVE)");
    const files = readdirSync(configDir).filter((f) => f.startsWith("agent-plane.db")).map((f) => join(configDir, f));
    for (const file of files) {
      const bytes = readFileSync(file);
      expect({ file, host: bytes.includes(Buffer.from(HOST)), home: bytes.includes(Buffer.from(home)), token: bytes.includes(Buffer.from("FAKE-")) })
        .toEqual({ file, host: false, home: false, token: false });
    }
  });
});

describe("createTaskWorktree baseCommit", () => {
  it("branches from the pinned commit, not from a HEAD that moved", async () => {
    const pinned = git(["rev-parse", "HEAD"]);
    commit("README.md", "moved\n");
    const worktree = await createTaskWorktree(repo, "AG-pin", join(root, "worktrees"), { baseCommit: pinned });
    expect(worktree.baseRef).toBe(pinned);
    expect(execFileSync("git", ["-C", worktree.path, "rev-parse", "HEAD"]).toString("utf8").trim()).toBe(pinned);
    await expect(createTaskWorktree(repo, "AG-bad", join(root, "worktrees"), { baseCommit: "HEAD" })).rejects.toThrow(/full commit id/);
  });
});
