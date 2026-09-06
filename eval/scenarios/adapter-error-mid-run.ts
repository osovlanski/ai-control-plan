import assert from 'node:assert/strict';
/**
 * adapter-error-mid-run (FAKE — plan §4 step 21). A deterministic mid-run
 * provider crash needs a fake marker; `FakeAdapter`'s `[FAKE:FAIL]` is exactly
 * that. Scored against the documented recovery outcome (task FAILED, no
 * failover on a plain provider error, per the characterization contract).
 */
import { bootScenario } from "../harness/boot.js";
import { runTaskToTerminal } from "../harness/run-task.js";
import type { ScenarioScore } from "../scorer.js";

export async function adapterErrorMidRun(): Promise<ScenarioScore> {
  const booted = await bootScenario({
    extraConfigYaml: "assistants:\n  eval-fake:\n    provider: fake\n",
    harnessSingle: true,
  });
  try {
    const score = await runTaskToTerminal(booted, {
      scenario: "adapter-error-mid-run",
      kind: "fake",
      goal: "Do the thing [FAKE:FAIL]",
      assistantId: "eval-fake",
    });
    assert.equal(score.terminalState, 'WAITING_RESOURCE');
    const condition = booted.built.scheduler.condition(score.taskId);
    assert.equal(condition?.kind, 'quota');
    assert.ok(condition?.checkpointId);
    assert.ok(condition?.blockers?.length);
    return score;
  } finally {
    await booted.close();
  }
}
