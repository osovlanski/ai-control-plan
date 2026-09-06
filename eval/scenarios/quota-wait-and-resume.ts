/** K2: two FakeAdapters, a real two-second reset, durable wait and checkpoint resume. */
import assert from 'node:assert/strict';
import type { AssistantId } from '@agent-plane/core';
import { bootScenario } from '../harness/boot.js';
import { scoreTask, type ScenarioScore } from '../scorer.js';

export async function quotaWaitAndResume(harnessSingle = true): Promise<ScenarioScore> {
  const booted = await bootScenario({
    extraConfigYaml: 'assistants:\n  eval-fake-a:\n    provider: fake\n  eval-fake-b:\n    provider: fake\n',
    harnessSingle,
  });
  booted.config.execution.harnessModes.single = harnessSingle;
  const { built, db } = booted;
  const A = 'eval-fake-a' as AssistantId;
  const B = 'eval-fake-b' as AssistantId;
  let reset: string | undefined;
  // Preserve the real FakeAdapter event stream; shorten only its test quota window.
  for (const id of [A, B]) {
    const adapter = built.registry.adapter(id);
    const events = adapter.events.bind(adapter);
    adapter.events = async function* (handle) {
      for await (const event of events(handle)) {
        if (event.type === 'limit.hit') {
          reset = new Date(Date.now() + 2000).toISOString();
          yield { ...event, payload: { quota: [{ window: '5h', usedPercent: 100, resetsAt: reset }] } };
        } else yield event;
      }
    };
  }
  try {
    built.cooldowns.penalize(B, 'limit', 'second candidate blocked', new Date(Date.now() + 60_000).toISOString());
    const task = built.tasks.create({ goal: 'Complete the quota continuation [FAKE:LIMIT]' });
    built.tasks.transition(task.taskId, 'ROUTING');
    await built.orchestrator.startTask(task.taskId, A);
    const deadline = Date.now() + 10_000;
    const waitFor = async (expected: string) => {
      while (built.tasks.get(task.taskId)?.state !== expected) {
        assert.ok(Date.now() < deadline, `quota scenario did not reach ${expected}`);
        await new Promise(resolve => setTimeout(resolve, 10));
      }
    };
    await waitFor('WAITING_RESOURCE');
    const condition = built.scheduler.condition(task.taskId)!;
    assert.equal(condition.kind, 'quota');
    assert.equal(condition.notBefore, reset);
    assert.ok(condition.checkpointId);
    built.scheduler.startTimer();
    await waitFor('COMPLETED');
    built.scheduler.stop();
    const dispatches = built.scheduler.dispatches(task.taskId);
    assert.equal(dispatches.length, 1);
    const dispatch = dispatches[0]!;
    const decision = db.prepare('SELECT chosen_assistant_id, explanation FROM routing_decisions WHERE id = ?').get(dispatch.routing_decision_id) as { chosen_assistant_id: string; explanation: string };
    assert.equal(decision.chosen_assistant_id, A, 'only A is eligible when its retry instant arrives');
    assert.equal(JSON.parse(decision.explanation).continuation.checkpointId, condition.checkpointId);
    assert.equal(dispatch.checkpoint_id, condition.checkpointId);
    const request = db.prepare('SELECT routing_decision_ref, assistant_id FROM execution_requests WHERE id = ?').get(dispatch.dispatch_id) as { routing_decision_ref: string; assistant_id: string };
    assert.equal(request.routing_decision_ref, String(dispatch.routing_decision_id));
    assert.equal(request.assistant_id, decision.chosen_assistant_id);
    return scoreTask(db, { scenario: `quota-wait-and-resume-${harnessSingle ? 'harness' : 'legacy'}`, kind: 'fake', taskId: task.taskId });
  } finally {
    built.scheduler.stop();
    await built.orchestrator.shutdown();
    await booted.close();
  }
}
