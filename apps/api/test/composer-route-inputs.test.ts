/**
 * M2 Composer S3: `routeInputs` is the input-building half of `routeTask`. It reads and writes
 * nothing; `routeTask` is `routeInputs` + `route()` + the same persisted row as before.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AssistantId, RoutingExplanation } from "@agent-plane/core";
import { loadConfig, type ResolvedConfig } from "../src/config.js";
import { openDb, type Db } from "../src/db/index.js";
import { route, routeInputs, routeTask } from "../src/modules/router.js";
import { buildServer, type BuiltServer } from "../src/server.js";

const A = "fake-a" as AssistantId;
const B = "fake-b" as AssistantId;
let home: string;
let db: Db;
let config: ResolvedConfig;
let built: BuiltServer;
const now = () => new Date("2030-01-01T00:00:00Z");

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), "route-inputs-"));
  config = loadConfig({ AGENT_PLANE_HOME: home });
  config.assistants = { [A]: { provider: "fake" }, [B]: { provider: "fake" } };
  db = openDb(config.dbPath);
  built = buildServer({ config, db, now });
  built.registry.init();
  await built.registry.syncAll();
});
afterEach(() => { db.close(); rmSync(home, { recursive: true, force: true }); });

const deps = () => ({ db, config, tasks: built.tasks, registry: built.registry, cooldowns: built.cooldowns, now });
const rows = () => db.prepare("SELECT chosen_assistant_id, explanation FROM routing_decisions ORDER BY id").all() as Array<{ chosen_assistant_id: string | null; explanation: string }>;

describe("routeInputs", () => {
  it("builds the route() request without persisting anything", () => {
    const { taskId } = built.tasks.create({ goal: "Summarise the README", profile: "preserve-quota" });
    const inputs = routeInputs(deps(), taskId, "intake");
    expect(rows()).toEqual([]);
    expect(inputs.request).toMatchObject({ taskId, profile: "preserve-quota", needsRepo: false, repoPathAllowed: true });
    expect(inputs.candidates.map((c) => [c.id, c.enabled])).toEqual([[A, true], [B, true]]);
    expect(inputs.intent.goal).toBe("Summarise the README");
    expect(inputs.dispatch).toBeUndefined();
    expect(inputs.continuation).toBeUndefined();
    expect(route(inputs.request, inputs.candidates).chosen).toBe(A);
    expect(rows()).toEqual([]);
  });

  it("applies the same exclusion and override options routeTask always has", () => {
    const { taskId } = built.tasks.create({ goal: "g" });
    const excluded = routeInputs(deps(), taskId, "failover", { exclude: A });
    expect(excluded.candidates.find((c) => c.id === A)!.enabled).toBe(false);
    expect(route(excluded.request, excluded.candidates).chosen).toBe(B);
    const overridden = routeInputs(deps(), taskId, "intake", { override: B });
    expect(overridden.request.userOverride).toBe(B);
    expect(route(overridden.request, overridden.candidates)).toMatchObject({ ruleFired: "user-override", chosen: B });
  });

  it("throws for an unknown task, as routeTask does", () => {
    expect(() => routeInputs(deps(), "AG-nope", "intake")).toThrow("Unknown task AG-nope");
    expect(() => routeTask(deps(), "AG-nope", "intake")).toThrow("Unknown task AG-nope");
  });
});

describe("routeTask over routeInputs", () => {
  it("persists exactly the route() outcome plus its origin, in one routing_decisions row", () => {
    const { taskId } = built.tasks.create({ goal: "Summarise the README" });
    const inputs = routeInputs(deps(), taskId, "intake");
    const direct = route(inputs.request, inputs.candidates);

    const { explanation, routingDecisionId } = routeTask(deps(), taskId, "intake");
    expect(explanation).toMatchObject({ ...direct, origin: "intake" });
    const stored = rows();
    expect(stored).toHaveLength(1);
    expect(stored[0]!.chosen_assistant_id).toBe(direct.chosen);
    expect(JSON.parse(stored[0]!.explanation) as RoutingExplanation).toEqual(JSON.parse(JSON.stringify(explanation)));
    expect((db.prepare("SELECT id FROM routing_decisions").get() as { id: number }).id).toBe(routingDecisionId);
  });

  it("a user override on the intent still wins and is recorded unchanged", () => {
    const { taskId } = built.tasks.create({ goal: "g", overrides: { assistantId: B } });
    const { explanation } = routeTask(deps(), taskId, "intake");
    expect(explanation).toMatchObject({ ruleFired: "user-override", chosen: B, userOverride: B, origin: "intake" });
  });
});
