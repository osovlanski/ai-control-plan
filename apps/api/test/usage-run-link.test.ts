/**
 * Imported usage joins its run (phase 7 "one deduped usage stream"; plan §3.7). Cockpit sends
 * `runId: null`, so the plane binds a record to the one run whose assistant has the record's
 * provider and whose provider_session_ref is the record's sessionRef. Settlement counts it once:
 * max(in-run, records), so in-run counted usage is reconciled, never summed, and with in-run
 * accounting `none` the records are the source. Every value is FAKE.
 */
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { migrate } from "../src/db/index.js";
import { UsageLedger } from "../src/modules/usage.js";
import { bootRig, type Rig } from "./helpers/composer-cockpit.js";

let rig: Rig | undefined;

afterEach(async () => {
  await rig?.close();
  rig = undefined;
});

interface RunBudget { runId: string; tokens: number; source: string; inRunTokens: number; recordTokens: number; recordCount: number; accounting: string }
interface Budget { consumed: { tokens: number; recordCount: number }; runs: RunBudget[]; overruns: Array<{ source: string; amount: number }> }

async function budget(taskId: string): Promise<Budget> {
  const res = await rig!.built.app.inject({ method: "GET", url: `/api/tasks/${taskId}/composition/budget`, headers: rig!.auth() });
  expect(res.statusCode).toBe(200);
  return res.json() as Budget;
}

/** A composed fake run that completes with in-run cumulative usage 1200 + 450. */
async function composedRun(): Promise<{ taskId: string; runId: string; sessionRef: string }> {
  const taskId = rig!.built.tasks.create({ goal: "Add a typed helper to the parser module", repoPath: rig!.repo }).taskId;
  const res = await rig!.built.app.inject({ method: "POST", url: `/api/tasks/${taskId}/start`, headers: rig!.auth(), payload: {} });
  expect(res.statusCode).toBe(200);
  const runId = (res.json() as { runId: string }).runId;
  expect(await rig!.built.orchestrator.waitForSettled(taskId)).toBe("COMPLETED");
  const { provider_session_ref } = rig!.db.prepare("SELECT provider_session_ref FROM runs WHERE id = ?").get(runId) as { provider_session_ref: string };
  expect(provider_session_ref).toMatch(/^fake-session-/);
  return { taskId, runId, sessionRef: provider_session_ref };
}

/** A Cockpit-shaped record: runId null, delta, keyed by session. */
function imported(sessionRef: string | null, eventId: string, tokensIn: number, tokensOut: number, extra: Record<string, unknown> = {}) {
  return {
    schemaVersion: "1.0", eventId, runId: null, provider: "fake", sessionRef, source: "cockpit-import", assistantId: "claude",
    model: "fake-1", accounting: "delta", tokensIn, tokensOut, cachedTokens: 0, costUsd: null, apiEquivalentUsd: 0,
    pricingVersion: "FAKE-pricing-not-real", observedAt: "2030-01-01T00:05:00.000Z", ...extra,
  };
}

async function post(body: object): Promise<{ status: number; body: { replayed?: boolean; link?: string; record?: { runId: string | null }; error?: string; sessionRuns?: string[] } }> {
  const res = await rig!.built.app.inject({ method: "POST", url: "/api/usage/records", headers: rig!.usageAuth(), payload: body });
  return { status: res.statusCode, body: res.json() as never };
}

const stored = () => rig!.db.prepare("SELECT event_id, run_id, run_link FROM usage_records ORDER BY rowid").all();

/** In-run accounting `none`: the manifest says so and the run has no in-run observation to count. */
function inRunNone(runId: string) {
  rig!.db.prepare("UPDATE assistants SET manifest = json_set(manifest, '$.harness.usageAccounting', 'none')").run();
  rig!.db.prepare("DELETE FROM execution_results WHERE session_id = ?").run(runId);
}

describe("imported usage joins its run by sessionRef", () => {
  it("binds a runId-null record to the session's run and counts it once; a replay adds nothing (in-run none)", async () => {
    rig = await bootRig({ budget: { maxTokens: 100_000 } });
    const { taskId, runId, sessionRef } = await composedRun();
    inRunNone(runId);
    expect((await budget(taskId)).runs[0]).toMatchObject({ accounting: "none", tokens: 0, recordCount: 0 });

    const first = await post(imported(sessionRef, "FAKE-msg-1", 800, 200));
    expect(first).toMatchObject({ status: 201, body: { replayed: false, link: "session_ref", record: { runId } } });
    expect((await post(imported(sessionRef, "FAKE-msg-2", 300, 100))).status).toBe(201);
    const counted = await budget(taskId);
    // In-run measured nothing, so the records are the source: 800+200 + 300+100.
    expect(counted.runs[0]).toMatchObject({ runId, tokens: 1400, source: "records", inRunTokens: 0, recordTokens: 1400, recordCount: 2 });
    expect(counted.consumed).toMatchObject({ tokens: 1400, recordCount: 2 });

    const replay = await post(imported(sessionRef, "FAKE-msg-1", 800, 200));
    expect(replay).toMatchObject({ status: 200, body: { replayed: true, link: "session_ref", record: { runId } } });
    expect((await budget(taskId)).consumed).toMatchObject({ tokens: 1400, recordCount: 2 });
    expect(stored()).toEqual([
      { event_id: "FAKE-msg-1", run_id: runId, run_link: "session_ref" },
      { event_id: "FAKE-msg-2", run_id: runId, run_link: "session_ref" },
    ]);
  });

  it("does not double-count a run whose in-run usage is counted: records reconcile, never add", async () => {
    rig = await bootRig({ budget: { maxTokens: 100_000 } });
    const { taskId, sessionRef } = await composedRun();
    const before = await budget(taskId);
    expect(before.runs[0]).toMatchObject({ accounting: "cumulative", tokens: 1650, source: "in_run", recordCount: 0 });

    // The same session's messages as Cockpit sees them, summing to the in-run total.
    expect((await post(imported(sessionRef, "FAKE-msg-a", 1000, 300))).body.link).toBe("session_ref");
    expect((await post(imported(sessionRef, "FAKE-msg-b", 200, 150))).body.link).toBe("session_ref");
    expect((await budget(taskId)).runs[0]).toMatchObject({ tokens: 1650, source: "in_run", inRunTokens: 1650, recordTokens: 1650, recordCount: 2 });

    // A record the in-run stream missed raises the run to the records' total; still never the sum (3650 + ...).
    expect((await post(imported(sessionRef, "FAKE-msg-c", 400, 0))).status).toBe(201);
    const after = await budget(taskId);
    expect(after.runs[0]).toMatchObject({ tokens: 2050, source: "records", inRunTokens: 1650, recordTokens: 2050, recordCount: 3 });
    expect(after.consumed.tokens).toBe(2050);
  });

  it("refuses a body runId that disagrees with the session's run, and stores nothing", async () => {
    rig = await bootRig();
    const a = await composedRun();
    const b = await composedRun();
    const res = await post(imported(a.sessionRef, "FAKE-msg-x", 10, 10, { runId: b.runId }));
    expect(res).toMatchObject({ status: 409, body: { sessionRuns: [a.runId] } });
    expect(res.body.error).toMatch(/^run_conflict/);
    expect(stored()).toEqual([]);
    // Agreeing with the match is fine, and is recorded as the body's.
    expect(await post(imported(a.sessionRef, "FAKE-msg-x", 10, 10, { runId: a.runId }))).toMatchObject({ status: 201, body: { link: "body", record: { runId: a.runId } } });
  });

  it("leaves a record unbound when no run or several runs have its session, and says which", async () => {
    rig = await bootRig();
    const { taskId, runId, sessionRef } = await composedRun();
    expect(await post(imported("FAKE-session-elsewhere", "FAKE-msg-u", 5, 5))).toMatchObject({ status: 201, body: { link: "unmatched", record: { runId: null } } });
    expect(await post(imported(null, "FAKE-msg-n", 5, 5))).toMatchObject({ status: 201, body: { link: "none", record: { runId: null } } });
    // A second run on the same provider session (as a resume would make): a session-wide total cannot be split.
    rig.db.prepare(
      `INSERT INTO runs (id, task_id, assistant_id, provider_session_ref, state, started_at)
       SELECT 'RUN-FAKE-second', task_id, assistant_id, provider_session_ref, 'COMPLETED', '2030-01-01T01:00:00.000Z' FROM runs WHERE id = ?`,
    ).run(runId);
    expect(await post(imported(sessionRef, "FAKE-msg-amb", 5, 5))).toMatchObject({ status: 201, body: { link: "ambiguous", record: { runId: null } } });
    expect((await budget(taskId)).consumed.recordCount).toBe(0);
  });

  it("backfills records stored before their session had a run, idempotently, and checks the cap late", async () => {
    rig = await bootRig({ budget: { maxTokens: 2000 } });
    const { taskId, runId, sessionRef } = await composedRun();
    // As if Cockpit delivered before the run's session was known: the run has no session ref yet.
    rig.db.prepare("UPDATE runs SET provider_session_ref = NULL WHERE id = ?").run(runId);
    expect((await post(imported(sessionRef, "FAKE-msg-early", 1500, 500))).body.link).toBe("unmatched");
    expect((await budget(taskId)).runs[0]).toMatchObject({ tokens: 1650, recordCount: 0 });
    rig.db.prepare("UPDATE runs SET provider_session_ref = ? WHERE id = ?").run(sessionRef, runId);

    const ledger = new UsageLedger(rig.db);
    expect(ledger.backfillRunLinks()).toEqual({ linked: [{ provider: "fake", sessionRef, eventId: "FAKE-msg-early", runId }], unmatched: 0, ambiguous: 0 });
    expect(ledger.backfillRunLinks()).toEqual({ linked: [], unmatched: 0, ambiguous: 0 });
    expect((await budget(taskId)).runs[0]).toMatchObject({ tokens: 2000, source: "records", recordCount: 1 });

    // A replay of an unbound record binds it too, and its late overrun is appended once.
    rig.db.prepare("UPDATE runs SET provider_session_ref = NULL WHERE id = ?").run(runId);
    expect((await post(imported(sessionRef, "FAKE-msg-late", 300, 0))).body.link).toBe("unmatched");
    rig.db.prepare("UPDATE runs SET provider_session_ref = ? WHERE id = ?").run(sessionRef, runId);
    expect(await post(imported(sessionRef, "FAKE-msg-late", 300, 0))).toMatchObject({ status: 200, body: { replayed: true, link: "session_ref", record: { runId } } });
    const b = await budget(taskId);
    expect(b.runs[0]).toMatchObject({ tokens: 2300, recordCount: 2 });
    expect(b.overruns).toEqual([expect.objectContaining({ source: "late", amount: 300 })]);
    await post(imported(sessionRef, "FAKE-msg-late", 300, 0));
    expect((await budget(taskId)).overruns).toHaveLength(1);
  });

  it("keeps records immutable except the one NULL-to-run step", async () => {
    rig = await bootRig();
    const { runId, sessionRef } = await composedRun();
    await post(imported(sessionRef, "FAKE-msg-bound", 1, 1));
    await post(imported("FAKE-session-free", "FAKE-msg-free", 1, 1));
    expect(() => rig!.db.prepare("UPDATE usage_records SET run_id = NULL, run_link = NULL WHERE event_id = 'FAKE-msg-bound'").run()).toThrow(/immutable/);
    expect(() => rig!.db.prepare("UPDATE usage_records SET tokens_in = 0 WHERE event_id = 'FAKE-msg-free'").run()).toThrow(/immutable/);
    expect(() => rig!.db.prepare("UPDATE usage_records SET run_id = ?, run_link = 'body' WHERE event_id = 'FAKE-msg-free'").run(runId)).toThrow(/immutable/);
    expect(() => rig!.db.prepare("UPDATE usage_records SET run_id = ?, run_link = 'session_ref', tokens_in = 9 WHERE event_id = 'FAKE-msg-free'").run(runId)).toThrow(/immutable/);
    expect(() => rig!.db.prepare("DELETE FROM usage_records").run()).toThrow(/immutable/);
  });
});

describe("migration 036", () => {
  it("marks records already bound by their body, and leaves unbound ones unbound", () => {
    const root = mkdtempSync(join(tmpdir(), "usage-036-"));
    const migrations = new URL("../src/db/migrations/", import.meta.url);
    const baseline = join(root, "migrations");
    const db = new Database(join(root, "plane.db"));
    try {
      mkdirSync(baseline);
      for (const name of readdirSync(migrations).filter((n) => /^0(?:[0-2]\d|3[0-4])_/.test(n))) copyFileSync(new URL(name, migrations), join(baseline, name));
      migrate(db, baseline);
      db.prepare("INSERT INTO assistants (id, provider) VALUES ('a1','fake')").run();
      db.prepare("INSERT INTO tasks (id, goal, envelope, created_at, updated_at) VALUES ('AG-0001','g','{}','t','t')").run();
      db.prepare("INSERT INTO runs (id, task_id, assistant_id, state, started_at) VALUES ('run-1','AG-0001','a1','COMPLETED','t')").run();
      const insert = db.prepare(`INSERT INTO usage_records (provider, event_id, body_digest, run_id, session_ref, source, assistant_id, model, accounting,
        tokens_in, tokens_out, cached_tokens, cost_usd, api_equivalent_usd, pricing_version, observed_at, received_at)
        VALUES ('fake', ?, 'sha256:FAKE', ?, 'FAKE-s', 'x', 'a1', 'm', 'delta', 1, 1, 0, NULL, 0, 'FAKE', 't', 't')`);
      insert.run("FAKE-e1", "run-1");
      insert.run("FAKE-e2", null);
      expect(migrate(db)).toContain("036_usage_run_link.sql");
      expect(db.prepare("SELECT event_id, run_id, run_link FROM usage_records ORDER BY rowid").all()).toEqual([
        { event_id: "FAKE-e1", run_id: "run-1", run_link: "body" },
        { event_id: "FAKE-e2", run_id: null, run_link: null },
      ]);
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
