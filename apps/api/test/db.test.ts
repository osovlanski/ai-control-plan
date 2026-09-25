import { copyFileSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { appliedMigrations, migrate, openDb, type Db } from "../src/db/index.js";

let dir: string;
let db: Db;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "agent-plane-db-"));
  db = openDb(join(dir, "test.db"));
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("migrations", () => {
  it("applies every migration on disk, in order, and is idempotent", () => {
    // Derived from the migrations directory rather than a hardcoded list: this
    // test is about ordering and idempotency, and hardcoding the set made it
    // fail for no real reason in three consecutive phases.
    const onDisk = readdirSync(new URL("../src/db/migrations", import.meta.url))
      .filter((f) => f.endsWith(".sql"))
      .sort();
    expect(onDisk.length).toBeGreaterThan(0);
    expect(new Set(onDisk.map((name) => name.split("_")[0])).size).toBe(onDisk.length);
    expect(appliedMigrations(db)).toEqual(onDisk);

    const again = openDb(join(dir, "test.db"));
    expect(appliedMigrations(again)).toEqual(onDisk); // re-opening applies nothing new
    again.close();
  });

  it("upgrades main's decision schema without changing existing records", () => {
    const migrations = new URL("../src/db/migrations/", import.meta.url);
    const baselineDir = mkdtempSync(join(dir, "main-migrations-"));
    for (const name of readdirSync(migrations).filter((name) => /^0(?:0\d|1\d|2[0-7])_/.test(name))) {
      copyFileSync(new URL(name, migrations), join(baselineDir, name));
    }
    const baseline = new Database(join(dir, "upgrade.db"));
    try {
      baseline.pragma("foreign_keys = ON");
      expect(migrate(baseline, baselineDir)).toHaveLength(27);
      baseline.prepare(`INSERT INTO decision_records
        (site, provider, question_set_hash, answers_json, latency_ms, mode, created_at)
        VALUES ('tool-gate', 'rules', 'test-hash', '{}', 0, 'shadow', '2026-09-24')`).run();
      const record = baseline.prepare("SELECT * FROM decision_records").get();
      expect(migrate(baseline)).toEqual(["028_session_input.sql", "029_session_input_commands.sql"]);
      expect(baseline.prepare("SELECT * FROM decision_records").get()).toEqual(record);
      expect(baseline.prepare("SELECT COUNT(*) AS n FROM session_inputs").get()).toEqual({ n: 0 });
      expect(migrate(baseline)).toEqual([]);
    } finally {
      baseline.close();
    }
  });

  it("creates the full domain model", () => {
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all()
      .map((r) => (r as { name: string }).name);
    expect(tables).toEqual([
      "approvals",
      "assistants",
      "bootstrap_jti",
      "capability_changes",
      "capability_probes",
      "checkpoints",
      "comparisons",
      "cooldowns",
      "decision_records",
      "dispatches",
      "event_archives",
      "events",
      "execution_requests",
      "execution_results",
      "guard_directives",
      "handoff_envelopes",
      "handoffs",
      "model_catalog",
      "model_catalog_refresh",
      "model_prices",
      "quota_probes",
      "quota_snapshots",
      "repository_identities",
      "repository_identity_observations",
      "resource_claims",
      "routing_decisions",
      "runs",
      "schedule_occurrences",
      "scheduler_events",
      "scheduler_state",
      "schedules",
      "schema_migrations",
      "session_input_attempts",
      "session_input_events",
      "session_inputs",
      "task_decisions",
      "tasks",
      "verification_plan_revisions",
      "verification_runs",
      "wait_conditions",
      "workspace_identities",
      "worktree_identities",
    ]);
  });

  it("enforces the load-bearing Task 1..n Runs relationship", () => {
    db.prepare("INSERT INTO assistants (id, provider) VALUES ('personal-claude', 'anthropic')").run();
    db.prepare(
      "INSERT INTO tasks (id, goal, envelope, created_at, updated_at) VALUES ('AG-1', 'g', '{}', 't', 't')",
    ).run();
    const insertRun = db.prepare(
      "INSERT INTO runs (id, task_id, assistant_id, state, started_at) VALUES (?, 'AG-1', 'personal-claude', 'ACTIVE', 't')",
    );
    insertRun.run("run-a");
    insertRun.run("run-b"); // failover creates a second run on the same task
    expect(db.prepare("SELECT COUNT(*) AS n FROM runs WHERE task_id='AG-1'").get()).toEqual({ n: 2 });

    // FK enforcement: a run cannot reference a missing task
    expect(() =>
      db
        .prepare("INSERT INTO runs (id, task_id, assistant_id, state, started_at) VALUES ('run-c', 'AG-404', 'personal-claude', 'ACTIVE', 't')")
        .run(),
    ).toThrow();
  });

  it("keeps events append-only-unique per run", () => {
    db.prepare("INSERT INTO assistants (id, provider) VALUES ('a', 'openai')").run();
    db.prepare("INSERT INTO tasks (id, goal, envelope, created_at, updated_at) VALUES ('AG-2', 'g', '{}', 't', 't')").run();
    db.prepare("INSERT INTO runs (id, task_id, assistant_id, state, started_at) VALUES ('r1', 'AG-2', 'a', 'ACTIVE', 't')").run();
    const insert = db.prepare("INSERT INTO events (run_id, seq, ts, type, summary) VALUES ('r1', ?, 't', 'message', 's')");
    insert.run(1);
    insert.run(2);
    expect(() => insert.run(2)).toThrow(); // duplicate seq in a run is rejected
  });
});
