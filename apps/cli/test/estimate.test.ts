/**
 * `aos task estimate` (qcq-03): the CLI side of `GET /api/tasks/:id/estimate` (API 2.15) and
 * `GET /api/tasks/:id/estimates/recorded` (qcq-02, API 2.16). Against a real plane each form
 * reaches exactly its route, `--json` is the served body, and the text keeps API spend,
 * API-equivalent and subscription quota on separate, labelled lines.
 */
import { afterEach, describe, expect, it } from "vitest";
import type { RunEstimate } from "@agent-plane/core";
import { spendLines } from "../src/estimate.js";
import { COMMAND_ROUTES } from "../src/task.js";
import { aos, bearer, bootPlane, type Plane } from "./helpers.js";

let plane: Plane | undefined;
afterEach(async () => { await plane?.close(); plane = undefined; });

const task = (argv: string[], opts: { fetchImpl?: typeof fetch } = {}) => aos(plane!, argv, { ...opts, group: "task" });
const recording = (id: string, seen: string[]): typeof fetch => (input, init) => {
  const u = new URL(String(input));
  seen.push(`${init?.method ?? "GET"} ${u.pathname.replace(`/api/tasks/${id}/`, "/api/tasks/:id/")}${u.search}`);
  return fetch(input, init);
};

describe("aos task estimate against a real plane", () => {
  it("prints the served estimate, passes the what-if knobs, and shows the recorded estimate beside the actual", async () => {
    plane = await bootPlane();
    const id = plane.built.tasks.create({ goal: "Document the parser module" }).taskId;

    const seen: string[] = [];
    const asJson = await task(["estimate", id, "--json"], { fetchImpl: recording(id, seen) });
    expect(asJson.code, asJson.err).toBe(0);
    expect(seen).toEqual([...COMMAND_ROUTES.estimate!]);
    const served = await plane.built.app.inject({ method: "GET", url: `/api/tasks/${id}/estimate`, headers: { authorization: `Bearer ${bearer(plane)}` } });
    const body = JSON.parse(asJson.out) as { taskId: string; advisory: boolean; estimate: RunEstimate };
    expect(body).toMatchObject({ taskId: id, advisory: true });
    expect(body.estimate.subject).toEqual((served.json() as { estimate: RunEstimate }).estimate.subject);

    const text = await task(["estimate", id]);
    expect(text.code, text.err).toBe(0);
    expect(text.out).toContain(`Task ${id} · ADVISORY estimate`);
    expect(text.out).toMatch(/Effort: unknown \(not recorded in the execution identity/);
    expect(text.out).toContain("Confidence: unknown · cohort none, 0 run(s)");
    expect(text.out).toMatch(/^ {2}API spend: {10}n\/a/m);
    expect(text.out).toMatch(/^ {2}API-equivalent: {5}n\/a/m);
    expect(text.out).toMatch(/^ {2}subscription quota: /m);
    expect(text.out).toContain("Recommendation (advisory): run-now");
    expect(text.out).toContain("unchanged: acceptance tests, permissions and approval mode, spend limits, dispatch and scheduling");

    const knobs: string[] = [];
    const whatIf = await task(["estimate", id, "--assistant", "fake-b", "--approval-required", "--deadline", "2030-01-06T09:00:00Z"], { fetchImpl: recording(id, knobs) });
    expect(whatIf.code, whatIf.err).toBe(0);
    expect(knobs).toEqual(["GET /api/tasks/:id/estimate?deadline=2030-01-06T09%3A00%3A00Z&approval=required&assistant=fake-b"]);
    expect(whatIf.out).toContain("(what-if: assistant pinned by --assistant)");
    expect(whatIf.out).toContain("Recommendation (advisory): wait-for-approval");

    const none = await task(["estimate", id, "--recorded"]);
    expect(none.code, none.err).toBe(0);
    expect(none.out).toContain("no estimate recorded");

    const res = await plane.built.app.inject({ method: "POST", url: `/api/tasks/${id}/start`, headers: { authorization: `Bearer ${bearer(plane)}` }, payload: { assistantId: "fake-a" } });
    expect(res.statusCode, res.body).toBe(200);
    await plane.built.orchestrator.waitForSettled(id);
    const runId = (res.json() as { runId: string }).runId;

    const rec: string[] = [];
    const recorded = await task(["estimate", id, "--recorded"], { fetchImpl: recording(id, rec) });
    expect(recorded.code, recorded.err).toBe(0);
    expect(rec).toEqual([...COMMAND_ROUTES["estimate --recorded"]!]);
    expect(recorded.out).toContain("estimates recorded at start (1), ADVISORY:");
    expect(recorded.out).toContain(`1. run ${runId} · fake-a · recorded `);
    expect(recorded.out).toMatch(/shown: duration unknown .* run-now/);
    expect(recorded.out).toMatch(/actual: ENDED_OK · duration /);
  });

  it("an unknown task exits 1; misplaced flags exit 2; a body of another shape is refused", async () => {
    plane = await bootPlane();
    const missing = await task(["estimate", "nope"]);
    expect(missing.code).toBe(1);
    expect(missing.err).toMatch(/aos task estimate: no task nope/);
    expect((await task(["estimate"])).code).toBe(2);
    expect((await task(["show", "x", "--recorded"])).code).toBe(2);
    expect((await task(["estimate", "x", "--recorded", "--assistant", "fake-a"])).code).toBe(2);
    const bad = await task(["estimate", "x", "--deadline", "soon"]);
    expect(bad.code).toBe(1);
    expect(bad.err).toMatch(/deadline must be an ISO instant/);

    const id = plane.built.tasks.create({ goal: "Plan the parser module" }).taskId;
    const wrong: typeof fetch = async () => new Response(JSON.stringify({ taskId: id, advisory: true }), { status: 200 });
    const r = await task(["estimate", id], { fetchImpl: wrong });
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/not the run-estimate v1 shape, so nothing is shown: estimate is missing/);
    expect(r.out).toBe("");
  });
});

describe("spendLines", () => {
  const spend = (over: Partial<RunEstimate["spend"]>): RunEstimate["spend"] => ({
    billing: "subscription", billingBasis: "provider default", apiUsd: null, apiEquivalentUsd: null, subscriptionQuota: null, ...over,
  });

  it("never prints API-equivalent dollars as spend", () => {
    const lines = spendLines(spend({ apiEquivalentUsd: { low: 0.5, typical: 1.25, high: 3 },
      subscriptionQuota: { bucket: "five_hour", usedPercent: 82, resetsAt: "2030-01-06T12:00:00Z", observedAt: "2030-01-06T08:00:00Z", perRunShare: "unknown" } }));
    expect(lines[1]).toBe("  API spend:          n/a (not API-billed)");
    expect(lines[2]).toBe("  API-equivalent:     $0.5000 / $1.25 / $3.00 (what the tokens would cost on the API; not spend)");
    expect(lines[3]).toContain("five_hour at 82%");
    expect(lines[3]).toContain("per-run share unknown");
  });

  it("an API-billed runtime shows spend and no API-equivalent", () => {
    const lines = spendLines(spend({ billing: "api", apiUsd: { low: 0.01, typical: 0.02, high: 0.04 } }));
    expect(lines[1]).toBe("  API spend:          $0.0100 / $0.0200 / $0.0400");
    expect(lines[2]).toBe("  API-equivalent:     n/a (not subscription-billed)");
  });
});
