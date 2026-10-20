/**
 * M2 Composer S4: `POST /api/tasks/:id/compose` runs stages 1 to 5 over the real route() and a
 * loopback fake Cockpit, writes one routing row and one attempt, and never writes a revision.
 */
import { execFileSync } from "node:child_process";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NotSupportedError, type AssistantId, type CapabilityManifest, type RunSpec } from "@agent-plane/core";
import { CursorAdapter } from "@agent-plane/adapters";
import { codexPermissions } from "../../../packages/adapters/src/codex-permissions.js";
import { credentialPath, readCredential } from "../src/auth/credential-file.js";
import { assembleBundle, fileDigest, type BundleRequest } from "../src/bundle-contract.js";
import { validateAgentSpec, validateCompositionDecision } from "../src/composition-contract.js";
import { loadConfig, type ResolvedConfig } from "../src/config.js";
import { openDb, type Db } from "../src/db/index.js";
import { HARNESS_APPROVAL_MODES, harnessOf } from "../src/modules/composer/ports.js";
import type { PreviewResponse } from "../src/modules/composer/service.js";
import { computeSnapshotDigest, REGISTRY_VERSION_HEADER, type RegistryAsset } from "../src/registry-contract.js";
import { buildServer, type BuiltServer } from "../src/server.js";

const TOKEN = "FAKE-cockpit-registry-token-not-real-s4";
const HOST = "fake-host-s4.example";
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
const PR_WRITER = "claude-skills:pr-writer";
const PY_LINT = "claude-skills:py-lint";

let root: string;
let home: string;
let plane: string;
let repo: string;
let cockpit: FakeCockpit;
let db: Db;
let built: BuiltServer | undefined;
let configDir: string;

function git(args: string[]) {
  execFileSync("git", ["-C", repo, ...args], { env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid" } });
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "composer-preview-"));
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
  cockpit.skills.set(PR_WRITER, { body: "---\nname: pr-writer\n---\nWrite the PR.\n", tags: ["coding"], assistants: ["claude"] });
  cockpit.skills.set(PY_LINT, { body: "---\nname: py-lint\n---\nLint Python.\n", tags: ["python"], assistants: ["claude"] });
  cockpit.agents.push("claude-agents:helper.md");
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
  federation?: boolean;
  assistants?: ResolvedConfig["assistants"];
  approvalMode?: ResolvedConfig["policy"]["approvalMode"];
  fragments?: string[];
}

async function boot(setup: Setup = {}): Promise<BuiltServer> {
  const config = loadConfig({ AGENT_PLANE_HOME: plane });
  config.assistants = setup.assistants ?? { "fake-claude": { provider: "fake" }, "fake-codex": { provider: "fake", options: { harness: "codex" } } };
  config.repoAllowlist = [repo];
  config.policy.approvalMode = setup.approvalMode ?? "auto-approve";
  config.registry.cockpit = { enabled: setup.federation ?? true, baseUrl: cockpit.url, tokenPath: join(home, ".cockpit", "registry-token"), maxCacheAgeHours: 48 };
  config.composer.enabled = setup.enabled ?? true;
  config.composer.assets.allowlist = [{ id: TS_REVIEW, digest: digestOf(cockpit.skills.get(TS_REVIEW)!.body) }];
  config.composer.context.fragments.default = setup.fragments ?? ["typescript-style"];
  config.composer.policy.permitAmbient = true;
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
const syncs = () => cockpit.requests.filter((r) => r.url === "/api/v1/registry/assets").length;

function task(goal: string, withRepo = true): string {
  return built!.tasks.create({ goal, ...(withRepo ? { repoPath: repo } : {}) }).taskId;
}

/** A compose answer: the preview on 200, `{ error, reason? }` otherwise. */
type ComposeBody = PreviewResponse & { error?: string; reason?: string };

async function compose(taskId: string, body: unknown = {}) {
  const res = await built!.app.inject({ method: "POST", url: `/api/tasks/${taskId}/compose`, headers: auth(), payload: body as object });
  return { status: res.statusCode, body: res.json() as ComposeBody };
}
const stage = (body: ComposeBody, name: string) => body.decision.stages.find((s) => s.stage === name)!;

/** The draft with the ids the api fills at persist, so the M1 validators can check it. */
function filled(taskId: string, body: ComposeBody) {
  const id = `CR-${taskId}-1`;
  return {
    spec: { ...body.specDraft, composition_revision_id: id, explanation_ref: `CD-${taskId}-1`, workspace: { repository_id: "repo-1", branch: `task/${taskId}`, worktree_id: "wt-1" } },
    decision: { ...body.decision, id: `CD-${taskId}-1`, composition_revision_id: id },
  };
}

// ---- tests -------------------------------------------------------------------

describe("POST /api/tasks/:id/compose", () => {
  it("composes a TypeScript coding goal with the one allowlisted skill, writing one routing row and one attempt", async () => {
    await boot();
    const id = task("Add a typed helper to the parser module");
    const { status, body } = await compose(id);
    expect(status).toBe(200);
    expect(body.outcome).toEqual({ status: "composed" });
    expect(body.compositionDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(stage(body, "intent").chosen).toEqual(["complexity:M", "domain:node", "domain:typescript", "kind:coding", "risk:normal"]);
    expect(stage(body, "harness_model").chosen).toEqual(["fake-claude/fake-1"]);
    const assets = stage(body, "assets");
    expect(assets.chosen).toEqual([TS_REVIEW]);
    expect(assets.filters.map((f) => f.filter)).toEqual(["kind_not_attachable", "not_allowlisted"]);
    expect(stage(body, "context").chosen).toEqual(["fragment:typescript-style"]);
    expect(stage(body, "policy").chosen).toEqual(["permission:auto", "provisioning:ambient"]);
    expect(stage(body, "confirm")).toMatchObject({ chosen: [], why: "awaiting confirmation" });
    expect(body.specDraft).toMatchObject({
      task_id: id, harness: "claude-code", model: { primary: { id: "fake-1" }, fallbacks: [] },
      assets: { skills: [{ id: TS_REVIEW, digest: digestOf(cockpit.skills.get(TS_REVIEW)!.body), allowlisted: true }], mcp_servers: [], subagents: [] },
      policy: { permission: "auto", tool_allowlist: [], budget: {} }, provisioning: { requested: "ambient" },
    });
    // The draft is a valid AgentSpec and decision once the api fills its ids at persist.
    const full = filled(id, body);
    expect(validateAgentSpec(full.spec)).toMatchObject({ ok: true });
    expect(validateCompositionDecision(full.decision)).toMatchObject({ ok: true });

    expect(count("routing_decisions")).toBe(1);
    expect(count("agent_specs")).toBe(0);
    expect(count("composition_decisions")).toBe(0);
    const attempts = db.prepare("SELECT * FROM composition_attempts").all() as Array<Record<string, unknown>>;
    expect(attempts).toEqual([expect.objectContaining({
      id: `CA-${id}-1`, task_id: id, origin: "preview", routing_decision_id: body.routingDecisionId, composition_digest: body.compositionDigest,
      inputs_digest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/), outcome: "previewed", reason: null, composition_revision_id: null,
    })]);
    expect(body.attemptId).toBe(`CA-${id}-1`);

    const history = await built!.app.inject({ method: "GET", url: `/api/tasks/${id}/composition`, headers: auth() });
    expect(history.statusCode).toBe(200);
    expect(history.json()).toMatchObject({ taskId: id, revisions: [], attempts: [{ id: `CA-${id}-1`, outcome: "previewed", compositionDigest: body.compositionDigest, inputsDigest: attempts[0]!.inputs_digest }], optIns: [] });

    // The same inputs again: the same inputs digest and composition digest, a second attempt row.
    const again = await compose(id);
    expect(again.body.compositionDigest).toBe(body.compositionDigest);
    const digests = db.prepare("SELECT inputs_digest FROM composition_attempts ORDER BY rowid").all() as Array<{ inputs_digest: string }>;
    expect(digests.map((d) => d.inputs_digest)).toEqual([attempts[0]!.inputs_digest, attempts[0]!.inputs_digest]);
  });

  it("records chosen: [] with a why when no skill fits (zero asset)", async () => {
    await boot();
    const id = task("Summarise the meeting notes", false);
    const { body } = await compose(id);
    expect(body.outcome).toEqual({ status: "composed" });
    const assets = stage(body, "assets");
    expect(assets.chosen).toEqual([]);
    expect(assets.why).toMatch(/^no optional asset fits/);
    expect(assets.filters.find((f) => f.filter === "no_tag_match")).toBeDefined();
    expect(body.specDraft!.assets.skills).toEqual([]);
  });

  it("records federation off: no Cockpit request, no bundle, attempt failed: disabled", async () => {
    await boot({ federation: false });
    const id = task("Add a typed helper to the parser module");
    const { status, body } = await compose(id);
    expect(status).toBe(200);
    expect(body.outcome).toEqual({ status: "failed", reason: "disabled" });
    expect(stage(body, "assets")).toMatchObject({ candidates: [], chosen: [], why: "registry federation is off" });
    expect(stage(body, "context")).toMatchObject({ chosen: [], why: "no bundle: disabled" });
    expect(body.specDraft).toBeNull();
    expect(body.compositionDigest).toBeNull();
    expect(cockpit.requests).toEqual([]);
    expect(db.prepare("SELECT outcome, reason, composition_digest FROM composition_attempts").get()).toEqual({ outcome: "failed", reason: "disabled", composition_digest: null });
    expect(count("routing_decisions")).toBe(1);
  });

  it("uses the last good snapshot when Cockpit is unreachable, and fails the render: unreachable", async () => {
    await boot();
    expect((await built!.registryFederation.sync()).ok).toBe(true);
    await cockpit.close();
    const id = task("Add a typed helper to the parser module");
    const { body } = await compose(id);
    expect(body.outcome).toEqual({ status: "failed", reason: "unreachable" });
    expect(stage(body, "assets").chosen).toEqual([TS_REVIEW]);
    expect(stage(body, "context").why).toBe("no bundle: unreachable");
    expect(db.prepare("SELECT outcome, reason FROM composition_attempts").get()).toEqual({ outcome: "failed", reason: "unreachable" });
  });

  it("tries one sync when no snapshot exists and records no_snapshot when Cockpit is down", async () => {
    await cockpit.close();
    await boot();
    const id = task("Add a typed helper to the parser module");
    const { body } = await compose(id);
    expect(body.outcome).toEqual({ status: "failed", reason: "unreachable" });
    expect(stage(body, "assets").why).toBe("no registry snapshot yet (unreachable)");
  });

  it("filters skills on a codex route as no_skill_path and renders AGENTS.md", async () => {
    await boot({ assistants: { "fake-codex": { provider: "fake", options: { harness: "codex" } } } });
    const id = task("Add a typed helper to the parser module");
    const { body } = await compose(id);
    expect(body.outcome).toEqual({ status: "composed" });
    expect(body.specDraft!.harness).toBe("codex");
    const assets = stage(body, "assets");
    expect(assets.chosen).toEqual([]);
    expect(assets.filters.find((f) => f.filter === "no_skill_path")).toMatchObject({ removed: [TS_REVIEW] });
    const request = JSON.parse(cockpit.requests.find((r) => r.url === "/api/v1/registry/bundle")!.body) as BundleRequest;
    expect(request).toMatchObject({ harness: "codex", skills: [] });
  });

  it("on not_found syncs the registry once and recomposes once", async () => {
    await boot();
    expect((await built!.registryFederation.sync()).ok).toBe(true);
    // The installed skill changes after the snapshot pinned it: Cockpit answers 404 for the old pin.
    cockpit.skills.get(TS_REVIEW)!.body += "\nAlso check the tests.\n";
    // The allowlist pins the old digest, so the new one attaches through an opt-in.
    const id = task("Add a typed helper to the parser module");
    await built!.app.inject({ method: "POST", url: `/api/tasks/${id}/composition/opt-ins`, headers: auth(), payload: { assetId: TS_REVIEW, digest: digestOf(cockpit.skills.get(TS_REVIEW)!.body) } });
    const before = { renders: renders(), syncs: syncs() };
    const { body } = await compose(id);
    expect(body.resynced).toBe(true);
    expect(body.outcome).toEqual({ status: "composed" });
    expect(body.specDraft!.assets.skills).toEqual([expect.objectContaining({ id: TS_REVIEW, digest: digestOf(cockpit.skills.get(TS_REVIEW)!.body), allowlisted: false })]);
    expect({ renders: renders() - before.renders, syncs: syncs() - before.syncs }).toEqual({ renders: 2, syncs: 1 });
    expect(count("routing_decisions")).toBe(1);
    expect(count("composition_attempts")).toBe(1);
  });

  it("fails not_found after the one resync when the pin still cannot be honoured", async () => {
    await boot({ fragments: ["typescript-style", "unknown-fragment"] });
    const id = task("Add a typed helper to the parser module");
    const { body } = await compose(id);
    expect(body.resynced).toBe(true);
    expect(body.outcome).toEqual({ status: "failed", reason: "not_found" });
    expect(renders()).toBe(2);
    expect(count("composition_attempts")).toBe(1);
  });

  it("records an asset and a harness override with from and to", async () => {
    await boot();
    const id = task("Add a typed helper to the parser module");
    // py-lint matches no intent tag, so the pipeline leaves it out; an opt-in lets an override attach it.
    await built!.app.inject({ method: "POST", url: `/api/tasks/${id}/composition/opt-ins`, headers: auth(), payload: { assetId: PY_LINT, digest: digestOf(cockpit.skills.get(PY_LINT)!.body) } });
    const assets = await compose(id, { overrides: { assets: { remove: [TS_REVIEW], add: [PY_LINT] } } });
    expect(assets.status).toBe(200);
    expect(assets.body.outcome).toEqual({ status: "composed" });
    expect(stage(assets.body, "assets")).toMatchObject({
      chosen: [PY_LINT],
      override: { actor: "operator", from: [TS_REVIEW], to: [PY_LINT], reason: "operator override" },
    });
    expect(stage(assets.body, "assets").why).toMatch(/^operator override; pipeline chose claude-skills:ts-review/);
    expect(assets.body.specDraft!.assets.skills.map((s) => s.id)).toEqual([PY_LINT]);

    const routed = await compose(id, { overrides: { harness_model: { assistantId: "fake-codex", model: "fake-2" } } });
    expect(stage(routed.body, "harness_model")).toMatchObject({
      chosen: ["fake-codex/fake-2"], override: { from: ["fake-claude/fake-1"], to: ["fake-codex/fake-2"] },
    });
    expect(routed.body.specDraft).toMatchObject({ harness: "codex", model: { primary: { id: "fake-2" } } });
    // Each preview: one routing row for the outcome used (not one per route() call) and one attempt.
    expect({ routing: count("routing_decisions"), attempts: count("composition_attempts") }).toEqual({ routing: 2, attempts: 2 });
    const used = db.prepare("SELECT chosen_assistant_id FROM routing_decisions ORDER BY id DESC LIMIT 1").get();
    expect(used).toEqual({ chosen_assistant_id: "fake-codex" });
  });

  it("refuses a permission override that loosens the workspace mode: 400, nothing recorded", async () => {
    await boot({ approvalMode: "prompt-on-escalation" });
    const id = task("Add a typed helper to the parser module");
    const res = await compose(id, { overrides: { policy: { permission: "auto" } } });
    expect(res).toMatchObject({ status: 400, body: { error: "override refused", reason: expect.stringMatching(/would loosen/) } });
    const tighter = await compose(id, { overrides: { policy: { permission: "read-only" } } });
    expect(tighter.status).toBe(200);
    expect(stage(tighter.body, "policy")).toMatchObject({ override: { from: ["permission:prompt-on-escalation", "provisioning:ambient"], to: ["permission:read-only", "provisioning:ambient"] } });
    expect({ routing: count("routing_decisions"), attempts: count("composition_attempts") }).toEqual({ routing: 1, attempts: 1 });
  });

  it("refuses attaching an unallowlisted asset without an opt-in: 400, nothing recorded", async () => {
    await boot();
    const id = task("Add a typed helper to the parser module");
    const res = await compose(id, { overrides: { assets: { add: [PR_WRITER] } } });
    expect(res).toMatchObject({ status: 400, body: { error: "override refused", reason: `asset ${PR_WRITER} was removed by not_allowlisted; an override cannot attach it` } });
    expect({ routing: count("routing_decisions"), attempts: count("composition_attempts") }).toEqual({ routing: 0, attempts: 0 });
  });

  it("answers 400 for a malformed override body", async () => {
    await boot();
    const id = task("Add a typed helper to the parser module");
    for (const body of [{ overrides: { assets: { add: "x" } } }, { overrides: { confirm: {} } }, { overrides: { harness_model: { assistantId: "nobody" } } }, { other: 1 }, { overrides: { policy: { budget: { max_tokens: "1" } } } }]) {
      expect({ body, status: (await compose(id, body)).status }).toEqual({ body, status: 400 });
    }
    expect(count("composition_attempts")).toBe(0);
  });

  it("pins an opt-in once: `at` is stamped at write, read back unchanged, and a different digest is opt_in_stale", async () => {
    await boot();
    const id = task("Add a typed helper to the parser module");
    const digest = digestOf(cockpit.skills.get(PR_WRITER)!.body);
    const first = await built!.app.inject({ method: "POST", url: `/api/tasks/${id}/composition/opt-ins`, headers: auth(), payload: { assetId: PR_WRITER, digest } });
    expect(first.statusCode).toBe(201);
    const optIn = first.json() as { assetId: string; digest: string; actor: string; at: string };
    expect(optIn).toMatchObject({ assetId: PR_WRITER, digest, actor: "operator" });
    const again = await built!.app.inject({ method: "POST", url: `/api/tasks/${id}/composition/opt-ins`, headers: auth(), payload: { assetId: PR_WRITER, digest } });
    expect(again.statusCode).toBe(200);
    expect(again.json()).toEqual(optIn);
    const bad = await built!.app.inject({ method: "POST", url: `/api/tasks/${id}/composition/opt-ins`, headers: auth(), payload: { assetId: PR_WRITER, digest: "sha256:nope" } });
    expect(bad.statusCode).toBe(400);

    const { body } = await compose(id);
    expect(body.specDraft!.assets.skills).toEqual([
      { id: PR_WRITER, digest, allowlisted: false, opt_in: { digest, actor: "operator", at: optIn.at } },
      expect.objectContaining({ id: TS_REVIEW, allowlisted: true }),
    ]);
    const full = filled(id, body);
    expect(validateAgentSpec(full.spec)).toMatchObject({ ok: true });

    // An opt-in at another digest does not attach the asset.
    const stale = task("Add a typed helper to the parser module");
    await built!.app.inject({ method: "POST", url: `/api/tasks/${stale}/composition/opt-ins`, headers: auth(), payload: { assetId: PR_WRITER, digest: `sha256:${"0".repeat(64)}` } });
    const staleBody = (await compose(stale)).body;
    expect(stage(staleBody, "assets").filters.find((f) => f.filter === "opt_in_stale")).toMatchObject({ removed: [PR_WRITER] });
  });

  it("gives an equal compositionDigest for the same preview twice, and leaks no hostname, home path or token", async () => {
    await boot({ fragments: ["host-notes", "typescript-style"] });
    // Cockpit's exclusion reason is untrusted text: it names the machine and a home path.
    cockpit.fragments.set("host-notes", "notes");
    cockpit.excludeFragments.set("host-notes", `contains ${HOST} at ${join(home, "notes.md")}`);
    const id = task("Add a typed helper to the parser module");
    const one = await compose(id);
    const two = await compose(id);
    expect(one.body.outcome).toEqual({ status: "composed" });
    expect(two.body.compositionDigest).toBe(one.body.compositionDigest);
    expect(two.body.decision).toEqual(one.body.decision);
    expect(stage(one.body, "context").filters).toEqual([
      { filter: "excluded_by_renderer", removed: ["fragment:host-notes"], reason: "excluded by renderer (reason withheld: failed text guard)" },
    ]);
    expect(count("composition_attempts")).toBe(2);
    expect(JSON.stringify(one.body)).not.toContain(HOST);

    db.pragma("wal_checkpoint(PASSIVE)");
    const files = readdirSync(configDir).filter((f) => f.startsWith("agent-plane.db")).map((f) => join(configDir, f));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const bytes = readFileSync(file);
      expect({ file, host: bytes.includes(Buffer.from(HOST)), home: bytes.includes(Buffer.from(home)), token: bytes.includes(Buffer.from("FAKE-")) })
        .toEqual({ file, host: false, home: false, token: false });
    }
  });

  it("answers 404 composer_disabled on all three routes when composer.enabled is false; /route is unchanged", async () => {
    await boot({ enabled: false });
    const id = task("Add a typed helper to the parser module");
    for (const [method, url] of [["POST", `/api/tasks/${id}/compose`], ["GET", `/api/tasks/${id}/composition`], ["POST", `/api/tasks/${id}/composition/opt-ins`]] as const) {
      const res = await built!.app.inject({ method, url, headers: auth(), ...(method === "POST" ? { payload: {} } : {}) });
      expect({ url, status: res.statusCode, reason: res.json().reason }).toEqual({ url, status: 404, reason: "composer_disabled" });
    }
    const routed = await built!.app.inject({ method: "POST", url: `/api/tasks/${id}/route`, headers: auth(), payload: {} });
    expect(routed.statusCode).toBe(200);
    expect(routed.json()).toMatchObject({ chosen: "fake-claude", origin: "intake" });
    expect(cockpit.requests).toEqual([]);
    expect(count("composition_attempts")).toBe(0);
  });

  it("answers 404 for an unknown task and requires commands.write", async () => {
    await boot();
    expect((await compose("AG-nope")).status).toBe(404);
    const anonymous = await built!.app.inject({ method: "POST", url: "/api/tasks/AG-nope/compose", payload: {} });
    expect(anonymous.statusCode).toBe(401);
  });
});

describe("stage-2 port facts", () => {
  it("keeps the accepted approval modes in step with what each adapter enforces or refuses", async () => {
    const modes = ["auto-approve", "prompt-on-escalation", "read-only"] as const;
    const codexAccepts = modes.filter((mode) => { try { codexPermissions({ mode }); return true; } catch (e) { if (e instanceof NotSupportedError) return false; throw e; } });
    expect(HARNESS_APPROVAL_MODES.codex).toEqual(codexAccepts);
    const cursor = new CursorAdapter("cursor-a" as AssistantId, {} as never);
    const cursorRefuses: string[] = [];
    for (const mode of modes.filter((m) => m !== "auto-approve")) {
      await cursor.start({ prompt: "x", workdir: root, permissionPolicy: { mode } } as unknown as RunSpec).then(
        () => { throw new Error(`cursor accepted ${mode}`); },
        (e: unknown) => { if (e instanceof NotSupportedError) cursorRefuses.push(mode); else throw e; },
      );
    }
    expect(HARNESS_APPROVAL_MODES.cursor).toEqual(modes.filter((m) => !cursorRefuses.includes(m)));
    expect(HARNESS_APPROVAL_MODES["claude-code"]).toEqual([...modes]);
    expect(HARNESS_APPROVAL_MODES.bedrock).toEqual([]);
  });

  it("reads providerDetail.harness only for a fake manifest", () => {
    const manifest = (provider: string, harness?: unknown) => ({ provider, providerDetail: harness === undefined ? {} : { harness } }) as Pick<CapabilityManifest, "provider" | "providerDetail">;
    expect(harnessOf(manifest("fake", "codex"))).toBe("codex");
    expect(harnessOf(manifest("fake"))).toBe("claude-code");
    expect(harnessOf(manifest("fake", "nonsense"))).toBeUndefined();
    expect(harnessOf(manifest("anthropic", "codex"))).toBe("claude-code");
    expect(harnessOf(manifest("openrouter", "claude-code"))).toBe("codex");
    expect(harnessOf(manifest("cursor"))).toBe("cursor");
  });
});

describe("plan risk 6: the Composer never builds a bundle itself", () => {
  it("no module of apps/api/src/modules/composer imports or names assembleBundle", () => {
    const dir = join(__dirname, "../src/modules/composer");
    const files = readdirSync(dir).filter((f) => f.endsWith(".ts"));
    expect(files).toEqual(expect.arrayContaining(["ports.ts", "repo-signals.ts", "service.ts"]));
    for (const file of files) {
      const source = readFileSync(join(dir, file), "utf8");
      expect({ file, names: source.includes("assembleBundle") }).toEqual({ file, names: false });
      // Nor anything from the bundle contract module, which is where the reference renderer lives.
      expect({ file, contract: /from\s+["'][^"']*bundle-contract(\.js)?["']/.test(source) }).toEqual({ file, contract: false });
    }
  });
});
