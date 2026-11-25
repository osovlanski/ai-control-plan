/**
 * Agent Runtime Registry PR 4: `POST /api/assistants/:id/test`, version-bound conformance evidence,
 * the conformance gate for runtimes that require it, and Cursor's honest auth state. Through the
 * real routes, router and database. Provider CLIs are stub binaries on PATH that log their argv;
 * nothing launches a real provider or reads a real credential. Every secret here is FAKE.
 */
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { openDb, type Db } from "../src/db/index.js";
import { buildServer, type BuiltServer } from "../src/server.js";
import { credentialPath, readCredential, rotateCredential } from "../src/auth/credential-file.js";
import { validateConformanceResult } from "../src/agent-runtime-contract.js";
import { RUNTIME_CATALOG } from "../src/modules/runtime-catalog.js";
import { deriveLifecycle } from "../src/modules/runtime-lifecycle.js";
import type { ConformanceResult, RuntimeConformanceOptions } from "../src/modules/runtime-conformance.js";

const SECRET = "FAKE-conformance-token-not-real";
let home: string | undefined;
let bin: string | undefined;
let db: Db | undefined;
let built: BuiltServer | undefined;
const savedPath = process.env.PATH;

afterEach(async () => {
  await stop();
  if (home) rmSync(home, { recursive: true, force: true });
  if (bin) rmSync(bin, { recursive: true, force: true });
  home = undefined; bin = undefined;
  process.env.PATH = savedPath;
  delete process.env.FAKE_CONFORMANCE_TOKEN;
  vi.restoreAllMocks();
});

/** A stub CLI on a private PATH directory: logs its argv to `<name>.argv`, then runs `body`. */
function cli(name: string, body: string): string {
  bin ??= mkdtempSync(join(tmpdir(), "conformance-bin-"));
  const path = join(bin, name);
  writeFileSync(path, `#!/bin/sh\necho "$@" >> ${join(bin, `${name}.argv`)}\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}
const argv = (name: string) => { try { return readFileSync(join(bin!, `${name}.argv`), "utf8").trim().split("\n"); } catch { return []; } };
/** PATH without any real provider CLI: only the stub directory and the system basics. */
const isolatePath = () => { bin ??= mkdtempSync(join(tmpdir(), "conformance-bin-")); process.env.PATH = `${bin}:/usr/bin:/bin`; };

async function boot(yaml: string, options: RuntimeConformanceOptions = {}, keepHome = false): Promise<BuiltServer> {
  if (!keepHome || !home) home = mkdtempSync(join(tmpdir(), "agent-plane-conformance-"));
  mkdirSync(join(home, "personal"), { recursive: true });
  writeFileSync(join(home, "personal", "config.yaml"), yaml);
  const config = loadConfig({ AGENT_PLANE_HOME: home });
  db = openDb(config.dbPath);
  built = buildServer({ config, db, conformance: options });
  built.registry.init();
  await built.registry.syncAll();
  // The capability probe records the observed CLI version, as the boot path does.
  for (const id of Object.keys(config.assistants)) await built.registry.syncChanged(id).catch(() => undefined);
  return built;
}

async function stop(): Promise<void> {
  await built?.orchestrator.shutdown();
  await built?.app.close();
  db?.close();
  built = undefined; db = undefined;
}

const bearer = (secret?: string) => ({ authorization: `Bearer ${secret ?? readCredential(credentialPath(loadConfig({ AGENT_PLANE_HOME: home! }).dir)).secrets[0]!.secret}` });
const inject = (method: "GET" | "POST", url: string, headers: Record<string, string> = bearer(), payload?: unknown) =>
  built!.app.inject({ method, url, headers, ...(payload !== undefined ? { payload: payload as object } : {}) });

async function test(id: string): Promise<ConformanceResult> {
  const res = await inject("POST", `/api/assistants/${id}/test`);
  expect(res.statusCode, res.body).toBe(200);
  const body = res.json() as ConformanceResult;
  const valid = validateConformanceResult(body);
  expect(valid.ok, valid.ok ? "" : valid.errors.join("; ")).toBe(true);
  return body;
}
const statuses = (r: ConformanceResult) => Object.fromEntries(r.checks.map((c) => [c.name, `${c.status}/${c.reason}`]));
const rows = () => db!.prepare("SELECT assistant_id, cli_version, descriptor_version, status, checks FROM runtime_conformance ORDER BY assistant_id, cli_version").all() as Array<{ assistant_id: string; cli_version: string; descriptor_version: number; status: string; checks: string }>;

async function routeFor(override?: string): Promise<{ chosen?: string; candidates: Array<{ assistantId: string; passedFilters: boolean; filterFailures: string[] }> }> {
  const created = await inject("POST", "/api/tasks", bearer(), { goal: "do it", ...(override ? { overrides: { assistantId: override } } : {}) });
  expect(created.statusCode, created.body).toBe(201);
  const routed = await inject("POST", `/api/tasks/${(created.json() as { taskId: string }).taskId}/route`);
  expect(routed.statusCode).toBe(200);
  return routed.json();
}
const failures = (r: Awaited<ReturnType<typeof routeFor>>, id: string) => r.candidates.find((c) => c.assistantId === id)!.filterFailures;

const CLAUDE = "assistants:\n  personal-claude:\n    provider: anthropic\n";
const FAKES = "assistants:\n  fake-a:\n    provider: fake\n  fake-req:\n    provider: fake\n    options:\n      conformanceRequired: true\n";

describe("POST /api/assistants/:id/test", () => {
  it("Claude: passes on --version alone, records the observed version, never runs anything else", async () => {
    isolatePath();
    cli("claude", 'echo "2.1.0 (Claude Code)"');
    await boot(CLAUDE);
    const adapter = vi.spyOn(built!.registry, "adapter");
    const result = await test("personal-claude");
    expect(statuses(result)).toEqual({
      executable: "pass/version_reported",
      "approval-refusal": "unsupported/all_modes_enforced",
      "manifest-claims": "pass/claims_backed",
      "host-claims": "pass/no_host_claim",
      "manifest-redaction": "pass/no_secret_in_manifest",
      "self-description": "not-run/quota_free_unverified",
    });
    expect(result).toMatchObject({ status: "pass", recorded: true, cliVersion: "2.1.0 (Claude Code)", descriptorVersion: 1, reasons: [] });
    // No billable call: the stub only ever saw --version (probe + test), and the registered adapter was never used.
    expect(new Set(argv("claude"))).toEqual(new Set(["--version"]));
    expect(adapter).not.toHaveBeenCalled();
    expect(rows().map(({ checks: _c, ...r }) => r)).toEqual([{ assistant_id: "personal-claude", cli_version: "2.1.0 (Claude Code)", descriptor_version: 1, status: "pass" }]);
    expect(result.lifecycle.conformance).toMatchObject({ required: false, state: "pass", cliVersion: "2.1.0 (Claude Code)" });
  });

  it("a missing executable is unavailable: fail, recorded against `unavailable`, and an optional runtime's routing is unchanged", async () => {
    isolatePath();
    await boot(`${CLAUDE}  fake-a:\n    provider: fake\n`);
    const before = await routeFor();
    const result = await test("personal-claude");
    expect(result.checks[0]).toEqual({ name: "executable", status: "unavailable", level: "host", reason: "executable_missing" });
    expect(result).toMatchObject({ status: "fail", reasons: ["executable_missing"], recorded: true, cliVersion: "unavailable" });
    expect(result.lifecycle.conformance.state).toBe("fail");
    const after = await routeFor();
    // conformanceRequired is false for anthropic (G.3): the failed row adds no filter.
    expect(failures(after, "personal-claude")).toEqual(failures(before, "personal-claude"));
    expect(failures(after, "personal-claude").some((f) => f.startsWith("conformance"))).toBe(false);
  });

  it("a hung --version is bounded and classified as timeout", async () => {
    isolatePath();
    cli("claude", 'case "$1" in --version) sleep 5 ;; esac');
    await boot(CLAUDE, { versionTimeoutMs: 300 });
    const t0 = Date.now();
    const result = await test("personal-claude");
    expect(Date.now() - t0).toBeLessThan(3_000);
    expect(result.checks[0]).toMatchObject({ name: "executable", status: "fail", reason: "timeout" });
    expect(result.status).toBe("fail");
  });

  it("a CLI version change makes earlier evidence stale", async () => {
    isolatePath();
    const claude = cli("claude", 'echo "2.1.0"');
    await boot(CLAUDE);
    expect((await test("personal-claude")).lifecycle.conformance.state).toBe("pass");
    writeFileSync(claude, `#!/bin/sh\necho "$@" >> ${join(bin!, "claude.argv")}\necho "2.2.0"\n`);
    await built!.registry.syncChanged("personal-claude");
    const lifecycle = (await inject("GET", "/api/assistants/personal-claude/lifecycle")).json();
    expect(lifecycle.conformance).toEqual({ required: false, state: "stale", descriptorVersion: 1 });
    // Re-testing records the new version beside the old one.
    expect((await test("personal-claude")).lifecycle.conformance).toMatchObject({ state: "pass", cliVersion: "2.2.0" });
    expect(rows().map((r) => r.cli_version)).toEqual(["2.1.0", "2.2.0"]);
  });

  it("an unsafe version string is never repeated or recorded; no secret reaches the response or the table", async () => {
    isolatePath();
    process.env.FAKE_CONFORMANCE_TOKEN = SECRET;
    cli("claude", `echo "2.1.0 token=${SECRET}"`);
    await boot(CLAUDE);
    const res = await inject("POST", "/api/assistants/personal-claude/test");
    const result = res.json() as ConformanceResult;
    expect(result.checks[0]).toMatchObject({ name: "executable", status: "fail", reason: "unsafe_version_output" });
    expect(result).toMatchObject({ status: "fail", recorded: false });
    expect(result.cliVersion).toBeUndefined();
    expect(res.body).not.toContain(SECRET);
    expect(rows()).toEqual([]);
    expect(JSON.stringify(db!.prepare("SELECT * FROM runtime_conformance").all())).not.toContain(SECRET);
  });

  it("stores only classified fields: names, statuses, levels and fixed reasons", async () => {
    isolatePath();
    cli("claude", 'echo "2.1.0"; echo "stderr noise SENTINEL-not-real" >&2');
    await boot(CLAUDE);
    await test("personal-claude");
    const stored = JSON.parse(rows()[0]!.checks) as Array<Record<string, unknown>>;
    for (const c of stored) expect(Object.keys(c).sort()).toEqual(["level", "name", "reason", "status"]);
    expect(rows()[0]!.checks).not.toContain("SENTINEL");
  });

  it("Codex and Cursor: unlisted approval modes are refused before launch; nothing but --version runs", async () => {
    isolatePath();
    cli("codex", 'echo "codex-cli 0.154.0"');
    const agent = cli("agent", 'echo "2026.11.01-FAKE"');
    await boot(`assistants:\n  personal-codex:\n    provider: openai\n  cursor:\n    provider: cursor\n    options:\n      command: ${agent}\n`);
    expect(statuses(await test("personal-codex"))).toMatchObject({ executable: "pass/version_reported", "approval-refusal:prompt-on-escalation": "pass/refused_before_launch", "self-description": "not-run/quota_free_unverified" });
    const cursor = await test("cursor");
    expect(statuses(cursor)).toMatchObject({
      executable: "pass/version_reported",
      "approval-refusal:prompt-on-escalation": "pass/refused_before_launch",
      "approval-refusal:read-only": "pass/refused_before_launch",
      "self-description": "unsupported/no_self_description",
    });
    expect(new Set(argv("codex"))).toEqual(new Set(["--version"]));
    expect(new Set(argv("agent"))).toEqual(new Set(["--version"]));
    // Conformance passing does not make Cursor authenticated (next block).
    expect(cursor.lifecycle.auth.state).toBe("unknown");
    expect(cursor.lifecycle.readiness.reasons).toContain("auth unknown");
  });

  it("Bedrock: its known gap (no approval refusal) is reported as fail, with no AgentCore request", async () => {
    isolatePath();
    await boot("assistants:\n  bedrock:\n    provider: bedrock\n    options:\n      agentRuntimeArn: arn:aws:bedrock-agentcore:us-east-1:000000000000:runtime/FAKE-not-real\n");
    const result = await test("bedrock");
    expect(statuses(result)).toMatchObject({
      executable: "unsupported/in_process_runtime",
      "approval-refusal:auto-approve": "fail/refused_for_other_reason",
      "approval-refusal:prompt-on-escalation": "fail/refused_for_other_reason",
      "approval-refusal:read-only": "fail/refused_for_other_reason",
    });
    expect(result).toMatchObject({ status: "fail", recorded: true, cliVersion: "in-process" });
  });

  it("an agent-user claim is host evidence: not run, and the result is not a pass", async () => {
    // A fake declaring agentUser stands in for Claude on a host with `execution.agentUser`.
    await boot("assistants:\n  fake-agent:\n    provider: fake\n    options:\n      agentUser: true\n");
    const result = await test("fake-agent");
    expect(statuses(result)["host-claims"]).toBe("not-run/host_probe_not_authorized");
    expect(result).toMatchObject({ status: "fail", reasons: ["host_probe_not_authorized"] });
  });

  it("answers 404, 409, 401 and 403 as specified, writing nothing", async () => {
    await boot(FAKES);
    expect((await inject("POST", "/api/assistants/nope/test")).statusCode).toBe(404);
    expect((await inject("POST", "/api/assistants/nope/test")).json()).toEqual({ error: "Unknown assistant: nope" });
    expect((await inject("POST", "/api/assistants/fake-a/test", {})).statusCode).toBe(401);
    const readOnly = rotateCredential(credentialPath(loadConfig({ AGENT_PLANE_HOME: home! }).dir), 3600, ["tasks.read"]);
    expect((await inject("POST", "/api/assistants/fake-a/test", bearer(readOnly.secret))).statusCode).toBe(403);
    expect(rows()).toEqual([]);
    // Two concurrent tests of one assistant: the second is refused.
    const [a, b] = await Promise.all([inject("POST", "/api/assistants/fake-a/test"), inject("POST", "/api/assistants/fake-a/test")]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 409]);
    // An assistant removed from config keeps its row but cannot be tested.
    await stop();
    await boot("assistants:\n  fake-req:\n    provider: fake\n", {}, true);
    const removed = await inject("POST", "/api/assistants/fake-a/test");
    expect(removed.statusCode).toBe(409);
    expect(removed.json()).toEqual({ error: "assistant fake-a is not in the workspace config" });
  });
});

describe("version-bound enforcement", () => {
  it("G.3: every shipped descriptor stays conformanceRequired: false", () => {
    expect(RUNTIME_CATALOG.map((d) => [d.provider, d.conformanceRequired])).toEqual([
      ["anthropic", false], ["openai", false], ["openrouter", false], ["cursor", false], ["bedrock", false], ["fake", false],
    ]);
  });

  it("a runtime that requires conformance fails closed until a passing test, then routes; the evidence survives a restart", async () => {
    await boot(FAKES);
    const blocked = await routeFor("fake-req");
    expect(blocked.chosen).toBeUndefined();
    expect(failures(blocked, "fake-req")).toEqual(["conformance required: not-run for the observed CLI and descriptor version"]);
    expect(failures(blocked, "fake-a")).toEqual([]);
    const lifecycle = (await inject("GET", "/api/assistants/fake-req/lifecycle")).json();
    expect(lifecycle.conformance).toEqual({ required: true, state: "not-run", descriptorVersion: 1 });
    expect(lifecycle.readiness).toEqual({ scope: "request-independent", ready: false, reasons: ["conformance required: not-run for the observed CLI and descriptor version"] });

    // Explicit compare/race selection is gated the same way, before anything is written.
    const task = built!.tasks.create({ goal: "compare" }).taskId;
    const parallel = await inject("POST", `/api/tasks/${task}/parallel`, bearer(), { assistants: ["fake-a", "fake-req"], mode: "compare" });
    expect(parallel.statusCode).toBe(409);
    expect(parallel.json().error).toContain("fake-req: conformance required: not-run for the observed CLI and descriptor version (POST /api/assistants/fake-req/test records it)");

    const result = await test("fake-req");
    expect(statuses(result)).toMatchObject({ executable: "unsupported/in_process_runtime", "in-process-run": "pass/scripted_run_completed" });
    expect(result).toMatchObject({ status: "pass", recorded: true, cliVersion: "in-process" });
    expect((await routeFor("fake-req")).chosen).toBe("fake-req");

    await stop();
    await boot(FAKES, {}, true);
    expect((await inject("GET", "/api/assistants/fake-req/lifecycle")).json().conformance).toMatchObject({ required: true, state: "pass", cliVersion: "in-process" });
    expect((await routeFor("fake-req")).chosen).toBe("fake-req");
  });

  it("a failed or stale row keeps a required runtime blocked, and never blocks an optional one", async () => {
    await boot(FAKES);
    const insert = (id: string, version: string, status: "pass" | "fail", descriptorVersion = 1) =>
      db!.prepare("INSERT INTO runtime_conformance (assistant_id, cli_version, descriptor_version, status, checks, checked_at) VALUES (?, ?, ?, ?, '[]', '2026-11-18T12:00:00.000Z')").run(id, version, descriptorVersion, status);
    insert("fake-req", "in-process", "fail");
    insert("fake-a", "in-process", "fail");
    const r1 = await routeFor();
    expect(failures(r1, "fake-req")).toEqual(["conformance required: fail for the observed CLI and descriptor version"]);
    expect(failures(r1, "fake-a")).toEqual([]);
    expect(r1.chosen).toBe("fake-a");
    db!.prepare("DELETE FROM runtime_conformance").run();
    insert("fake-req", "0.9.0-earlier-cli", "pass");
    insert("fake-req", "in-process", "pass", 2);
    expect(failures(await routeFor(), "fake-req")).toEqual(["conformance required: stale for the observed CLI and descriptor version"]);
  });

  it("a descriptor version change makes earlier evidence stale", () => {
    const facts = (descriptorVersion: number) => deriveLifecycle({
      row: { provider: "fake", enabled: 1, operator_state: null, operator_state_at: null, manifestParsed: null },
      configured: true,
      descriptor: { descriptorVersion, conformanceRequired: true },
      probe: { version: "in-process", observedAt: "2026-11-18T12:00:00.000Z" },
      conformance: [{ cli_version: "in-process", descriptor_version: 1, status: "pass", checked_at: "2026-11-18T12:00:00.000Z" }],
    }).conformance.state;
    expect(facts(1)).toBe("pass");
    expect(facts(2)).toBe("stale");
  });
});

describe("Cursor: installed is not signed in", () => {
  it("an installed Cursor CLI reports auth unknown and is not routed; an absent one reports missing", async () => {
    isolatePath();
    const agent = cli("agent", 'echo "2026.11.01-FAKE"');
    await boot(`assistants:\n  cursor:\n    provider: cursor\n    options:\n      command: ${agent}\n  cursor-absent:\n    provider: cursor\n    options:\n      command: ${join(bin!, "no-such-agent")}\n  fake-a:\n    provider: fake\n`);
    const listed = (await inject("GET", "/api/assistants")).json() as Array<{ id: string; manifest: { core: { auth: { state: string } } }; lifecycle: { installed: { state: string; version?: string }; auth: { state: string } } }>;
    const byId = Object.fromEntries(listed.map((a) => [a.id, a]));
    expect(byId.cursor!.manifest.core.auth.state).toBe("unknown");
    expect(byId.cursor!.lifecycle.installed).toMatchObject({ state: "present", version: "2026.11.01-FAKE" });
    expect(byId["cursor-absent"]!.manifest.core.auth.state).toBe("missing");
    expect(byId["cursor-absent"]!.lifecycle.installed.state).toBe("missing");
    const routed = await routeFor("cursor");
    expect(routed.chosen).toBeUndefined();
    expect(failures(routed, "cursor")).toContain("auth unknown");
    expect(argv("agent").every((a) => a === "--version")).toBe(true);
  });
});
