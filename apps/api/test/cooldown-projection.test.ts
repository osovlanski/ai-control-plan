/**
 * `routeInputs()` hands route() an empty cooldown map on purpose: an active cooldown reaches
 * routing through `QuotaProjection.for()`, which reads the cooldowns table and returns it as a
 * blocker, and route() fails the candidate on that blocker. These tests pin that the projection
 * path really enforces a cooldown, that only FRESH recovery evidence for the cooldown's own
 * account and bucket clears it early, and that nothing else does.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AssistantId } from "@agent-plane/core";
import { loadConfig, type ResolvedConfig } from "../src/config.js";
import { openDb, type Db } from "../src/db/index.js";
import { routeInputs } from "../src/modules/router.js";
import { buildServer, type BuiltServer } from "../src/server.js";

const A = "fake-a" as AssistantId, B = "fake-b" as AssistantId;
let built: BuiltServer | undefined;
let db: Db;
let home: string;
let config: ResolvedConfig;
let clock = new Date("2030-01-01T00:00:00.000Z");
const now = () => clock;
const at = (ms: number) => new Date(clock.getTime() + ms).toISOString();

async function boot() {
  home = mkdtempSync(join(tmpdir(), "cooldown-proj-"));
  config = loadConfig({ AGENT_PLANE_HOME: home });
  config.assistants = { [A]: { provider: "fake" }, [B]: { provider: "fake" } };
  clock = new Date("2030-01-01T00:00:00.000Z");
  db = openDb(config.dbPath);
  built = buildServer({ config, db, now });
  built.registry.init();
  await built.registry.syncAll();
  // The fake manifest reports no limits of its own, so only the rows below are quota evidence.
  for (const id of [A, B]) expect(built.registry.manifest(id)?.core.limits ?? []).toEqual([]);
}
afterEach(async () => {
  if (built) { await built.orchestrator.shutdown(); await built.app.close(); }
  if (db?.open) db.close();
  if (home) rmSync(home, { recursive: true, force: true });
  built = undefined;
});

/** One quota observation as the Harness quota-snapshot writer records it. */
function snapshot(id: string, window: string, usedPercent: number, observedAt: string, resetsAt: string | null = null, account: string | null = "fake") {
  db.prepare("INSERT INTO quota_snapshots (assistant_id, window, used_percent, resets_at, source, observed_at, account) VALUES (?, ?, ?, ?, 'runtime-probe', ?, ?)")
    .run(id, window, usedPercent, resetsAt, observedAt, account);
}

/** A 5h limit on A as a run reports it: the exhausted snapshot first, then the cooldown keyed to its bucket. */
function limitA(resetMs = 3_600_000) {
  const resetsAt = at(resetMs);
  snapshot(A, "5h", 100, at(0), resetsAt);
  built!.cooldowns.penalize(A, "limit", "5h limit reached", resetsAt);
  return resetsAt;
}

function route(override?: AssistantId) {
  const taskId = built!.tasks.create({ goal: "route me" }).taskId;
  return built!.orchestrator.routeTask(taskId, "intake", override ? { override } : {}).explanation;
}
const failuresOf = (explanation: ReturnType<typeof route>, id: string) => explanation.candidates.find((c) => c.assistantId === id)!.filterFailures;

describe("cooldown enforcement through QuotaProjection", () => {
  it("routes past an active cooldown although route() is given no cooldown map", async () => {
    await boot();
    const resetsAt = limitA();
    const taskId = built!.tasks.create({ goal: "x" }).taskId;
    const deps = { db, config, tasks: built!.tasks, registry: built!.registry, cooldowns: built!.cooldowns, now };
    const inputs = routeInputs(deps, taskId, "intake");
    expect(inputs.request.cooldowns.size).toBe(0);
    expect(inputs.request.projections!.get(A)!.blockers.map((b) => b.reason).sort()).toEqual(["5h limit reached", "quota exhausted"]);

    const explanation = route();
    expect(explanation.chosen).toBe(B);
    expect(failuresOf(explanation, A).join(" ")).toContain(`provider-reset until ${resetsAt} (5h limit reached)`);
  });

  it("holds a cooldown with no matching snapshot (a failure) until its deadline, then lets it go", async () => {
    await boot();
    built!.cooldowns.penalize(A, "failure", "adapter crashed");
    const until = (db.prepare("SELECT until, bucket FROM cooldowns WHERE assistant_id = ?").get(A) as { until: string; bucket: string | null });
    expect(until.bucket).toBeNull();
    expect(failuresOf(route(), A).join(" ")).toMatch(/quota blocked: transient-unavailable until .* \(adapter crashed\)/);
    // Recovery evidence for some bucket is not evidence for a bucket-less cooldown.
    snapshot(A, "5h", 10, at(1000));
    expect(route().chosen).toBe(B);

    clock = new Date(Date.parse(until.until) + 1);
    expect(failuresOf(route(), A)).toEqual([]);
    // Eligible again (auto prefers B's unknown quota over A's 10%, so an override proves it).
    expect(route(A).chosen).toBe(A);
  });

  it("an explicit override cannot pick a cooled-down assistant", async () => {
    await boot();
    limitA();
    const explanation = route(A);
    expect(explanation.chosen).toBeUndefined();
    expect(explanation.tieBreaker).toBe("override target failed hard filters");
  });

  it("fresh recovery evidence for the same account and bucket clears it before the deadline", async () => {
    await boot();
    limitA();
    clock = new Date(clock.getTime() + 60_000);
    snapshot(A, "5h", 40, at(0));
    expect(built!.cooldowns.active(clock).has(A)).toBe(true); // the row is still there
    expect(failuresOf(route(), A)).toEqual([]);
    expect(route(A).chosen).toBe(A);
  });

  describe("evidence that must NOT clear it", () => {
    const cases: Array<[string, () => void]> = [
      ["older than the cooldown", () => { snapshot(A, "5h", 40, new Date(clock.getTime() - 1).toISOString()); }],
      ["another bucket", () => { clock = new Date(clock.getTime() + 60_000); snapshot(A, "weekly", 40, at(0)); }],
      ["another account", () => { clock = new Date(clock.getTime() + 60_000); snapshot(A, "5h", 40, at(0), null, "someone-else"); }],
      ["still exhausted", () => { clock = new Date(clock.getTime() + 60_000); snapshot(A, "5h", 100, at(0), at(3_600_000)); }],
      ["with no percentage", () => { clock = new Date(clock.getTime() + 60_000); db.prepare("INSERT INTO quota_snapshots (assistant_id, window, used_percent, resets_at, source, observed_at, account) VALUES (?, '5h', NULL, NULL, 'runtime-probe', ?, 'fake')").run(A, at(0)); }],
      ["stale (past the 15-minute freshness window)", () => { clock = new Date(clock.getTime() + 60_000); snapshot(A, "5h", 40, at(0)); clock = new Date(clock.getTime() + 16 * 60_000); }],
    ];
    it.each(cases)("%s", async (_name, evidence) => {
      await boot();
      limitA(2 * 3_600_000);
      evidence();
      const explanation = route();
      expect(explanation.chosen).toBe(B);
      expect(failuresOf(explanation, A).join(" ")).toContain("(5h limit reached)");
    });
  });
});
