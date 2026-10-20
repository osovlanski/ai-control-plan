/**
 * M2 Composer S3: migration 034 — append-only attempt log and per-task opt-ins.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appliedMigrations, openDb, type Db } from "../src/db/index.js";

let dir: string;
let db: Db;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "migration-034-"));
  db = openDb(join(dir, "t.db"));
  db.prepare("INSERT INTO assistants (id, provider) VALUES ('a1','fake')").run();
  db.prepare("INSERT INTO tasks (id, goal, envelope, created_at, updated_at) VALUES ('AG-0001','g','{}','t','t')").run();
  db.prepare("INSERT INTO tasks (id, goal, envelope, created_at, updated_at) VALUES ('AG-0002','g','{}','t','t')").run();
  db.prepare("INSERT INTO routing_decisions (task_id, chosen_assistant_id, explanation, at) VALUES ('AG-0001','a1','{}','t')").run();
  db.prepare(`INSERT INTO agent_specs (composition_revision_id, task_id, schema_version, explanation_ref, bundle_digest, spec_json, bundle_request_json, bundle_response_json, created_at)
    VALUES ('CR-AG-0001-1','AG-0001','1.1','CD-AG-0001-1','sha256:x','{}','{}','{}','t')`).run();
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const attempt = (over: Record<string, unknown> = {}) => {
  const row = {
    id: "CA-AG-0001-1", task_id: "AG-0001", origin: "intake", routing_decision_id: 1, composition_digest: null,
    inputs_digest: null, outcome: "failed", reason: "cockpit unreachable", composition_revision_id: null, created_at: "t", ...over,
  };
  db.prepare(`INSERT INTO composition_attempts (id, task_id, origin, routing_decision_id, composition_digest, inputs_digest, outcome, reason, composition_revision_id, created_at)
    VALUES (@id, @task_id, @origin, @routing_decision_id, @composition_digest, @inputs_digest, @outcome, @reason, @composition_revision_id, @created_at)`).run(row);
};
const optIn = (over: Record<string, unknown> = {}) =>
  db.prepare("INSERT INTO composition_opt_ins (task_id, asset_id, digest, actor, at) VALUES (@task_id, @asset_id, @digest, @actor, @at)")
    .run({ task_id: "AG-0001", asset_id: "claude-skills:ts-review", digest: "sha256:a", actor: "operator", at: "t", ...over });
const count = (table: string) => (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

describe("migration 034", () => {
  it("is applied after 033 and creates both tables, empty", () => {
    const applied = appliedMigrations(db);
    expect(applied.slice(-2)).toEqual(["033_composition.sql", "034_composition_attempts.sql"]);
    expect(count("composition_attempts")).toBe(0);
    expect(count("composition_opt_ins")).toBe(0);
  });

  describe("composition_attempts", () => {
    it("records each outcome; a persisted attempt names its revision, the others do not", () => {
      attempt({ id: "CA-1", outcome: "failed", reason: "unreachable" });
      attempt({ id: "CA-2", outcome: "skipped", reason: "unsupported_harness", routing_decision_id: null });
      attempt({ id: "CA-3", outcome: "persisted", reason: null, composition_revision_id: "CR-AG-0001-1", composition_digest: "sha256:d" });
      expect(db.prepare("SELECT id, outcome, composition_revision_id FROM composition_attempts ORDER BY id").all()).toEqual([
        { id: "CA-1", outcome: "failed", composition_revision_id: null },
        { id: "CA-2", outcome: "skipped", composition_revision_id: null },
        { id: "CA-3", outcome: "persisted", composition_revision_id: "CR-AG-0001-1" },
      ]);
    });

    it("records a preview with its digests and no reason", () => {
      attempt({ id: "CA-P", outcome: "previewed", reason: null, composition_digest: "sha256:d", inputs_digest: "sha256:i" });
      expect(db.prepare("SELECT outcome, composition_digest, inputs_digest FROM composition_attempts WHERE id = 'CA-P'").get())
        .toEqual({ outcome: "previewed", composition_digest: "sha256:d", inputs_digest: "sha256:i" });
      expect(() => attempt({ id: "CA-Q", outcome: "previewed", composition_digest: null })).toThrow(/CHECK constraint failed/);
      expect(() => attempt({ id: "CA-R", outcome: "previewed", composition_revision_id: "CR-AG-0001-1", composition_digest: "sha256:d" })).toThrow(/CHECK constraint failed/);
    });

    it("refuses an outcome outside persisted, previewed, failed, skipped", () => {
      for (const outcome of ["ok", "PERSISTED", "", "error"]) expect(() => attempt({ outcome })).toThrow(/CHECK constraint failed/);
      expect(count("composition_attempts")).toBe(0);
    });

    it("keeps composition_revision_id NULL unless persisted, and required when persisted", () => {
      expect(() => attempt({ outcome: "failed", composition_revision_id: "CR-AG-0001-1" })).toThrow(/CHECK constraint failed/);
      expect(() => attempt({ outcome: "skipped", composition_revision_id: "CR-AG-0001-1" })).toThrow(/CHECK constraint failed/);
      expect(() => attempt({ outcome: "persisted", reason: null, composition_revision_id: null })).toThrow(/CHECK constraint failed/);
    });

    it("requires a reason for an attempt that persisted nothing", () => {
      expect(() => attempt({ outcome: "failed", reason: null })).toThrow(/CHECK constraint failed/);
      expect(() => attempt({ outcome: "skipped", reason: "" })).toThrow(/CHECK constraint failed/);
    });

    it("enforces its foreign keys and a unique id", () => {
      expect(() => attempt({ task_id: "AG-9999" })).toThrow(/FOREIGN KEY/);
      expect(() => attempt({ routing_decision_id: 999 })).toThrow(/FOREIGN KEY/);
      expect(() => attempt({ outcome: "persisted", reason: null, composition_revision_id: "CR-nope", composition_digest: "sha256:d" })).toThrow(/FOREIGN KEY/);
      attempt();
      expect(() => attempt()).toThrow(/UNIQUE|PRIMARY KEY/);
    });

    it("refuses UPDATE and DELETE by trigger", () => {
      attempt();
      expect(() => db.prepare("UPDATE composition_attempts SET reason = 'edited' WHERE id = 'CA-AG-0001-1'").run()).toThrow(/immutable/);
      expect(() => db.prepare("UPDATE composition_attempts SET outcome = 'skipped'").run()).toThrow(/immutable/);
      expect(() => db.prepare("DELETE FROM composition_attempts WHERE id = 'CA-AG-0001-1'").run()).toThrow(/immutable/);
      expect(() => db.prepare("DELETE FROM composition_attempts").run()).toThrow(/immutable/);
      expect(db.prepare("SELECT reason FROM composition_attempts").get()).toEqual({ reason: "cockpit unreachable" });
    });
  });

  describe("composition_opt_ins", () => {
    it("is unique on (task, asset, digest); a different digest, asset or task is a different row", () => {
      optIn();
      expect(() => optIn()).toThrow(/UNIQUE/);
      expect(() => optIn({ actor: "someone-else", at: "later" })).toThrow(/UNIQUE/);
      optIn({ digest: "sha256:b" });
      optIn({ asset_id: "claude-skills:pr-writer" });
      optIn({ task_id: "AG-0002" });
      expect(count("composition_opt_ins")).toBe(4);
    });

    it("requires every column and a known task", () => {
      for (const column of ["asset_id", "digest", "actor", "at"]) expect(() => optIn({ [column]: null })).toThrow(/NOT NULL/);
      expect(() => optIn({ task_id: "AG-9999" })).toThrow(/FOREIGN KEY/);
    });

    it("refuses UPDATE and DELETE by trigger", () => {
      optIn();
      expect(() => db.prepare("UPDATE composition_opt_ins SET actor = 'x'").run()).toThrow(/immutable/);
      expect(() => db.prepare("UPDATE composition_opt_ins SET at = 'restamped'").run()).toThrow(/immutable/);
      expect(() => db.prepare("DELETE FROM composition_opt_ins").run()).toThrow(/immutable/);
      expect(db.prepare("SELECT actor, at FROM composition_opt_ins").get()).toEqual({ actor: "operator", at: "t" });
    });
  });
});
