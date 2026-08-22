import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appliedMigrations, openDb, type Db } from "../src/db/index.js";

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
  it("applies 001_init and is idempotent", () => {
    expect(appliedMigrations(db)).toEqual(["001_init.sql", "002_handoff.sql"]);
    const again = openDb(join(dir, "test.db"));
    expect(appliedMigrations(again)).toEqual(["001_init.sql", "002_handoff.sql"]);
    again.close();
  });

  it("creates the full domain model", () => {
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all()
      .map((r) => (r as { name: string }).name);
    expect(tables).toEqual([
      "assistants",
      "capability_changes",
      "checkpoints",
      "cooldowns",
      "events",
      "handoffs",
      "quota_snapshots",
      "routing_decisions",
      "runs",
      "schema_migrations",
      "task_decisions",
      "tasks",
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
