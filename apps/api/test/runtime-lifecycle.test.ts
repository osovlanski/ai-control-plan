/**
 * Agent Runtime Registry PR 3 (docs/contracts/agent-runtime-v1.md): the catalogue projection,
 * lifecycle read model and operator disable overlay, through the real routes, router and database.
 */
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AssistantId } from "@agent-plane/core";
import { loadConfig } from "../src/config.js";
import { openDb, type Db } from "../src/db/index.js";
import { buildServer, type BuiltServer } from "../src/server.js";
import { credentialPath, readCredential, rotateCredential } from "../src/auth/credential-file.js";
import {
  AGENT_RUNTIME_CONTRACT_DIR, validateAssistantLifecycle, validateConformanceResult, validateOperatorStateChange, validateRuntimeCatalog,
} from "../src/agent-runtime-contract.js";
import { QuotaProjection } from "../src/modules/quota.js";
import { RUNTIME_CATALOG } from "../src/modules/runtime-catalog.js";
import { deriveLifecycle, REQUEST_DEPENDENT_CONSTRAINTS, runtimeCatalogProjection } from "../src/modules/runtime-lifecycle.js";

const A = "fake-a" as AssistantId;
const B = "fake-b" as AssistantId;
const FAKE_ENV_VALUE = "FAKE-openrouter-key-not-real";

let home: string | undefined;
let db: Db | undefined;
let built: BuiltServer | undefined;

afterEach(async () => {
  await built?.orchestrator.shutdown();
  await built?.app.close();
  db?.close();
  if (home) rmSync(home, { recursive: true, force: true });
  home = undefined; db = undefined; built = undefined;
  delete process.env.FAKE_RUNTIME_LIFECYCLE_KEY;
});

const TWO_FAKES = "assistants:\n  fake-a:\n    provider: fake\n  fake-b:\n    provider: fake\n";

/** A server over a fresh (or, with `keepHome`, the same) workspace. */
async function boot(yaml = TWO_FAKES, keepHome = false): Promise<BuiltServer> {
  if (!keepHome || !home) {
    home = mkdtempSync(join(tmpdir(), "agent-plane-runtime-lifecycle-"));
  }
  mkdirSync(join(home, "personal"), { recursive: true });
  writeFileSync(join(home, "personal", "config.yaml"), yaml);
  const config = loadConfig({ AGENT_PLANE_HOME: home });
  db = openDb(config.dbPath);
  built = buildServer({ config, db });
  built.registry.init();
  await built.registry.syncAll();
  return built;
}

/** Closes the server and database without removing the workspace, as a process exit would. */
async function stop(): Promise<void> {
  await built?.orchestrator.shutdown();
  await built?.app.close();
  db?.close();
  built = undefined; db = undefined;
}

function bearer(secret?: string) {
  return { authorization: `Bearer ${secret ?? readCredential(credentialPath(loadConfig({ AGENT_PLANE_HOME: home! }).dir)).secrets[0]!.secret}` };
}

const inject = (method: "GET" | "POST", url: string, headers: Record<string, string> = bearer(), payload?: unknown) =>
  built!.app.inject({ method, url, headers, ...(payload !== undefined ? { payload: payload as object } : {}) });

async function routeFor(goal = "do it"): Promise<{ chosen?: string; candidates: Array<{ assistantId: string; passedFilters: boolean; filterFailures: string[] }> }> {
  const created = await inject("POST", "/api/tasks", bearer(), { goal });
  expect(created.statusCode).toBe(201);
  const routed = await inject("POST", `/api/tasks/${(created.json() as { taskId: string }).taskId}/route`);
  expect(routed.statusCode).toBe(200);
  return routed.json();
}

const failuresOf = (r: Awaited<ReturnType<typeof routeFor>>, id: string) => r.candidates.find((c) => c.assistantId === id)!.filterFailures;

describe("agent-runtime v1 contract fixtures", () => {
  it("pass and fail the reference validators as named", () => {
    const validators = { catalog: validateRuntimeCatalog, lifecycle: validateAssistantLifecycle, "operator-state-change": validateOperatorStateChange, "conformance-result": validateConformanceResult };
    let seen = 0;
    for (const kind of ["valid", "invalid"] as const) {
      const dir = join(AGENT_RUNTIME_CONTRACT_DIR, "fixtures", kind);
      for (const file of readdirSync(dir)) {
        const prefix = (Object.keys(validators) as Array<keyof typeof validators>).find((p) => file.startsWith(`${p}-`));
        expect(prefix, file).toBeDefined();
        const result = validators[prefix!](JSON.parse(readFileSync(join(dir, file), "utf8")));
        expect(result.ok, `${kind}/${file}: ${result.ok ? "" : result.errors.join("; ")}`).toBe(kind === "valid");
        seen += 1;
      }
    }
    expect(seen).toBeGreaterThanOrEqual(20);
  });

  it("uses the registry contract's inline-credential guard, not a copy that can drift", () => {
    const pattern = (file: string) => (JSON.parse(readFileSync(file, "utf8")) as { $defs: { noInlineSecret: unknown } }).$defs.noInlineSecret;
    const registry = pattern(join(AGENT_RUNTIME_CONTRACT_DIR, "../../registry/v1/registry-snapshot.schema.json"));
    for (const name of ["catalog.schema.json", "assistant-lifecycle.schema.json", "conformance-result.schema.json"]) {
      expect(pattern(join(AGENT_RUNTIME_CONTRACT_DIR, name)), name).toEqual(registry);
    }
  });
});

describe("GET /api/runtimes/catalog", () => {
  it("serves the in-tree catalogue as data only, valid against the schema", async () => {
    await boot();
    const res = await inject("GET", "/api/runtimes/catalog");
    expect(res.statusCode).toBe(200);
    const body = res.json();
    const valid = validateRuntimeCatalog(body);
    expect(valid.ok, valid.ok ? "" : valid.errors.join("; ")).toBe(true);
    expect(body).toEqual(runtimeCatalogProjection());
    expect(body.runtimes.map((r: { provider: string }) => r.provider)).toEqual(RUNTIME_CATALOG.map((d) => d.provider));
    // No code, probe wiring, option types or session-input binding crosses the wire.
    const text = res.body;
    for (const field of ["create", "probe", "quotaProbe", "sessionInput", "options", "command", "credentialEnv"]) expect(text).not.toContain(`"${field}"`);
    for (const r of body.runtimes) expect(r.conformanceRequired).toBe(false);
  });
});

describe("GET /api/assistants stays additive", () => {
  it("keeps every existing field byte-identical and only adds a valid lifecycle", async () => {
    await boot();
    const res = await inject("GET", "/api/assistants");
    expect(res.statusCode).toBe(200);
    const body = res.json() as Array<Record<string, unknown>>;
    // The response exactly as it was built before 2.10.
    const before = built!.registry.list().map((a) => {
      const projection = new QuotaProjection(db!, () => new Date()).for(a.id, a.manifestParsed);
      return { id: a.id, provider: a.provider, enabled: a.enabled === 1, manifest: a.manifestParsed, manifestUpdatedAt: a.manifest_updated_at, quota: projection.quota, quotaObservations: projection.observations };
    });
    expect(JSON.stringify(body.map(({ lifecycle: _lifecycle, ...rest }) => rest))).toBe(JSON.stringify(before));
    body.forEach((a, i) => {
      // `lifecycle` is appended after the old fields (an absent `quota` stays absent, as before).
      expect(Object.keys(a)).toEqual([...Object.keys(JSON.parse(JSON.stringify(before[i])) as object), "lifecycle"]);
      const valid = validateAssistantLifecycle(a.lifecycle);
      expect(valid.ok, valid.ok ? "" : valid.errors.join("; ")).toBe(true);
      expect(a.lifecycle).toMatchObject({
        catalogued: true, configured: true, auth: { state: "ok" },
        conformance: { required: false, state: "not-run", descriptorVersion: 1 },
        enablement: { config: true, operator: "none", effective: true },
        readiness: { scope: "request-independent", ready: true, reasons: [] },
        requestDependent: [...REQUEST_DEPENDENT_CONSTRAINTS],
      });
    });
  });

  it("does not call readiness eligibility: a ready runtime is still filtered by a request's constraints", async () => {
    await boot();
    const lifecycle = (await inject("GET", `/api/assistants/${A}/lifecycle`)).json();
    expect(lifecycle.readiness.ready).toBe(true);
    expect(lifecycle).not.toHaveProperty("eligible");
    // The same ready assistant, routed for a task outside the repository allowlist, is filtered.
    const id = built!.tasks.create({ goal: "x", repoPath: "/not/allowlisted" }).taskId;
    const routed = (await inject("POST", `/api/tasks/${id}/route`)).json();
    expect(routed.chosen).toBeUndefined();
    expect(failuresOf(routed, A)).toContain("repository path not in workspace allowlist");
    expect(lifecycle.requestDependent).toContain("repository-allowlist");
  });
});

describe("operator disable overlay", () => {
  it("disable → excluded with its reason → enable → routes normally", async () => {
    await boot();
    expect((await routeFor()).chosen).toBe(A);

    const disabled = await inject("POST", `/api/assistants/${A}/disable`);
    expect(disabled.statusCode).toBe(200);
    const change = disabled.json();
    const valid = validateOperatorStateChange(change);
    expect(valid.ok, valid.ok ? "" : valid.errors.join("; ")).toBe(true);
    expect(change).toMatchObject({ assistantId: A, operatorState: "disabled", changed: true, lifecycle: { enablement: { config: true, operator: "disabled", effective: false }, readiness: { ready: false, reasons: ["disabled by operator"] } } });

    const routed = await routeFor();
    expect(routed.chosen).toBe(B);
    expect(failuresOf(routed, A)).toEqual(["disabled by operator"]);
    // Config `enabled` keeps its meaning on the old field.
    expect((await inject("GET", "/api/assistants")).json().find((a: { id: string }) => a.id === A).enabled).toBe(true);

    const enabled = await inject("POST", `/api/assistants/${A}/enable`);
    expect(enabled.json()).toMatchObject({ operatorState: "none", changed: true, lifecycle: { readiness: { ready: true, reasons: [] } } });
    expect((await routeFor()).chosen).toBe(A);

    const changes = (await inject("GET", "/api/assistants/changes")).json() as Array<{ assistant_id: string; field: string; old_value: string; new_value: string; source: string }>;
    expect(changes.filter((c) => c.field === "operator.state").map((c) => [c.assistant_id, c.old_value, c.new_value, c.source])).toEqual([
      [A, "disabled", "none", "manual"],
      [A, "none", "disabled", "manual"],
    ]);
  });

  it("is idempotent: a repeated request changes nothing and records nothing", async () => {
    await boot();
    const count = () => (db!.prepare("SELECT COUNT(*) AS n FROM capability_changes WHERE field = 'operator.state'").get() as { n: number }).n;
    expect((await inject("POST", `/api/assistants/${A}/disable`)).json().changed).toBe(true);
    const at = (db!.prepare("SELECT operator_state_at FROM assistants WHERE id = ?").get(A) as { operator_state_at: string }).operator_state_at;
    for (let i = 0; i < 3; i += 1) {
      const res = await inject("POST", `/api/assistants/${A}/disable`);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ operatorState: "disabled", changed: false });
    }
    expect(count()).toBe(1);
    expect((db!.prepare("SELECT operator_state_at FROM assistants WHERE id = ?").get(A) as { operator_state_at: string }).operator_state_at).toBe(at);
    expect((await inject("POST", `/api/assistants/${B}/enable`)).json()).toMatchObject({ operatorState: "none", changed: false });
    expect(count()).toBe(1);
  });

  it("enable never overrides a config disable, and both reasons are shown while both hold", async () => {
    await boot("assistants:\n  fake-a:\n    provider: fake\n    enabled: false\n  fake-b:\n    provider: fake\n");
    await inject("POST", `/api/assistants/${A}/disable`);
    let routed = await routeFor();
    expect(failuresOf(routed, A)).toEqual(["disabled in workspace config", "disabled by operator"]);

    const res = await inject("POST", `/api/assistants/${A}/enable`);
    expect(res.json()).toMatchObject({
      operatorState: "none", changed: true,
      lifecycle: { enablement: { config: false, operator: "none", effective: false }, readiness: { ready: false, reasons: ["disabled in workspace config"] } },
    });
    routed = await routeFor();
    expect(routed.chosen).toBe(B);
    expect(failuresOf(routed, A)).toEqual(["disabled in workspace config"]);
    expect(db!.prepare("SELECT enabled FROM assistants WHERE id = ?").get(A)).toEqual({ enabled: 0 });
  });

  it("survives a process restart and re-seeding from config, including a config change to enabled", async () => {
    await boot();
    await inject("POST", `/api/assistants/${A}/disable`);
    await stop();
    await boot(TWO_FAKES, true);
    expect((await inject("GET", `/api/assistants/${A}/lifecycle`)).json().enablement).toMatchObject({ operator: "disabled", effective: false });
    expect(failuresOf(await routeFor(), A)).toEqual(["disabled by operator"]);

    // Config goes false then true across restarts: the overlay is not config and is never reset by it.
    await stop();
    await boot("assistants:\n  fake-a:\n    provider: fake\n    enabled: false\n  fake-b:\n    provider: fake\n", true);
    await stop();
    await boot("assistants:\n  fake-a:\n    provider: fake\n    enabled: true\n  fake-b:\n    provider: fake\n", true);
    const routed = await routeFor();
    expect(routed.chosen).toBe(B);
    expect(failuresOf(routed, A)).toEqual(["disabled by operator"]);
  });

  it("does not touch a session already running: it finishes on the disabled assistant", async () => {
    await boot(`${TWO_FAKES}policy:\n  approvalMode: prompt-on-escalation\n`);
    const { orchestrator, tasks } = built!;
    const env = tasks.create({ goal: "needs sign-off [FAKE:APPROVAL]" });
    tasks.transition(env.taskId, "ROUTING");
    await orchestrator.startTask(env.taskId, A);
    const requestId = await waitForApproval(env.taskId);

    expect((await inject("POST", `/api/assistants/${A}/disable`)).json().changed).toBe(true);
    await orchestrator.respondApproval(env.taskId, requestId, true);
    expect(await orchestrator.waitForSettled(env.taskId)).toBe("COMPLETED");
    expect(db!.prepare("SELECT assistant_id, state FROM runs WHERE task_id = ?").all(env.taskId)).toEqual([{ assistant_id: A, state: "ENDED_OK" }]);
    // New routing decisions do see it.
    expect((await routeFor()).chosen).toBe(B);
  });

  it("also removes the assistant from quota planning, as route() does", async () => {
    await boot();
    const id = built!.tasks.create({ goal: "x" }).taskId;
    await inject("POST", `/api/assistants/${A}/disable`);
    await inject("POST", `/api/assistants/${B}/disable`);
    const plan = built!.orchestrator.quotaPlan(id);
    expect(plan.blockers).toEqual([]);
    expect((await routeFor()).chosen).toBeUndefined();
  });
});

describe("unknown assistants and authorization", () => {
  it("answers 404 for an unknown assistant and writes nothing", async () => {
    await boot();
    for (const [method, url] of [["POST", "/api/assistants/nope/disable"], ["POST", "/api/assistants/nope/enable"], ["GET", "/api/assistants/nope/lifecycle"]] as const) {
      const res = await inject(method, url);
      expect(res.statusCode, url).toBe(404);
      expect(res.json()).toEqual({ error: "Unknown assistant: nope" });
    }
    expect(db!.prepare("SELECT COUNT(*) AS n FROM capability_changes WHERE field = 'operator.state'").get()).toEqual({ n: 0 });
  });

  it("needs a credential for every route, and commands.write to change the overlay", async () => {
    await boot();
    const routes = [["GET", "/api/runtimes/catalog"], ["GET", `/api/assistants/${A}/lifecycle`], ["POST", `/api/assistants/${A}/disable`], ["POST", `/api/assistants/${A}/enable`]] as const;
    for (const [method, url] of routes) expect((await inject(method, url, {})).statusCode, url).toBe(401);

    const readOnly = rotateCredential(credentialPath(loadConfig({ AGENT_PLANE_HOME: home! }).dir), 3600, ["tasks.read"]);
    expect((await inject("GET", "/api/runtimes/catalog", bearer(readOnly.secret))).statusCode).toBe(200);
    expect((await inject("GET", `/api/assistants/${A}/lifecycle`, bearer(readOnly.secret))).statusCode).toBe(200);
    for (const action of ["disable", "enable"]) {
      expect((await inject("POST", `/api/assistants/${A}/${action}`, bearer(readOnly.secret))).statusCode, action).toBe(403);
    }
    expect(db!.prepare("SELECT operator_state FROM assistants WHERE id = ?").get(A)).toEqual({ operator_state: null });
  });
});

describe("conformance evidence", () => {
  const insert = (version: string, status: "pass" | "fail", descriptorVersion = 1) =>
    db!.prepare("INSERT INTO runtime_conformance (assistant_id, cli_version, descriptor_version, status, checks, checked_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(A, version, descriptorVersion, status, JSON.stringify([{ name: "approval-refusal", ok: status === "pass", raw: "SENTINEL-STDOUT-not-real" }]), "2026-11-18T09:30:00.000Z");
  const conformance = async () => (await inject("GET", `/api/assistants/${A}/lifecycle`)).json().conformance;

  it("is not-run when absent, stale for another CLI or descriptor version, and never fabricated", async () => {
    await boot();
    expect(await conformance()).toEqual({ required: false, state: "not-run", descriptorVersion: 1 });
    // Before any capability probe there is no observed CLI version, so any row is stale.
    insert("in-process", "pass");
    expect(await conformance()).toEqual({ required: false, state: "stale", descriptorVersion: 1 });
    await built!.registry.syncChanged(A); // the fake's probe reports version "in-process"
    expect(await conformance()).toEqual({ required: false, state: "pass", descriptorVersion: 1, cliVersion: "in-process", checkedAt: "2026-11-18T09:30:00.000Z" });
    db!.prepare("DELETE FROM runtime_conformance").run();
    insert("0.0.1-older", "pass");
    insert("in-process", "pass", 2);
    expect(await conformance()).toEqual({ required: false, state: "stale", descriptorVersion: 1 });
    expect(db!.prepare("SELECT COUNT(*) AS n FROM runtime_conformance").get()).toEqual({ n: 2 });
  });

  it("gates nothing for a runtime that does not require it: existing eligibility is unchanged", async () => {
    await boot();
    await built!.registry.syncChanged(A);
    insert("in-process", "fail");
    const body = (await inject("GET", `/api/assistants/${A}/lifecycle`)).json();
    expect(body.conformance.state).toBe("fail");
    expect(body.readiness).toEqual({ scope: "request-independent", ready: true, reasons: [] });
    expect((await routeFor()).chosen).toBe(A);
    // The stored check list never crosses the wire.
    expect((await inject("GET", "/api/assistants")).body).not.toContain("SENTINEL-STDOUT");
  });

  it("no descriptor requires conformance while PR 3 adds no conformance router gate", () => {
    // PR 4 adds the gate and the probe together; until then a `required: true` runtime would be
    // shown ready by readiness and routed by the router, so none may exist.
    expect(RUNTIME_CATALOG.filter((d) => d.conformanceRequired).map((d) => d.provider)).toEqual([]);
  });
});

describe("credential redaction", () => {
  it("no lifecycle or catalogue field carries an environment value or a credential-shaped version", async () => {
    process.env.FAKE_RUNTIME_LIFECYCLE_KEY = FAKE_ENV_VALUE;
    await boot(`${TWO_FAKES}  router:\n    provider: openrouter\n    options:\n      apiKeyEnv: FAKE_RUNTIME_LIFECYCLE_KEY\n`);
    await built!.registry.syncChanged("router");
    // A CLI that prints something credential-shaped as its version is not repeated.
    db!.prepare("UPDATE capability_probes SET details = ? WHERE assistant_id = ?")
      .run(JSON.stringify({ version: "cli 1.0 token=FAKE-cli-token-not-real", credentialEnv: "FAKE_RUNTIME_LIFECYCLE_KEY" }), "router");
    const lifecycle = (await inject("GET", "/api/assistants/router/lifecycle")).json();
    expect(lifecycle.installed).toMatchObject({ state: "present" });
    expect(lifecycle.installed).not.toHaveProperty("version");
    expect(validateAssistantLifecycle(lifecycle).ok).toBe(true);
    for (const url of ["/api/assistants", "/api/assistants/router/lifecycle", "/api/runtimes/catalog"]) {
      const text = (await inject("GET", url)).body;
      expect(text, url).not.toContain(FAKE_ENV_VALUE);
      expect(text, url).not.toContain("FAKE-cli-token-not-real");
    }
    const change = await inject("POST", "/api/assistants/router/disable");
    expect(change.body).not.toContain(FAKE_ENV_VALUE);
    // The env var's NAME is configuration, not a lifecycle field either.
    expect(JSON.stringify(lifecycle)).not.toContain("FAKE_RUNTIME_LIFECYCLE_KEY");
  });

  it("deriveLifecycle drops malformed evidence instead of publishing it", () => {
    const lifecycle = deriveLifecycle({
      row: { provider: "fake", enabled: 1, operator_state: "disabled", operator_state_at: "yesterday", manifestParsed: null },
      configured: true,
      descriptor: { descriptorVersion: 1, conformanceRequired: false },
      probe: { version: "x".repeat(200), observedAt: "not a time" },
      conformance: [],
    });
    expect(lifecycle.installed).toEqual({ state: "present" });
    expect(lifecycle.enablement).toEqual({ config: true, operator: "disabled", effective: false });
    expect(lifecycle.readiness.reasons).toEqual(["disabled by operator", "no capability manifest (sync has not run)"]);
    expect(validateAssistantLifecycle(lifecycle).ok).toBe(true);
  });
});

async function waitForApproval(taskId: string, timeoutMs = 5_000): Promise<string> {
  const start = Date.now();
  for (;;) {
    const row = db!
      .prepare(`SELECT e.payload FROM events e JOIN runs r ON r.id = e.run_id WHERE r.task_id = ? AND e.type = 'approval.requested' ORDER BY e.seq DESC LIMIT 1`)
      .get(taskId) as { payload: string | null } | undefined;
    const requestId = row?.payload ? (JSON.parse(row.payload) as { requestId?: string }).requestId : undefined;
    if (requestId) return requestId;
    if (Date.now() - start > timeoutMs) throw new Error(`no approval surfaced for ${taskId}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}
