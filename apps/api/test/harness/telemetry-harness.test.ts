/**
 * Phase 8e — TelemetryService.scores() with the read-time effective-state
 * derivation (execution-harness.md §5, PLAN.md 8e). A completed harness session
 * (session_state='COMPLETED', no runs.usage, an execution_results row carrying
 * usage) must count toward successRate and contribute its tokens, exactly like a
 * legacy ENDED_OK run.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb, type Db } from "../../src/db/index.js";
import { TelemetryService } from "../../src/modules/telemetry.js";

let dir: string;
let db: Db;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "harness-tel-"));
  db = openDb(join(dir, "t.db"));
  db.prepare("INSERT INTO assistants (id, provider) VALUES ('a1', 'fake')").run();
  db.prepare(
    "INSERT INTO tasks (id, goal, envelope, created_at, updated_at) VALUES ('AG-1', 'ship it', '{}', 't', 't')",
  ).run();
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const recent = () => new Date(Date.now() - 60_000).toISOString();

describe("scores() — harness rows via read-time derivation", () => {
  it("counts a COMPLETED harness session toward successRate and tokens", () => {
    db.prepare(
      `INSERT INTO execution_requests
         (id, task_id, attempt, assistant_id, routing_decision_ref, request_fingerprint,
          fingerprint_algorithm, prompt_source, rendered_prompt_digest, policy, verification,
          origin, canonical_projection, created_at)
       VALUES ('erq-1', 'AG-1', 1, 'a1', 'rd', 'fp', 'alg', 'fresh', 'd', '{}', '[]',
               '{"kind":"fresh"}', '{}', 't')`,
    ).run();
    // Harness row: session_state authoritative, runs.usage NULL.
    db.prepare(
      `INSERT INTO runs (id, task_id, assistant_id, state, session_state, execution_request_id, usage, started_at, ended_at)
       VALUES ('es-1', 'AG-1', 'a1', 'ENDED_OK', 'COMPLETED', 'erq-1', NULL, ?, ?)`,
    ).run(recent(), recent());
    db.prepare(
      "INSERT INTO execution_results (session_id, terminal_state, outcome, result, at) VALUES ('es-1','COMPLETED','completed',?, 't')",
    ).run(JSON.stringify({ usage: { inputTokens: 120, outputTokens: 30, accounting: "delta" } }));

    const score = new TelemetryService(db).scores().get("a1");
    expect(score).toBeTruthy();
    expect(score!.runs).toBe(1);
    expect(score!.successRate).toBe(1); // COMPLETED counts as success
    expect(score!.errors).toBe(0);
    expect(score!.medianTokens).toBe(150); // pulled from execution_results.result.usage
  });

  it("counts a FAILED harness session as an error, not a success", () => {
    db.prepare(
      `INSERT INTO execution_requests
         (id, task_id, attempt, assistant_id, routing_decision_ref, request_fingerprint,
          fingerprint_algorithm, prompt_source, rendered_prompt_digest, policy, verification,
          origin, canonical_projection, created_at)
       VALUES ('erq-2', 'AG-1', 1, 'a1', 'rd', 'fp2', 'alg', 'fresh', 'd', '{}', '[]',
               '{"kind":"fresh"}', '{}', 't')`,
    ).run();
    db.prepare(
      `INSERT INTO runs (id, task_id, assistant_id, state, session_state, execution_request_id, started_at, ended_at)
       VALUES ('es-2', 'AG-1', 'a1', 'ENDED_ERROR', 'FAILED', 'erq-2', ?, ?)`,
    ).run(recent(), recent());

    const score = new TelemetryService(db).scores().get("a1");
    expect(score!.successRate).toBe(0);
    expect(score!.errors).toBe(1);
  });
});
