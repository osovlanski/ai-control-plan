/**
 * replan-needed (REAL — plan §4 step 21/R4). Forces the real initial-vs-
 * post-change discovery-comparison revision mechanism: the `discovery-revision`
 * fixture has no `lint` script until the goal adds one, so post-change
 * discovery finds a check the initial plan lacked and `VerificationCoordinator`
 * writes a superseding `verification_plan_revisions` row.
 */
import { bootScenario } from "../harness/boot.js";
import { prepareFixture, fixtureDigest } from "../harness/prepare-fixture.js";
import { runTaskToTerminal } from "../harness/run-task.js";
import type { ScenarioScore } from "../scorer.js";

export async function replanNeeded(provider: "anthropic" | "openai" = "anthropic"): Promise<ScenarioScore & { fixtureDigest: string }> {
  const assistantId = provider === "anthropic" ? "personal-claude" : "personal-codex";
  const fixture = prepareFixture("discovery-revision");
  const digest = fixtureDigest(fixture.path);
  const booted = await bootScenario({ repoAllowlist: [fixture.path], harnessSingle: true });
  try {
    const score = await runTaskToTerminal(booted, {
      scenario: "replan-needed",
      kind: "real",
      provider,
      goal:
        'Add a "lint" script to package.json that runs `node lint.mjs`, and remove the TODO marker from src/clean.mjs so lint.mjs passes.',
      assistantId,
      repoPath: fixture.path,
      timeoutMs: 180_000,
    });
    return { ...score, fixtureDigest: digest };
  } finally {
    await booted.close();
    fixture.cleanup();
  }
}
