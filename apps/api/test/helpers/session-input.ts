/**
 * Shared fixture for the session-input slice.
 *
 * Every test drives real HTTP through `app.inject` against a real SQLite
 * workspace; only the provider is a double. Sessions are seeded straight into
 * `tasks`/`runs` so a test can pin one exact lifecycle condition without
 * running an orchestrator to get there.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FakeSessionInputAdapter } from "@agent-plane/adapters";
import type { SessionInputAdapter } from "@agent-plane/core";
import type { SessionInputAdapterResolver } from "../../src/modules/session-input.js";
import { credentialPath, readCredential } from "../../src/auth/credential-file.js";
import { loadConfig, type ResolvedConfig } from "../../src/config.js";
import { openDb, type Db } from "../../src/db/index.js";
import { buildServer, type BuiltServer } from "../../src/server.js";

export interface Workspace {
  built: BuiltServer;
  db: Db;
  config: ResolvedConfig;
  headers: { authorization: string };
}

export function writeWorkspaceConfig(
  home: string,
  workspace: string,
  opts: { sessionInput: boolean },
): void {
  mkdirSync(join(home, workspace), { recursive: true });
  writeFileSync(
    join(home, workspace, "config.yaml"),
    [
      `workspace: ${workspace}`,
      "assistants:",
      "  fake-a:",
      "    provider: fake",
      "  real-a:",
      "    provider: anthropic",
      "  codex-a:",
      "    provider: openai",
      "sessionInput:",
      `  enabled: ${opts.sessionInput}`,
      "",
    ].join("\n"),
  );
}

export function boot(
  home: string,
  opts: {
    workspace?: string;
    sessionInput?: boolean;
    adapter?: SessionInputAdapter;
    /** Full resolver, for a test that wires more than the deterministic fake. */
    adapters?: SessionInputAdapterResolver;
    /** Reuse a fixed lease epoch to simulate the SAME incarnation restarting. */
    now?: () => Date;
  } = {},
): Workspace {
  const workspace = opts.workspace ?? "personal";
  writeWorkspaceConfig(home, workspace, { sessionInput: opts.sessionInput !== false });
  const config = loadConfig({ AGENT_PLANE_HOME: home, AGENT_PLANE_WORKSPACE: workspace });
  const db = openDb(config.dbPath);
  const built = buildServer({
    config,
    db,
    now: opts.now,
    sessionInputAdapters:
      opts.adapters ?? (opts.adapter ? (id) => (id === "fake-a" ? opts.adapter : undefined) : undefined),
  });
  built.registry.init();
  const headers = {
    authorization: `Bearer ${readCredential(credentialPath(config.dir)).secrets[0]!.secret}`,
  };
  return { built, db, config, headers };
}

export interface SeedOptions {
  sessionId?: string;
  taskId?: string;
  assistantId?: string;
  taskState?: string;
  sessionState?: string;
  runState?: string;
  approvalPending?: boolean;
}

/** Seeds one task + one execution session in an exact lifecycle condition. */
export function seedSession(db: Db, opts: SeedOptions = {}): { sessionId: string; taskId: string } {
  const taskId = opts.taskId ?? `AG-${Math.random().toString(36).slice(2, 8)}`;
  const sessionId = opts.sessionId ?? `run_${Math.random().toString(36).slice(2, 10)}`;
  const at = "2026-09-20T09:00:00.000Z";
  db.prepare(
    "INSERT INTO tasks (id, goal, state, profile, envelope, created_at, updated_at) VALUES (?, ?, ?, 'auto', '{}', ?, ?)",
  ).run(taskId, "seeded mission", opts.taskState ?? "RUNNING", at, at);
  db.prepare(
    `INSERT INTO runs (id, task_id, assistant_id, provider_session_ref, state, session_state, started_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    sessionId,
    taskId,
    opts.assistantId ?? "fake-a",
    `provider-${sessionId}`,
    opts.runState ?? "ACTIVE",
    opts.sessionState ?? "RUNNING",
    at,
  );
  if (opts.approvalPending) {
    db.prepare(
      `INSERT INTO approvals (id, session_id, provider_request_id, state, created_at, updated_at)
       VALUES (?, ?, 'apr_1', 'pending', ?, ?)`,
    ).run(`apr_${sessionId}`, sessionId, at, at);
  }
  return { sessionId, taskId };
}

export const newAdapter = (opts?: ConstructorParameters<typeof FakeSessionInputAdapter>[0]) =>
  new FakeSessionInputAdapter(opts);

export async function send(
  ws: Workspace,
  sessionId: string,
  body: Record<string, unknown>,
): Promise<{ statusCode: number; body: Record<string, unknown> }> {
  const res = await ws.built.app.inject({
    method: "POST",
    url: `/api/sessions/${sessionId}/inputs`,
    headers: ws.headers,
    payload: body,
  });
  return { statusCode: res.statusCode, body: res.statusCode === 404 ? {} : res.json() };
}

/** Drives one explicit command over a MESSAGE id, exactly as a client would. */
export async function command(
  ws: Workspace,
  messageId: string,
  action: "retry" | "cancel",
  body: Record<string, unknown> = {},
): Promise<{ statusCode: number; body: Record<string, unknown> }> {
  const res = await ws.built.app.inject({
    method: "POST",
    url: `/api/inputs/${messageId}/${action}`,
    headers: ws.headers,
    payload: body,
  });
  return { statusCode: res.statusCode, body: res.statusCode === 404 ? {} : res.json() };
}

/**
 * The kernel's own task-state announcement — the frame the orchestrator, the
 * scheduler and the harness event recorder all publish — followed by a drain of
 * the redelivery pump it feeds.
 */
export async function announceState(ws: Workspace, taskId: string, state: string): Promise<void> {
  ws.built.bus.publish(taskId, { kind: "state", state: { state } });
  await ws.built.sessionInputRedelivery?.();
}
