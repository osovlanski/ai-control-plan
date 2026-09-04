/**
 * boot-crash-recovery (FAKE — plan §4 step 21). Starts a session, "crashes"
 * (never asked to settle), then boots a fresh production-equivalent
 * Orchestrator against the same DB — the real `reconcileOnBoot` path,
 * in-process, abandon-the-lease crash model (eval-plan §4). Scored against the
 * documented recovery outcome (`resume_offered` / `FAILED(orphaned)` /
 * `COMPLETED`-from-evidence), never claimed as "terminal E2E success" (R2-#5).
 */
import { Orchestrator } from "../../apps/api/src/modules/orchestrator.js";
import { buildHarnessComposition } from "../../apps/api/src/modules/harness/composition.js";
import { bootScenario } from "../harness/boot.js";
import { scoreTask } from "../scorer.js";
import type { ScenarioScore } from "../scorer.js";

export async function bootCrashRecovery(): Promise<ScenarioScore & { recoveryOutcome: string }> {
  const booted = await bootScenario({
    extraConfigYaml: "assistants:\n  eval-fake:\n    provider: fake\n",
    harnessSingle: true,
  });
  try {
    const created = await booted.built.app.inject({
      method: "POST",
      url: "/api/tasks",
      headers: booted.client.headers,
      payload: { goal: "long one [FAKE:APPROVAL]" },
    });
    const taskId = (created.json() as { taskId: string }).taskId;
    await booted.built.app.inject({
      method: "POST",
      url: `/api/tasks/${taskId}/start`,
      headers: booted.client.headers,
      payload: { assistantId: "eval-fake" },
    });
    // Let the session actually reach AWAITING_APPROVAL before "crashing".
    await new Promise((r) => setTimeout(r, 200));

    // Reboot: a fresh Orchestrator + Harness composition against the same DB,
    // never settled by the first process — the abandon-the-lease crash model.
    const composed = buildHarnessComposition({
      db: booted.db,
      config: booted.config,
      tasks: booted.built.tasks,
      bus: booted.built.bus,
      checkpoints: booted.built.checkpoints,
      registry: booted.built.registry,
      onError: () => {},
    });
    const rebooted = new Orchestrator(
      booted.db,
      booted.config,
      booted.built.registry,
      booted.built.tasks,
      booted.built.bus,
      booted.built.checkpoints,
      booted.built.cooldowns,
      undefined,
      composed.harnessRecovery,
      composed.harnessBridge,
      composed.projectVerification,
    );
    await rebooted.reconcileOnBoot();

    const score = scoreTask(booted.db, { scenario: "boot-crash-recovery", kind: "fake", taskId });
    return { ...score, recoveryOutcome: score.executionResultsOutcome ?? score.terminalState ?? "unknown" };
  } finally {
    await booted.close();
  }
}
