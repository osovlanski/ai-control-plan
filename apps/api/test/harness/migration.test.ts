/**
 * Phase 1 migration: 005_harness on a seeded LEGACY database
 * (docs/harness-implementation-plan.md Phase 1 — "migration up on a seeded
 * legacy DB"). Verifies the additive columns, the §5 session_state backfill,
 * the new tables, and the load-bearing indexes/constraints.
 */
import { cpSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { migrate } from "../../src/db/index.js";

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), "../../src/db/migrations");

let dir: string;
let db: Database.Database;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "harness-mig-"));
});
afterEach(() => {
  db?.close();
  rmSync(dir, { recursive: true, force: true });
});

/** Apply only migrations strictly before 005 into a throwaway dir. */
function migrateLegacy(database: Database.Database): void {
  const legacyDir = join(dir, "legacy-migrations");
  cpSync(MIGRATIONS, legacyDir, { recursive: true });
  for (const f of readdirSync(legacyDir)) {
    if (/^\d+_/.test(f) && Number(f.slice(0, 3)) >= 5) rmSync(join(legacyDir, f));
  }
  migrate(database, legacyDir);
}

describe("005_harness on a legacy DB", () => {
  beforeEach(() => {
    db = new Database(join(dir, "legacy.db"));
    db.pragma("foreign_keys = ON");
    migrateLegacy(db);

    // Seed one legacy row per old vocabulary value.
    db.prepare("INSERT INTO assistants (id, provider) VALUES ('a1', 'fake')").run();
    db.prepare(
      "INSERT INTO tasks (id, goal, envelope, created_at, updated_at) VALUES ('AG-1', 'g', '{}', 't', 't')",
    ).run();
    const insertRun = db.prepare(
      "INSERT INTO runs (id, task_id, assistant_id, state, started_at) VALUES (?, 'AG-1', 'a1', ?, 't')",
    );
    for (const [id, state] of [
      ["r-starting", "STARTING"],
      ["r-active", "ACTIVE"],
      ["r-ok", "ENDED_OK"],
      ["r-err", "ENDED_ERROR"],
      ["r-cancelled", "CANCELLED"],
    ]) {
      insertRun.run(id, state);
    }
  });

  it("applies cleanly and backfills session_state per the §5 forward map", () => {
    const applied = migrate(db, MIGRATIONS);
    expect(applied).toContain("005_harness.sql");

    const rows = db
      .prepare("SELECT id, state, session_state, version, attempt FROM runs ORDER BY id")
      .all() as Array<{ id: string; state: string; session_state: string; version: number; attempt: number }>;
    const map = Object.fromEntries(rows.map((r) => [r.id, r.session_state]));
    expect(map).toEqual({
      "r-starting": "STARTING",
      "r-active": "RUNNING",
      "r-ok": "COMPLETED",
      "r-err": "FAILED",
      "r-cancelled": "CANCELLED",
    });
    // Legacy column is untouched; new columns get their defaults.
    expect(rows.every((r) => r.version === 0 && r.attempt === 1)).toBe(true);
    expect(rows.find((r) => r.id === "r-active")!.state).toBe("ACTIVE");
  });

  it("creates the new tables and load-bearing indexes", () => {
    migrate(db, MIGRATIONS);
    const tables = (
      db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>
    ).map((r) => r.name);
    for (const t of [
      "execution_requests",
      "approvals",
      "guard_directives",
      "execution_results",
      "handoff_envelopes",
    ]) {
      expect(tables).toContain(t);
    }
    const indexes = (
      db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all() as Array<{ name: string }>
    ).map((r) => r.name);
    expect(indexes).toContain("uq_live_successor");
    expect(indexes).toContain("uq_runs_execution_request");
  });

  it("enforces the two-way handoff-origin CHECK", () => {
    migrate(db, MIGRATIONS);
    const insertReq = db.prepare(
      `INSERT INTO execution_requests
         (id, task_id, attempt, assistant_id, routing_decision_ref, request_fingerprint,
          fingerprint_algorithm, prompt_source, rendered_prompt_digest, policy, verification,
          origin, origin_envelope_id, canonical_projection, created_at)
       VALUES (?, 'AG-1', 1, 'a1', 'rd', ?, 'alg', ?, 'd', '{}', '[]', ?, ?, '{}', 't')`,
    );

    // handoff kind without an envelope id → rejected.
    expect(() => insertReq.run("b1", "fp1", "handoff", '{"kind":"handoff"}', null)).toThrow();
    // non-handoff kind carrying an envelope id → rejected (the other direction).
    expect(() => insertReq.run("b2", "fp2", "fresh", '{"kind":"fresh"}', "env-x")).toThrow();
    // origin with no kind at all → rejected (a NULL sub-expression must not pass).
    expect(() => insertReq.run("b3", "fp3", "fresh", "{}", null)).toThrow();
    // unknown kind → rejected.
    expect(() => insertReq.run("b4", "fp4", "fresh", '{"kind":"telepathy"}', null)).toThrow();

    // Well-formed rows on both sides are accepted.
    expect(() => insertReq.run("ok1", "fp5", "fresh", '{"kind":"fresh"}', null)).not.toThrow();
    expect(() =>
      insertReq.run("ok2", "fp6", "handoff", '{"kind":"handoff","envelopeId":"env-1"}', "env-1"),
    ).not.toThrow();
  });

  it("006 upgrades an already-applied 005 handoff_envelopes to the start_ambiguous protocol", () => {
    // Apply through 005 only.
    const upTo005 = join(dir, "upto-005");
    cpSync(MIGRATIONS, upTo005, { recursive: true });
    for (const f of readdirSync(upTo005)) {
      if (/^\d+_/.test(f) && Number(f.slice(0, 3)) >= 6) rmSync(join(upTo005, f));
    }
    migrate(db, upTo005);
    const cols005 = (
      db.prepare("PRAGMA table_info(handoff_envelopes)").all() as Array<{ name: string }>
    ).map((c) => c.name);
    expect(cols005).not.toContain("start_attempted_at");

    // Now the real dir carries 006 forward.
    expect(migrate(db, MIGRATIONS)).toContain("006_harness_handoff.sql");
    const cols006 = (
      db.prepare("PRAGMA table_info(handoff_envelopes)").all() as Array<{ name: string }>
    ).map((c) => c.name);
    expect(cols006).toEqual(expect.arrayContaining(["claimed_at", "start_attempted_at"]));

    // The new state is accepted; an old-vocabulary value that never existed is not.
    const insertEnv = db.prepare(
      `INSERT INTO checkpoints (id, task_id, run_id, envelope_snapshot, reason, at)
         VALUES ('ck', 'AG-1', 'r-active', '{}', 'handoff', 't')`,
    );
    insertEnv.run();
    const env = db.prepare(
      `INSERT INTO handoff_envelopes
         (id, task_id, checkpoint_id, envelope, state, from_assistant_id, reason, created_at, updated_at)
       VALUES (?, 'AG-1', 'ck', '{}', ?, 'a1', 'r', 't', 't')`,
    );
    expect(() => env.run("e1", "start_ambiguous")).not.toThrow();
    expect(() => env.run("e2", "bogus")).toThrow();
  });

  it("enforces one live successor per handoff envelope", () => {
    migrate(db, MIGRATIONS);
    const insertReq = db.prepare(
      `INSERT INTO execution_requests
         (id, task_id, attempt, assistant_id, routing_decision_ref, request_fingerprint,
          fingerprint_algorithm, prompt_source, rendered_prompt_digest, policy, verification,
          origin, origin_envelope_id, canonical_projection, created_at)
       VALUES (?, 'AG-1', 1, 'a1', 'rd', ?, 'alg', 'handoff', 'd', '{}', '[]',
               '{"kind":"handoff","envelopeId":"env-1"}', 'env-1', '{}', 't')`,
    );
    insertReq.run("s1", "fp1");
    expect(() => insertReq.run("s2", "fp2")).toThrow(); // second live successor blocked
    db.prepare("UPDATE execution_requests SET superseded = 1 WHERE id = 's1'").run();
    expect(() => insertReq.run("s3", "fp3")).not.toThrow(); // corrected successor accepted
  });
});
