/**
 * Shared boot helper for the four safety-net test files
 * (characterization/orchestrator/failover/parallel.test.ts) — increment 3, D5.
 *
 * Before this, each file called `loadConfig({ AGENT_PLANE_HOME: home })` (no
 * `process.env`) and constructed `new Orchestrator(...)` directly with no
 * Harness bridge/recovery — so a forced `AGENT_PLANE_HARNESS_SINGLE_MODE=1` CI
 * leg reached neither config nor execution, and the leg proved nothing. This
 * factory (a) merges `AGENT_PLANE_HARNESS_SINGLE_MODE` from the real
 * `process.env` into the hermetic test env, and (b) builds the Orchestrator
 * through the exact same `buildHarnessComposition` production wiring
 * `buildServer` uses, so a forced-ON run actually exercises the Harness path.
 */
import type { ResolvedConfig } from "../../src/config.js";
import { loadConfig } from "../../src/config.js";
import type { Db } from "../../src/db/index.js";
import type { CheckpointService } from "../../src/modules/checkpoint.js";
import type { CooldownStore } from "../../src/modules/cooldown.js";
import { buildHarnessComposition } from "../../src/modules/harness/composition.js";
import { Orchestrator } from "../../src/modules/orchestrator.js";
import type { Registry } from "../../src/modules/registry.js";
import type { TaskEventBus } from "../../src/modules/sse.js";
import type { TaskStore } from "../../src/modules/tasks.js";

/**
 * `loadConfig`, but with `AGENT_PLANE_HARNESS_SINGLE_MODE` merged in from the
 * real process environment (test envs are otherwise fully hermetic — this is
 * the one deliberate escape hatch, for the `test:harness-on` vitest project).
 */
export function loadHarnessTestConfig(env: NodeJS.ProcessEnv): ResolvedConfig {
  const merged = { ...env };
  const forced = process.env.AGENT_PLANE_HARNESS_SINGLE_MODE;
  if (forced !== undefined) merged.AGENT_PLANE_HARNESS_SINGLE_MODE = forced;
  return loadConfig(merged);
}

/** Builds an Orchestrator wired exactly as `buildServer`'s internal composition root. */
export function bootHarnessOrchestrator(opts: {
  db: Db;
  config: ResolvedConfig;
  registry: Registry;
  tasks: TaskStore;
  bus: TaskEventBus;
  checkpoints: CheckpointService;
  cooldowns: CooldownStore;
}): Orchestrator {
  const composed = buildHarnessComposition({
    db: opts.db,
    config: opts.config,
    tasks: opts.tasks,
    bus: opts.bus,
    checkpoints: opts.checkpoints,
    registry: opts.registry,
    onError: () => {},
  });
  return new Orchestrator(
    opts.db,
    opts.config,
    opts.registry,
    opts.tasks,
    opts.bus,
    opts.checkpoints,
    opts.cooldowns,
    undefined,
    composed.harnessRecovery,
    composed.harnessBridge,
    composed.projectVerification,
  );
}
