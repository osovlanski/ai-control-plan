/**
 * hits-token-cap (FAKE — plan §4 step 21). `HarnessBridge`'s budget is
 * advisory with no `maxTokens`, so a real token cap isn't reachable yet;
 * `FakeAdapter`'s `[FAKE:LIMIT]` marker is the deterministic analog. Scored
 * against the documented recovery outcome (a durable `limit.hit` event and,
 * with auto-failover on by default, a handoff), not a real budget rejection.
 */
import { bootScenario } from "../harness/boot.js";
import { runTaskToTerminal } from "../harness/run-task.js";
import type { ScenarioScore } from "../scorer.js";

export async function hitsTokenCap(): Promise<ScenarioScore> {
  const booted = await bootScenario({
    extraConfigYaml: "assistants:\n  eval-fake:\n    provider: fake\n",
    harnessSingle: true,
  });
  try {
    return await runTaskToTerminal(booted, {
      scenario: "hits-token-cap",
      kind: "fake",
      goal: "Burn the quota [FAKE:LIMIT]",
      assistantId: "eval-fake",
    });
  } finally {
    await booted.close();
  }
}
