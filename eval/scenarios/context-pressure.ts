/**
 * K11: critical context pressure → checkpoint → YIELDED(context) → a clean
 * successor from that exact checkpoint → lower pressure → COMPLETED.
 *
 * Runs the real `buildServer` composition root and the real scheduler dispatch
 * path; only the provider is fake, scripted through `[FAKE:CONTEXT:0.96>0.30]`
 * (critical in a fresh session, comfortable in a continuation). A real git
 * fixture is required — the continuation's adequacy gate demands a committed
 * Git ref, so an in-repo or repo-less run would prove nothing.
 */
import assert from "node:assert/strict";
import type { AssistantId, ContextYieldRequest, ExecutionResult } from "@agent-plane/core";
import { DEFAULT_CONTEXT_POLICY, isReliabilityFailure } from "@agent-plane/core";
import { bootScenario } from "../harness/boot.js";
import { prepareFixture } from "../harness/prepare-fixture.js";
import { scoreTask, type ScenarioScore } from "../scorer.js";

export async function contextPressure(): Promise<ScenarioScore> {
  const fixture = prepareFixture("context-continuation");
  const booted = await bootScenario({
    extraConfigYaml: "assistants:\n  eval-fake-a:\n    provider: fake\n  eval-fake-b:\n    provider: fake\n",
    repoAllowlist: [fixture.path],
    harnessSingle: true,
  });
  booted.config.execution.harnessModes.single = true;
  const { built, db } = booted;
  const A = "eval-fake-a" as AssistantId;

  try {
    const task = built.tasks.create({
      goal: "Finish the revision [FAKE:CONTEXT:0.96>0.30]",
      repoPath: fixture.path,
      overrides: { assistantId: A },
    });
    const taskId = task.taskId;
    // The park between the two sessions is brief, so record every state the
    // task passes through rather than polling for one of them.
    const seen: string[] = [];
    built.bus.subscribe(taskId, (p) => {
      if (p.kind === "state" && p.state) seen.push(p.state.state);
    });
    built.tasks.transition(taskId, "ROUTING");
    built.scheduler.startTimer();
    await built.orchestrator.startTask(taskId, A);

    const deadline = Date.now() + 15_000;
    const waitFor = async (expected: string) => {
      while (built.tasks.get(taskId)?.state !== expected) {
        assert.ok(
          Date.now() < deadline,
          `context scenario did not reach ${expected}; state=${built.tasks.get(taskId)?.state} pause=${built.tasks.get(taskId)?.pause_kind} seen=${seen.join(">")}`,
        );
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    };

    // Session 1 hits critical pressure, checkpoints and settles; the plane parks
    // the task on a context-yield wait, then the ordinary dispatch path runs the
    // successor to completion.
    await waitFor("COMPLETED");
    built.scheduler.stop();
    assert.ok(seen.includes("WAITING_RESOURCE"), `the task must park between sessions; saw ${seen.join(">")}`);
    const condition = built.scheduler.condition(taskId)!;
    assert.equal(condition.origin, "context-yield", "the wait must remember it is a context continuation");
    assert.ok(condition.checkpointId, "the continuation is anchored to a checkpoint");

    const sessions = () =>
      db.prepare("SELECT id, assistant_id, session_state FROM runs WHERE task_id = ? ORDER BY started_at, rowid")
        .all(taskId) as Array<{ id: string; assistant_id: string; session_state: string }>;
    const predecessorId = sessions()[0]!.id;
    const predecessor = JSON.parse(
      (db.prepare("SELECT result FROM execution_results WHERE session_id = ?").get(predecessorId) as { result: string })
        .result,
    ) as ExecutionResult;

    assert.equal(predecessor.terminalState, "YIELDED");
    assert.equal(predecessor.yield?.kind, "context");
    assert.equal(isReliabilityFailure(predecessor), false, "a healthy context yield is not a provider failure");
    const detail = predecessor.yield!.detail as ContextYieldRequest;
    assert.equal(detail.reason, "critical_context_pressure");
    assert.ok(
      (detail.observation.pressure ?? 0) >= DEFAULT_CONTEXT_POLICY.criticalRatio,
      "only a fresh observation at or above criticalRatio may yield",
    );
    assert.equal(detail.observation.freshness, "live");
    assert.equal(predecessor.checkpoint.committed, true, "the anchor must have a committed Git ref");
    assert.ok(predecessor.checkpoint.gitRef);
    assert.equal(condition.checkpointId, detail.checkpointId);

    const all = sessions();
    assert.equal(all.length, 2, "exactly one successor");
    assert.equal(all[1]!.assistant_id, all[0]!.assistant_id, "the same assistant is preferred when eligible");

    const dispatches = built.scheduler
      .dispatches(taskId)
      .filter((d) => d.origin === "context-yield");
    assert.equal(dispatches.length, 1);
    const dispatch = dispatches[0]!;
    assert.equal(dispatch.checkpoint_id, detail.checkpointId, "the successor starts from the exact checkpoint");
    assert.equal(dispatch.session_id, all[1]!.id);

    const explanation = JSON.parse(
      (db.prepare("SELECT explanation FROM routing_decisions WHERE id = ?").get(dispatch.routing_decision_id) as {
        explanation: string;
      }).explanation,
    ) as { origin: string; contextContinuation?: Record<string, unknown> };
    assert.equal(explanation.origin, "context-yield");
    assert.equal(explanation.contextContinuation?.continuationNumber, 1);
    assert.equal(explanation.contextContinuation?.predecessorSessionId, predecessorId);
    assert.equal(explanation.contextContinuation?.preferSameSatisfied, true);

    // The successor consumed the committed envelope, not a transcript, and its
    // own context stayed comfortable, so it completed.
    const request = db
      .prepare("SELECT origin, prompt_source, prompt_source_ref FROM execution_requests WHERE id = ?")
      .get(dispatch.dispatch_id) as { origin: string; prompt_source: string; prompt_source_ref: string };
    assert.equal(prompt(request.origin), detail.envelopeId);
    assert.equal(request.prompt_source, "handoff");
    assert.equal(request.prompt_source_ref, detail.envelopeId);

    const successor = JSON.parse(
      (db.prepare("SELECT result FROM execution_results WHERE session_id = ?").get(all[1]!.id) as { result: string })
        .result,
    ) as ExecutionResult;
    assert.equal(successor.outcome, "completed");

    // K10 stayed out of it.
    const compaction = db
      .prepare("SELECT COUNT(*) AS n FROM events WHERE type LIKE 'context.compaction.request%'")
      .get() as { n: number };
    assert.equal(compaction.n, 0, "K11 issues no compaction directive");

    return scoreTask(db, { scenario: "context-pressure", kind: "fake", taskId });
  } finally {
    built.scheduler.stop();
    await built.orchestrator.shutdown();
    await booted.close();
    fixture.cleanup();
  }
}

function prompt(originJson: string): string | undefined {
  return (JSON.parse(originJson) as { envelopeId?: string }).envelopeId;
}
