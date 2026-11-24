/**
 * Run estimate v1 contract (`contracts/run-estimate/v1`): the fixtures pass and fail the published
 * JSON Schemas as named, and the bodies the real routes serve validate against them. Cockpit vendors
 * these schemas pinned by SHA, so a route change that breaks them fails here first.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import { afterEach, describe, expect, it } from "vitest";
import { bootRig, reaches, type Rig } from "./helpers/composer-cockpit.js";

const CONTRACT = join(import.meta.dirname, "../../../contracts/run-estimate/v1");
const BASE = "https://agent-plane.local/contracts/run-estimate/v1/";
const SCHEMAS = ["run-estimate", "task-estimate", "task-recorded-estimates"] as const;

function compile() {
  const ajv = new Ajv2020({ strict: true, allErrors: true });
  for (const name of SCHEMAS) ajv.addSchema(JSON.parse(readFileSync(join(CONTRACT, `${name}.schema.json`), "utf8")));
  return (name: (typeof SCHEMAS)[number], body: unknown) => {
    const validate = ajv.getSchema(`${BASE}${name}.schema.json`)!;
    return { ok: validate(body) as boolean, errors: validate.errors };
  };
}
/** A fixture names its schema by prefix: `task-estimate-…`, `task-recorded-estimates-…` or `run-estimate-…`. */
const schemaOf = (file: string) => [...SCHEMAS].sort((a, b) => b.length - a.length).find((s) => file.startsWith(`${s}-`))!;

let rig: Rig | undefined;
afterEach(async () => {
  await rig?.close();
  rig = undefined;
});
const SUN_1000 = Date.parse("2030-01-06T08:00:00.000Z");

describe("run estimate v1 contract", () => {
  it("its fixtures pass and fail the schemas as named", () => {
    const check = compile();
    for (const kind of ["valid", "invalid"] as const) {
      for (const name of readdirSync(join(CONTRACT, "fixtures", kind))) {
        const schema = schemaOf(name);
        expect(schema, name).toBeDefined();
        const body = JSON.parse(readFileSync(join(CONTRACT, "fixtures", kind, name), "utf8"));
        expect([name, check(schema, body).ok]).toEqual([name, kind === "valid"]);
      }
    }
    expect(readdirSync(join(CONTRACT, "fixtures", "valid")).length).toBeGreaterThanOrEqual(5);
  });

  it("the routes serve bodies that validate: no history, a cohort with usage, approval, deadline, recorded", async () => {
    const t0 = Date.now();
    rig = await bootRig({
      assistants: { "fake-a": { provider: "fake" }, "fake-b": { provider: "fake" } },
      enabled: false,
      now: () => new Date(SUN_1000 + (Date.now() - t0)),
    });
    const r = rig;
    const check = compile();
    const get = async (url: string) => {
      const res = await r.built.app.inject({ method: "GET", url, headers: r.auth() });
      expect(res.statusCode, res.body).toBe(200);
      return res.json() as unknown;
    };
    const valid = (schema: (typeof SCHEMAS)[number], body: unknown) => expect(check(schema, body).errors ?? null).toBeNull();
    const task = (goal: string) => r.built.tasks.create({ goal, repoPath: r.repo }).taskId;

    const fresh = task("Add a typed helper to the parser module");
    valid("task-estimate", await get(`/api/tasks/${fresh}/estimate`));

    const runs: Array<{ taskId: string; runId: string }> = [];
    for (const goal of ["Add a typed helper to the parser", "Add a typed helper to the lexer", "Add a typed helper to the printer"]) {
      const id = task(goal);
      const res = await r.built.app.inject({ method: "POST", url: `/api/tasks/${id}/start`, headers: r.auth(), payload: { assistantId: "fake-a" } });
      expect(res.statusCode, res.body).toBe(200);
      expect(await reaches(r.built, id, ["COMPLETED", "FAILED", "CANCELLED", "WAITING_INPUT"])).toBe("COMPLETED");
      runs.push({ taskId: id, runId: (res.json() as { runId: string }).runId });
    }
    const posted = await r.postUsage({ eventId: "evt-contract", runId: runs[0]!.runId, accounting: "cumulative", tokensIn: 50_000, tokensOut: 5_000, apiEquivalentUsd: 1.5 });
    expect(posted.status).toBe(201);

    const next = task("Add a typed helper to the formatter");
    const cohort = await get(`/api/tasks/${next}/estimate?assistant=fake-a`) as { estimate: { durationMs: { range: unknown } } };
    expect(cohort.estimate.durationMs.range).not.toBeNull();
    valid("task-estimate", cohort);
    valid("run-estimate", (cohort as { estimate: unknown }).estimate);
    valid("task-estimate", await get(`/api/tasks/${next}/estimate?approval=required`));
    valid("task-estimate", await get(`/api/tasks/${next}/estimate?deadline=2030-01-06T09:00:00Z`));

    const recorded = await get(`/api/tasks/${runs[2]!.taskId}/estimates/recorded`) as { records: Array<{ actual: unknown }> };
    expect(recorded.records).toHaveLength(1);
    expect(recorded.records[0]!.actual).not.toBeNull();
    valid("task-recorded-estimates", recorded);
    valid("task-recorded-estimates", await get(`/api/tasks/${fresh}/estimates/recorded`));
  });
});
