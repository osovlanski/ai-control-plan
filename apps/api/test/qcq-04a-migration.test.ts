/**
 * qcq-04a: migration 058 (execution attempts) — the upgrade backfill of review packet 2.3.1 and the
 * schema triggers of 2.3. Section 5 tests 6 (backfill, operator-reconciled upgrade, released-claim
 * owner, counterexamples) and 7 (schema triggers).
 */
import { copyFileSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { migrate, type Db } from "../src/db/index.js";

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), "../src/db/migrations");
const TARGET = "058_execution_attempts.sql";
const T = "2026-11-20T10:00:00.000Z";

let dir: string;
let db: Db;
/** A database at 057, as a pre-upgrade plane left it. */
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "qcq-04a-mig-"));
  for (const f of readdirSync(MIGRATIONS).filter((f) => /^\d+_.+\.sql$/.test(f) && f < TARGET)) copyFileSync(join(MIGRATIONS, f), join(dir, f));
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  migrate(db, dir);
  db.prepare("INSERT INTO assistants (id, provider) VALUES ('a1','fake')").run();
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});
const upgrade = () => {
  copyFileSync(join(MIGRATIONS, TARGET), join(dir, TARGET));
  return migrate(db, dir);
};

let taskSeq = 0;
const task = (over: { mode?: string; run_as?: string } = {}): string => {
  const id = `AG-${String(++taskSeq).padStart(4, "0")}`;
  db.prepare("INSERT INTO tasks (id, goal, envelope, created_at, updated_at, mode, run_as) VALUES (?, 'g', '{}', ?, ?, ?, ?)")
    .run(id, T, T, over.mode ?? "single", over.run_as ?? null);
  return id;
};
const wait = (taskId: string, generation = 1, resource: string | null = "gpu") => {
  db.prepare(`INSERT INTO wait_conditions (task_id, generation, state, kind, not_before, created_by, created_at, reason, resource, resource_units, resource_queued_at)
    VALUES (?, ?, 'consumed', ?, ?, 'user', ?, 'r', ?, ?, ?)`)
    .run(taskId, generation, resource ? "resource" : "time", T, T, resource, resource ? 1 : null, resource ? "2026-11-20T09:00:00.000Z" : null);
};
const dispatch = (taskId: string, id: string, phase: string, path: "legacy" | "harness" = "legacy", generation = 1) => {
  db.prepare(`INSERT INTO dispatches (dispatch_id, task_id, condition_generation, origin, execution_path, phase, created_at, updated_at)
    VALUES (?, ?, ?, 'wake', ?, ?, ?, ?)`).run(id, taskId, generation, path, phase, T, T);
};
const event = (taskId: string, dispatchId: string, type: string, payload: Record<string, unknown> = {}, at = "2026-11-20T10:01:00.000Z") => {
  db.prepare("INSERT INTO scheduler_events (task_id, generation, dispatch_id, type, at, payload) VALUES (?, 1, ?, ?, ?, ?)")
    .run(taskId, dispatchId, type, at, JSON.stringify(payload));
};
const claim = (taskId: string, dispatchId: string, released: boolean, generation = 1): number =>
  Number(db.prepare(`INSERT INTO resource_claims (task_id, dispatch_id, generation, resource, units, claimed_at, released_at, release_reason)
    VALUES (?, ?, ?, 'gpu', 1, ?, ?, ?)`).run(taskId, dispatchId, generation, T, released ? "2026-11-20T10:05:00.000Z" : null, released ? "task terminal" : null).lastInsertRowid);
const run = (taskId: string, id: string, opts: { dispatchId?: string; ended?: boolean; startedAt?: string; harness?: boolean } = {}) => {
  // 005 backfills session_state on legacy runs too, so only execution_request_id marks a Harness run.
  db.prepare(`INSERT INTO runs (id, task_id, assistant_id, state, started_at, ended_at, dispatch_id, session_state, execution_request_id)
    VALUES (?, ?, 'a1', 'ACTIVE', ?, ?, ?, ?, ?)`)
    .run(id, taskId, opts.startedAt ?? "2026-11-20T10:02:00.000Z", opts.ended ? "2026-11-20T10:09:00.000Z" : null, opts.dispatchId ?? null,
      opts.ended ? "COMPLETED" : "RUNNING", opts.harness ? `erq_${id}` : null);
};
type Att = { attempt_id: string; state: string; entered_at: string | null; exit_proof: string | null; session_id: string | null;
  candidate_slot: number; kind: string; execution_path: string; reason: string | null; account_source: string; account_key: string | null };
const attempts = (taskId: string): Att[] =>
  db.prepare("SELECT * FROM execution_attempts WHERE task_id = ? ORDER BY candidate_slot, attempt_id").all(taskId) as Att[];
const liveClaims = (taskId: string) =>
  db.prepare("SELECT claim_id, attempt_id FROM resource_claims WHERE task_id = ? AND released_at IS NULL").all(taskId);

describe("migration 058 upgrade backfill (packet 2.3.1)", () => {
  it("applies after 057 on an empty database and passes the foreign-key check", () => {
    expect(upgrade()).toEqual([TARGET]);
    expect(db.prepare("SELECT COUNT(*) n FROM execution_attempts").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT * FROM pragma_foreign_key_check").all()).toEqual([]);
  });

  it("classifies every pre-upgrade row as section 2.3.1 says, first match wins", () => {
    // row 1: live run carrying the dispatch, claim released (K4b released at task terminal)
    const t1 = task(); wait(t1); dispatch(t1, "d1", "started"); event(t1, "d1", "dispatch.start_attempted");
    const c1 = claim(t1, "d1", true); run(t1, "r1", { dispatchId: "d1" });
    // row 2: ended run, live claim -> settled migrated_historical, the claim released
    const t2 = task(); wait(t2); dispatch(t2, "d2", "started"); event(t2, "d2", "dispatch.start_attempted");
    const c2 = claim(t2, "d2", false); run(t2, "r2", { dispatchId: "d2", ended: true });
    // row 2: released historical claim with a run
    const t2b = task(); wait(t2b); dispatch(t2b, "d2b", "started"); event(t2b, "d2b", "dispatch.start_attempted");
    claim(t2b, "d2b", true); run(t2b, "r2b", { dispatchId: "d2b", ended: true });
    // row 3: legacy entry mark, no run, dispatch now cancelled, live claim -> ambiguous
    const t3 = task(); wait(t3); dispatch(t3, "d3", "cancelled"); event(t3, "d3", "dispatch.start_attempted"); claim(t3, "d3", false);
    // row 3: legacy entry mark, no run, released claim -> ambiguous, zero pool units, k4b_released_before_upgrade
    const t3r = task(); wait(t3r); dispatch(t3r, "d3r", "cancelled"); event(t3r, "d3r", "dispatch.start_attempted"); claim(t3r, "d3r", true);
    // row 3: legacy entry mark, no run, no claim
    const t3n = task(); wait(t3n, 1, null); dispatch(t3n, "d3n", "start_attempted"); event(t3n, "d3n", "dispatch.start_attempted");
    // row 3b: operator-confirmed legacy entry mark (runNow(..., true)), live claim
    const t3b = task(); wait(t3b); dispatch(t3b, "d3b", "aborted"); event(t3b, "d3b", "dispatch.start_attempted");
    event(t3b, "d3b", "dispatch.aborted", { reason: "Operator confirmed no live execution owner" }); claim(t3b, "d3b", false);
    // row 4: Harness entry mark, no session, claim -> dropped never_entered
    const t4 = task(); wait(t4); dispatch(t4, "d4", "reparked", "harness"); event(t4, "d4", "dispatch.start_attempted"); claim(t4, "d4", false);
    // row 5: Harness entry mark, no session, no claim -> nothing
    const t5 = task(); wait(t5, 1, null); dispatch(t5, "d5", "reparked", "harness"); event(t5, "d5", "dispatch.start_attempted");
    // row 6: live claim on a reserved dispatch -> held (an autopilot pool claim is the same row)
    const t6 = task({ run_as: "agent" }); wait(t6); dispatch(t6, "d6", "reserved"); const c6 = claim(t6, "d6", false);
    // row 7: released claim, no mark, no run -> dropped never_entered
    const t7 = task(); wait(t7); dispatch(t7, "d7", "reparked"); claim(t7, "d7", true);
    // compare task with two live pre-upgrade runs of equal started_at -> slots 1, 2 by run id
    const tc = task({ mode: "compare" }); run(tc, "f_z"); run(tc, "f_a");
    // a live direct run with no dispatch
    const td = task(); run(td, "rd", { harness: true });

    upgrade();
    expect(db.prepare("SELECT * FROM pragma_foreign_key_check").all()).toEqual([]);
    const one = (t: string) => { const a = attempts(t); expect(a).toHaveLength(1); return a[0]!; };

    expect(one(t1)).toMatchObject({ attempt_id: `att_mig_${c1}`, state: "live", entered_at: "2026-11-20T10:02:00.000Z", session_id: "r1", reason: "k4b_released_before_upgrade" });
    expect(liveClaims(t1)).toEqual([]);
    expect(one(t2)).toMatchObject({ attempt_id: `att_mig_${c2}`, state: "settled", exit_proof: "migrated_historical", session_id: "r2" });
    expect(liveClaims(t2)).toEqual([]);
    expect(one(t2b)).toMatchObject({ state: "settled", exit_proof: "migrated_historical" });
    expect(one(t3)).toMatchObject({ state: "ambiguous", entered_at: "2026-11-20T10:01:00.000Z", exit_proof: null });
    expect(liveClaims(t3)).toHaveLength(1);
    expect(one(t3r)).toMatchObject({ state: "ambiguous", reason: "k4b_released_before_upgrade" });
    expect(liveClaims(t3r)).toEqual([]);
    expect(one(t3n)).toMatchObject({ attempt_id: "att_mig_d_d3n", state: "ambiguous" });
    expect(one(t3b)).toMatchObject({ state: "settled", exit_proof: "operator_confirmed" });
    expect(liveClaims(t3b)).toEqual([]);
    expect(one(t4)).toMatchObject({ state: "dropped", exit_proof: "never_entered", entered_at: null });
    expect(liveClaims(t4)).toEqual([]);
    expect(attempts(t5)).toEqual([]);
    expect(one(t6)).toMatchObject({ attempt_id: `att_mig_${c6}`, state: "held", entered_at: null });
    expect(liveClaims(t6)).toEqual([{ claim_id: c6, attempt_id: `att_mig_${c6}` }]);
    expect(db.prepare("SELECT resource, units FROM attempt_requirements WHERE attempt_id = ?").all(`att_mig_${c6}`)).toEqual([{ resource: "gpu", units: 1 }]);
    expect(db.prepare("SELECT run_as FROM execution_attempts WHERE task_id = ?").get(t6)).toEqual({ run_as: "agent" });
    expect(one(t7)).toMatchObject({ state: "dropped", exit_proof: "never_entered" });
    expect(attempts(tc).map((a) => [a.attempt_id, a.candidate_slot, a.kind])).toEqual([["att_mig_run_f_a", 1, "candidate"], ["att_mig_run_f_z", 2, "candidate"]]);
    expect(one(td)).toMatchObject({ attempt_id: "att_mig_run_rd", kind: "direct", candidate_slot: 0, execution_path: "harness", state: "live", account_source: "unresolved" });
    // No migrated row is starting, and none carries an account.
    expect(db.prepare("SELECT COUNT(*) n FROM execution_attempts WHERE state = 'starting' OR account_key IS NOT NULL").get()).toEqual({ n: 0 });
  });

  it("keeps extra open runs on one single task as owners on the next slots, ended runs and terminal tasks as none", () => {
    // A crash can leave a legacy run open beside a later one; boot reconcile ends it after the upgrade.
    const t = task(); run(t, "x2", { startedAt: "2026-11-20T10:03:00.000Z" }); run(t, "x1");
    // Open run in a legacy end state, and an open run on a terminal task: not owners.
    const te = task(); run(te, "e1");
    db.prepare("UPDATE runs SET state = 'ENDED_ERROR' WHERE id = 'e1'").run();
    const tt = task(); run(tt, "t1");
    db.prepare("UPDATE tasks SET state = 'FAILED' WHERE id = ?").run(tt);
    upgrade();
    expect(attempts(t).map((a) => [a.attempt_id, a.candidate_slot, a.kind, a.state, a.execution_path, a.reason])).toEqual([
      ["att_mig_run_x1", 0, "direct", "live", "legacy", "migrated: open run"],
      ["att_mig_run_x2", 1, "direct", "live", "legacy", "migrated: extra open run on a single task"],
    ]);
    expect(attempts(te)).toEqual([]);
    expect(attempts(tt)).toEqual([]);
  });

  it("#264 review finding 3: a terminal task's open dispatch run with a released claim is row 1, owning zero units", () => {
    const t = task(); wait(t); dispatch(t, "dc", "cancelled"); event(t, "dc", "dispatch.start_attempted");
    const c = claim(t, "dc", true); run(t, "rc", { dispatchId: "dc" });
    db.prepare("UPDATE tasks SET state = 'CANCELLED' WHERE id = ?").run(t);
    upgrade();
    expect(attempts(t).map((a) => [a.attempt_id, a.state, a.session_id, a.exit_proof, a.reason])).toEqual([
      [`att_mig_${c}`, "live", "rc", null, "k4b_released_before_upgrade"],
    ]);
    expect(db.prepare("SELECT COUNT(*) n FROM attempt_requirements WHERE attempt_id = ?").get(`att_mig_${c}`)).toEqual({ n: 0 });
    expect(liveClaims(t)).toEqual([]);
  });

  it("aborts by name when two dispatch owners share a slot", () => {
    const t = task(); wait(t, 1); wait(t, 2);
    // A started dispatch whose run is still open (row 1) and a newer reserved one with a live claim (row 6).
    dispatch(t, "dx1", "started", "legacy", 1); event(t, "dx1", "dispatch.start_attempted"); run(t, "rx1", { dispatchId: "dx1" });
    dispatch(t, "dx2", "reserved", "legacy", 2); claim(t, "dx2", false, 2);
    expect(() => upgrade()).toThrow(/qcq_backfill_two_owners: task AG-\d+ slot 0 has 2 open owners/);
    // The migration rolled back as a whole: the K4b schema is still in place.
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'execution_attempts'").get()).toBeUndefined();
  });
});

describe("migration 058 schema triggers (packet 2.3)", () => {
  beforeEach(() => { upgrade(); });
  const insertAttempt = (over: Record<string, unknown>) => {
    const row = { attempt_id: "a", task_id: "", kind: "direct", execution_path: "harness", candidate_slot: 0, run_as: "plane",
      account_key: null, account_source: "none", queue_key: T, state: "held", entered_at: null, entered_boot_id: null,
      predecessor_id: null, occupies_account: null, created_at: T, updated_at: T, ...over };
    db.prepare(`INSERT INTO execution_attempts (attempt_id, task_id, kind, execution_path, candidate_slot, run_as, account_key, account_source, queue_key, state, entered_at, entered_boot_id, predecessor_id, occupies_account, created_at, updated_at)
      VALUES (@attempt_id, @task_id, @kind, @execution_path, @candidate_slot, @run_as, @account_key, @account_source, @queue_key, @state, @entered_at, @entered_boot_id, @predecessor_id, @occupies_account, @created_at, @updated_at)`).run(row);
  };
  const live = { state: "live", entered_at: T, entered_boot_id: "b" };

  it("admits only the owner's named successor beside it, in every write direction", () => {
    const t = task();
    insertAttempt({ attempt_id: "o", task_id: t, ...live });
    expect(() => insertAttempt({ attempt_id: "q0", task_id: t, state: "queued" })).toThrow(/must name the owner/);
    insertAttempt({ attempt_id: "q1", task_id: t, state: "queued", predecessor_id: "o" });
    expect(() => db.prepare("UPDATE execution_attempts SET predecessor_id = NULL WHERE attempt_id = 'q1'").run()).toThrow(/must name the owner/);
    // reverse order: an unrelated queued row first, then an owner in the same slot
    insertAttempt({ attempt_id: "u", task_id: t, state: "queued", candidate_slot: 4 });
    expect(() => insertAttempt({ attempt_id: "o2", task_id: t, candidate_slot: 4, ...live })).toThrow(/not this owner's successor/);
    // moving a queued row into an owned slot
    insertAttempt({ attempt_id: "m", task_id: t, state: "queued", candidate_slot: 5 });
    expect(() => db.prepare("UPDATE execution_attempts SET candidate_slot = 0 WHERE attempt_id = 'm'").run()).toThrow(/must name the owner|UNIQUE/);
  });

  it("keeps claims immutable and undeletable, and forbids account claims on legacy attempts", () => {
    const t = task(); wait(t);
    insertAttempt({ attempt_id: "L", task_id: t, execution_path: "legacy", ...live });
    const ins = (attempt: string, resource: string) => db.prepare("INSERT INTO resource_claims (attempt_id, task_id, generation, resource, units, claimed_at) VALUES (?, ?, 1, ?, 1, ?)").run(attempt, t, resource, T);
    expect(() => ins("L", "account:A")).toThrow(/requires a Harness owner attempt/);
    ins("L", "gpu");
    expect(() => db.prepare("UPDATE resource_claims SET resource = 'account:A' WHERE attempt_id = 'L'").run()).toThrow(/identity is immutable/);
    db.prepare("UPDATE resource_claims SET released_at = ?, release_reason = 'done' WHERE attempt_id = 'L'").run(T);
    expect(() => db.prepare("DELETE FROM resource_claims WHERE attempt_id = 'L'").run()).toThrow(/never deleted/);
  });

  it("rejects a weak proof once an account claim ever existed, and occupies_account beside account_key", () => {
    const t = task(); wait(t);
    insertAttempt({ attempt_id: "H", task_id: t, ...live });
    db.prepare("INSERT INTO resource_claims (attempt_id, task_id, generation, resource, units, claimed_at, released_at) VALUES ('H', ?, 1, 'account:A', 1, ?, NULL)").run(t, T);
    db.prepare("UPDATE resource_claims SET released_at = ? WHERE attempt_id = 'H'").run(T);
    for (const proof of ["boot_unverified", "task_terminal_unverified", "stream_closed_unverified"]) {
      expect(() => db.prepare("UPDATE execution_attempts SET state = 'settled', exit_proof = ? WHERE attempt_id = 'H'").run(proof)).toThrow(/weak exit proof/);
    }
    expect(() => insertAttempt({ attempt_id: "X", task_id: t, candidate_slot: 3, account_key: "account:A", account_source: "declared", occupies_account: "account:A", ...live }))
      .toThrow(/CHECK constraint failed/);
    insertAttempt({ attempt_id: "att_mig_run_x", task_id: t, candidate_slot: 2, occupies_account: "account:A", ...live, entered_boot_id: null });
    db.prepare("UPDATE execution_attempts SET state = 'settled', exit_proof = 'boot_unverified' WHERE attempt_id = 'att_mig_run_x'").run();
  });
});

describe("migration 059 attempt guards (#264 review)", () => {
  beforeEach(() => {
    upgrade();
    copyFileSync(join(MIGRATIONS, "059_attempt_guards.sql"), join(dir, "059_attempt_guards.sql"));
    expect(migrate(db, dir)).toEqual(["059_attempt_guards.sql"]);
  });
  const insertAttempt = (over: Record<string, unknown>) => {
    const row = { attempt_id: "a", task_id: "", kind: "direct", execution_path: "harness", candidate_slot: 0, run_as: "plane",
      account_source: "none", queue_key: T, state: "held", entered_at: null, entered_boot_id: null, predecessor_id: null, created_at: T, updated_at: T, ...over };
    db.prepare(`INSERT INTO execution_attempts (attempt_id, task_id, kind, execution_path, candidate_slot, run_as, account_source, queue_key, state, entered_at, entered_boot_id, predecessor_id, created_at, updated_at)
      VALUES (@attempt_id, @task_id, @kind, @execution_path, @candidate_slot, @run_as, @account_source, @queue_key, @state, @entered_at, @entered_boot_id, @predecessor_id, @created_at, @updated_at)`).run(row);
  };
  const live = { state: "live", entered_at: T, entered_boot_id: "b" };

  it("refuses moving an existing owner into a slot that holds an unrelated queued row", () => {
    const t = task();
    insertAttempt({ attempt_id: "q", task_id: t, state: "queued", candidate_slot: 3 });
    insertAttempt({ attempt_id: "h", task_id: t, candidate_slot: 1 });
    insertAttempt({ attempt_id: "l", task_id: t, candidate_slot: 2, ...live });
    expect(() => db.prepare("UPDATE execution_attempts SET candidate_slot = 3 WHERE attempt_id = 'h'").run()).toThrow(/not this owner's successor/);
    const t2 = task();
    insertAttempt({ attempt_id: "q2", task_id: t2, state: "queued", candidate_slot: 2 });
    expect(() => db.prepare("UPDATE execution_attempts SET task_id = ? WHERE attempt_id = 'l'").run(t2)).toThrow(/not this owner's successor/);
    // The named successor's own owner may still move into nothing, and a plain state step is unaffected.
    db.prepare("UPDATE execution_attempts SET state = 'starting', entered_at = ?, entered_boot_id = 'b' WHERE attempt_id = 'h'").run(T);
  });

  it("keeps claim_id, claimed_at and generation immutable, and refuses a REPLACE that would erase a claim", () => {
    const t = task(); wait(t);
    insertAttempt({ attempt_id: "H", task_id: t, ...live });
    db.prepare("INSERT INTO resource_claims (attempt_id, task_id, generation, resource, units, claimed_at) VALUES ('H', ?, 1, 'account:A', 1, ?)").run(t, T);
    const id = (db.prepare("SELECT claim_id FROM resource_claims WHERE attempt_id = 'H'").get() as { claim_id: number }).claim_id;
    expect(() => db.prepare("UPDATE resource_claims SET claim_id = claim_id + 100 WHERE claim_id = ?").run(id)).toThrow(/identity is immutable/);
    expect(() => db.prepare("UPDATE resource_claims SET claimed_at = ? WHERE claim_id = ?").run("2030-01-01T00:00:00.000Z", id)).toThrow(/identity is immutable/);
    expect(() => db.prepare("UPDATE resource_claims SET generation = NULL WHERE claim_id = ?").run(id)).toThrow(/identity is immutable/);
    // The repository connection's default: a REPLACE would delete without firing the DELETE trigger.
    expect(db.pragma("recursive_triggers", { simple: true })).toBe(0);
    expect(() => db.prepare("INSERT OR REPLACE INTO resource_claims (claim_id, attempt_id, task_id, generation, resource, units, claimed_at) VALUES (?, 'H', ?, 1, 'gpu', 1, ?)").run(id, t, T))
      .toThrow(/never replaced/);
    expect(() => db.prepare("INSERT OR REPLACE INTO resource_claims (attempt_id, task_id, generation, resource, units, claimed_at) VALUES ('H', ?, 1, 'account:A', 1, ?)").run(t, T))
      .toThrow(/never replaced/);
    // The account evidence survives, so a weak proof is still refused.
    expect(db.prepare("SELECT resource FROM resource_claims WHERE claim_id = ?").get(id)).toEqual({ resource: "account:A" });
    expect(() => db.prepare("UPDATE execution_attempts SET state = 'settled', exit_proof = 'boot_unverified' WHERE attempt_id = 'H'").run()).toThrow(/weak exit proof/);
    // A release, and a fresh claim after it, are still ordinary writes.
    db.prepare("UPDATE resource_claims SET released_at = ?, release_reason = 'done' WHERE claim_id = ?").run(T, id);
    db.prepare("INSERT INTO resource_claims (attempt_id, task_id, generation, resource, units, claimed_at) VALUES ('H', ?, 1, 'account:A', 1, ?)").run(t, T);
  });
});
