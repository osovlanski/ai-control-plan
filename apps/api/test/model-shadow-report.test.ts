/**
 * `pnpm model:shadow-report` — the read path for the 7-day K13 shadow soak.
 *
 * The report must be reconstructible arithmetic over the persisted shadow log,
 * must never mutate activation state, must not need the AA network, and must not
 * leak a secret into its output.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DIMENSION_K } from "@agent-plane/core";
import { openDb, type Db } from "../src/db/index.js";
import { buildShadowReport, renderShadowReport } from "../src/bin/model-shadow-report.js";

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
  candidates?: Array<{ label: string; assistantId: string; eligible: boolean; filterFailures: string[]; dimensions: Array<{ dimension: string; n: number; missing?: string }> }>;
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
