/**
 * M2 Composer S6: recomposition at dispatch and failover (plans/m2-composer.md §2 stage 6, I-S1,
 * §5). A scheduler wake, run-now, failover or manual handoff composes a new revision over the
 * route the dispatch already made, with the task's remaining budget. A K11 continuation on the
 * same assistant reuses its revision. A recomposition with no budget left starts nothing.
 */
import { afterEach, describe, expect, it } from "vitest";
import type { AgentSpec, ComposerOverrides, CompositionDecision, ExecutionPolicy } from "@agent-plane/core";
import { bootRig, reaches, type Rig } from "./helpers/composer-cockpit.js";

let rig: Rig | undefined;
let instant = Date.parse("2030-01-01T00:00:00.000Z");
const now = () => new Date(instant);

afterEach(async () => {
  await rig?.close();
  rig = undefined;
});

const settled = (id: string) => reaches(rig!.built, id, ["COMPLETED", "FAILED", "CANCELLED", "WAITING_INPUT"]);

function revisions(taskId: string) {
  return (rig!.db.prepare(
    `SELECT s.composition_revision_id AS id, s.spec_json, d.decision_json FROM agent_specs s
       JOIN composition_decisions d ON d.composition_revision_id = s.composition_revision_id
      WHERE s.task_id = ? ORDER BY s.rowid`,
  ).all(taskId) as Array<{ id: string; spec_json: string; decision_json: string }>)
    .map((r) => ({ id: r.id, spec: JSON.parse(r.spec_json) as AgentSpec, decision: JSON.parse(r.decision_json) as CompositionDecision }));
}
const attempts = (taskId: string) => rig!.db.prepare(
  "SELECT origin, outcome, reason, routing_decision_id, composition_revision_id FROM composition_attempts WHERE task_id = ? ORDER BY rowid",
).all(taskId) as Array<{ origin: string; outcome: string; reason: string | null; routing_decision_id: number | null; composition_revision_id: string | null }>;
const runs = (taskId: string) => rig!.db.prepare(
  "SELECT id, assistant_id, composition_revision_id, execution_request_id FROM runs WHERE task_id = ? ORDER BY started_at, rowid",
).all(taskId) as Array<{ id: string; assistant_id: string; composition_revision_id: string | null; execution_request_id: string | null }>;
const request = (id: string) => {
  const row = rig!.db.prepare("SELECT composition_revision_id, routing_decision_ref, policy FROM execution_requests WHERE id = ?").get(id) as { composition_revision_id: string | null; routing_decision_ref: string; policy: string };
  return { ...row, policy: JSON.parse(row.policy) as ExecutionPolicy };
};
const confirm = (decision: CompositionDecision) => decision.stages.find((s) => s.stage === "confirm")!;
const routingRows = (taskId: string) => (rig!.db.prepare("SELECT COUNT(*) AS n FROM routing_decisions WHERE task_id = ?").get(taskId) as { n: number }).n;

function repoTask(goal: string, overrides?: { assistantId: string }): string {
  return rig!.built.tasks.create({ goal, repoPath: rig!.repo, ...(overrides ? { overrides: overrides as never } : {}) }).taskId;
}
function park(taskId: string) {
  rig!.built.scheduler.attach(taskId, { kind: "time", notBefore: new Date(instant + 1000).toISOString() });
}
async function operatorStart(taskId: string, overrides?: ComposerOverrides) {
  const res = await rig!.built.app.inject({ method: "POST", url: `/api/tasks/${taskId}/start`, headers: rig!.auth(), payload: overrides ? { overrides } : {} });
  return { status: res.statusCode, body: res.json() as { runId?: string; composition?: { compositionRevisionId: string | null } } };
}

describe("recomposition at a scheduler dispatch", () => {
  it.each([
    ["unchanged", 10_000, 5000],
    ["tightened", 4000, 4000],
    ["removed", undefined, 5000],
  ] as const)("run-now carries the persisted override when the config cap is %s", async (_label, configuredCap, effectiveCap) => {
    rig = await bootRig({ now, budget: { maxTokens: 10_000, maxRuntimeMs: 600_000 } });
    const id = repoTask("Ship the feature [FAKE:LIMIT]");
    expect((await operatorStart(id, { policy: { budget: { max_tokens: 5000, max_runtime_ms: 60_000 } } })).status).toBe(200);
    expect(await reaches(rig.built, id, ["WAITING_RESOURCE", "WAITING_INPUT"])).toBe("WAITING_RESOURCE");
    expect(revisions(id)[0]!.spec.policy.budget).toEqual({ max_tokens: 5000, max_runtime_ms: 60_000 });

    // Change only the live config; no override is sent with the scheduler dispatch.
    rig.config.composer.policy.budget = configuredCap === undefined ? {} : { maxTokens: configuredCap, maxRuntimeMs: 600_000 };
    instant += 11 * 60_000;
    const done = settled(id);
    await rig.built.scheduler.runNow(id);
    expect(await done).toBe("COMPLETED");
    const all = revisions(id);
    expect(all).toHaveLength(2);
    expect(all[1]!.spec.policy.budget).toEqual({ max_tokens: effectiveCap - 1650, max_runtime_ms: 60_000 });
    expect(attempts(id).at(-1)).toMatchObject({ origin: "run-now", outcome: "persisted" });
    expect(request(runs(id)[1]!.execution_request_id!)).toMatchObject({
      composition_revision_id: all[1]!.id,
      policy: { budget: { maxTokens: effectiveCap - 1650 }, timeout: { hardMs: 60_000 } },
    });
  });

  // A persisted revision's budget is the task's remainder when it was composed. The carry must take
  // the task cap behind it, so consumption is subtracted once, however many revisions came before.
  const policyEvidence = (decision: CompositionDecision, ref: string) =>
    decision.stages.find((s) => s.stage === "policy")!.candidates.find((c) => c.ref === ref)?.evidence;
  async function recompose(taskId: string) {
    const routingDecisionId = (rig!.db.prepare("SELECT routing_decision_id AS r FROM dispatches WHERE task_id = ? ORDER BY rowid DESC LIMIT 1").get(taskId) as { r: number }).r;
    const latest = revisions(taskId).at(-1)!.spec.workspace;
    const composed = await rig!.built.orchestrator.dispatchComposer!.composeForDispatch({ taskId, assistantId: "fake-a", origin: "wake", routingDecisionId });
    if (composed.kind !== "compose") return composed;
    return composed.composition.bind({ repositoryId: latest.repository_id, branch: latest.branch, worktreeId: latest.worktree_id });
  }
  async function twoRuns(configuredCap: number | undefined) {
    rig = await bootRig({ now, assistants: { "fake-a": { provider: "fake" } }, budget: { maxTokens: 10_000, maxRuntimeMs: 600_000 } });
    const id = repoTask("Ship the feature [FAKE:LIMIT]");
    expect((await operatorStart(id, { policy: { budget: { max_tokens: 5000, max_runtime_ms: 60_000 } } })).status).toBe(200);
    expect(await reaches(rig.built, id, ["WAITING_RESOURCE", "WAITING_INPUT"])).toBe("WAITING_RESOURCE");
    rig.config.composer.policy.budget = configuredCap === undefined ? {} : { maxTokens: configuredCap, maxRuntimeMs: 600_000 };
    instant += 11 * 60_000;
    const done = settled(id);
    await rig.built.scheduler.runNow(id);
    expect(await done).toBe("COMPLETED");
    return id;
  }

  it("revisions 2, 3 and 4 each carry the operator cap less the task's whole consumption, once", async () => {
    const id = await twoRuns(10_000);
    // Revision 2: 1650 consumed by run 1.
    const [r1, r2] = revisions(id);
    expect(r1!.spec.policy.budget).toEqual({ max_tokens: 5000, max_runtime_ms: 60_000 });
    expect(r2!.spec.policy.budget).toEqual({ max_tokens: 3350, max_runtime_ms: 60_000 });
    expect(policyEvidence(r2!.decision, "max_tokens:3350")).toContain("task cap 5000, consumed 1650, remaining 3350");

    // Revision 3: run 2 settled another 1650. 5000 - 3300, not 3350 - 3300.
    expect(await recompose(id)).toMatchObject({ ok: true, compositionRevisionId: `CR-${id}-3`, policy: { budget: { max_tokens: 1700, max_runtime_ms: 60_000 } } });
    const r3 = revisions(id)[2]!;
    expect(r3.spec.policy.budget).toEqual({ max_tokens: 1700, max_runtime_ms: 60_000 });
    expect(policyEvidence(r3.decision, "max_tokens:1700")).toContain("task cap 5000, consumed 3300, remaining 1700");

    // Revision 4: a late record lifts run 2 from 1650 to 2150 settled after revision 3 was composed.
    const run2 = runs(id)[1]!.id;
    expect((await rig!.postUsage({ eventId: "FAKE-evt-late", runId: run2, accounting: "cumulative", tokensIn: 1500, tokensOut: 650 })).status).toBe(201);
    expect(await recompose(id)).toMatchObject({ ok: true, compositionRevisionId: `CR-${id}-4`, policy: { budget: { max_tokens: 1200, max_runtime_ms: 60_000 } } });
    const r4 = revisions(id)[3]!;
    expect(policyEvidence(r4.decision, "max_tokens:1200")).toContain("task cap 5000, consumed 3800, remaining 1200");

    // Once the cap is spent the next recomposition starts nothing, rather than resetting.
    expect((await rig!.postUsage({ eventId: "FAKE-evt-late-2", runId: run2, accounting: "cumulative", tokensIn: 3000, tokensOut: 650 })).status).toBe(201);
    expect(await recompose(id)).toEqual({ kind: "blocked", reason: "budget_exhausted", pauseKind: "budget_exhausted" });
    expect(revisions(id)).toHaveLength(4);
  });

  it("when config tightens below the operator cap, policy wins at every later revision", async () => {
    const id = await twoRuns(4000);
    expect(revisions(id)[1]!.spec.policy.budget).toEqual({ max_tokens: 4000 - 1650, max_runtime_ms: 60_000 });
    expect(await recompose(id)).toMatchObject({ ok: true, policy: { budget: { max_tokens: 4000 - 3300, max_runtime_ms: 60_000 } } });
    expect(policyEvidence(revisions(id)[2]!.decision, "max_tokens:700")).toContain("task cap 4000, consumed 3300, remaining 700");
    // Raising config again never loosens: revision 3's task cap of 4000 is carried.
    rig!.config.composer.policy.budget = { maxTokens: 50_000, maxRuntimeMs: 600_000 };
    expect(await recompose(id)).toMatchObject({ ok: true, policy: { budget: { max_tokens: 700, max_runtime_ms: 60_000 } } });
  });

  it("a wake composes a new revision over the dispatch's own route and binds the run to it", async () => {
    rig = await bootRig({ now, budget: { maxTokens: 50_000, maxRuntimeMs: 600_000 } });
    const id = repoTask("Add a typed helper to the parser module");
    park(id);
    instant += 1000;
    const done = settled(id);
    await rig.built.scheduler.tick();
    expect(await done).toBe("COMPLETED");

    const [revision, ...rest] = revisions(id);
    expect(rest).toEqual([]);
    expect(revision!.id).toBe(`CR-${id}-1`);
    expect(confirm(revision!.decision)).toMatchObject({ chosen: ["start"], why: "wake dispatch; intent confirmed at creation" });
    // Nothing consumed yet: the revision carries the whole task cap.
    expect(revision!.spec.policy.budget).toEqual({ max_tokens: 50_000, max_runtime_ms: 600_000 });

    const dispatch = rig.db.prepare("SELECT dispatch_id, origin, routing_decision_id, phase FROM dispatches WHERE task_id = ?").get(id) as { dispatch_id: string; origin: string; routing_decision_id: number; phase: string };
    expect(dispatch).toMatchObject({ origin: "wake", phase: "started" });
    // One routing row: the dispatch's. The composition projected it rather than routing again.
    expect(routingRows(id)).toBe(1);
    expect(attempts(id)).toEqual([{ origin: "wake", outcome: "persisted", reason: null, routing_decision_id: dispatch.routing_decision_id, composition_revision_id: `CR-${id}-1` }]);
    const [run] = runs(id);
    expect(run).toMatchObject({ composition_revision_id: `CR-${id}-1`, execution_request_id: dispatch.dispatch_id });
    // BIND: the wake's run requests its revision's model, and records that the revision chose it.
    expect(rig.db.prepare("SELECT model_requested, model_requested_source FROM runs WHERE task_id = ?").get(id))
      .toEqual({ model_requested: revision!.spec.model.primary.id, model_requested_source: "revision" });
    const req = request(dispatch.dispatch_id);
    expect(req.composition_revision_id).toBe(`CR-${id}-1`);
    expect(req.routing_decision_ref).toBe(String(dispatch.routing_decision_id));
    expect(req.policy.budget).toEqual({ maxTokens: 50_000, enforcement: "advisory" });
    expect(req.policy.timeout).toEqual({ hardMs: 600_000 });
  });

  it("run-now recomposes under its own origin", async () => {
    rig = await bootRig({ now });
    const id = repoTask("Add a typed helper to the parser module");
    park(id);
    const done = settled(id);
    await rig.built.scheduler.runNow(id);
    expect(await done).toBe("COMPLETED");
    expect(attempts(id).map((a) => [a.origin, a.outcome])).toEqual([["run-now", "persisted"]]);
    expect(confirm(revisions(id)[0]!.decision).why).toBe("run-now dispatch; intent confirmed at creation");
    expect(runs(id)[0]!.composition_revision_id).toBe(`CR-${id}-1`);
  });

  it("with the composer off a dispatch is exactly as before: no attempt, no revision, no Cockpit render", async () => {
    rig = await bootRig({ now, enabled: false });
    const id = repoTask("Add a typed helper to the parser module");
    park(id);
    instant += 1000;
    const done = settled(id);
    await rig.built.scheduler.tick();
    expect(await done).toBe("COMPLETED");
    expect(attempts(id)).toEqual([]);
    expect(revisions(id)).toEqual([]);
    expect(rig.cockpit.renders).toBe(0);
    const [run] = runs(id);
    expect(run!.composition_revision_id).toBeNull();
    expect(request(run!.execution_request_id!).policy.budget).toEqual({ enforcement: "advisory" });
  });

  it("a dispatch that can never carry a revision records why and runs route-only; with requireRevision it aborts instead", async () => {
    rig = await bootRig({ now });
    const loose = rig.built.tasks.create({ goal: "Summarise the release notes" }).taskId;
    park(loose);
    instant += 1000;
    const done = settled(loose);
    await rig.built.scheduler.tick();
    expect(await done).toBe("COMPLETED");
    expect(attempts(loose).map((a) => [a.origin, a.outcome, a.reason])).toEqual([["wake", "skipped", "no_repository"]]);
    expect(runs(loose)[0]!.composition_revision_id).toBeNull();
    await rig.close();

    rig = await bootRig({ now, requireRevision: true });
    const strict = rig.built.tasks.create({ goal: "Summarise the release notes" }).taskId;
    park(strict);
    instant += 1000;
    const parked = settled(strict);
    await rig.built.scheduler.tick();
    expect(await parked).toBe("WAITING_INPUT");
    expect(rig.built.tasks.get(strict)!.pause_kind).toBe("intervention_required");
    expect(runs(strict)).toEqual([]);
    expect(rig.db.prepare("SELECT phase, reason FROM dispatches WHERE task_id = ?").get(strict)).toEqual({ phase: "aborted", reason: "no_repository" });
    // An operator decision, not a retry: no new wait was armed.
    expect(rig.built.scheduler.condition(strict)?.state).toBe("consumed");
  });
});

describe("recomposition at failover", () => {
  const two = { "fake-a": { provider: "fake" as const }, "fake-b": { provider: "fake" as const } };

  it.each([10_000, 5000])("a failover carries the persisted cap %i to the new assistant, less consumption", async (cap) => {
    rig = await bootRig({ now, assistants: two, budget: { maxTokens: 10_000 } });
    const id = repoTask("Ship the feature [FAKE:LIMIT]");
    const started = await operatorStart(id, { policy: { budget: { max_tokens: cap } } });
    expect(started.status).toBe(200);
    expect(started.body.composition?.compositionRevisionId).toBe(`CR-${id}-1`);
    expect(await rig.built.orchestrator.waitForSettled(id)).toBe("COMPLETED");

    const [first, second] = runs(id);
    expect(second!.assistant_id).not.toBe(first!.assistant_id);
    expect(first!.composition_revision_id).toBe(`CR-${id}-1`);
    expect(second!.composition_revision_id).toBe(`CR-${id}-2`);

    const [r1, r2] = revisions(id);
    expect(confirm(r2!.decision)).toMatchObject({ chosen: ["start"], why: "failover dispatch; intent confirmed at creation" });
    expect(r2!.spec.harness).toBe(r1!.spec.harness);
    // The first run settled 1200 in + 450 out (the fake reports one cumulative total).
    expect(r1!.spec.policy.budget).toEqual({ max_tokens: cap });
    expect(r2!.spec.policy.budget).toEqual({ max_tokens: cap - 1650 });
    const policy = r2!.decision.stages.find((s) => s.stage === "policy")!;
    expect(policy.candidates.find((c) => c.ref === `max_tokens:${cap - 1650}`)?.evidence).toContain(`task cap ${cap}, consumed 1650, remaining ${cap - 1650}`);
    expect(attempts(id).map((a) => [a.origin, a.outcome, a.composition_revision_id])).toEqual([
      ["start", "persisted", `CR-${id}-1`], ["failover", "persisted", `CR-${id}-2`],
    ]);
    expect(request(second!.execution_request_id!)).toMatchObject({ composition_revision_id: `CR-${id}-2`, policy: { budget: { maxTokens: cap - 1650, enforcement: "advisory" } } });
    // BIND: each run requests its own revision's model; the destination's comes from its recomposition.
    const models = rig.db.prepare("SELECT composition_revision_id, model_requested, model_requested_source FROM runs WHERE task_id = ? ORDER BY started_at").all(id);
    expect(models).toEqual([
      { composition_revision_id: `CR-${id}-1`, model_requested: r1!.spec.model.primary.id, model_requested_source: "revision" },
      { composition_revision_id: `CR-${id}-2`, model_requested: r2!.spec.model.primary.id, model_requested_source: "revision" },
    ]);
  });

  it("a failover with no budget left starts nothing and parks the task for an operator: budget_exhausted", async () => {
    rig = await bootRig({ now, assistants: two, budget: { maxTokens: 1000 } });
    const id = repoTask("Ship the feature [FAKE:LIMIT]");
    expect((await operatorStart(id)).status).toBe(200);
    expect(await settled(id)).toBe("WAITING_INPUT");
    // Wait out the async failover chain: the pause kind lands with the last transition.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(rig.built.tasks.get(id)).toMatchObject({ state: "WAITING_INPUT", pause_kind: "budget_exhausted" });
    expect(runs(id)).toHaveLength(1);
    expect(attempts(id).map((a) => [a.origin, a.outcome, a.reason])).toEqual([["start", "persisted", null], ["failover", "failed", "budget_exhausted"]]);
    // The first run went 650 tokens past its revision's cap: recorded, never acted on.
    const overrun = rig.db.prepare("SELECT run_id, payload FROM events WHERE type = 'budget.overrun'").all() as Array<{ run_id: string; payload: string }>;
    expect(overrun).toHaveLength(1);
    expect(overrun[0]!.run_id).toBe(runs(id)[0]!.id);
    expect(JSON.parse(overrun[0]!.payload)).toEqual({
      compositionRevisionId: `CR-${id}-1`, cap: "max_tokens", capValue: 1000, settled: 1650, amount: 650, source: "in_run", method: "tokens",
    });
    // The pause needs an operator: a wait cannot be attached over it.
    expect(() => rig!.built.scheduler.attach(id, { kind: "time", notBefore: now().toISOString() })).toThrow(/operator decision/);
  });
});

describe("K11 continuation", () => {
  it("a continuation on the same assistant reuses the revision, and runs on what that revision has left", async () => {
    rig = await bootRig({ now, assistants: { "fake-a": { provider: "fake" } }, budget: { maxTokens: 100_000 } });
    const id = repoTask("implement the change [FAKE:CONTEXT:0.96>0.3]", { assistantId: "fake-a" });
    park(id);
    instant += 1000;
    const done = settled(id);
    await rig.built.scheduler.tick();
    expect(await done).toBe("COMPLETED");

    const all = runs(id);
    expect(all).toHaveLength(2);
    expect(all.map((r) => r.composition_revision_id)).toEqual([`CR-${id}-1`, `CR-${id}-1`]);
    expect(revisions(id)).toHaveLength(1);
    expect(attempts(id).map((a) => [a.origin, a.outcome, a.reason, a.composition_revision_id])).toEqual([
      ["wake", "persisted", null, `CR-${id}-1`], ["context-yield", "skipped", "revision_reused", null],
    ]);
    // The yielded session reported no usage before the context guard stopped it, so nothing was spent yet.
    expect(request(all[1]!.execution_request_id!)).toMatchObject({ composition_revision_id: `CR-${id}-1`, policy: { budget: { maxTokens: 100_000, enforcement: "advisory" } } });

    // A late record for the first session is spending under CR-1: a further reuse runs on the rest
    // (100000 - 98000 late - 1650 settled by the continued session).
    expect((await rig.postUsage({ eventId: "FAKE-evt-1", runId: all[0]!.id, accounting: "cumulative", tokensIn: 90_000, tokensOut: 8_000 })).status).toBe(201);
    const routingDecisionId = (rig.db.prepare("SELECT routing_decision_id AS r FROM dispatches WHERE task_id = ? AND origin = 'context-yield'").get(id) as { r: number }).r;
    const composer = rig.built.orchestrator.dispatchComposer!;
    const reused = await composer.composeForDispatch({ taskId: id, assistantId: "fake-a", origin: "context-yield", routingDecisionId });
    expect(reused.kind).toBe("compose");
    const bound = (reused as { composition: { bind(w: undefined): unknown } }).composition.bind(undefined);
    expect(bound).toMatchObject({ ok: true, compositionRevisionId: `CR-${id}-1`, policy: { budget: { max_tokens: 350 } } });

    // And once the revision has nothing left, a continuation is blocked rather than run.
    expect((await rig.postUsage({ eventId: "FAKE-evt-2", runId: all[0]!.id, accounting: "cumulative", tokensIn: 91_000, tokensOut: 8_000 })).status).toBe(201);
    expect(await composer.composeForDispatch({ taskId: id, assistantId: "fake-a", origin: "context-yield", routingDecisionId }))
      .toEqual({ kind: "blocked", reason: "budget_exhausted", pauseKind: "budget_exhausted" });
    expect(attempts(id).slice(2).map((a) => [a.origin, a.outcome, a.reason])).toEqual([["context-yield", "skipped", "revision_reused"], ["context-yield", "failed", "budget_exhausted"]]);
    // Only a K11 continuation reuses. A wake recomposes, and the task's own remainder is spent too.
    expect(await composer.composeForDispatch({ taskId: id, assistantId: "fake-a", origin: "wake", routingDecisionId }))
      .toEqual({ kind: "blocked", reason: "budget_exhausted", pauseKind: "budget_exhausted" });
    expect(attempts(id).at(-1)).toMatchObject({ origin: "wake", outcome: "failed", reason: "budget_exhausted" });
  });
});

describe("budget_exhausted at a scheduler wake", () => {
  it("a wake whose recomposition finds no budget left aborts the dispatch and waits for an operator", async () => {
    // One assistant: a limit has nowhere to fail over to, so the task parks on a quota wait.
    rig = await bootRig({ now, assistants: { "fake-a": { provider: "fake" } }, budget: { maxTokens: 10_000 } });
    const id = repoTask("Ship the feature [FAKE:LIMIT]");
    expect((await operatorStart(id, { policy: { budget: { max_tokens: 1000 } } })).status).toBe(200);
    expect(await reaches(rig.built, id, ["WAITING_RESOURCE", "WAITING_INPUT"])).toBe("WAITING_RESOURCE");
    expect(runs(id)).toHaveLength(1);

    // Past the inferred backoff, the operator wakes it. The recomposition sees 1650 settled against a cap of 1000.
    instant += 11 * 60_000;
    const parked = reaches(rig.built, id, ["WAITING_INPUT", "RUNNING", "COMPLETED"]);
    await rig.built.scheduler.runNow(id);
    expect(await parked).toBe("WAITING_INPUT");
    expect(rig.built.tasks.get(id)!.pause_kind).toBe("budget_exhausted");
    expect(runs(id)).toHaveLength(1);
    expect(attempts(id).map((a) => [a.origin, a.outcome, a.reason])).toEqual([["start", "persisted", null], ["run-now", "failed", "budget_exhausted"]]);
    const dispatch = rig.db.prepare("SELECT phase, reason FROM dispatches WHERE task_id = ? ORDER BY rowid DESC LIMIT 1").get(id);
    expect(dispatch).toEqual({ phase: "aborted", reason: "budget_exhausted" });
    const event = rig.db.prepare("SELECT type, payload FROM scheduler_events WHERE task_id = ? AND type = 'dispatch.aborted'").get(id) as { payload: string };
    expect(JSON.parse(event.payload)).toEqual({ reason: "budget_exhausted" });
  });
});
