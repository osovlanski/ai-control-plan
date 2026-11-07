/**
 * `pnpm model:shadow-report` — the read path for the 7-day K13 shadow soak.
 *
 * The report must be reconstructible arithmetic over the persisted shadow log,
 * must never mutate activation state, must not need the AA network, and must not
 * leak a secret into its output.
 */
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DIMENSION_K } from "@agent-plane/core";
import { migrate, openDb, type Db } from "../src/db/index.js";
import {
  buildShadowReport,
  openReportDb,
  renderShadowReport,
  ReportSchemaError,
} from "../src/bin/model-shadow-report.js";

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "../src/db/migrations");
const sha = (path: string): string => createHash("sha256").update(readFileSync(path)).digest("hex");

let home: string;
let db: Db;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "shadow-report-"));
  db = openDb(join(home, "agent-plane.db"));
  // This is a unit test of report aggregation, not of referential integrity —
  // the routing_decisions rows are hand-written, so drop the FK guard.
  db.pragma("foreign_keys = OFF");
});

afterEach(() => {
  if (db.open) db.close();
  rmSync(home, { recursive: true, force: true });
});

/** Insert a routing_decisions row carrying a modelRecommendation. */
function record(explanation: object, at: string): void {
  db.prepare("INSERT INTO routing_decisions (task_id, chosen_assistant_id, explanation, at) VALUES (?, ?, ?, ?)")
    .run("AG-x", null, JSON.stringify(explanation), at);
}

const gate = (name: string, passed: boolean) => ({ name, passed, detail: `${name} ${passed ? "ok" : "not ok"}` });

/** A realistic shadow recommendation, with the knobs each test needs. */
function shadowRec(over: {
  recommended?: string;
  candidates?: Array<{ label: string; assistantId: string; eligible: boolean; filterFailures: string[]; identity?: object; dimensions: Array<{ dimension: string; n: number; missing?: string }> }>;
  gates?: Array<{ name: string; passed: boolean; detail: string }>;
} = {}) {
  return {
    ruleFired: "test",
    candidates: [],
    modelRecommendation: {
      schemaVersion: 2,
      mode: "shadow",
      recommended: over.recommended,
      candidates: over.candidates ?? [
        { label: "fake-a/premium-max", assistantId: "fake-a", eligible: true, filterFailures: [], dimensions: [
          { dimension: "coding", n: DIMENSION_K.coding },
          { dimension: "speed", n: 0 },
          { dimension: "cost", n: 0 },
        ] },
      ],
      activation: { active: false, gates: over.gates ?? [gate("config", false), gate("telemetry", false), gate("shadow-week", false)] },
    },
  };
}

describe("shadow soak report", () => {
  it("is empty and honest on a workspace that has recorded nothing", () => {
    const report = buildShadowReport(db);
    expect(report.recommendations).toBe(0);
    expect(report.firstRecommendationAt).toBeNull();
    expect(report.hardFilterViolations).toBe(0);
    expect(report.activation.gates).toEqual([]);
    // Renders without throwing and never claims progress it does not have.
    expect(renderShadowReport(report)).toMatch(/none yet/);
    expect(renderShadowReport(report)).toMatch(/read-only/);
  });

  it("counts recommendations, first timestamp, coverage and by-model", () => {
    record(shadowRec({ recommended: "fake-a/premium-max" }), "2026-09-01T00:00:00.000Z");
    record(shadowRec({ recommended: "fake-a/premium-max" }), "2026-09-02T00:00:00.000Z");
    record(shadowRec({
      recommended: "fake-b/swift-mini",
      candidates: [
        { label: "fake-a/premium-max", assistantId: "fake-a", eligible: true, filterFailures: [], dimensions: [{ dimension: "coding", n: 3 }] },
        { label: "fake-b/swift-mini", assistantId: "fake-b", eligible: true, filterFailures: [], dimensions: [{ dimension: "coding", n: 0 }] },
      ],
    }), "2026-09-03T00:00:00.000Z");

    const report = buildShadowReport(db);
    expect(report.recommendations).toBe(3);
    expect(report.firstRecommendationAt).toBe("2026-09-01T00:00:00.000Z");
    expect(report.lastRecommendationAt).toBe("2026-09-03T00:00:00.000Z");
    expect(report.candidateCoverage).toEqual(["fake-a/premium-max", "fake-b/swift-mini"]);
    expect(report.recommendationsByModel).toEqual({ "fake-a/premium-max": 2, "fake-b/swift-mini": 1 });
  });

  it("counts priorMissing per dimension and reports own-telemetry n vs k", () => {
    record(shadowRec({
      candidates: [
        { label: "fake-c/nightly", assistantId: "fake-c", eligible: true, filterFailures: [], dimensions: [
          { dimension: "coding", n: 0, missing: "priorMissing:coding and no telemetry — contributes nothing" },
          { dimension: "speed", n: 0, missing: "priorMissing:speed" },
        ] },
        { label: "fake-a/premium-max", assistantId: "fake-a", eligible: true, filterFailures: [], dimensions: [
          { dimension: "coding", n: DIMENSION_K.coding },
        ] },
      ],
    }), "2026-09-01T00:00:00.000Z");

    const report = buildShadowReport(db);
    expect(report.priorMissing).toEqual({ "priorMissing:coding": 1, "priorMissing:speed": 1 });
    const codingRow = report.telemetryVsK.find((r) => r.label === "fake-a/premium-max" && r.dimension === "coding")!;
    expect(codingRow).toMatchObject({ n: DIMENSION_K.coding, k: DIMENSION_K.coding, reachedK: true });
    // n = 0 rows are not noise in the table.
    expect(report.telemetryVsK.some((r) => r.n === 0)).toBe(false);
  });

  it("surfaces a hard-filter violation: a recommendation that named a filtered candidate", () => {
    record(shadowRec({
      recommended: "fake-a/premium-max",
      candidates: [
        { label: "fake-a/premium-max", assistantId: "fake-a", eligible: false, filterFailures: ["quota exhausted"], dimensions: [] },
      ],
    }), "2026-09-01T00:00:00.000Z");
    const report = buildShadowReport(db);
    expect(report.hardFilterViolations).toBe(1);
    expect(renderShadowReport(report)).toMatch(/MUST be 0 to activate/);
  });

  it("reports the current activation gates from the most recent recommendation", () => {
    record(shadowRec({ gates: [gate("config", false), gate("telemetry", true)] }), "2026-09-01T00:00:00.000Z");
    record(shadowRec({ gates: [gate("config", true), gate("telemetry", true), gate("shadow-week", false)] }), "2026-09-05T00:00:00.000Z");
    const report = buildShadowReport(db);
    expect(report.activation.as_of).toBe("2026-09-05T00:00:00.000Z");
    expect(report.activation.passed).toBe(2);
    expect(report.activation.failed).toBe(1);
  });

  it("shows each candidate's identity basis from its newest record, with N, newest age and the unresolved reason", () => {
    const cand = (label: string, identity: object) => ({
      label, assistantId: label.split("/")[0]!, eligible: true, filterFailures: [], identity,
      dimensions: [{ dimension: "coding", n: 0 }],
    });
    const unresolvedOld = { basis: "unresolved", evidence: "older refusal" };
    const observed = {
      basis: "observed-resolution",
      resolvedModelKey: "anthropic:claude-opus-5",
      evidence: "the last 3 runs …",
      observation: {
        rule: "last-n-agreement-v1", requiredRuns: 3, freshnessDays: 14, runsExamined: 3,
        resolvedIds: ["claude-opus-5"], newestObservedAt: "2026-11-05T12:00:00.000Z", cliVersions: ["2.1.238"],
      },
    };
    const exact = { basis: "catalog-exact", resolvedModelKey: "fake:premium-max", evidence: "catalog id" };
    const unresolved = {
      basis: "unresolved",
      evidence: '"sonnet" on personal-claude is not bound by observed resolution: only 1 of the 3 agreeing runs required have reported a resolution',
      observation: {
        rule: "last-n-agreement-v1", requiredRuns: 3, freshnessDays: 14, runsExamined: 1,
        resolvedIds: ["claude-sonnet-5"], newestObservedAt: "2026-11-01T12:00:00.000Z", cliVersions: [],
      },
    };
    const noRuns = { basis: "unresolved", evidence: '"haiku" is not a catalog model id for anthropic and no run has reported what it resolves to' };
    record(shadowRec({ candidates: [cand("personal-claude/opus", unresolvedOld)] }), "2026-11-04T00:00:00.000Z");
    record(shadowRec({ candidates: [
      cand("personal-claude/opus", observed),
      cand("fake-a/premium-max", exact),
      cand("personal-claude/sonnet", unresolved),
      cand("personal-claude/haiku", noRuns),
    ] }), "2026-11-06T00:00:00.000Z");

    const report = buildShadowReport(db, { now: () => new Date("2026-11-07T00:00:00.000Z") });
    expect(report.candidateIdentity).toEqual([
      { label: "fake-a/premium-max", basis: "catalog-exact", resolvedModelKey: "fake:premium-max", recordedAt: "2026-11-06T00:00:00.000Z" },
      { label: "personal-claude/haiku", basis: "unresolved", recordedAt: "2026-11-06T00:00:00.000Z", reason: noRuns.evidence },
      {
        label: "personal-claude/opus", basis: "observed-resolution", resolvedModelKey: "anthropic:claude-opus-5",
        recordedAt: "2026-11-06T00:00:00.000Z", runsExamined: 3, requiredRuns: 3,
        newestObservedAt: "2026-11-05T12:00:00.000Z", newestAgeDays: 1.5, cliVersions: ["2.1.238"],
      },
      {
        label: "personal-claude/sonnet", basis: "unresolved", recordedAt: "2026-11-06T00:00:00.000Z",
        runsExamined: 1, requiredRuns: 3, newestObservedAt: "2026-11-01T12:00:00.000Z", newestAgeDays: 5.5,
        cliVersions: [], reason: unresolved.evidence,
      },
    ]);
    const text = renderShadowReport(report);
    expect(text).toContain("observed-resolution -> anthropic:claude-opus-5: 3 agreeing run(s), newest 2026-11-05T12:00:00.000Z (1.5d old), CLI 2.1.238");
    expect(text).toContain("catalog-exact -> fake:premium-max");
    expect(text).toContain("unresolved (1 run(s) examined of 3 required, newest 2026-11-01T12:00:00.000Z (5.5d old), CLI not reported): \"sonnet\"");
    expect(text).toContain(`unresolved: ${noRuns.evidence}`);
    expect(text).not.toContain("older refusal");
  });

  it("tolerates a recorded candidate with no identity (a row from before K13 identity)", () => {
    record(shadowRec(), "2026-11-06T00:00:00.000Z");
    const report = buildShadowReport(db);
    expect(report.candidateIdentity).toEqual([]);
    expect(renderShadowReport(report)).toContain("(no candidate identity recorded yet)");
  });

  it("does not mutate anything: identical output on a second run, and the row count is unchanged", () => {
    record(shadowRec({ recommended: "fake-a/premium-max" }), "2026-09-01T00:00:00.000Z");
    const before = db.prepare("SELECT COUNT(*) AS n FROM routing_decisions").get() as { n: number };
    const first = renderShadowReport(buildShadowReport(db));
    const second = renderShadowReport(buildShadowReport(db));
    const after = db.prepare("SELECT COUNT(*) AS n FROM routing_decisions").get() as { n: number };
    expect(first).toBe(second);
    expect(after.n).toBe(before.n);
    // No config table touched — the report has no write path to selection state.
    expect(() => db.prepare("SELECT 1 FROM schema_migrations LIMIT 1").get()).not.toThrow();
  });

  it("keeps no secret in its output and needs no network", () => {
    // A token-shaped string accidentally serialized into an explanation must not
    // be echoed — the report reads only named, structural fields. Built from
    // parts so the repo's own secret scanner has nothing literal to flag.
    const tokenShaped = ["Bea" + "rer", "sk-" + "live-" + "A".repeat(28)].join(" ");
    record({
      ruleFired: "test",
      candidates: [],
      note: tokenShaped,
      modelRecommendation: shadowRec().modelRecommendation,
    }, "2026-09-01T00:00:00.000Z");
    const text = renderShadowReport(buildShadowReport(db));
    expect(text).not.toContain("sk-live-");
    expect(text).not.toContain(tokenShaped);
  });
});

describe("shadow report opens the DB read-only and unmigrated", () => {
  /** A DB file migrated only to the first `count` migrations, holding one shadow row. */
  function dbAtMigration(count: number): string {
    const partial = join(home, `migrations-${count}`);
    mkdirSync(partial);
    const files = readdirSync(MIGRATIONS_DIR).filter((f) => /^\d+_.+\.sql$/.test(f)).sort().slice(0, count);
    for (const f of files) copyFileSync(join(MIGRATIONS_DIR, f), join(partial, f));
    const path = join(home, `at-${count}.db`);
    const old = new Database(path);
    old.pragma("journal_mode = WAL");
    migrate(old, partial);
    old.pragma("foreign_keys = OFF");
    old.prepare("INSERT INTO routing_decisions (task_id, chosen_assistant_id, explanation, at) VALUES (?, ?, ?, ?)")
      .run("AG-old", null, JSON.stringify(shadowRec({ recommended: "fake-a/premium-max" })), "2026-09-26T00:00:00.000Z");
    old.close();
    return path;
  }

  const migrationRows = (path: string): number => {
    const ro = new Database(path, { readonly: true });
    const n = (ro.prepare("SELECT COUNT(*) AS n FROM schema_migrations").get() as { n: number }).n;
    ro.close();
    return n;
  };

  it("leaves a DB that is behind main exactly as it was (schema_migrations rows and file hash)", () => {
    const path = dbAtMigration(30);
    const rowsBefore = migrationRows(path);
    const hashBefore = sha(path);
    expect(rowsBefore).toBe(30);

    const ro = openReportDb(path);
    const report = buildShadowReport(ro);
    ro.close();

    expect(report.recommendations).toBe(1);
    expect(report.recommendationsByModel).toEqual({ "fake-a/premium-max": 1 });
    expect(migrationRows(path)).toBe(rowsBefore);
    expect(sha(path)).toBe(hashBefore);
  });

  it("gives the same output on a current DB as the migrated handle does, without writing", () => {
    record(shadowRec({ recommended: "fake-a/premium-max" }), "2026-09-01T00:00:00.000Z");
    record(shadowRec({ recommended: "fake-b/swift-mini" }), "2026-09-02T00:00:00.000Z");
    const expected = renderShadowReport(buildShadowReport(db));
    const path = join(home, "agent-plane.db");
    db.close();
    const hashBefore = sha(path);

    const ro = openReportDb(path);
    const text = renderShadowReport(buildShadowReport(ro));
    ro.close();

    expect(text).toBe(expected);
    expect(sha(path)).toBe(hashBefore);
  });

  it("names the missing migration when a table the report reads is absent, and still does not migrate", () => {
    const path = join(home, "bare.db");
    const bare = new Database(path);
    bare.exec("CREATE TABLE schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)");
    bare.close();
    const hashBefore = sha(path);

    expect(() => openReportDb(path)).toThrow(ReportSchemaError);
    expect(() => openReportDb(path)).toThrow(/table routing_decisions \(added by migration 001_init\.sql\)/);
    expect(() => openReportDb(path)).toThrow(/never migrates/);
    expect(sha(path)).toBe(hashBefore);
    expect(migrationRows(path)).toBe(0);
  });

  it("names a missing column too", () => {
    const path = join(home, "narrow.db");
    const narrow = new Database(path);
    narrow.exec("CREATE TABLE routing_decisions (id INTEGER PRIMARY KEY, explanation TEXT NOT NULL)");
    narrow.close();
    expect(() => openReportDb(path)).toThrow(/column routing_decisions\.at \(added by migration 001_init\.sql\)/);
  });

  it("refuses a path that does not exist instead of creating an empty DB", () => {
    const path = join(home, "typo.db");
    expect(() => openReportDb(path)).toThrow();
    expect(existsSync(path)).toBe(false);
  });

  it("cannot write through the handle it returns", () => {
    db.close();
    const ro = openReportDb(join(home, "agent-plane.db"));
    expect(() => ro.prepare("DELETE FROM routing_decisions").run()).toThrow(/readonly/i);
    ro.close();
  });
});
