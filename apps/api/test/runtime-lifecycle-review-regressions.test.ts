import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { credentialPath, readCredential } from "../src/auth/credential-file.js";
import { loadConfig } from "../src/config.js";
import { openDb } from "../src/db/index.js";
import { Registry } from "../src/modules/registry.js";
import { buildServer } from "../src/server.js";

const A = "fake-a";
const B = "fake-b";
const FAKES = { [A]: { provider: "fake" }, [B]: { provider: "fake" } };

let home: string;
let rig: ReturnType<typeof boot> | undefined;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "agent-plane-runtime-review-"));
  mkdirSync(join(home, "personal"));
});

afterEach(async () => {
  vi.restoreAllMocks();
  try {
    await stop();
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

function boot(assistants: Record<string, { provider: string; options?: Record<string, string> }> = FAKES) {
  writeFileSync(join(home, "personal", "config.yaml"), JSON.stringify({
    assistants,
    policy: { approvalMode: "prompt-on-escalation" },
  }));
  const config = loadConfig({ AGENT_PLANE_HOME: home });
  const db = openDb(config.dbPath);
  const server = buildServer({ config, db });
  server.registry.init();
  const credential = readCredential(credentialPath(config.dir));
  const headers = { authorization: `Bearer ${credential.secrets[0]!.secret}` };
  const request = (method: "GET" | "POST", url: string, payload?: object) =>
    server.app.inject({ method, url, headers, payload });
  const workspace = { config, db, server, request };
  rig = workspace;
  return workspace;
}

async function stop() {
  if (!rig) return;
  const { server, db } = rig;
  rig = undefined;
  try {
    await server.orchestrator.shutdown();
    await server.app.close();
  } finally {
    db.close();
  }
}

it("leaves a task RUNNING after the handoff target is disabled during source drain", async () => {
  const { server, db, request } = boot();
  await server.registry.sync(A);
  await server.registry.sync(B);

  const created = await request("POST", "/api/tasks", { goal: "Wait for approval [FAKE:APPROVAL]" });
  expect(created.statusCode).toBe(201);
  const { taskId } = created.json<{ taskId: string }>();
  const start = await request("POST", `/api/tasks/${taskId}/start`, { assistantId: A });
  expect(start.statusCode).toBe(200);
  expect(server.orchestrator.isActive(taskId)).toBe(true);

  // Interleave the operator request at the provider boundary, then run actual fake-provider cancel.
  const adapter = server.registry.adapter(A);
  const cancel = adapter.cancel.bind(adapter);
  const disableWhileDraining = vi.spyOn(adapter, "cancel").mockImplementation(async (handle) => {
    const disabled = await request("POST", `/api/assistants/${B}/disable`);
    expect(disabled.statusCode).toBe(200);
    await cancel(handle);
  });

  const handoff = await request("POST", `/api/tasks/${taskId}/handoff`, { to: B });
  expect(disableWhileDraining).toHaveBeenCalledOnce();
  expect(handoff.statusCode).toBe(409);
  expect(handoff.json().error).toContain("disabled by operator");
  expect(db.prepare("SELECT assistant_id, state FROM runs WHERE task_id = ?").all(taskId))
    .toEqual([{ assistant_id: A, state: "ENDED_ERROR" }]);
  expect(server.orchestrator.isActive(taskId)).toBe(false);
  const task = await request("GET", `/api/tasks/${taskId}`);
  expect(task.statusCode).toBe(200);
  expect(task.json().state, "A refused handoff with zero active runs must not leave the task RUNNING")
    .not.toBe("RUNNING");
});

it.fails("returns contradictory operator state when a second writer enables after disable commits", async () => {
  const { server, config, request } = boot();
  const otherDb = openDb(config.dbPath);
  try {
    const otherWriter = new Registry(otherDb, config);
    const setOperatorState = server.registry.setOperatorState.bind(server.registry);
    // Force the interleaving after the first transaction commits and before the handler reads.
    const disable = vi.spyOn(server.registry, "setOperatorState").mockImplementation((id, state, now) => {
      const result = setOperatorState(id, state, now);
      expect(result?.changed).toBe(true);
      expect(otherWriter.setOperatorState(id, "none")?.changed).toBe(true);
      return result;
    });

    const response = await request("POST", `/api/assistants/${A}/disable`);
    expect(disable).toHaveBeenCalledOnce();
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body).toMatchObject({ changed: true, operatorState: "disabled" });
    expect(body.lifecycle.enablement.operator, "Disable response lifecycle must agree with its top-level operatorState")
      .toBe(body.operatorState);
  } finally {
    otherDb.close();
  }
});

it.fails("reports a removed assistant as effectively enabled and ready after an empty-config restart", async () => {
  const first = boot();
  await first.server.registry.sync(A);
  const before = await first.request("GET", `/api/assistants/${A}/lifecycle`);
  expect(before.statusCode).toBe(200);
  expect(before.json()).toMatchObject({ configured: true, readiness: { ready: true } });
  await stop();

  const { server, request } = boot({});
  expect(() => server.registry.adapter(A)).toThrow("Unknown assistant");
  const response = await request("GET", `/api/assistants/${A}/lifecycle`);
  expect(response.statusCode).toBe(200);
  expect(response.json(), "A cached assistant with no configured adapter must be ineffective and unready")
    .toMatchObject({ configured: false, enablement: { effective: false }, readiness: { ready: false } });
});

it.fails("returns 500 after disabling a healthy assistant when another cached manifest is malformed", async () => {
  const { server, db, request } = boot();
  await server.registry.sync(A);
  await server.registry.sync(B);
  expect(db.prepare("UPDATE assistants SET manifest = ? WHERE id = ?").run("{", B).changes).toBe(1);

  const response = await request("POST", `/api/assistants/${A}/disable`);
  expect(db.prepare("SELECT operator_state FROM assistants WHERE id = ?").get(A))
    .toEqual({ operator_state: "disabled" });
  expect(response.statusCode, "A durably committed disable must return 200 despite another assistant's malformed manifest")
    .toBe(200);
});

it("returns 414 when disabling a listed assistant with a 101-character ID", async () => {
  const id = "a".repeat(101);
  const { request } = boot({ [id]: { provider: "fake" } });
  const list = await request("GET", "/api/assistants");
  expect(list.statusCode).toBe(200);
  expect(list.json()).toContainEqual(expect.objectContaining({ id }));
  const response = await request("POST", `/api/assistants/${id}/disable`);
  expect(response.statusCode, "A listed assistant with a contract-valid 101-character ID must be disableable")
    .toBe(200);
});

it("reports OpenRouter as in-process even though it uses the Codex CLI", async () => {
  const { server, request } = boot({
    router: { provider: "openrouter", options: { apiKeyEnv: "FAKE_HO_194_OPENROUTER_KEY" } },
  });
  vi.stubEnv("FAKE_HO_194_OPENROUTER_KEY", "");
  try {
    await server.registry.syncChanged("router");
    const response = await request("GET", "/api/assistants/router/lifecycle");
    expect(response.statusCode).toBe(200);
    const { installed } = response.json();
    expect(installed.state, "OpenRouter uses the Codex CLI and must not be reported as in-process").not.toBe("in-process");
  } finally {
    vi.unstubAllEnvs();
  }
});
