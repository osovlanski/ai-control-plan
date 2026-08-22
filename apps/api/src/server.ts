import Fastify, { type FastifyInstance, type FastifyReply } from "fastify";
import type { AssistantId, RoutingProfile } from "@agent-plane/core";
import type { ResolvedConfig } from "./config.js";
import { appliedMigrations, type Db } from "./db/index.js";
import { CheckpointService } from "./modules/checkpoint.js";
import { CooldownStore } from "./modules/cooldown.js";
import { Orchestrator } from "./modules/orchestrator.js";
import { Registry } from "./modules/registry.js";
import { persistRoutingDecision, route, routingHistory, type RouteRequest } from "./modules/router.js";
import { TaskEventBus } from "./modules/sse.js";
import { TaskStore } from "./modules/tasks.js";
import { renderHandoffMd } from "./render/handoff.js";
import { renderProgressMd } from "./render/progress.js";

export interface ServerDeps {
  config: ResolvedConfig;
  db: Db;
  /** Injectable for tests; defaults are built from config. */
  registry?: Registry;
  orchestrator?: Orchestrator;
  bus?: TaskEventBus;
  tasks?: TaskStore;
}

export interface BuiltServer {
  app: FastifyInstance;
  registry: Registry;
  orchestrator: Orchestrator;
  tasks: TaskStore;
  bus: TaskEventBus;
  checkpoints: CheckpointService;
  cooldowns: CooldownStore;
}

export function buildServer(deps: ServerDeps): BuiltServer {
  const { config, db } = deps;
  const bus = deps.bus ?? new TaskEventBus();
  const tasks = deps.tasks ?? new TaskStore(db);
  const registry = deps.registry ?? new Registry(db, config);
  const checkpoints = new CheckpointService(db, tasks);
  const cooldowns = new CooldownStore(db);
  const orchestrator =
    deps.orchestrator ??
    new Orchestrator(db, config, registry, tasks, bus, checkpoints, cooldowns);

  const app = Fastify({ logger: true });

  const repoAllowed = (repoPath: string | null | undefined): boolean =>
    !repoPath || config.repoAllowlist.some((allowed) => repoPath === allowed || repoPath.startsWith(`${allowed}/`));

  const computeRoute = (taskId: string, userOverride?: AssistantId) => {
    const row = tasks.get(taskId);
    if (!row) return undefined;
    const req: RouteRequest = {
      taskId,
      profile: row.profile,
      needsRepo: row.repo_path !== null,
      repoPathAllowed: repoAllowed(row.repo_path),
      cooldowns: cooldowns.active(),
      userOverride,
    };
    const explanation = route(
      req,
      registry.list().map((a) => ({
        id: a.id as AssistantId,
        enabled: a.enabled === 1,
        manifest: a.manifestParsed,
      })),
    );
    persistRoutingDecision(db, taskId, explanation);
    return explanation;
  };

  app.get("/api/health", () => ({
    status: "ok",
    workspace: config.workspace,
    migrations: appliedMigrations(db).length,
    now: new Date().toISOString(),
  }));

  app.get("/api/workspace", () => ({
    workspace: config.workspace,
    assistants: Object.keys(config.assistants),
    repoAllowlist: config.repoAllowlist,
    failover: config.failover,
    sync: config.sync,
  }));

  // ---- Assistants / registry ----

  app.get("/api/assistants", () =>
    registry.list().map((a) => ({
      id: a.id,
      provider: a.provider,
      enabled: a.enabled === 1,
      manifest: a.manifestParsed,
      manifestUpdatedAt: a.manifest_updated_at,
    })),
  );

  app.post<{ Params: { id: string } }>("/api/assistants/:id/sync", async (req, reply) => {
    try {
      return await registry.sync(req.params.id);
    } catch (err) {
      return reply.status(400).send({ error: message(err) });
    }
  });

  app.get("/api/assistants/changes", () => registry.recentChanges());

  app.get("/api/cooldowns", () => cooldowns.list());

  // ---- Tasks ----

  app.post<{
    Body: { goal?: string; constraints?: string[]; repoPath?: string; profile?: RoutingProfile };
  }>("/api/tasks", async (req, reply) => {
    const { goal, constraints, repoPath, profile } = req.body ?? {};
    if (!goal || !goal.trim()) return reply.status(400).send({ error: "goal is required" });
    if (repoPath && !repoAllowed(repoPath)) {
      return reply.status(403).send({ error: `Repository ${repoPath} is not in this workspace's allowlist` });
    }
    const envelope = tasks.create({ goal: goal.trim(), constraints, repoPath, profile });
    return reply.status(201).send(envelope);
  });

  app.get("/api/tasks", () =>
    tasks.list().map((t) => ({
      id: t.id,
      goal: t.goal,
      state: t.state,
      phase: t.activity_phase,
      profile: t.profile,
      repoPath: t.repo_path,
      createdAt: t.created_at,
      updatedAt: t.updated_at,
    })),
  );

  app.get<{ Params: { id: string } }>("/api/tasks/:id", (req, reply) => {
    const row = tasks.get(req.params.id);
    if (!row) return reply.status(404).send({ error: "not found" });
    const runs = db
      .prepare(
        "SELECT id, assistant_id, provider_session_ref, state, usage, started_at, ended_at FROM runs WHERE task_id = ? ORDER BY started_at",
      )
      .all(req.params.id) as Array<Record<string, unknown> & { usage: string | null }>;
    return {
      ...row,
      envelope: JSON.parse(row.envelope) as unknown,
      runs: runs.map((r) => ({ ...r, usage: r.usage ? (JSON.parse(r.usage) as unknown) : null })),
      active: orchestrator.isActive(req.params.id),
    };
  });

  app.post<{ Params: { id: string }; Body: { assistantId?: AssistantId } }>(
    "/api/tasks/:id/route",
    (req, reply) => {
      const explanation = computeRoute(req.params.id, req.body?.assistantId);
      if (!explanation) return reply.status(404).send({ error: "not found" });
      return explanation;
    },
  );

  app.post<{ Params: { id: string }; Body: { assistantId?: AssistantId } }>(
    "/api/tasks/:id/start",
    async (req, reply) => {
      const taskId = req.params.id;
      const row = tasks.get(taskId);
      if (!row) return reply.status(404).send({ error: "not found" });
      if (row.state !== "CREATED") {
        return reply.status(409).send({ error: `Task is ${row.state}; only CREATED tasks can start` });
      }
      const explanation = computeRoute(taskId, req.body?.assistantId);
      if (!explanation?.chosen) {
        return reply.status(422).send({ error: "No eligible assistant", explanation });
      }
      try {
        tasks.transition(taskId, "ROUTING");
        const { runId } = await orchestrator.startTask(taskId, explanation.chosen);
        return { runId, assistantId: explanation.chosen, explanation };
      } catch (err) {
        // Worktree/adapter startup failure: park the task as FAILED with the reason.
        const current = tasks.get(taskId);
        if (current && current.state !== "FAILED") {
          try {
            tasks.transition(taskId, "FAILED");
          } catch {
            /* already terminal */
          }
        }
        return reply.status(500).send({ error: message(err) });
      }
    },
  );

  app.post<{
    Params: { id: string };
    Body: { kind?: string; requestId?: string; approved?: boolean };
  }>("/api/tasks/:id/input", async (req, reply) => {
    const { kind, requestId, approved } = req.body ?? {};
    if (kind !== "approval" || !requestId || typeof approved !== "boolean") {
      return reply.status(400).send({ error: "Body must be {kind:'approval', requestId, approved}" });
    }
    try {
      await orchestrator.respondApproval(req.params.id, requestId, approved);
      return { ok: true };
    } catch (err) {
      return reply.status(409).send({ error: message(err) });
    }
  });

  app.post<{ Params: { id: string } }>("/api/tasks/:id/cancel", async (req, reply) => {
    try {
      await orchestrator.cancelTask(req.params.id);
      return { ok: true };
    } catch (err) {
      return reply.status(409).send({ error: message(err) });
    }
  });

  app.post<{ Params: { id: string } }>("/api/tasks/:id/checkpoint", async (req, reply) => {
    if (!tasks.get(req.params.id)) return reply.status(404).send({ error: "not found" });
    try {
      const cp = await orchestrator.createCheckpoint(req.params.id);
      return { id: cp.id, gitRef: cp.gitRef, diffStat: cp.diffStat, at: cp.at };
    } catch (err) {
      return reply.status(500).send({ error: message(err) });
    }
  });

  app.get<{ Params: { id: string } }>("/api/tasks/:id/checkpoints", (req, reply) => {
    if (!tasks.get(req.params.id)) return reply.status(404).send({ error: "not found" });
    return checkpoints.list(req.params.id);
  });

  app.post<{ Params: { id: string }; Body: { to?: AssistantId } }>(
    "/api/tasks/:id/handoff",
    async (req, reply) => {
      if (!tasks.get(req.params.id)) return reply.status(404).send({ error: "not found" });
      try {
        return await orchestrator.handoff(req.params.id, req.body?.to);
      } catch (err) {
        return reply.status(409).send({ error: message(err) });
      }
    },
  );

  app.get<{ Params: { id: string } }>("/api/tasks/:id/handoffs", (req, reply) => {
    if (!tasks.get(req.params.id)) return reply.status(404).send({ error: "not found" });
    return db
      .prepare(
        `SELECT h.id, h.trigger, h.at, h.checkpoint_id,
                fr.assistant_id AS from_assistant, tr.assistant_id AS to_assistant
         FROM handoffs h
         LEFT JOIN runs fr ON fr.id = h.from_run_id
         LEFT JOIN runs tr ON tr.id = h.to_run_id
         WHERE h.task_id = ? ORDER BY h.at`,
      )
      .all(req.params.id);
  });

  app.get<{ Params: { id: string } }>("/api/tasks/:id/files/handoff.md", (req, reply) => {
    if (!tasks.get(req.params.id)) return reply.status(404).send({ error: "not found" });
    const cp = checkpoints.latest(req.params.id);
    if (!cp) return reply.status(404).send({ error: "no checkpoint yet — take one first" });
    const from = cp.runId
      ? (db.prepare("SELECT assistant_id FROM runs WHERE id = ?").get(cp.runId) as
          | { assistant_id: string }
          | undefined)
      : undefined;
    reply.type("text/markdown; charset=utf-8");
    return renderHandoffMd(cp.envelope, {
      reason: "Prepared handoff package",
      fromAssistantId: from?.assistant_id,
      gitRef: cp.gitRef,
      diffStat: cp.diffStat,
      activitySummary: cp.activitySummary,
    });
  });

  app.get<{ Params: { id: string } }>("/api/tasks/:id/events", (req, reply) => {
    const row = tasks.get(req.params.id);
    if (!row) return reply.status(404).send({ error: "not found" });
    return db
      .prepare(
        `SELECT e.run_id, e.seq, e.ts, e.type, e.phase, e.summary, e.payload, r.assistant_id
         FROM events e JOIN runs r ON r.id = e.run_id
         WHERE r.task_id = ? ORDER BY e.ts, e.seq`,
      )
      .all(req.params.id)
      .map((raw) => {
        const e = raw as Record<string, unknown> & { payload: string | null };
        return { ...e, payload: e.payload ? (JSON.parse(e.payload) as unknown) : null };
      });
  });

  app.get<{ Params: { id: string } }>("/api/tasks/:id/events/stream", (req, reply) => {
    const row = tasks.get(req.params.id);
    if (!row) return reply.status(404).send({ error: "not found" });
    sseHeaders(reply);
    send(reply, { kind: "state", state: { state: row.state, phase: row.activity_phase ?? undefined } });
    const unsubscribe = bus.subscribe(req.params.id, (payload) => send(reply, payload));
    req.raw.on("close", unsubscribe);
  });

  app.get<{ Params: { id: string } }>("/api/tasks/:id/routing", (req, reply) => {
    const row = tasks.get(req.params.id);
    if (!row) return reply.status(404).send({ error: "not found" });
    return routingHistory(db, req.params.id);
  });

  app.get<{ Params: { id: string } }>("/api/tasks/:id/files/progress.md", (req, reply) => {
    const row = tasks.get(req.params.id);
    if (!row) return reply.status(404).send({ error: "not found" });
    const lastRun = db
      .prepare("SELECT assistant_id FROM runs WHERE task_id = ? ORDER BY started_at DESC LIMIT 1")
      .get(req.params.id) as { assistant_id: string } | undefined;
    reply.type("text/markdown; charset=utf-8");
    return renderProgressMd(tasks.envelope(req.params.id), lastRun?.assistant_id);
  });

  return { app, registry, orchestrator, tasks, bus, checkpoints, cooldowns };
}

function sseHeaders(reply: FastifyReply): void {
  reply.raw.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  reply.raw.write(":ok\n\n");
}

function send(reply: FastifyReply, payload: unknown): void {
  reply.raw.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
