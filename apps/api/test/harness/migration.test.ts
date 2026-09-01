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

  it("006 rebuilds an already-applied 005 handoff_envelopes, preserving rows and FKs", () => {
    // Apply through 005 only.
    const upTo005 = join(dir, "upto-005");
    cpSync(MIGRATIONS, upTo005, { recursive: true });
    for (const f of readdirSync(upTo005)) {
      if (/^\d+_/.test(f) && Number(f.slice(0, 3)) >= 6) rmSync(join(upTo005, f));
    }
    migrate(db, upTo005);
    expect(
      (db.prepare("PRAGMA table_info(handoff_envelopes)").all() as Array<{ name: string }>).map((c) => c.name),
    ).not.toContain("start_attempted_at");

    // Seed one envelope per 005-era state, plus a claimed one with a real
    // execution_requests FK, so the rebuild's row-copy + FK survival is exercised.
    db.prepare(
      `INSERT INTO checkpoints (id, task_id, run_id, envelope_snapshot, reason, at)
         VALUES ('ck', 'AG-1', 'r-active', '{}', 'handoff', 't')`,
    ).run();
    db.prepare(
      `INSERT INTO execution_requests
         (id, task_id, attempt, assistant_id, routing_decision_ref, request_fingerprint,
          fingerprint_algorithm, prompt_source, prompt_source_ref, rendered_prompt_digest, policy,
          verification, origin, origin_envelope_id, canonical_projection, created_at)
       VALUES ('req-c', 'AG-1', 2, 'a1', 'rd', 'fp', 'alg', 'handoff', 'env-claimed', 'd', '{}', '[]',
               '{"kind":"handoff","envelopeId":"env-claimed"}', 'env-claimed', '{}', 't')`,
    ).run();
    const insEnv = db.prepare(
      `INSERT INTO handoff_envelopes
         (id, task_id, checkpoint_id, envelope, state, claimed_by_request_id, from_assistant_id, reason, created_at, updated_at)
       VALUES (?, 'AG-1', 'ck', '{"k":1}', ?, ?, 'a1', 'r', 't', 't')`,
    );
    insEnv.run("env-ready", "ready", null);
    insEnv.run("env-claimed", "claimed", "req-c");
    insEnv.run("env-consumed", "consumed", null);
    insEnv.run("env-released", "released", null);

    // 006 rebuilds the table.
    expect(migrate(db, MIGRATIONS)).toContain("006_harness_handoff.sql");
    expect(
      (db.prepare("PRAGMA table_info(handoff_envelopes)").all() as Array<{ name: string }>).map((c) => c.name),
    ).toEqual(expect.arrayContaining(["claimed_at", "start_attempted_at"]));

    // Every seeded row survived with its state, envelope JSON and claim FK.
    const rows = db
      .prepare("SELECT id, state, envelope, claimed_by_request_id FROM handoff_envelopes ORDER BY id")
      .all() as Array<{ id: string; state: string; envelope: string; claimed_by_request_id: string | null }>;
    expect(rows.map((r) => [r.id, r.state, r.claimed_by_request_id])).toEqual([
      ["env-claimed", "claimed", "req-c"],
      ["env-consumed", "consumed", null],
      ["env-ready", "ready", null],
      ["env-released", "released", null],
    ]);
    expect(rows.every((r) => r.envelope === '{"k":1}')).toBe(true);
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(
      (db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all() as Array<{ name: string }>).map(
        (r) => r.name,
      ),
    ).toContain("idx_handoff_envelopes_task");

    // The new state is accepted post-rebuild; a bogus one is not.
    const env = db.prepare(
      `INSERT INTO handoff_envelopes
         (id, task_id, checkpoint_id, envelope, state, from_assistant_id, reason, created_at, updated_at)
       VALUES (?, 'AG-1', 'ck', '{}', ?, 'a1', 'r', 't', 't')`,
    );
    expect(() => env.run("env-sa", "start_ambiguous")).not.toThrow();
    expect(() => env.run("env-bogus", "telepathy")).toThrow();
  });

  describe("008_state_vocab_authority backfill", () => {
    /** Apply migrations up to (not including) 008. */
    function migrateUpTo008(database: Database.Database): void {
      const upTo = join(dir, "upto-008");
      cpSync(MIGRATIONS, upTo, { recursive: true });
      for (const f of readdirSync(upTo)) {
        if (/^\d+_/.test(f) && Number(f.slice(0, 3)) >= 8) rmSync(join(upTo, f));
      }
      migrate(database, upTo);
    }

    it("re-aligns a drifted legacy session_state with the §5 forward map", () => {
      migrateUpTo008(db);
      // Drift the backfilled legacy session_state values.
      db.prepare("UPDATE runs SET session_state = 'STARTING' WHERE execution_request_id IS NULL").run();

      expect(migrate(db, MIGRATIONS)).toContain("008_state_vocab_authority.sql");

      const map = Object.fromEntries(
        (
          db.prepare("SELECT id, session_state FROM runs WHERE execution_request_id IS NULL").all() as Array<{
            id: string;
            session_state: string;
          }>
        ).map((r) => [r.id, r.session_state]),
      );
      expect(map).toEqual({
        "r-starting": "STARTING",
        "r-active": "RUNNING",
        "r-ok": "COMPLETED",
        "r-err": "FAILED",
        "r-cancelled": "CANCELLED",
      });
      // Legacy `state` column untouched.
      expect((db.prepare("SELECT state FROM runs WHERE id = 'r-ok'").get() as { state: string }).state).toBe("ENDED_OK");
    });

    it("does not touch harness rows (execution_request_id IS NOT NULL)", () => {
      migrateUpTo008(db);
      db.prepare(
        `INSERT INTO execution_requests
           (id, task_id, attempt, assistant_id, routing_decision_ref, request_fingerprint,
            fingerprint_algorithm, prompt_source, rendered_prompt_digest, policy, verification,
            origin, canonical_projection, created_at)
         VALUES ('erq-h', 'AG-1', 1, 'a1', 'rd', 'fp', 'alg', 'fresh', 'd', '{}', '[]',
                 '{"kind":"fresh"}', '{}', 't')`,
      ).run();
      db.prepare(
        `INSERT INTO runs (id, task_id, assistant_id, state, session_state, execution_request_id, started_at)
         VALUES ('es-h', 'AG-1', 'a1', 'ACTIVE', 'AWAITING_APPROVAL', 'erq-h', 't')`,
      ).run();

      migrate(db, MIGRATIONS);
      expect(
        (db.prepare("SELECT session_state FROM runs WHERE id = 'es-h'").get() as { session_state: string })
          .session_state,
      ).toBe("AWAITING_APPROVAL"); // not stomped by the state='ACTIVE' → 'RUNNING' map
    });

    it("leaves an unknown legacy state value unchanged (surfaces, not masked)", () => {
      migrateUpTo008(db);
      db.prepare("UPDATE runs SET state = 'WEIRD', session_state = 'WEIRD' WHERE id = 'r-active'").run();

      migrate(db, MIGRATIONS);
      const row = db.prepare("SELECT state, session_state FROM runs WHERE id = 'r-active'").get() as {
        state: string;
        session_state: string;
      };
      expect(row).toEqual({ state: "WEIRD", session_state: "WEIRD" });
    });
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
