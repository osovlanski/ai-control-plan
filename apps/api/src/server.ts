import Fastify, { type FastifyInstance } from "fastify";
import type { ResolvedConfig } from "./config.js";
import { appliedMigrations, type Db } from "./db/index.js";

export interface ServerDeps {
  config: ResolvedConfig;
  db: Db;
}

export function buildServer({ config, db }: ServerDeps): FastifyInstance {
  const app = Fastify({ logger: true });

  app.get("/api/health", () => ({
    status: "ok",
    workspace: config.workspace,
    migrations: appliedMigrations(db).length,
    now: new Date().toISOString(),
  }));

  app.get("/api/workspace", () => ({
    workspace: config.workspace,
    repoAllowlist: config.repoAllowlist,
    failover: config.failover,
    sync: config.sync,
  }));

  // Phase 1 fills these with real registry/task modules; the shapes are stable now.
  app.get("/api/assistants", () => {
    return db
      .prepare("SELECT id, provider, tier, enabled, manifest_updated_at FROM assistants ORDER BY id")
      .all();
  });

  app.get("/api/tasks", () => {
    return db
      .prepare("SELECT id, goal, state, activity_phase, profile, created_at, updated_at FROM tasks ORDER BY created_at DESC")
      .all();
  });

  return app;
}
