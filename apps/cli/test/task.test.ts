/**
 * `aos task provenance` (tlm-03): the CLI side of tlm-02a's provenance read. Against a real plane
 * the command reaches exactly `GET /api/tasks/:id/provenance`, `--json` is the body the route
 * serves, and the text names the source of every join. Fixtures then cover the joins a fake run
 * cannot produce on demand (inferred, unrecorded, envelope-only, autopilot owner).
 */
import { afterEach, describe, expect, it } from "vitest";
import { INFERENCE_RULES, type RunProvenance, type TaskProvenance } from "../../api/src/modules/provenance.js";
import { credentialPath, readCredential } from "../../api/src/auth/credential-file.js";
import { readApiEndpoint } from "../../api/src/config.js";
import { checkProvenance, COMMAND_ROUTES, provenanceText } from "../src/task.js";
import { aos, bootPlane, type Plane } from "./helpers.js";

let plane: Plane | undefined;
afterEach(async () => { await plane?.close(); plane = undefined; });

const task = (argv: string[], opts: { fetchImpl?: typeof fetch } = {}) => aos(plane!, argv, { ...opts, group: "task" });
async function settle(id: string) {
  await plane!.built.orchestrator.waitForSettled(id);
}

describe("aos task provenance against a real plane", () => {
  it("reaches only the provenance route, --json is the served body, and a failover reads as a labelled handoff", async () => {
    plane = await bootPlane();
    const id = plane.built.tasks.create({ goal: "Ship the feature [FAKE:LIMIT]" }).taskId;
    const started = await task(["provenance", id, "--json"]);
    expect(started.code, started.err).toBe(0);
    expect(JSON.parse(started.out)).toMatchObject({ taskId: id, runs: [], handoffs: [], owner: { kind: "operator" } });

    // Start it the way the web does: POST /api/tasks/:id/start with the workspace credential.
    const { dir } = readApiEndpoint({ AGENT_PLANE_HOME: plane.home });
    const bearer = readCredential(credentialPath(dir)).secrets.at(-1)!.secret;
    const res = await plane.built.app.inject({ method: "POST", url: `/api/tasks/${id}/start`, headers: { authorization: `Bearer ${bearer}` }, payload: { assistantId: "fake-a" } });
    expect(res.statusCode, res.body).toBe(200);
    await settle(id);

    const seen: string[] = [];
    const recording: typeof fetch = (input, init) => {
      seen.push(`${init?.method ?? "GET"} ${new URL(String(input)).pathname.replace(`/api/tasks/${id}/`, "/api/tasks/:id/")}`);
      return fetch(input, init);
    };
    const asJson = await task(["provenance", id, "--json"], { fetchImpl: recording });
    expect(asJson.code, asJson.err).toBe(0);
    expect(seen).toEqual([...COMMAND_ROUTES.provenance!]);
    expect(plane.built.app.hasRoute({ method: "GET", url: "/api/tasks/:id/provenance" })).toBe(true);

    const p = JSON.parse(asJson.out) as TaskProvenance;
    const served = await plane.built.app.inject({ method: "GET", url: `/api/tasks/${id}/provenance`, headers: { authorization: `Bearer ${bearer}` } });
    expect(p).toEqual(served.json());
    expect(p.runs.map((r) => r.assistantId)).toEqual(["fake-a", "fake-b"]);
    expect(p.handoffs).toHaveLength(1);

    const text = await task(["provenance", id]);
    expect(text.code, text.err).toBe(0);
    const [first, second] = p.runs;
    const [h] = p.handoffs;
    expect(text.out).toContain(`Task ${id} · mode single · owner operator`);
    expect(text.out).toContain("Runs (2):");
    expect(text.out).toContain(`run ${first!.runId} · fake-a`);
    expect(text.out).toContain(`launch: handoff (trigger ${h!.trigger})`);
    expect(text.out).toContain(`continues: run ${first!.runId} (fake-a) [via handoff_record]`);
    expect(text.out).toContain(`routing: decision #${second!.routingDecision.id} chose fake-b`);
    expect(text.out).toContain(`from run ${first!.runId} (fake-a) [via handoff_record] -> to run ${second!.runId} (fake-b)`);
  });

  it("an unknown task exits 1 with a plain message; bad usage exits 2", async () => {
    plane = await bootPlane();
    const missing = await task(["provenance", "nope"]);
    expect(missing.code).toBe(1);
    expect(missing.err).toMatch(/aos task provenance: no task nope/);
    expect((await task(["provenance"])).code).toBe(2);
    expect((await task(["show", "x"])).code).toBe(2);
    expect((await task(["provenance", "a", "b"])).code).toBe(2);
    const help = await task(["--help"]);
    expect(help.code).toBe(0);
    expect(help.out).toContain("GET /api/tasks/:id/provenance");
    expect(help.out).toContain("Exit codes: 0 ok, 1 failure");
  });

  it("refuses a body that is not the API 2.12 shape instead of printing it", async () => {
    plane = await bootPlane();
    const id = plane.built.tasks.create({ goal: "Plan the parser module" }).taskId;
    const wrong: typeof fetch = async () => new Response(JSON.stringify({ taskId: id, runs: [] }), { status: 200 });
    const r = await task(["provenance", id], { fetchImpl: wrong });
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/not the API 2\.12 shape, so nothing is shown: handoffs is not a list/);
    expect(r.out).toBe("");
  });
});

const baseRun = (over: Partial<RunProvenance>): RunProvenance => ({
  runId: "run-1", assistantId: "fake-a", executionPath: "legacy", executionRequestId: null, attempt: null,
  startedAt: "2026-11-21T10:00:00.000Z", endedAt: null, settlementOwner: null, compositionRevisionId: null, promptSource: null,
  launch: { kind: "operator", dispatch: null, handoffTrigger: null },
  routingDecision: { id: null, source: "unrecorded", chosenAssistantId: null, at: null },
  continuedFrom: null,
  ...over,
});

describe("provenanceText", () => {
  it("labels inferred and unrecorded joins and prints the plane's inference rules", () => {
    const p: TaskProvenance = {
      taskId: "t-1", mode: "single", owner: { kind: "operator", runAs: null }, inferenceRules: INFERENCE_RULES,
      runs: [
        baseRun({ routingDecision: { id: 7, source: "inferred", chosenAssistantId: "fake-a", at: "2026-11-21T09:59:00.000Z" } }),
        baseRun({ runId: "run-2", assistantId: "fake-b", continuedFrom: { runId: "run-1", assistantId: "fake-a", source: "inferred", checkpointId: "cp-1", handoffId: null, envelopeId: null } }),
      ],
      handoffs: [],
    };
    const text = provenanceText(checkProvenance(p, "t-1"));
    expect(text).toContain("routing: decision #7 chose fake-a at 2026-11-21T09:59:00.000Z [INFERRED]");
    expect(text).toContain("routing: UNRECORDED (no decision names this run)");
    expect(text).toContain("continues: run run-1 (fake-a) [INFERRED] · checkpoint cp-1");
    expect(text).toContain("legacy (no execution request)");
    expect(text).toContain(`routingDecision: ${INFERENCE_RULES.routingDecision}`);
    expect(text).toContain(`predecessor: ${INFERENCE_RULES.predecessor}`);
    expect(text).toContain("UNRECORDED joins: no record names them");
  });

  it("prints no rules when every join is a stored key, and shows an autopilot owner, a dispatch and an open envelope", () => {
    const p: TaskProvenance = {
      taskId: "t-2", mode: "single", inferenceRules: INFERENCE_RULES,
      owner: { kind: "autopilot", runAs: "aos-agent", attemptId: "att-1", itemId: "tlm-03", attemptNo: 2, state: "running" },
      runs: [baseRun({
        executionPath: "harness", executionRequestId: "disp-1", attempt: 1, promptSource: "fresh",
        launch: { kind: "scheduler", dispatch: { id: "disp-1", origin: "time", phase: "started", generation: 3 }, handoffTrigger: null },
        routingDecision: { id: 4, source: "dispatch", chosenAssistantId: "fake-a", at: "2026-11-21T09:00:00.000Z" },
      })],
      handoffs: [{
        id: "env-1", record: "envelope_only", trigger: null, at: "2026-11-21T10:05:00.000Z", checkpointId: "cp-9",
        from: { runId: "run-1", assistantId: "fake-a", source: "handoff_envelope" }, to: { runId: null, assistantId: null },
        closed: false, envelope: { id: "env-1", state: "ready", claimedByRequestId: null }, successorRoutingDecisionId: null,
      }],
    };
    const text = provenanceText(checkProvenance(p, "t-2"));
    expect(text).toContain("owner autopilot attempt att-1 (item tlm-03, attempt 2, running) · run as aos-agent");
    expect(text).toContain("launch: scheduler dispatch disp-1 (origin time, phase started, generation 3)");
    expect(text).toContain("[via dispatch]");
    expect(text).toContain("Harness envelope with no handoff record");
    expect(text).toContain("OPEN: no successor has started");
    expect(text).toContain("from run run-1 (fake-a) [via handoff_envelope] -> to no run");
    expect(text).toContain("envelope env-1 (ready, unclaimed)");
    expect(text).not.toContain("INFERRED");
    expect(text).not.toContain("UNRECORDED");
  });

  it("a task that never started says so", () => {
    const text = provenanceText({ taskId: "t-3", mode: "single", owner: { kind: "operator", runAs: null }, runs: [], handoffs: [], inferenceRules: INFERENCE_RULES });
    expect(text).toContain("Runs: none (the task has not started)");
    expect(text).toContain("Handoffs: none");
  });
});
