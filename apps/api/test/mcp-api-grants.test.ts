/**
 * mcp-api-grants (API 2.14, docs/adr/mcp-connector.md "Acceptance cases", C1 1–7): narrow
 * `tasks.create` / `tasks.start` grants, a named MCP credential that main-credential rotation
 * leaves alone, `mcp.repos` aliases mapped to exact paths, idempotent create/start and the Web link.
 * Secrets in this file are minted by the code under test or are FAKE-*-not-real.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Ajv2020 } from "ajv/dist/2020.js";
import { capabilityGranted } from "@agent-plane/core";
import { CredentialStore, credentialPath, namedCredentialPath, readCredential, rotateCredential, rotateNamedCredential } from "../src/auth/credential-file.js";
import { loadConfig, type ResolvedConfig } from "../src/config.js";
import { openDb, type Db } from "../src/db/index.js";
import { buildServer, type BuiltServer } from "../src/server.js";

const ORIGIN = "https://aos.example-tailnet.ts.net";
const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid" };

let root: string;
let plane: string;
let repo: string;
let other: string;
let db: Db | undefined;
let built: BuiltServer | undefined;
let config: ResolvedConfig;

function gitRepo(path: string) {
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, "README.md"), "x\n");
  for (const args of [["init", "-q"], ["add", "."], ["commit", "-q", "-m", "init"]]) execFileSync("git", ["-C", path, ...args], { env: GIT_ENV });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "mcp-grants-"));
  plane = join(root, "plane");
  repo = join(root, "repo");
  other = join(root, "other");
  mkdirSync(plane);
  gitRepo(repo);
  gitRepo(other);
});

afterEach(async () => {
  await built?.app.close();
  built = undefined;
  db?.close();
  db = undefined;
  rmSync(root, { recursive: true, force: true });
});

async function boot(opts: { webOrigin?: string | null } = {}): Promise<BuiltServer> {
  config = loadConfig({ AGENT_PLANE_HOME: plane });
  config.assistants = { "fake-claude": { provider: "fake" } };
  config.repoAllowlist = [repo, other];
  config.policy.approvalMode = "auto-approve";
  config.execution.harnessModes.single = true;
  config.mcp = { repos: { "dogfood": repo }, ...(opts.webOrigin === null ? {} : { webOrigin: opts.webOrigin ?? ORIGIN }) };
  db = openDb(config.dbPath);
  built = buildServer({ config, db });
  built.registry.init();
  await built.registry.syncAll();
  await built.app.ready();
  return built;
}

const main = () => ({ authorization: `Bearer ${readCredential(credentialPath(config.dir)).secrets.at(-1)!.secret}` });
const mcpSecret = () => rotateNamedCredential(config.dir, "mcp", 0);
const bearer = (secret: string) => ({ authorization: `Bearer ${secret}` });

async function call(method: "GET" | "POST" | "PATCH" | "DELETE", url: string, headers: Record<string, string>, payload?: unknown) {
  const res = await built!.app.inject({ method, url, headers, ...(payload !== undefined ? { payload: payload as object } : {}) });
  return { status: res.statusCode, body: res.json() as Record<string, unknown> };
}
const count = (table: string) => (db!.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
const KEY = "mcp-create-0001-FAKE";

describe("capabilities (2.14)", () => {
  it("commands.write implies tasks.create and tasks.start, and nothing else", () => {
    expect(capabilityGranted(["commands.write"], "tasks.create")).toBe(true);
    expect(capabilityGranted(["commands.write"], "tasks.start")).toBe(true);
    expect(capabilityGranted(["commands.write"], "tasks.read")).toBe(false);
    expect(capabilityGranted(["tasks.create"], "commands.write")).toBe(false);
    expect(capabilityGranted(["tasks.create"], "tasks.start")).toBe(false);
  });
});

describe("named MCP credential", () => {
  it("is minted narrow in its own file; rotating the main credential never expires it, and the other way round", async () => {
    await boot();
    const mcp = mcpSecret();
    expect(mcp.capabilities).toEqual(["tasks.read", "tasks.create", "tasks.start"]);
    expect(mcp.kid).toMatch(/^k_mcp_[0-9a-f]{8}$/);
    expect(readCredential(credentialPath(config.dir)).secrets.some((s) => s.secret === mcp.secret)).toBe(false);
    expect(readCredential(namedCredentialPath(config.dir, "mcp")).secrets).toHaveLength(1);

    // Acceptance 6: rotating the main credential (no grace) expires only main-file secrets.
    const mainBefore = readCredential(credentialPath(config.dir)).secrets.map((x) => x.kid);
    rotateCredential(credentialPath(config.dir), 0);
    expect(readCredential(namedCredentialPath(config.dir, "mcp")).secrets).toEqual([{ ...mcp }]);
    expect(readCredential(credentialPath(config.dir)).secrets.filter((x) => mainBefore.includes(x.kid)).every((x) => x.notAfter !== null)).toBe(true);
    expect((await call("GET", "/api/tasks", bearer(mcp.secret))).status).toBe(200);
    expect((await call("GET", "/api/tasks", main())).status).toBe(200);

    // Rotating the MCP credential expires only the MCP secret, and keeps its narrow set.
    const mainAfter = readCredential(credentialPath(config.dir));
    const next = rotateNamedCredential(config.dir, "mcp", 0);
    expect(next.capabilities).toEqual(["tasks.read", "tasks.create", "tasks.start"]);
    expect(readCredential(namedCredentialPath(config.dir, "mcp")).secrets.find((x) => x.kid === mcp.kid)!.notAfter).not.toBeNull();
    expect(readCredential(credentialPath(config.dir))).toEqual(mainAfter);
    expect((await call("GET", "/api/tasks", bearer(next.secret))).status).toBe(200);
    expect((await call("GET", "/api/tasks", main())).status).toBe(200);
  });

  it("refuses autopilot.operate and an invalid name", async () => {
    await boot();
    expect(() => rotateNamedCredential(config.dir, "mcp", 0, ["tasks.read", "autopilot.operate"])).toThrow(/may not be granted/);
    expect(() => rotateNamedCredential(config.dir, "../main", 0)).toThrow(/Invalid credential name/);
  });
});

describe("POST /api/tasks with an idempotency key (2.14)", () => {
  it("two identical creates give one task; the second is the first with replayed: true", async () => {
    await boot();
    const secret = mcpSecret().secret;
    const body = { goal: "Add a typed helper", repo: "dogfood", idempotencyKey: KEY, propose: true };
    const first = await call("POST", "/api/tasks", bearer(secret), body);
    expect(first.status).toBe(201);
    const taskId = first.body.taskId as string;
    expect(first.body).toMatchObject({ repo: "dogfood", replayed: false, webLink: `${ORIGIN}/#/missions/${taskId}`, status: { state: "CREATED" } });
    expect(first.body.proposal).toMatchObject({ eligible: true, assistantId: "fake-claude", compositionDigest: null });
    // The plane's proposal and Web link are what the mcp-tools v1 create_task output carries verbatim.
    const output = JSON.parse(readFileSync(join(import.meta.dirname, "../../../contracts/mcp-tools/v1/create_task.output.schema.json"), "utf8")) as { properties: Record<string, object> };
    const ajv = new Ajv2020({ strict: true, allErrors: true });
    expect(ajv.validate(output.properties.proposal!, first.body.proposal), JSON.stringify(ajv.errors)).toBe(true);
    expect(ajv.validate(output.properties.webLink!, first.body.webLink)).toBe(true);
    const second = await call("POST", "/api/tasks", bearer(secret), body);
    expect(second.status).toBe(201);
    expect(second.body).toEqual({ ...first.body, replayed: true });
    expect(count("tasks")).toBe(1);
  });

  it("same key, different input is 409 idempotency_conflict and creates nothing", async () => {
    await boot();
    const secret = mcpSecret().secret;
    expect((await call("POST", "/api/tasks", bearer(secret), { goal: "one", repo: "dogfood", idempotencyKey: KEY })).status).toBe(201);
    const again = await call("POST", "/api/tasks", bearer(secret), { goal: "two", repo: "dogfood", idempotencyKey: KEY });
    expect(again).toMatchObject({ status: 409, body: { reason: "idempotency_conflict" } });
    expect(count("tasks")).toBe(1);
  });

  it("two concurrent creates with one key make one task", async () => {
    await boot();
    const secret = mcpSecret().secret;
    const body = { goal: "race", repo: "dogfood", idempotencyKey: KEY, propose: true };
    const results = await Promise.all([call("POST", "/api/tasks", bearer(secret), body), call("POST", "/api/tasks", bearer(secret), body)]);
    expect(count("tasks")).toBe(1);
    for (const r of results) expect(r.status === 201 || (r.status === 409 && r.body.reason === "idempotency_in_progress")).toBe(true);
  });

  it("keys are scoped to the credential", async () => {
    await boot();
    const secret = mcpSecret().secret;
    await call("POST", "/api/tasks", bearer(secret), { goal: "one", repo: "dogfood", idempotencyKey: KEY });
    const viaMain = await call("POST", "/api/tasks", main(), { goal: "one", repo: "dogfood", idempotencyKey: KEY });
    expect(viaMain.status).toBe(201);
    expect(viaMain.body.replayed).toBe(false);
    expect(count("tasks")).toBe(2);
  });

  it("the narrow credential must use an alias and a key, and may send no operator knob", async () => {
    await boot();
    const secret = mcpSecret().secret;
    expect(await call("POST", "/api/tasks", bearer(secret), { goal: "x", repoPath: repo, idempotencyKey: KEY })).toMatchObject({ status: 403, body: { reason: "narrow_credential" } });
    expect(await call("POST", "/api/tasks", bearer(secret), { goal: "x", repo: "dogfood", idempotencyKey: KEY, runAs: "agent" })).toMatchObject({ status: 403, body: { reason: "narrow_credential" } });
    expect(await call("POST", "/api/tasks", bearer(secret), { goal: "x", repo: "dogfood" })).toMatchObject({ status: 400, body: { reason: "invalid_input" } });
    expect(await call("POST", "/api/tasks", bearer(secret), { goal: "x", idempotencyKey: KEY })).toMatchObject({ status: 400, body: { reason: "invalid_input" } });
    expect(await call("POST", "/api/tasks", bearer(secret), { goal: "x", repo: "dogfood", idempotencyKey: "short" })).toMatchObject({ status: 400, body: { reason: "invalid_input" } });
    // T4: unknown alias, a prefix sibling of an alias path, an inherited key.
    for (const alias of ["nope", "dogfood-evil", "__proto__", "constructor"]) {
      expect(await call("POST", "/api/tasks", bearer(secret), { goal: "x", repo: alias, idempotencyKey: KEY })).toMatchObject({ status: 403, body: { reason: "repo_not_allowed" } });
    }
    expect(count("tasks")).toBe(0);
  });

  it("commands.write keeps today's create (repoPath, no key) and gets no replayed field", async () => {
    await boot();
    const res = await call("POST", "/api/tasks", main(), { goal: "legacy", repoPath: other });
    expect(res.status).toBe(201);
    expect(res.body.replayed).toBeUndefined();
    expect(res.body.repo).toBeUndefined();
    expect(res.body.proposal).toBeUndefined();
    expect(res.body.webLink).toBe(`${ORIGIN}/#/missions/${res.body.taskId as string}`);
  });

  it("answers no webLink when no Web origin is configured (acceptance 7)", async () => {
    await boot({ webOrigin: null });
    const res = await call("POST", "/api/tasks", bearer(mcpSecret().secret), { goal: "x", repo: "dogfood", idempotencyKey: KEY });
    expect(res.status).toBe(201);
    expect(res.body).not.toHaveProperty("webLink");
  });
});

describe("POST /api/tasks/:id/start with an idempotency key (2.14)", () => {
  async function created(secret: string) {
    const res = await call("POST", "/api/tasks", bearer(secret), { goal: "Add a typed helper", repo: "dogfood", idempotencyKey: KEY, propose: true });
    return { taskId: res.body.taskId as string, proposal: res.body.proposal as { assistantId: string; compositionDigest: string | null } };
  }

  it("two starts with one key give one run; a new key on the started task is invalid_state (acceptance 3)", async () => {
    await boot();
    const secret = mcpSecret().secret;
    const { taskId, proposal } = await created(secret);
    const body = { idempotencyKey: "mcp-start-0001-FAKE", confirm: { assistantId: proposal.assistantId, compositionDigest: proposal.compositionDigest } };
    const first = await call("POST", `/api/tasks/${taskId}/start`, bearer(secret), body);
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ taskId, assistantId: "fake-claude", replayed: false, webLink: `${ORIGIN}/#/missions/${taskId}` });
    expect(typeof first.body.runId).toBe("string");
    expect(first.body.startedAt).toMatch(/Z$/);
    const second = await call("POST", `/api/tasks/${taskId}/start`, bearer(secret), body);
    expect(second.status).toBe(200);
    expect(second.body).toEqual({ ...first.body, replayed: true });
    expect(await built!.orchestrator.waitForSettled(taskId)).toBe("COMPLETED");
    const third = await call("POST", `/api/tasks/${taskId}/start`, bearer(secret), { idempotencyKey: "mcp-start-0002-FAKE" });
    expect(third).toMatchObject({ status: 409, body: { reason: "invalid_state", currentState: "COMPLETED" } });
    expect((db!.prepare("SELECT COUNT(*) AS n FROM runs WHERE task_id = ?").get(taskId) as { n: number }).n).toBe(1);
    // The replay after settlement is still the first answer.
    expect((await call("POST", `/api/tasks/${taskId}/start`, bearer(secret), body)).body).toEqual({ ...first.body, replayed: true });
    // Same key, different confirm: conflict.
    expect(await call("POST", `/api/tasks/${taskId}/start`, bearer(secret), { idempotencyKey: body.idempotencyKey, confirm: { assistantId: "other" } })).toMatchObject({ status: 409, body: { reason: "idempotency_conflict" } });
  });

  it("refuses a start whose confirmed assistant no longer routes: no run, a new proposal (acceptance 4)", async () => {
    await boot();
    const secret = mcpSecret().secret;
    const { taskId } = await created(secret);
    const res = await call("POST", `/api/tasks/${taskId}/start`, bearer(secret), { idempotencyKey: "mcp-start-0003-FAKE", confirm: { assistantId: "fake-codex" } });
    expect(res).toMatchObject({ status: 409, body: { reason: "route_changed", proposal: { assistantId: "fake-claude" } } });
    expect(count("runs")).toBe(0);
    expect((await call("GET", `/api/tasks/${taskId}`, main())).body.state).toBe("CREATED");
    // A digest the composer-off plane cannot have is also a changed route.
    const digest = await call("POST", `/api/tasks/${taskId}/start`, bearer(secret), { idempotencyKey: "mcp-start-0004-FAKE", confirm: { compositionDigest: `sha256:${"a".repeat(64)}` } });
    expect(digest).toMatchObject({ status: 409, body: { reason: "route_changed" } });
    // A refusal records nothing, so its key is free: the same key with a matching confirm starts once.
    const ok = await call("POST", `/api/tasks/${taskId}/start`, bearer(secret), { idempotencyKey: "mcp-start-0003-FAKE", confirm: { assistantId: "fake-claude" } });
    expect(ok.status).toBe(200);
    await built!.orchestrator.waitForSettled(taskId);
  });

  it("the narrow credential starts only tasks in an exposed repository, with a key and no overrides", async () => {
    await boot();
    const secret = mcpSecret().secret;
    const outside = (await call("POST", "/api/tasks", main(), { goal: "x", repoPath: other })).body.taskId as string;
    expect(await call("POST", `/api/tasks/${outside}/start`, bearer(secret), { idempotencyKey: "mcp-start-0005-FAKE" })).toMatchObject({ status: 403, body: { reason: "repo_not_allowed" } });
    const { taskId } = await created(secret);
    expect(await call("POST", `/api/tasks/${taskId}/start`, bearer(secret), {})).toMatchObject({ status: 400, body: { reason: "invalid_input" } });
    expect(await call("POST", `/api/tasks/${taskId}/start`, bearer(secret), { idempotencyKey: "mcp-start-0006-FAKE", assistantId: "fake-claude" })).toMatchObject({ status: 403, body: { reason: "narrow_credential" } });
    expect(count("runs")).toBe(0);
  });

  it("commands.write keeps today's start (no key, no confirm)", async () => {
    await boot();
    const taskId = (await call("POST", "/api/tasks", main(), { goal: "legacy", repoPath: repo })).body.taskId as string;
    const res = await call("POST", `/api/tasks/${taskId}/start`, main(), {});
    expect(res.status).toBe(200);
    expect(res.body.replayed).toBeUndefined();
    await built!.orchestrator.waitForSettled(taskId);
  });
});

describe("the narrow credential reaches nothing but read, create and start (acceptance 5)", () => {
  it("gets 403 on approve, input, cancel, route, compose, schedules, assistant and Autopilot writes", async () => {
    await boot();
    const secret = mcpSecret().secret;
    const taskId = (await call("POST", "/api/tasks", main(), { goal: "x", repoPath: repo })).body.taskId as string;
    const refused: Array<[("POST" | "PATCH" | "DELETE"), string, unknown]> = [
      ["POST", `/api/tasks/${taskId}/input`, { kind: "approval", requestId: "r", approved: true }],
      ["POST", `/api/tasks/${taskId}/cancel`, {}],
      ["POST", `/api/tasks/${taskId}/route`, {}],
      ["POST", `/api/tasks/${taskId}/compose`, {}],
      ["POST", `/api/tasks/${taskId}/restart`, {}],
      ["POST", `/api/tasks/${taskId}/wait`, {}],
      ["POST", `/api/tasks/${taskId}/links`, {}],
      ["POST", "/api/schedules", {}],
      ["PATCH", "/api/schedules/x", {}],
      ["DELETE", "/api/schedules/x", undefined],
      ["POST", "/api/assistants/fake-claude/disable", {}],
      ["POST", "/api/models/refresh", {}],
      ["POST", "/api/autopilot/start", {}],
      ["POST", "/api/autopilot/stop", { mode: "now" }],
      ["POST", "/api/autopilot/dispatch", {}],
      ["POST", "/api/autopilot/windows", {}],
      ["POST", "/api/usage/records", {}],
    ];
    for (const [method, url, payload] of refused) {
      const res = await call(method, url, bearer(secret), payload);
      expect([method, url, res.status]).toEqual([method, url, 403]);
    }
    expect((await call("GET", `/api/tasks/${taskId}`, bearer(secret))).status).toBe(200);
  });

  it("cannot mint a browser session from bootstrap: only main-file kids resolve there", async () => {
    await boot();
    const mcp = mcpSecret();
    const store = new CredentialStore(credentialPath(config.dir), () => new Date(), config.dir);
    expect(store.byKid(mcp.kid)?.secret).toBe(mcp.secret);
    expect(store.mainByKid(mcp.kid)).toBeUndefined();
    expect(store.mainByKid(readCredential(credentialPath(config.dir)).secrets[0]!.kid)).toBeDefined();
  });
});

describe("GET /api/workspace advertises the aliases and the Web origin", () => {
  it("lists alias names, never alias paths", async () => {
    await boot();
    const res = await call("GET", "/api/workspace", bearer(mcpSecret().secret));
    expect(res.body.mcp).toEqual({ repos: ["dogfood"], webOrigin: ORIGIN });
  });
});

describe("mcp config", () => {
  const write = (yaml: string) => { mkdirSync(join(root, "cfg", "personal"), { recursive: true, mode: 0o700 }); writeFileSync(join(root, "cfg", "personal", "config.yaml"), yaml); };
  const load = () => loadConfig({ AGENT_PLANE_HOME: join(root, "cfg") });
  it("accepts an alias whose path is exactly an allowlist entry", () => {
    write(`repoAllowlist: [${repo}]\nmcp:\n  webOrigin: ${ORIGIN}/\n  repos:\n    dogfood: ${repo}\n`);
    expect(load().mcp).toEqual({ repos: { dogfood: repo }, webOrigin: ORIGIN });
  });
  it("refuses a path that only matches the allowlist by prefix", () => {
    write(`repoAllowlist: [${root}]\nmcp:\n  repos:\n    dogfood: ${repo}\n`);
    expect(load).toThrow(/exactly an entry of repoAllowlist/);
  });
  it("refuses a Web origin with a path, http, or credentials, and a bad alias", () => {
    for (const origin of [`${ORIGIN}/app`, "http://aos.example", "https://u:FAKE-pass-not-real@aos.example"]) {
      write(`mcp:\n  webOrigin: "${origin}"\n`);
      expect(load).toThrow(/mcp.webOrigin/);
    }
    write(`repoAllowlist: [${repo}]\nmcp:\n  repos:\n    Dog/Food: ${repo}\n`);
    expect(load).toThrow(/alias/);
  });
  it("refuses runAs agent without an agent user, and defaults to no aliases", () => {
    write(`mcp:\n  runAs: agent\n`);
    expect(load).toThrow(/execution.agentUser/);
    write(`workspace: default\n`);
    expect(load().mcp).toEqual({ repos: {} });
  });
});
