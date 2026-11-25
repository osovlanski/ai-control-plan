/**
 * tlm-02a: `GET /api/tasks/:id/provenance` joins a task's runs to the records that explain them
 * (routing decision, dispatch, checkpoint, handoff record, Harness envelope) on every execution
 * path, and names the source of each join. The legacy path stores no run→decision key, so that
 * join is `inferred` by the stated rule; the Harness and scheduler paths are exact.
 */
import { afterEach, describe, expect, it } from "vitest";
import { INFERENCE_RULES, type TaskProvenance } from "../src/modules/provenance.js";
import { bootRig, reaches, type Rig } from "./helpers/composer-cockpit.js";

let rig: Rig | undefined;
afterEach(async () => {
  await rig?.close();
  rig = undefined;
});

const ASSISTANTS = { "fake-a": { provider: "fake" }, "fake-b": { provider: "fake" } } as const;
const legacy = (c: Rig["config"]) => { c.execution.harnessModes.single = false; };
const settled = (id: string) => reaches(rig!.built, id, ["COMPLETED", "FAILED", "CANCELLED", "WAITING_INPUT"]);

async function boot(options: { legacy?: boolean; prompt?: boolean } = {}) {
  rig = await bootRig({ assistants: ASSISTANTS, enabled: false, configure: (c) => {
    if (options.legacy) legacy(c);
    if (options.prompt) c.policy.approvalMode = "prompt-on-escalation";
  } });
  return rig;
}
const task = (goal: string, repo = true) => rig!.built.tasks.create({ goal, ...(repo ? { repoPath: rig!.repo } : {}) }).taskId;
async function provenance(taskId: string): Promise<TaskProvenance> {
  const res = await rig!.built.app.inject({ method: "GET", url: `/api/tasks/${taskId}/provenance`, headers: rig!.auth() });
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as TaskProvenance;
}
async function start(taskId: string, assistantId?: string) {
  const res = await rig!.built.app.inject({ method: "POST", url: `/api/tasks/${taskId}/start`, headers: rig!.auth(), payload: assistantId ? { assistantId } : {} });
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as { runId: string };
}
const decisions = (taskId: string) => rig!.db.prepare("SELECT id, chosen_assistant_id FROM routing_decisions WHERE task_id = ? ORDER BY id").all(taskId) as Array<{ id: number; chosen_assistant_id: string }>;

describe("GET /api/tasks/:id/provenance", () => {
  it("404s an unknown task and requires sessions.read", async () => {
    await boot();
    const missing = await rig!.built.app.inject({ method: "GET", url: "/api/tasks/nope/provenance", headers: rig!.auth() });
    expect(missing.statusCode).toBe(404);
    const anonymous = await rig!.built.app.inject({ method: "GET", url: "/api/tasks/nope/provenance" });
    expect(anonymous.statusCode).toBe(401);
    // A credential without sessions.read is refused, even one that can write usage.
    const narrow = await rig!.built.app.inject({ method: "GET", url: "/api/tasks/nope/provenance", headers: rig!.usageAuth() });
    expect(narrow.statusCode).toBe(403);
  });

  it("a task never started has an operator owner, no runs and no handoffs", async () => {
    await boot();
    const id = task("Plan the parser module", false);
    expect(await provenance(id)).toEqual({
      taskId: id, owner: { kind: "operator", runAs: null }, mode: "single", runs: [], handoffs: [], inferenceRules: INFERENCE_RULES,
    });
  });

  it("Harness start: the run joins its routing decision through its execution request", async () => {
    await boot();
    const id = task("Add a typed helper to the parser module");
    const { runId } = await start(id, "fake-b");
    expect(await settled(id)).toBe("COMPLETED");
    const p = await provenance(id);
    const [decision] = decisions(id);
    expect(p.runs).toHaveLength(1);
    expect(p.runs[0]).toMatchObject({
      runId, assistantId: "fake-b", executionPath: "harness", promptSource: "fresh", attempt: 1,
      launch: { kind: "operator", dispatch: null, handoffTrigger: null },
      routingDecision: { id: decision!.id, source: "execution_request", chosenAssistantId: "fake-b" },
      continuedFrom: null,
    });
    expect(p.runs[0]!.executionRequestId).toEqual(expect.any(String));
    expect(p.runs[0]!.settlementOwner).toEqual(expect.any(String));
  });

  it("legacy start: the run has no stored decision key, so the join is inferred by the stated rule", async () => {
    await boot({ legacy: true });
    const id = task("Add a typed helper to the parser module");
    // A routing preview for the other assistant must not be taken for this run's decision.
    await rig!.built.app.inject({ method: "POST", url: `/api/tasks/${id}/route`, headers: rig!.auth(), payload: { assistantId: "fake-b" } });
    const { runId } = await start(id, "fake-a");
    expect(await settled(id)).toBe("COMPLETED");
    const p = await provenance(id);
    const chosen = decisions(id).filter((d) => d.chosen_assistant_id === "fake-a").at(-1)!;
    expect(p.runs).toEqual([expect.objectContaining({
      runId, executionPath: "legacy", executionRequestId: null, attempt: null, promptSource: null,
      launch: { kind: "operator", dispatch: null, handoffTrigger: null },
      routingDecision: expect.objectContaining({ id: chosen.id, source: "inferred", chosenAssistantId: "fake-a" }),
      continuedFrom: null,
    })]);
    expect(p.inferenceRules.routingDecision).toMatch(/at or before the run started/);
  });

  it("legacy run with no decision for its assistant reports the join as unrecorded", async () => {
    await boot({ legacy: true });
    const id = task("Add a typed helper to the parser module");
    await start(id, "fake-a");
    expect(await settled(id)).toBe("COMPLETED");
    // A decision that chose someone else is all there is.
    rig!.db.prepare("UPDATE routing_decisions SET chosen_assistant_id = 'fake-b' WHERE task_id = ?").run(id);
    const [run] = (await provenance(id)).runs;
    expect(run!.routingDecision).toEqual({ id: null, source: "unrecorded", chosenAssistantId: null, at: null });
  });

  for (const path of ["harness", "legacy"] as const) {
    it(`${path} failover: the successor continues the limited run through the handoff record`, async () => {
      await boot({ legacy: path === "legacy" });
      // No pool or cooldown config: a limit hands off to the other assistant at once.
      const id = task("Ship the feature [FAKE:LIMIT]");
      const { runId: first } = await start(id, "fake-a");
      expect(await settled(id)).toBe("COMPLETED");
      const p = await provenance(id);
      expect(p.runs.map((r) => r.assistantId)).toEqual(["fake-a", "fake-b"]);
      const [source, successor] = p.runs;
      expect(source!.runId).toBe(first);
      expect(p.handoffs).toHaveLength(1);
      const [h] = p.handoffs;
      expect(h).toMatchObject({
        record: "handoff", closed: true,
        from: { runId: first, assistantId: "fake-a", source: "handoff_record" },
        to: { runId: successor!.runId, assistantId: "fake-b" },
        successorRoutingDecisionId: successor!.routingDecision.id,
      });
      expect(successor).toMatchObject({
        launch: { kind: "handoff", handoffTrigger: h!.trigger },
        continuedFrom: { runId: first, assistantId: "fake-a", source: "handoff_record", checkpointId: h!.checkpointId, handoffId: h!.id },
      });
      // The failover decision chose fake-b and is a different decision from the start's.
      expect(successor!.routingDecision).toMatchObject({ chosenAssistantId: "fake-b", source: path === "harness" ? "execution_request" : "inferred" });
      expect(successor!.routingDecision.id).not.toBe(source!.routingDecision.id);
      if (path === "harness") {
        expect(successor!.promptSource).toBe("handoff");
        expect(h!.envelope).toMatchObject({ id: expect.any(String), claimedByRequestId: successor!.executionRequestId });
        expect(successor!.continuedFrom!.envelopeId).toBe(h!.envelope!.id);
      } else {
        expect(h!.envelope).toBeNull();
      }
    });
  }

  it("manual handoff joins its source run, and infers it (labelled) when no record names it", async () => {
    await boot({ legacy: true, prompt: true });
    const id = task("Add a typed helper to the parser module [FAKE:APPROVAL]");
    const requested = new Promise<void>((resolve) => {
      const off = rig!.built.bus.subscribe(id, (p) => { if (p.event?.type === "approval.requested") { off(); resolve(); } });
    });
    const { runId: first } = await start(id, "fake-a");
    await requested;
    const running = reaches(rig!.built, id, ["RUNNING"]);
    const res = await rig!.built.app.inject({ method: "POST", url: `/api/tasks/${id}/handoff`, headers: rig!.auth(), payload: { to: "fake-b" } });
    expect(res.statusCode, res.body).toBe(200);
    await running;
    const p = await provenance(id);
    const [h] = p.handoffs;
    expect(h).toMatchObject({ trigger: "manual", closed: true, from: { runId: first, assistantId: "fake-a", source: "handoff_record" }, to: { assistantId: "fake-b" } });
    expect(p.runs.at(-1)!.continuedFrom).toMatchObject({ runId: first, handoffId: h!.id, source: "handoff_record" });

    // A handoff from a task with no live run checkpoints with a null run id, so neither the record
    // nor its checkpoint names the source (orchestrator `checkpoints.create(taskId, null, ...)`).
    rig!.db.prepare("UPDATE handoffs SET from_run_id = NULL WHERE id = ?").run(h!.id);
    rig!.db.prepare("UPDATE checkpoints SET run_id = NULL, session_id = NULL WHERE id = ?").run(h!.checkpointId);
    const gap = await provenance(id);
    expect(gap.handoffs[0]!.from).toEqual({ runId: first, assistantId: "fake-a", source: "inferred" });
    expect(gap.runs.at(-1)!.continuedFrom).toMatchObject({ runId: first, source: "inferred" });
    expect(gap.inferenceRules.predecessor).toMatch(/started most recently before/);

    // The existing handoffs read keeps its shape.
    const legacyRead = await rig!.built.app.inject({ method: "GET", url: `/api/tasks/${id}/handoffs`, headers: rig!.auth() });
    expect(Object.keys((legacyRead.json() as Array<Record<string, unknown>>)[0]!).sort())
      .toEqual(["at", "checkpoint_id", "from_assistant", "id", "to_assistant", "trigger"]);
  });

  it("scheduler run-now: the run joins its dispatch and the dispatch's routing decision", async () => {
    await boot();
    const id = task("Add a typed helper to the parser module");
    rig!.built.scheduler.attach(id, { kind: "time", notBefore: new Date(Date.now() + 3_600_000).toISOString() });
    const done = settled(id);
    await rig!.built.scheduler.runNow(id);
    expect(await done).toBe("COMPLETED");
    const dispatch = rig!.db.prepare("SELECT dispatch_id, origin, routing_decision_id, condition_generation FROM dispatches WHERE task_id = ?").get(id) as
      { dispatch_id: string; origin: string; routing_decision_id: number; condition_generation: number };
    const [run] = (await provenance(id)).runs;
    expect(run).toMatchObject({
      executionRequestId: dispatch.dispatch_id,
      launch: { kind: "scheduler", dispatch: { id: dispatch.dispatch_id, origin: dispatch.origin, phase: "started", generation: dispatch.condition_generation } },
      routingDecision: { id: dispatch.routing_decision_id },
    });
    expect(["execution_request", "dispatch"]).toContain(run!.routingDecision.source);
  });

  it("compare: each candidate is a parallel launch joined to the decision that chose it", async () => {
    await boot();
    const id = task("Add a typed helper to the parser module");
    const res = await rig!.built.app.inject({ method: "POST", url: `/api/tasks/${id}/parallel`, headers: rig!.auth(), payload: { assistants: ["fake-a", "fake-b"], mode: "compare" } });
    expect(res.statusCode, res.body).toBe(200);
    expect(await rig!.built.orchestrator.waitForSettled(id)).toBe("WAITING_INPUT");
    const p = await provenance(id);
    expect(p.mode).toBe("compare");
    // The compare path persists no routing decision without the composer, and its legacy runs
    // store no key: the join is an honest unknown, never borrowed from another record.
    expect(decisions(id)).toEqual([]);
    expect(p.runs.map((r) => [r.assistantId, r.launch.kind, r.executionPath, r.routingDecision.source]).sort())
      .toEqual([["fake-a", "parallel", "legacy", "unrecorded"], ["fake-b", "parallel", "legacy", "unrecorded"]]);
  });

  it("compare with the composer: each candidate joins the decision that chose it", async () => {
    rig = await bootRig({ assistants: ASSISTANTS, budget: { maxTokens: 10_000, maxRuntimeMs: 600_000 } });
    const id = task("Add a typed helper to the parser module");
    const res = await rig.built.app.inject({ method: "POST", url: `/api/tasks/${id}/parallel`, headers: rig.auth(), payload: { assistants: ["fake-a", "fake-b"], mode: "compare" } });
    expect(res.statusCode, res.body).toBe(200);
    expect(await rig.built.orchestrator.waitForSettled(id)).toBe("WAITING_INPUT");
    const p = await provenance(id);
    const byAssistant = new Map(decisions(id).map((d) => [d.chosen_assistant_id, d.id]));
    expect(byAssistant.size).toBe(2);
    expect(p.runs.map((r) => [r.assistantId, r.launch.kind, r.routingDecision.id, r.routingDecision.source]).sort())
      .toEqual([
        ["fake-a", "parallel", byAssistant.get("fake-a"), "execution_request"],
        ["fake-b", "parallel", byAssistant.get("fake-b"), "execution_request"],
      ]);
  });

  it("a Harness envelope no handoff record names is listed as an open envelope-only handoff", async () => {
    await boot();
    const id = task("Add a typed helper to the parser module");
    const { runId } = await start(id, "fake-a");
    expect(await settled(id)).toBe("COMPLETED");
    // A context continuation writes its envelope without a `handoffs` row (recordHandoff: false).
    const at = new Date().toISOString();
    rig!.db.prepare("INSERT INTO checkpoints (id, task_id, run_id, envelope_snapshot, reason, at) VALUES ('ckpt_FAKE', ?, NULL, '{}', 'handoff', ?)").run(id, at);
    rig!.db.prepare(
      `INSERT INTO handoff_envelopes (id, task_id, checkpoint_id, envelope, state, from_assistant_id, reason, source_session_id, created_at, updated_at)
       VALUES ('he_FAKE', ?, 'ckpt_FAKE', '{}', 'ready', 'fake-a', 'context continuation', ?, ?, ?)`,
    ).run(id, runId, at, at);
    const p = await provenance(id);
    expect(p.handoffs).toEqual([{
      id: "he_FAKE", record: "envelope_only", trigger: null, at, checkpointId: "ckpt_FAKE",
      from: { runId, assistantId: "fake-a", source: "handoff_envelope" },
      to: { runId: null, assistantId: null }, closed: false,
      envelope: { id: "he_FAKE", state: "ready", claimedByRequestId: null },
      successorRoutingDecisionId: null,
    }]);
  });

  it("an autopilot task names its attempt as the owner", async () => {
    await boot();
    const id = task("Plan the parser module", false);
    const at = new Date().toISOString();
    rig!.db.prepare(
      `INSERT INTO autopilot_attempts (id, item_id, attempt_no, reservation_id, task_id, state, runtime_budget_ms, created_at, updated_at)
       VALUES ('AA-FAKE-1', 'tlm-02a', 2, 'R-FAKE-not-real', ?, 'admitted', 60000, ?, ?)`,
    ).run(id, at, at);
    expect((await provenance(id)).owner).toEqual({ kind: "autopilot", runAs: null, attemptId: "AA-FAKE-1", itemId: "tlm-02a", attemptNo: 2, state: "admitted" });
  });
});
