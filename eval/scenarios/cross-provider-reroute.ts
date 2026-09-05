/**
 * cross-provider-reroute (FAKE — plan §4 step 21). Quota-triggered reroute
 * needs injected quota/cooldown state a real provider can't be told to
 * fabricate; two `FakeAdapter` instances give a deterministic two-provider
 * failover. Scored against the documented outcome: task COMPLETED via a
 * handoff (`failoverCount >= 1`) rather than a real cross-provider handle.
 */
import { bootScenario } from "../harness/boot.js";
import { runTaskToTerminal } from "../harness/run-task.js";
import type { ScenarioScore } from "../scorer.js";

export async function crossProviderReroute(): Promise<ScenarioScore> {
  const booted = await bootScenario({
    extraConfigYaml: "assistants:\n  eval-fake-a:\n    provider: fake\n  eval-fake-b:\n    provider: fake\n",
    harnessSingle: true,
  });
  try {
    return await runTaskToTerminal(booted, {
      scenario: "cross-provider-reroute",
      kind: "fake",
      goal: "Ship it [FAKE:LIMIT]",
      assistantId: "eval-fake-a",
      timeoutMs: 15_000,
    });
  } finally {
    await booted.close();
  }
}
