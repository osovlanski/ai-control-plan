import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import fastifyStatic from "@fastify/static";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  COMMAND_CAPABILITIES,
  CONTROL_PLANE_API_VERSION,
  NORMALIZED_EVENT_VERSION,
  OBSERVABILITY_CAPABILITIES,
  redactSecrets,
  redactValue,
  type AssistantId,
  type DecisionProvider,
  type DecisionSite,
  type RoutingProfile,
  type ScheduleInput,
  type TaskIntent,
  type WaitInput,
} from "@agent-plane/core";
import type { ResolvedConfig } from "./config.js";
import { appliedMigrations, type Db } from "./db/index.js";
import { CheckpointService } from "./modules/checkpoint.js";
import { CooldownStore } from "./modules/cooldown.js";
import { listDecisions, toolGatePromptRates } from "./modules/decision.js";
import type { HarnessBridge } from "./modules/harness/control-plane-bridge.js";
import { buildHarnessComposition } from "./modules/harness/composition.js";
import { effectiveStateSql, effectiveUsageJoin, effectiveUsageSql } from "./modules/harness/state-vocab.js";
import { Orchestrator } from "./modules/orchestrator.js";
import type { planProjectVerification } from "./modules/project-verification.js";
import { Registry } from "./modules/registry.js";
import { routingHistory } from "./modules/router.js";
import { TaskEventBus } from "./modules/sse.js";
import { Scheduler } from "./modules/scheduler.js";
import { QuotaProbeService, type QuotaProbeFn } from "./modules/quota-probe.js";
import { ModelCatalogService, CATALOG_REVISION, type CatalogSource } from "./modules/model-catalog.js";
import { createArtificialAnalysisSource } from "./modules/artificial-analysis.js";
import { QuotaProjection } from "./modules/quota.js";
import { readTaskContext } from "./modules/context.js";
import { TaskStore } from "./modules/tasks.js";
import {
  SessionInputCommandRejectedError,
  SessionInputConflictError,
  SessionInputInvalidError,
  SessionInputService,
  SessionInputUnknownSessionError,
  type SessionInputAdapterResolver,
  type SessionInputRow,
} from "./modules/session-input.js";
import { TelemetryService } from "./modules/telemetry.js";
import { EventRetention } from "./modules/retention.js";
import { RepositoryIdentityRegistry } from "./repo/identity-registry.js";
import { renderHandoffMd } from "./render/handoff.js";
import { renderProgressMd } from "./render/progress.js";
import { registerAuth, type SessionMap } from "./auth/index.js";
import { ClaudeAdapter, ClaudeCodeSessionInputAdapter, CodexAdapter, FakeSessionInputAdapter } from "@agent-plane/adapters";
import { CredentialStore, credentialPath } from "./auth/credential-file.js";

export interface ServerDeps {
  config: ResolvedConfig;
  db: Db;
  /** Injectable for tests; defaults are built from config. */
  registry?: Registry;
  orchestrator?: Orchestrator;
  bus?: TaskEventBus;
  tasks?: TaskStore;
  now?: () => Date;
  quotaProbes?: QuotaProbeService;
  /** Overrides the idle quota probe transport (K3) when `quotaProbes` is not supplied. Test/demo only. */
  quotaProbeFn?: QuotaProbeFn;
  modelCatalog?: ModelCatalogService;
  /** External catalog sources (K7 seam for K8). Empty in production. */
  modelCatalogSources?: CatalogSource[];
  /** Transport handed to those sources. Test/demo only. */
  modelCatalogFetch?: typeof globalThis.fetch;
  /**
   * Overrides the session-input delivery adapters. Test/demo only — the default
   * resolver hands the deterministic fake adapter to `provider: fake`
   * assistants and NOTHING to every real provider (docs/contracts/session-input.md).
   */
  sessionInputAdapters?: SessionInputAdapterResolver;
  registerExtraRoutes?: (app: FastifyInstance) => void;
  /** M16 decision providers beyond rules. Test/scratch only — production registers `decisionProviders()` (K19d: the model judge). */
  decisionProviders?: DecisionProvider[];
}

export interface BuiltServer {
  app: FastifyInstance;
  registry: Registry;
  orchestrator: Orchestrator;
  tasks: TaskStore;
  bus: TaskEventBus;
  checkpoints: CheckpointService;
  cooldowns: CooldownStore;
  telemetry: TelemetryService;
  scheduler: Scheduler;
  quotaProbes: QuotaProbeService;
  modelCatalog: ModelCatalogService;
  /** Present only when `sessionInput.enabled` is true. */
  sessionInputs?: SessionInputService;
  /**
   * Resolves once the scheduler-owned redelivery pump has drained everything the
   * kernel has announced so far. Present only when `sessionInput.enabled` is
   * true; it exists so a caller can await the pump instead of racing it.
   */
  sessionInputRedelivery?: () => Promise<unknown>;
}

export function buildServer(deps: ServerDeps): BuiltServer {
  const { config, db } = deps;
  const now = deps.now ?? (() => new Date());
  const bus = deps.bus ?? new TaskEventBus();
  const tasks = deps.tasks ?? new TaskStore(db);
  const registry = deps.registry ?? new Registry(db, config);
  const checkpoints = new CheckpointService(db, tasks);
  const cooldowns = new CooldownStore(db, now);
  const telemetry = new TelemetryService(db);
  const retention = new EventRetention(db);
  const repositoryIdentities = new RepositoryIdentityRegistry(db);
  const app = Fastify({ logger: { stream: { write: (line) => process.stdout.write(redactSecrets(line)) }, serializers: { req: (r) => ({ method: r.method, url: String(r.url).split("?")[0] }), res: (r) => ({ statusCode: r.statusCode }) }, redact: ["req.headers.authorization", "req.headers.cookie", "res.headers[\"set-cookie\"]"] } });
  const credentials = new CredentialStore(credentialPath(config.dir), now);
  const authSessions: SessionMap = new Map();
  registerAuth(app, { config, credentials, sessions: authSessions, db, now });
  for (const warning of config.warnings ?? []) app.log.warn(warning);
  const read = {
    tasks: { config: { auth: { require: "tasks.read" } } }, events: { config: { auth: { require: "events.read" } } },
    stream: { config: { auth: { require: "events.stream" } } }, routing: { config: { auth: { require: "routing.read" } } },
    sessions: { config: { auth: { require: "sessions.read" } } }, verification: { config: { auth: { require: "verification.read" } } },
  } as const;
  const schedulerRead = { config: { auth: { require: "schedules.read" } } } as const;
  const modelsRead = { config: { auth: { require: "models.read" } } } as const;
  const decisionsRead = { config: { auth: { require: "decisions.read" } } } as const;
  const contextRead = { config: { auth: { require: "context.read" } } } as const;
  const write = { config: { auth: { require: "commands.write" } } } as const;

  // The internal bridge + recovery are wired for every real composition root
  // (extracted to modules/harness/composition.ts so a test factory can build a
  // production-equivalent Harness-wired Orchestrator without duplicating this
  // wiring — increment 3, D5), NOT gated on any harnessModes value (D6):
  // rollback safety needs an already-started Harness session to stay
  // Harness-owned and settle under HarnessRecovery after a mode is disabled.
  // `harnessRouting()` is the only flag-gated decision (new starts). A test
  // that injects its own orchestrator owns the harness wiring itself.
  // harnessRecovery is always built (the lease sweep below runs regardless of
  // whether a test injects its own orchestrator); harnessBridge/projectVerification
  // are only wired into the internal composition root.
  const composed = buildHarnessComposition({
    db,
    config,
    tasks,
    bus,
    checkpoints,
    registry,
    onError: (err) => app.log.error(err),
    onQuotaObserved: () => orchestrator.scheduler?.quotaObserved(),
    decisionProviders: deps.decisionProviders,
    onWarning: (message) => app.log.warn(message),
  });
  const harnessRecovery = composed.harnessRecovery;
  const harnessBridge: HarnessBridge | undefined = deps.orchestrator ? undefined : composed.harnessBridge;
  const projectVerification: ((worktreePath: string) => ReturnType<typeof planProjectVerification>) | undefined =
    deps.orchestrator ? undefined : composed.projectVerification;
  if (!deps.orchestrator && !harnessBridge) {
    throw new Error("execution-harness bridge is not wired for the internal composition root");
  }

  // K7 (M12). Catalog reads never sit on the routing path: routing reads the
  // registry, and a stale or failed catalog refresh only affects these routes.
  // K8: the one external benchmark source (Artificial Analysis) is registered
  // here from the `AA_API_KEY` env only. With no key it records a classified
  // `not configured` refresh attempt and the local catalog is untouched (§3).
  // K13 also reads it to build the SHADOW model recommendation on each routing
  // decision — advisory, and a catalog failure degrades to no recommendation.
  const modelCatalogSources = deps.modelCatalogSources ?? [
    createArtificialAnalysisSource({ apiKey: process.env.AA_API_KEY, now }),
  ];
  const modelCatalog = deps.modelCatalog ?? new ModelCatalogService(db, registry, now, modelCatalogSources, deps.modelCatalogFetch);

  const orchestrator =
    deps.orchestrator ??
    new Orchestrator(
      db,
      config,
      registry,
      tasks,
      bus,
      checkpoints,
      cooldowns,
      undefined,
      harnessRecovery,
      harnessBridge,
      projectVerification,
      repositoryIdentities,
      now,
      modelCatalog,
    );

  const repoAllowed = (repoPath: string | null | undefined): boolean =>
    !repoPath || config.repoAllowlist.some((allowed) => repoPath === allowed || repoPath.startsWith(`${allowed}/`));

  const probes = deps.quotaProbes ?? new QuotaProbeService(db, config, registry, deps.quotaProbeFn, now);
  const scheduler = new Scheduler({ db, tasks, orchestrator, bus, config, probes, now, onError: error => app.log.error(error) });
  const computeRoute = (taskId: string, userOverride?: AssistantId) => tasks.get(taskId)
    ? orchestrator.routeTask(taskId, 'intake', { override: userOverride }) : undefined;

  app.get("/api/meta", read.tasks, () => ({
    apiVersion: CONTROL_PLANE_API_VERSION,
    eventVersion: NORMALIZED_EVENT_VERSION,
    authRequired: true,
    capabilities: [...OBSERVABILITY_CAPABILITIES, ...COMMAND_CAPABILITIES],
  }));

  app.get("/api/health", read.tasks, () => ({
    status: "ok",
    workspace: config.workspace,
    migrations: appliedMigrations(db).length,
    now: now().toISOString(),
  }));

  app.get("/api/workspace", read.tasks, () => ({
    workspace: config.workspace,
    assistants: Object.keys(config.assistants),
    repoAllowlist: config.repoAllowlist,
    failover: config.failover,
    sync: config.sync,
    scheduler: { enabled: scheduler.enabled },
    // Advertised so a client can tell "capability off" from "request failed"
    // without probing a route that does not exist.
    sessionInput: { enabled: config.sessionInput.enabled },
  }));

  // ---- Assistants / registry ----

  app.get("/api/assistants", read.tasks, () =>
    registry.list().map((a) => {
      // Effective headroom, not the manifest's copy: a fresh idle probe (K3)
      // supersedes a stale run-stream snapshot and vice versa, by observedAt.
      const projection = new QuotaProjection(db, now).for(a.id, a.manifestParsed);
      return {
        id: a.id,
        provider: a.provider,
        enabled: a.enabled === 1,
        manifest: a.manifestParsed,
        manifestUpdatedAt: a.manifest_updated_at,
        quota: projection.quota,
        quotaObservations: projection.observations,
      };
    }),
  );

  app.post<{ Params: { id: string } }>("/api/assistants/:id/sync", write, async (req, reply) => {
    try {
      return await registry.sync(req.params.id);
    } catch (err) {
      return reply.status(400).send({ error: message(err) });
    }
  });

  app.get("/api/assistants/changes", read.tasks, () => registry.recentChanges());

  app.get("/api/cooldowns", read.tasks, () => cooldowns.list());

  // ---- Models (K7 / M12) ----
  // Identity + evidence only. Nothing here selects a model: benchmark ingestion
  // (K8) and model scoring (K13) are not implemented.

  app.get("/api/models", modelsRead, () => ({
    catalogRevision: CATALOG_REVISION,
    models: modelCatalog.list(),
    refreshes: modelCatalog.refreshes(10),
  }));

  // `:id` accepts `provider:modelId`, a bare model id, or a known alias. A bare
  // id several providers claim (Codex and Cursor both call a model `default`)
  // is answered with 409 and the candidate keys — never an arbitrary provider.
  app.get<{ Params: { id: string } }>("/api/models/:id", modelsRead, (req, reply) => {
    const { entry, candidates } = modelCatalog.resolve(req.params.id);
    if (!entry) {
      if (candidates.length > 1) {
        return reply.status(409).send({
          error: `"${req.params.id}" is not a unique model identity`,
          candidates: candidates.map((c) => c.modelKey),
        });
      }
      return reply.status(404).send({ error: "not found" });
    }
    // Detail carries the unmerged evidence rows too; the list stays the merged
    // projection so the UI is not handed every source for every model.
    return { ...entry, evidence: modelCatalog.evidenceFor(entry) };
  });

  app.post("/api/models/refresh", write, async () => ({ attempts: await modelCatalog.refresh() }));

  // ---- Decisions (K18 / M16) ----
  // Read-only. `site` and `limit` are the only filters — the K22 shadow
  // report and this route share the same `listDecisions` query.
  app.get<{ Querystring: { site?: string; limit?: string } }>("/api/decisions", decisionsRead, (req, reply) => {
    const { site, limit } = req.query ?? {};
    const knownSites: readonly DecisionSite[] = ["tool-gate", "task-classifier", "context-breakpoint"];
    if (site !== undefined && !knownSites.includes(site as DecisionSite)) {
      return reply.status(400).send({ error: `invalid site: ${site}` });
    }
    const parsedLimit = limit !== undefined ? Number(limit) : undefined;
    if (parsedLimit !== undefined && (!Number.isFinite(parsedLimit) || parsedLimit < 1)) {
      return reply.status(400).send({ error: "limit must be a positive number" });
    }
    return { decisions: listDecisions(db, { site: site as DecisionSite | undefined, limit: parsedLimit }) };
  });

  // K19c / §8: tool-gate prompt rate per run, for the K22 chart.
  app.get<{ Querystring: { limit?: string } }>("/api/decisions/prompt-rate", decisionsRead, (req, reply) => {
    const limit = req.query?.limit !== undefined ? Number(req.query.limit) : undefined;
    if (limit !== undefined && (!Number.isFinite(limit) || limit < 1)) {
      return reply.status(400).send({ error: "limit must be a positive number" });
    }
    return { promptRates: toolGatePromptRates(db, { limit }) };
  });

  // ---- Tasks ----

  app.post<{
    Body: { goal?: string; constraints?: string[]; repoPath?: string; profile?: RoutingProfile; wait?: WaitInput; overrides?: TaskIntent["overrides"]; mode?: string };
  }>("/api/tasks", write, async (req, reply) => {
    const { goal, constraints, repoPath, profile, wait, overrides, mode } = req.body ?? {};
    if (typeof goal !== "string" || !goal.trim()) return reply.status(400).send({ error: "goal is required" });
    if (repoPath !== undefined && typeof repoPath !== "string") return reply.status(400).send({ error: "repoPath must be a string" });
    if (repoPath && !repoAllowed(repoPath)) {
      return reply.status(403).send({ error: `Repository ${repoPath} is not in this workspace's allowlist` });
    }
    try {
      if (wait && mode && mode !== 'single') throw new Error('K1 waits require single mode');
      // K7 widens overrides by exactly one field: `model`, the requested
      // SELECTOR. It is recorded as intent and never resolved here.
      if (overrides && (typeof overrides !== 'object' || Object.keys(overrides).some(k => k !== 'assistantId' && k !== 'model') ||
          (overrides.assistantId !== undefined && typeof overrides.assistantId !== 'string') ||
          (overrides.model !== undefined && (typeof overrides.model !== 'string' || !overrides.model.trim())))) throw new Error('overrides accept only assistantId and model');
      if (constraints && (!Array.isArray(constraints) || constraints.some(c => typeof c !== 'string'))) throw new Error('constraints must be strings');
      if (profile && !['auto','preserve-quota','fastest','best-quality','lowest-tokens'].includes(profile)) throw new Error('Invalid routing profile');
      if (wait) scheduler.validate(wait);
      const envelope = db.transaction(() => {
        const task = tasks.create(redactValue({ goal: goal.trim(), constraints, repoPath, profile, overrides }));
        if (wait) scheduler.attach(task.taskId, wait);
        return tasks.envelope(task.taskId);
      })();
      if (wait) scheduler.publish(envelope.taskId);
      return reply.status(201).send(envelope);
    } catch (err) { return reply.status(400).send({ error: message(err) }); }
  });

  app.get("/api/tasks", read.tasks, () =>
    tasks.list().map((t) => ({
      id: t.id,
      goal: t.goal,
      state: t.state,
      phase: t.activity_phase,
      profile: t.profile,
      repoPath: t.repo_path,
      createdAt: t.created_at,
      updatedAt: t.updated_at,
      wait: scheduler.condition(t.id),
      schedulerEnabled: scheduler.enabled,
    })),
  );

  app.get<{ Params: { id: string } }>("/api/tasks/:id", read.tasks, (req, reply) => {
    const row = tasks.get(req.params.id);
    if (!row) return reply.status(404).send({ error: "not found" });
    const runs = db
      .prepare(
        // Effective state + usage derived at read time (execution-harness.md §5,
        // PLAN.md 8e) — session_state authoritative for harness rows, usage
        // falls back to the terminal execution_results row. See state-vocab.ts.
        `SELECT r.id, r.assistant_id, r.provider_session_ref,
           ${effectiveStateSql("r")} AS state,
           ${effectiveUsageSql("r")} AS usage,
           r.started_at, r.ended_at,
           -- K7: requested and served identity are separate facts; NULL resolved
           -- means the provider reported none, not that it matched the request.
           r.model_requested, r.model_resolved, r.model_resolved_source,
           a.provider AS serving_provider
         FROM runs r ${effectiveUsageJoin("r")}
         LEFT JOIN assistants a ON a.id = r.assistant_id
         WHERE r.task_id = ? ORDER BY r.started_at`,
      )
      .all(req.params.id) as Array<Record<string, unknown> & { usage: string | null }>;
    return {
      ...row,
      envelope: JSON.parse(row.envelope) as unknown,
      runs: runs.map(({ model_requested, model_resolved, model_resolved_source, serving_provider, ...r }) => ({
        ...r,
        usage: r.usage ? (JSON.parse(r.usage as string) as unknown) : null,
        modelIdentity: {
          requestedSelector: model_requested ?? null,
          resolvedModelId: model_resolved ?? null,
          resolvedSource: model_resolved_source ?? "unknown",
          servingProvider: serving_provider ?? null,
        },
      })),
      active: orchestrator.isActive(req.params.id),
      wait: scheduler.condition(req.params.id),
      /** K4b: derived pool truth for the Orbital Inspector; null unless the task waits on one. */
      resourceWait: scheduler.resourceWaitStatus(req.params.id) ?? null,
      resourceClaim: scheduler.claim(req.params.id) ?? null,
      dispatches: scheduler.dispatches(req.params.id),
      schedulerEvents: scheduler.events(req.params.id),
      schedulerEnabled: scheduler.enabled,
      intent: JSON.parse(row.intent_json) as unknown,
    };
  });

  // K9 (M14) — current/latest truthful context observation for the task's
  // active session. `context.read`; credentials minted before K9 lack the
  // capability and fail closed until rotated. Observation only.
  app.get<{ Params: { id: string } }>("/api/tasks/:id/context", contextRead, (req, reply) => {
    if (!tasks.get(req.params.id)) return reply.status(404).send({ error: "not found" });
    return readTaskContext(db, req.params.id, {
      now,
      capabilityFor: (assistantId) => registry.manifest(assistantId)?.context ?? undefined,
      advertisedMaxFor: (provider, modelId) =>
        modelCatalog.resolve(`${provider}:${modelId}`).entry?.contextWindowTokens?.value,
    });
  });

  app.get('/api/scheduler/status', schedulerRead, () => scheduler.status());
  app.get<{ Params: { id: string } }>('/api/tasks/:id/wait', read.tasks, (req, reply) => {
    if (!tasks.get(req.params.id)) return reply.status(404).send({ error: 'not found' });
    return { condition: scheduler.condition(req.params.id) ?? null,
      openDispatch: scheduler.dispatches(req.params.id).find(d => ['reserved','start_attempted'].includes(d.phase)) ?? null,
      // K4b: derived pool truth (why this task waits, who holds the slot). Computed
      // per request — a stored occupancy number would be stale on arrival.
      resourceWait: scheduler.resourceWaitStatus(req.params.id) ?? null,
      resourceClaim: scheduler.claim(req.params.id) ?? null,
      schedulerEnabled: scheduler.enabled };
  });

  app.post<{ Params: { id: string }; Body: WaitInput }>('/api/tasks/:id/wait', write, (req, reply) => {
    if (!tasks.get(req.params.id)) return reply.status(404).send({ error: 'not found' });
    try { return scheduler.attach(req.params.id, req.body); }
    catch (err) { return reply.status(409).send({ error: message(err) }); }
  });
  // K5 recurring schedules. Reads need `schedules.read`; every mutation is a command.
  app.get('/api/schedules', schedulerRead, () => scheduler.schedules.list());
  app.get<{ Params: { id: string } }>('/api/schedules/:id', schedulerRead, (req, reply) => {
    const schedule = scheduler.schedules.get(req.params.id);
    if (!schedule) return reply.status(404).send({ error: 'not found' });
    // `occurrences` pages recent history; `queuedOccurrences` is the FIFO
    // backlog's own head-first view, so a large backlog never hides it.
    return { ...schedule, occurrences: scheduler.schedules.occurrences(req.params.id),
      queuedOccurrences: scheduler.schedules.queuedOccurrences(req.params.id) };
  });
  app.post<{ Body: ScheduleInput }>('/api/schedules', write, (req, reply) => {
    try { return reply.status(201).send(scheduler.schedules.create(req.body)); }
    catch (err) { return reply.status(400).send({ error: message(err) }); }
  });
  app.patch<{ Params: { id: string }; Body: Partial<ScheduleInput> }>('/api/schedules/:id', write, (req, reply) => {
    if (!scheduler.schedules.get(req.params.id)) return reply.status(404).send({ error: 'not found' });
    try { return scheduler.schedules.update(req.params.id, req.body ?? {}); }
    catch (err) { return reply.status(400).send({ error: message(err) }); }
  });
  app.delete<{ Params: { id: string } }>('/api/schedules/:id', write, (req, reply) => {
    if (!scheduler.schedules.remove(req.params.id)) return reply.status(404).send({ error: 'not found' });
    return reply.status(204).send();
  });

  app.post<{ Params: { id: string }; Body: { generation?: number; confirmNoLiveOwner?: boolean } }>('/api/tasks/:id/run-now', write, async (req, reply) => {
    if (!tasks.get(req.params.id)) return reply.status(404).send({ error: 'not found' });
    const result = await scheduler.runNow(req.params.id, req.body?.generation, req.body?.confirmNoLiveOwner === true);
    return reply.status(result.outcome === 'stale' ? 409 : 200).send(result);
  });

  app.post<{ Params: { id: string }; Body: { assistantId?: AssistantId } }>(
    "/api/tasks/:id/route", write,
    (req, reply) => {
      const routed = computeRoute(req.params.id, req.body?.assistantId);
      if (!routed) return reply.status(404).send({ error: "not found" });
      return routed.explanation;
    },
  );

  app.post<{ Params: { id: string }; Body: { assistantId?: AssistantId } }>(
    "/api/tasks/:id/start", write,
    async (req, reply) => {
      const taskId = req.params.id;
      const row = tasks.get(taskId);
      if (!row) return reply.status(404).send({ error: "not found" });
      if (row.state !== "CREATED") {
        return reply.status(409).send({ error: `Task is ${row.state}; only CREATED tasks can start` });
      }
      const routed = computeRoute(taskId, req.body?.assistantId);
      const chosen = routed?.explanation.chosen;
      if (!routed || !chosen) {
        return reply.status(422).send({ error: "No eligible assistant", explanation: routed?.explanation });
      }
      const { explanation, routingDecisionId } = routed;
      try {
        tasks.transition(taskId, "ROUTING");
        const { runId } = await orchestrator.startTask(taskId, chosen, {
          routingDecisionRef: String(routingDecisionId),
        });
        return { runId, assistantId: chosen, explanation };
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
  }>("/api/tasks/:id/input", write, async (req, reply) => {
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

  app.post<{ Params: { id: string } }>("/api/tasks/:id/cancel", write, async (req, reply) => {
    try {
      await scheduler.cancel(req.params.id);
      return { ok: true };
    } catch (err) {
      return reply.status(409).send({ error: message(err) });
    }
  });

  app.post<{ Params: { id: string } }>("/api/tasks/:id/checkpoint", write, async (req, reply) => {
    if (!tasks.get(req.params.id)) return reply.status(404).send({ error: "not found" });
    try {
      const cp = await orchestrator.createCheckpoint(req.params.id);
      return { id: cp.id, gitRef: cp.gitRef, diffStat: cp.diffStat, at: cp.at };
    } catch (err) {
      return reply.status(500).send({ error: message(err) });
    }
  });

  app.get<{ Params: { id: string } }>("/api/tasks/:id/checkpoints", read.tasks, (req, reply) => {
    if (!tasks.get(req.params.id)) return reply.status(404).send({ error: "not found" });
    return checkpoints.list(req.params.id);
  });

  app.post<{ Params: { id: string }; Body: { to?: AssistantId } }>(
    "/api/tasks/:id/handoff", write,
    async (req, reply) => {
      if (!tasks.get(req.params.id)) return reply.status(404).send({ error: "not found" });
      try {
        return await orchestrator.handoff(req.params.id, req.body?.to);
      } catch (err) {
        return reply.status(409).send({ error: message(err) });
      }
    },
  );

  app.get<{ Params: { id: string } }>("/api/tasks/:id/handoffs", read.tasks, (req, reply) => {
    if (!tasks.get(req.params.id)) return reply.status(404).send({ error: "not found" });
    const live = db
      .prepare(
        `SELECT h.id, h.trigger, h.at, h.checkpoint_id,
                fr.assistant_id AS from_assistant, tr.assistant_id AS to_assistant
         FROM handoffs h
         LEFT JOIN runs fr ON fr.id = h.from_run_id
         LEFT JOIN runs tr ON tr.id = h.to_run_id
         WHERE h.task_id = ? ORDER BY h.at`,
      )
      .all(req.params.id);
    return live;
  });

  app.get<{ Params: { id: string } }>("/api/tasks/:id/files/handoff.md", read.tasks, (req, reply) => {
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

  app.post<{ Params: { id: string }; Body: { assistants?: AssistantId[]; mode?: "compare" | "race" } }>(
    "/api/tasks/:id/parallel", write,
    async (req, reply) => {
      const { assistants, mode } = req.body ?? {};
      if (!Array.isArray(assistants) || assistants.length < 2) {
        return reply.status(400).send({ error: "Provide at least two assistants to run in parallel" });
      }
      try {
        return await orchestrator.startParallel(req.params.id, assistants, mode ?? "compare");
      } catch (err) {
        return reply.status(409).send({ error: message(err) });
      }
    },
  );

  app.get<{ Params: { id: string } }>("/api/tasks/:id/comparison", read.tasks, async (req, reply) => {
    try {
      return await orchestrator.comparison(req.params.id);
    } catch (err) {
      return reply.status(404).send({ error: message(err) });
    }
  });

  app.post<{ Params: { id: string }; Body: { winnerRunId?: string; reason?: string } }>(
    "/api/tasks/:id/comparison/resolve", write,
    async (req, reply) => {
      const { winnerRunId, reason } = req.body ?? {};
      if (!winnerRunId) return reply.status(400).send({ error: "winnerRunId is required" });
      try {
        return await orchestrator.resolveComparison(req.params.id, winnerRunId, reason);
      } catch (err) {
        return reply.status(409).send({ error: message(err) });
      }
    },
  );

  app.get<{ Querystring: { kind?: string } }>("/api/scores", read.tasks, (req) => {
    // What the router is actually measuring, so a recommendation can be checked.
    return [...telemetry.scores(req.query.kind).values()];
  });

  app.get<{ Params: { id: string } }>("/api/tasks/:id/events", read.events, (req, reply) => {
    const row = tasks.get(req.params.id);
    if (!row) return reply.status(404).send({ error: "not found" });
    const live = db
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
    return [...retention.events(req.params.id), ...live];
  });

  app.get<{ Params: { id: string } }>("/api/tasks/:id/events/stream", read.stream, (req, reply) => {
    const row = tasks.get(req.params.id);
    if (!row) return reply.status(404).send({ error: "not found" });
    sseHeaders(reply);
    send(reply, { kind: "state", state: { state: row.state, phase: row.activity_phase ?? undefined, wait: scheduler.condition(row.id), schedulerEnabled: scheduler.enabled } });
    const unsubscribe = bus.subscribe(req.params.id, (payload) => send(reply, payload));
    req.raw.on("close", unsubscribe);
  });

  app.get<{ Params: { id: string } }>("/api/tasks/:id/routing", read.routing, (req, reply) => {
    const row = tasks.get(req.params.id);
    if (!row) return reply.status(404).send({ error: "not found" });
    return routingHistory(db, req.params.id);
  });

  app.get<{ Params: { id: string } }>("/api/tasks/:id/files/progress.md", read.tasks, (req, reply) => {
    const row = tasks.get(req.params.id);
    if (!row) return reply.status(404).send({ error: "not found" });
    const lastRun = db
      .prepare("SELECT assistant_id FROM runs WHERE task_id = ? ORDER BY started_at DESC LIMIT 1")
      .get(req.params.id) as { assistant_id: string } | undefined;
    reply.type("text/markdown; charset=utf-8");
    return renderProgressMd(tasks.envelope(req.params.id), lastRun?.assistant_id);
  });

  // ---- Execution Harness durable reads (§11) — additive, read-only ----------
  // Every state distinction in §11 is renderable from these durable rows alone;
  // nothing is inferred from SSE. `sessionState` is primary (§5); the legacy
  // `state` vocabulary is still served during the dual-field window.

  app.get<{ Params: { id: string } }>("/api/tasks/:id/sessions", read.sessions, (req, reply) => {
    if (!tasks.get(req.params.id)) return reply.status(404).send({ error: "not found" });
    const rows = db
      .prepare(
        `SELECT r.id, r.execution_request_id, r.assistant_id, r.session_state, r.state, r.attempt,
                r.provider_start_acked, r.cancel_requested, r.settlement_owner, r.started_at, r.ended_at,
                er.parent_task_id, er.group_id, er.target_kind, er.workspace_id,
                er.repository_id, er.worktree_id
           FROM runs r JOIN execution_requests er ON er.id = r.execution_request_id
          WHERE r.task_id = ?
          ORDER BY r.started_at, r.id`,
      )
      .all(req.params.id) as Array<Record<string, unknown>>;
    return rows.map(sessionSummary);
  });

  // Correlated navigation (§11): sessions across a subtask GROUP or under a
  // PARENT task — the fan-out the single-task list above cannot express.
  app.get<{ Querystring: { groupId?: string; parentTaskId?: string } }>("/api/sessions", read.sessions, (req, reply) => {
    const { groupId, parentTaskId } = req.query;
    if (!groupId && !parentTaskId) {
      return reply.status(400).send({ error: "provide groupId or parentTaskId" });
    }
    const where = groupId ? "er.group_id = ?" : "er.parent_task_id = ?";
    const rows = db
      .prepare(
        `SELECT r.id, r.execution_request_id, r.assistant_id, r.session_state, r.state, r.attempt,
                r.provider_start_acked, r.cancel_requested, r.settlement_owner, r.started_at, r.ended_at,
                er.parent_task_id, er.group_id, er.target_kind, er.workspace_id,
                er.repository_id, er.worktree_id, r.task_id
           FROM runs r JOIN execution_requests er ON er.id = r.execution_request_id
          WHERE ${where}
          ORDER BY r.started_at, r.id`,
      )
      .all((groupId ?? parentTaskId) as string) as Array<Record<string, unknown>>;
    return rows.map((r) => ({ ...sessionSummary(r), taskId: r.task_id }));
  });

  app.get<{ Params: { id: string } }>("/api/sessions/:id", read.sessions, (req, reply) => {
    const run = db
      .prepare(
        `SELECT id, task_id, execution_request_id, assistant_id, session_state, state, version,
                provider_session_ref, provider_start_acked, cancel_requested, settlement_owner,
                attempt, lease_token, lease_expires_at, started_at, ended_at
           FROM runs WHERE id = ?`,
      )
      .get(req.params.id) as Record<string, unknown> | undefined;
    if (!run || run.execution_request_id == null) return reply.status(404).send({ error: "not found" });

    const requestRow = db
      .prepare(
        `SELECT id, attempt, assistant_id, model, routing_decision_ref, request_fingerprint,
                fingerprint_algorithm, prompt_source, prompt_source_ref, origin_envelope_id,
                superseded, policy, verification, origin, parent_task_id, group_id,
                target_kind, workspace_id, repository_id, worktree_id, created_at
           FROM execution_requests WHERE id = ?`,
      )
      .get(run.execution_request_id) as Record<string, unknown> | undefined;

    const resultRow = db
      .prepare("SELECT result FROM execution_results WHERE session_id = ?")
      .get(req.params.id) as { result: string } | undefined;
    // A well-formed ExecutionResult is an object with a string `outcome` and an
    // `enforcement` object; anything else (corrupt row) degrades to null so a
    // client never dereferences `result.enforcement.tools` on garbage.
    const parsed = resultRow ? safeJson(resultRow.result) : null;
    const result =
      parsed && typeof parsed === "object" && !Array.isArray(parsed) &&
      typeof (parsed as Record<string, unknown>).outcome === "string"
        ? (parsed as Record<string, unknown>)
        : null;

    const checkpoints = (
      db
        .prepare(
          "SELECT id, reason, git_ref, diff_stat, at FROM checkpoints WHERE session_id = ? ORDER BY at, id",
        )
        .all(req.params.id) as Array<Record<string, unknown>>
    ).map((c) => ({ id: c.id, reason: c.reason, gitRef: c.git_ref, diffStat: c.diff_stat, at: c.at }));

    const handoffEnvelopes = (
      db
        .prepare(
          `SELECT id, state, checkpoint_id, claimed_by_request_id, claimed_at, start_attempted_at,
                  from_assistant_id, reason, created_at, updated_at
             FROM handoff_envelopes WHERE source_session_id = ? ORDER BY created_at, id`,
        )
        .all(req.params.id) as Array<Record<string, unknown>>
    ).map((e) => ({
      id: e.id,
      state: e.state,
      checkpointId: e.checkpoint_id,
      claimedByRequestId: e.claimed_by_request_id,
      claimedAt: e.claimed_at,
      startAttemptedAt: e.start_attempted_at,
      fromAssistantId: e.from_assistant_id,
      reason: e.reason,
      createdAt: e.created_at,
      updatedAt: e.updated_at,
    }));

    const approvals = (
      db
        .prepare(
          `SELECT id, provider_request_id, state, decision, answered_by, answered_at, delivered_at,
                  delivery_note, created_at, updated_at
             FROM approvals WHERE session_id = ? ORDER BY created_at, id`,
        )
        .all(req.params.id) as Array<Record<string, unknown>>
    ).map((a) => ({
      id: a.id,
      providerRequestId: a.provider_request_id,
      state: a.state,
      decision: a.decision,
      answeredBy: a.answered_by,
      answeredAt: a.answered_at,
      deliveredAt: a.delivered_at,
      deliveryNote: a.delivery_note,
      createdAt: a.created_at,
      updatedAt: a.updated_at,
    }));

    // Typed audit events for the drill-down: guard decisions, verification
    // results, checkpoint markers, recovery decisions (orphan vs resume, §9).
    // Absence means "stage did not happen".
    const audit = (
      db
        .prepare(
          `SELECT seq, ts, type, phase, summary, payload FROM events
             WHERE run_id = ?
               AND type IN ('guard.decision', 'verification.result', 'checkpoint.created', 'recovery.decision')
             ORDER BY seq`,
        )
        .all(req.params.id) as Array<Record<string, unknown> & { payload: string | null }>
    ).map((e) => ({
      seq: e.seq,
      ts: e.ts,
      type: e.type,
      phase: e.phase,
      summary: e.summary,
      payload: e.payload ? safeJson(e.payload) : null,
    }));

    return {
      sessionId: run.id,
      taskId: run.task_id,
      executionRequestId: run.execution_request_id,
      assistantId: run.assistant_id,
      attempt: run.attempt,
      sessionState: run.session_state, // primary (§5)
      state: run.state, // legacy vocabulary, still served (dual-field window)
      version: run.version,
      providerSessionRef: run.provider_session_ref,
      providerStartAcked: run.provider_start_acked === 1,
      cancelRequested: run.cancel_requested === 1,
      settlementOwner: run.settlement_owner,
      lease: run.lease_token ? { expiresAt: run.lease_expires_at } : null,
      startedAt: run.started_at,
      endedAt: run.ended_at,
      // K7: what we asked for vs what the provider said it served. A null
      // `resolvedModelId` is an honest unknown, never back-filled from the request.
      modelIdentity: {
        requestedSelector: run.model_requested ?? null,
        resolvedModelId: run.model_resolved ?? null,
        resolvedSource: run.model_resolved_source ?? "unknown",
      },
      // Opaque observability join keys (§2) — carried for navigation, never read by logic.
      correlation: requestRow
        ? { parentTaskId: requestRow.parent_task_id ?? null, groupId: requestRow.group_id ?? null }
        : null,
      request: requestRow
        ? {
            id: requestRow.id,
            attempt: requestRow.attempt,
            assistantId: requestRow.assistant_id,
            model: requestRow.model ? safeJson(requestRow.model as string) : null,
            routingDecisionRef: requestRow.routing_decision_ref,
            requestFingerprint: requestRow.request_fingerprint,
            fingerprintAlgorithm: requestRow.fingerprint_algorithm,
            promptSource: requestRow.prompt_source,
            promptSourceRef: requestRow.prompt_source_ref,
            originEnvelopeId: requestRow.origin_envelope_id,
            superseded: requestRow.superseded === 1,
            policy: safeJson(requestRow.policy as string),
            verification: safeJson(requestRow.verification as string),
            origin: safeJson(requestRow.origin as string),
            target: targetOf(requestRow),
            createdAt: requestRow.created_at,
          }
        : null,
      // verification + enforcement live inside `result` — not duplicated here.
      result,
      checkpoints,
      handoffEnvelopes,
      approvals,
      audit,
    };
  });

  app.get<{ Params: { id: string } }>("/api/sessions/:id/verification", read.verification, (req, reply) => {
    const run = db.prepare(
      "SELECT id, execution_request_id FROM runs WHERE id = ?",
    ).get(req.params.id) as { id: string; execution_request_id: string | null } | undefined;
    // Legacy orchestrator rows have no accepted ExecutionRequest and therefore
    // are not Harness sessions, even if their ids happen to be known.
    if (!run || run.execution_request_id === null) return reply.status(404).send({ error: "not found" });

    const revisions = (db.prepare(
      `SELECT id, session_id, execution_request_id, revision, supersedes_revision_id,
              plan_fingerprint, plan, reason, created_at
         FROM verification_plan_revisions
        WHERE session_id = ? ORDER BY revision, id`,
    ).all(req.params.id) as Array<Record<string, unknown> & { plan: string }>).map((revision) => ({
      id: revision.id,
      sessionId: revision.session_id,
      executionRequestId: revision.execution_request_id,
      revision: revision.revision,
      supersedesRevisionId: revision.supersedes_revision_id,
      planFingerprint: revision.plan_fingerprint,
      plan: safeLifecycleJson(revision.plan),
      reason: revision.reason,
      createdAt: revision.created_at,
    }));
    const runs = (db.prepare(
      `SELECT vr.id, vr.session_id, vr.execution_request_id, vr.plan_revision_id, vr.state,
              vr.claimed_at, vr.evaluation, vr.artifacts, vr.interruption_reason,
              vr.created_at, vr.updated_at
         FROM verification_runs vr
         JOIN verification_plan_revisions p ON p.id = vr.plan_revision_id
        WHERE vr.session_id = ? ORDER BY p.revision, vr.created_at, vr.id`,
    ).all(req.params.id) as Array<Record<string, unknown> & { evaluation: string | null; artifacts: string | null }>).map((verificationRun) => ({
      id: verificationRun.id,
      sessionId: verificationRun.session_id,
      executionRequestId: verificationRun.execution_request_id,
      planRevisionId: verificationRun.plan_revision_id,
      state: verificationRun.state,
      claimedAt: verificationRun.claimed_at,
      evaluation: verificationRun.evaluation === null ? null : safeLifecycleJson(verificationRun.evaluation),
      artifacts: verificationRun.artifacts === null ? [] : safeLifecycleJsonArray(verificationRun.artifacts),
      interruptionReason: safeLifecycleText(verificationRun.interruption_reason),
      createdAt: verificationRun.created_at,
      updatedAt: verificationRun.updated_at,
    }));
    return { sessionId: req.params.id, revisions, runs };
  });

  // Lease sweeper (execution-harness §9): a periodic tick hands any session whose
  // fencing lease has expired to recovery. ponytail: fixed 60s = the lease TTL;
  // make it config if a deployment ever needs a different cadence.
  const leaseSweep = setInterval(() => {
    void harnessRecovery.sweepExpiredLeases().catch((err) => app.log.error(err, "lease sweep failed"));
  }, 60_000);
  leaseSweep.unref();
  app.addHook("onClose", async () => { clearInterval(leaseSweep); scheduler.stop(); });
  // ---- Durable session-addressed conversational input (default OFF) ----
  //
  // The whole capability is behind `sessionInput.enabled`. While it is false
  // NOTHING below is registered: the routes 404 exactly as they did before this
  // slice, no ledger row is ever written, and the Shell composer keeps saying
  // truthfully that session-addressed delivery is unavailable.
  let sessionInputs: SessionInputService | undefined;
  let sessionInputRedelivery: (() => Promise<unknown>) | undefined;
  if (config.sessionInput.enabled) {
    const fakes = new Map<string, FakeSessionInputAdapter>();
    const lives = new Map<string, ClaudeCodeSessionInputAdapter>();
    const resolve: SessionInputAdapterResolver = deps.sessionInputAdapters ?? ((assistantId) => {
      // `AgentAdapter.send` is still NOT reused as the delivery seam: it has no
      // idempotency, receipt or acknowledgement contract, and a typed method is
      // not acceptance evidence. Claude Code gets its own adapter, which proves
      // delivery from the CLI's own transcript; every OTHER provider still
      // declares no session-input capability at all.
      const row = db.prepare("SELECT provider FROM assistants WHERE id = ?").get(assistantId) as
        | { provider: string }
        | undefined;
      if (row?.provider === "openai") {
        const owner = registry.adapter(assistantId);
        return owner instanceof CodexAdapter ? owner.sessionInput : undefined;
      }
      if (row?.provider === "anthropic") {
        let adapter = lives.get(assistantId);
        if (!adapter) {
          const agent = registry.adapter(assistantId);
          // Only a live-input ClaudeAdapter can be delivered to. Anything else
          // has no capability rather than a silently faked one.
          if (!(agent instanceof ClaudeAdapter)) return undefined;
          adapter = new ClaudeCodeSessionInputAdapter((sessionId) => agent.liveSession(sessionId));
          lives.set(assistantId, adapter);
        }
        return adapter;
      }
      if (row?.provider !== "fake") return undefined;
      let adapter = fakes.get(assistantId);
      if (!adapter) {
        adapter = new FakeSessionInputAdapter();
        fakes.set(assistantId, adapter);
      }
      return adapter;
    });
    sessionInputs = new SessionInputService(db, { workspace: config.workspace, adapters: resolve, now });
    // A previous incarnation's in-flight attempts are unknown outcomes, not
    // deliveries and not failures. Fence them before serving anything.
    sessionInputs.reconcileOpenAttempts();
    const inputs = sessionInputs;

    app.post<{
      Params: { sessionId: string };
      Body: { clientMessageId?: string; text?: string; kind?: string; expiresAt?: string };
    }>("/api/sessions/:sessionId/inputs", write, async (req, reply) => {
      const body = req.body ?? {};
      const actor = `${req.cred?.kind ?? "unknown"}:${req.cred?.kid ?? "unknown"}`;
      let messageId: string;
      try {
        const { row } = inputs.submit({
          sessionId: req.params.sessionId,
          clientMessageId: String(body.clientMessageId ?? ""),
          text: String(body.text ?? ""),
          kind: body.kind,
          expiresAt: body.expiresAt,
          actor,
        });
        messageId = row.id;
      } catch (err) {
        if (err instanceof SessionInputUnknownSessionError) return reply.status(404).send({ error: "not found" });
        if (err instanceof SessionInputConflictError) return reply.status(409).send({ error: message(err) });
        if (err instanceof SessionInputInvalidError) return reply.status(400).send({ error: message(err) });
        throw err;
      }
      // The record is already durable; a dispatch fault must never turn a
      // persisted input into a failed request.
      try {
        await inputs.dispatch(messageId);
      } catch (err) {
        app.log.error(err);
      }
      const row = inputs.get(messageId)!;
      // 202 means persisted — never "the provider has it". A message refused on
      // arrival is reported as such rather than dressed up as accepted work.
      return reply.status(row.state === "rejected" || row.state === "expired" ? 422 : 202).send(inputView(row, inputs));
    });

    app.get<{ Params: { sessionId: string }; Querystring: { after?: string; limit?: string } }>(
      "/api/sessions/:sessionId/inputs", read.sessions,
      (req, reply) => {
        if (!inputs.session(req.params.sessionId)) return reply.status(404).send({ error: "not found" });
        const limit = req.query.limit ? Number(req.query.limit) : undefined;
        const rows = inputs.list(req.params.sessionId, { after: req.query.after, limit });
        return { inputs: rows.map((row) => inputView(row, inputs)), nextCursor: rows.at(-1)?.id ?? null };
      },
    );

    // Probe the adapter for this exact session, rather than inferring liveness from configuration.
    app.get<{ Params: { sessionId: string } }>(
      "/api/sessions/:sessionId/input-capability", read.sessions,
      async (req, reply) => {
        if (!inputs.session(req.params.sessionId)) return reply.status(404).send({ error: "not found" });
        return inputs.capability(req.params.sessionId);
      },
    );

    // Explicit session authorization for Codex. Workspace enablement alone grants nothing.
    app.post<{ Params: { sessionId: string }; Body: { enabled?: boolean } }>(
      "/api/sessions/:sessionId/input-enablement", write,
      async (req, reply) => {
        const session = inputs.session(req.params.sessionId);
        if (!session) return reply.status(404).send({ error: "not found" });
        if (typeof req.body?.enabled !== "boolean") return reply.status(400).send({ error: "enabled must be a boolean" });
        const owner = registry.adapter(session.assistantId);
        const adapter = owner instanceof CodexAdapter ? owner.sessionInput : undefined;
        if (!adapter) return reply.status(409).send({ reason: "adapter_input_unsupported" });
        if (!req.body.enabled) adapter.disable(session.sessionId);
        else {
          if (session.sessionState !== "RUNNING" || session.approvalPending) return reply.status(409).send({ reason: "session_not_running" });
          const probe = await adapter.enable({
            sessionId: session.sessionId, assistantId: session.assistantId,
            providerSessionRef: session.providerSessionRef ?? undefined,
          });
          if (!probe.available) return reply.status(409).send(probe);
        }
        return inputs.capability(session.sessionId);
      },
    );

    // Resolves a lost response: the client knows its own message id from the
    // 202 it never received only via this read plus its client key listing.
    app.get<{ Params: { id: string } }>("/api/inputs/:id", read.sessions, (req, reply) => {
      const row = inputs.get(req.params.id);
      if (!row) return reply.status(404).send({ error: "not found" });
      return inputView(row, inputs);
    });

    // ---- Explicit commands over a message id ----
    //
    // Addressed by MESSAGE id, not session id, and authorized exactly like the
    // send path: a record outside this workspace is invisible, so it answers
    // 404 rather than revealing that it exists. A command the record's own
    // state forbids answers 409 with a machine-readable reason — never a
    // silent no-op, because "nothing happened" and "we refused" are different
    // facts to an operator deciding what to do next.
    const command = (
      run: (id: string, actor: string, expectedVersion?: number) => Promise<SessionInputRow | undefined>,
    ) =>
      async (
        req: FastifyRequest<{ Params: { id: string }; Body?: { expectedVersion?: number } }>,
        reply: FastifyReply,
      ) => {
        const actor = `${req.cred?.kind ?? "unknown"}:${req.cred?.kid ?? "unknown"}`;
        try {
          const row = await run(req.params.id, actor, req.body?.expectedVersion);
          if (!row) return reply.status(404).send({ error: "not found" });
          return reply.status(200).send(inputView(row, inputs));
        } catch (err) {
          if (err instanceof SessionInputCommandRejectedError) {
            return reply.status(409).send({ error: message(err), reason: err.reason });
          }
          throw err;
        }
      };

    app.post<{ Params: { id: string }; Body?: { expectedVersion?: number } }>(
      "/api/inputs/:id/retry", write,
      command((id, actor, expectedVersion) => inputs.retry(id, actor, expectedVersion)),
    );

    app.post<{ Params: { id: string }; Body?: { expectedVersion?: number } }>(
      "/api/inputs/:id/cancel", write,
      command(async (id, actor, expectedVersion) => inputs.cancel(id, actor, expectedVersion)),
    );

    // ---- Scheduler-owned redelivery ----
    //
    // The kernel already announces every task-state change on the task bus;
    // that is the signal, and this subscribes to it rather than inventing a
    // second one or polling. A message queued behind a quota pause or a
    // pending approval therefore resumes on its own when the condition clears,
    // with no client action.
    //
    // Work is chained rather than started inline for two reasons: a publish can
    // happen inside a SQLite transaction, and serializing the pump means two
    // announcements can never dispatch the same message twice.
    let pump: Promise<unknown> = Promise.resolve();
    sessionInputRedelivery = () => pump;
    const unwatch = bus.subscribeAll((taskId, payload) => {
      if (payload.kind !== "state") return;
      pump = pump.then(() =>
        inputs.redeliverForTask(taskId).catch((err) => {
          app.log.error(err, "session-input redelivery failed");
        }),
      );
    });
    app.addHook("onClose", async () => unwatch());
  }

  deps.registerExtraRoutes?.(app);
  app.setErrorHandler((error, _req, reply) => {
    const statusCode = error && typeof error === "object" && "statusCode" in error &&
      typeof error.statusCode === "number" ? error.statusCode : 500;
    return reply.status(statusCode).send({ error: message(error) });
  });

  const staticRoot = join(dirname(fileURLToPath(import.meta.url)), "../../web/dist");
  if (existsSync(staticRoot)) {
    void app.register(fastifyStatic, { root: staticRoot, wildcard: false });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.split("?")[0]!.startsWith("/api/")) return reply.code(404).send({ error: "not found" });
      return reply.sendFile("index.html");
    });
  }

  return { app, registry, orchestrator, tasks, bus, checkpoints, cooldowns, telemetry, scheduler, quotaProbes: probes, modelCatalog, sessionInputs, sessionInputRedelivery };
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
  reply.raw.write(`data: ${JSON.stringify(redactValue(payload))}\n\n`);
}

function message(err: unknown): string {
  return redactValue(err instanceof Error ? err.message : String(err));
}

/** Parse a durable JSON column; a corrupt one yields null rather than a 500. */
function safeJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function safeLifecycleJson(value: string): unknown {
  return scrubLifecycleValue(redactValue(safeJson(value)));
}

function safeLifecycleJsonArray(value: string): unknown[] {
  const parsed = safeLifecycleJson(value);
  return Array.isArray(parsed) ? parsed : [];
}

/** Redact scalar lifecycle fields too; old rows may predate store sanitization. */
function safeLifecycleText(value: unknown): string | null {
  return typeof value === "string" ? redactValue(value).slice(0, 2_000) : null;
}

function scrubLifecycleValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(scrubLifecycleValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([key]) => !/(claim.?token|transcript|secret)/i.test(key))
    .map(([key, nested]) => [key, scrubLifecycleValue(nested)]));
}

/** One row of the session-list endpoints. */
function sessionSummary(r: Record<string, unknown>): Record<string, unknown> {
  return {
    sessionId: r.id,
    executionRequestId: r.execution_request_id,
    assistantId: r.assistant_id,
    sessionState: r.session_state,
    state: r.state,
    attempt: r.attempt,
    providerStartAcked: r.provider_start_acked === 1,
    cancelRequested: r.cancel_requested === 1,
    settlementOwner: r.settlement_owner,
    correlation: { parentTaskId: r.parent_task_id ?? null, groupId: r.group_id ?? null },
    // Lists expose navigation identity directly; detail keeps it with request provenance.
    target: targetOf(r),
    startedAt: r.started_at,
    endedAt: r.ended_at,
  };
}

/**
 * The canonical wire view of one durable input: the message, every attempt and
 * every normalized trace event. `deliveryUnknown` is surfaced explicitly — a
 * client must never render an unknown outcome as "sent".
 */
function inputView(row: SessionInputRow, service: SessionInputService): Record<string, unknown> {
  return {
    id: row.id,
    sessionId: row.sessionId,
    taskId: row.taskId,
    clientMessageId: row.clientMessageId,
    kind: row.kind,
    text: row.text,
    state: row.state,
    reason: row.reason,
    deliveryUnknown: row.deliveryUnknown,
    version: row.version,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    expiresAt: row.expiresAt,
    providerReceipt: row.providerReceipt,
    generation: row.generation,
    retryOf: row.retryOf,
    attempts: service.attempts(row.id),
    events: service.events(row.id),
  };
}

function targetOf(row: Record<string, unknown>): Record<string, unknown> | null {
  if (row.target_kind === "repository") {
    return { kind: "repository", workspaceId: row.workspace_id, repositoryId: row.repository_id };
  }
  if (row.target_kind === "worktree") {
    return {
      kind: "worktree",
      workspaceId: row.workspace_id,
      repositoryId: row.repository_id,
      worktreeId: row.worktree_id,
    };
  }
  return null;
}
