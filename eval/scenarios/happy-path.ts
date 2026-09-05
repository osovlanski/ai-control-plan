/**
 * happy-path (REAL, ×2 providers — plan §4 step 21). A trivial one-file goal
 * against the `failing-test` fixture. Gates the increment (step 22): must
 * reach terminal, pass verification, produce a durable session, and link a
 * verification_plan_revisions row.
 */
import { bootScenario } from "../harness/boot.js";
import { prepareFixture, fixtureDigest } from "../harness/prepare-fixture.js";
import { runTaskToTerminal } from "../harness/run-task.js";
import type { ScenarioScore } from "../scorer.js";

export async function happyPath(provider: "anthropic" | "openai"): Promise<ScenarioScore & { fixtureDigest: string }> {
  const assistantId = provider === "anthropic" ? "personal-claude" : "personal-codex";
  const fixture = prepareFixture("failing-test");
  const digest = fixtureDigest(fixture.path);
  const booted = await bootScenario({ repoAllowlist: [fixture.path], harnessSingle: true });
  try {
    const score = await runTaskToTerminal(booted, {
      scenario: `happy-path-${provider}`,
      kind: "real",
      provider,
      goal: "Fix src/add.mjs so `pnpm test` passes (add(2, 3) should be 5, it currently subtracts).",
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
