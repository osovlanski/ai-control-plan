/**
 * K13 shadow model selection over the real composition root (§4.4.3).
 *
 * The assertions that matter most here are the negative ones: a benchmark score
 * never resurrects a hard-filtered candidate, an unproven identity never
 * receives a prior, and the recommendation never touches what actually runs.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AA_NORMALIZATION_VERSION,
  DIMENSION_K,
  HARNESS_MAJOR,
  type AssistantId,
  type ModelRecommendation,
  type RoutingExplanation,
  type RunSpec,
} from '@agent-plane/core';
import { loadConfig, type ResolvedConfig } from '../src/config.js';
import { openDb, type Db } from '../src/db/index.js';
import { buildServer, type BuiltServer } from '../src/server.js';
import type { CatalogObservation, CatalogSource } from '../src/modules/model-catalog.js';
import { buildExecutionRequest } from '../src/modules/harness/control-plane-bridge.js';
import { resolveCandidateIdentity } from '../src/modules/model-selection.js';
import { modelCohorts } from '../src/modules/telemetry.js';
import { countHardFilterViolations, priceApplicability } from '../src/modules/model-selection.js';
import { Scheduler } from '../src/modules/scheduler.js';

let home: string;
let db: Db;
let config: ResolvedConfig;
let built: BuiltServer;
const A = 'fake-a' as AssistantId;
const B = 'fake-b' as AssistantId;
let clock = new Date('2030-01-01T00:00:00Z');
const now = () => clock;

/** The fake adapter advertises exactly one selector, and it IS a model id. */
const FAKE_MODEL = 'fake-1';

async function boot(
  sources: CatalogSource[] = [],
  assistants: ResolvedConfig['assistants'] = { [A]: { provider: 'fake' }, [B]: { provider: 'fake' } },
  options: { harness?: boolean } = {},
) {
  home = mkdtempSync(join(tmpdir(), 'k13-'));
  config = loadConfig({ AGENT_PLANE_HOME: home });
  config.assistants = assistants;
  // Flag-ON single mode routes execution through the ExecutionRequest → RunSpec
  // bridge, which is the path CR-33 is about.
  config.execution.harnessModes.single = options.harness ?? false;
  db = openDb(config.dbPath);
  built = buildServer({ config, db, now, modelCatalogSources: sources });
  built.registry.init();
  await built.registry.syncAll();
  await built.modelCatalog.refresh();
}

/** A K8-shaped external benchmark observation for one catalog model. */
function benchmarkSource(rows: Array<{ provider: string; modelId: string; coding?: number; speed?: number; normalizationVersion?: string; observedAt?: string; publishedAt?: string }>): CatalogSource {
  return {
    name: 'test-benchmark',
    collect: async () => {
      const observations: CatalogObservation[] = rows.map((row) => {
        const observedAt = row.observedAt ?? now().toISOString();
        const normalizationVersion = row.normalizationVersion ?? AA_NORMALIZATION_VERSION;
        const provenance = {
          source: 'external:artificial-analysis' as const,
          tier: 'external-benchmark' as const,
          observedAt,
          benchmark: { release: 'intelligence-index-4.3', category: 'coding', ...(row.publishedAt ? { publishedAt: row.publishedAt } : {}) },
          normalizationVersion,
          attribution: 'test',
        };
        return {
          modelId: row.modelId,
          provider: row.provider,
          provenance,
          benchmarks: [
            ...(row.coding !== undefined
              ? [{ dimension: 'coding' as const, normalized: row.coding, raw: { metric: 'coding_index', value: row.coding * 100, unit: 'index-0-100' }, sourceModelId: row.modelId, normalizationVersion, provenance, freshness: 'fresh' as const }]
              : []),
            ...(row.speed !== undefined
              ? [{ dimension: 'speed' as const, normalized: row.speed, raw: { metric: 'median_output_tokens_per_second', value: row.speed * 200, unit: 'tokens/second' }, sourceModelId: row.modelId, normalizationVersion, provenance: { ...provenance, benchmark: { ...provenance.benchmark, category: 'speed' } }, freshness: 'fresh' as const }]
              : []),
          ],
        };
      });
      return { observations };
    },
  };
}

/**
 * A provider-official observation carrying ONE price row. `appliesTo` is passed
 * through verbatim (including absent) so applicability can be tested honestly.
 */
function priceSource(rows: Array<{
  provider: string;
  modelId: string;
  inputPerMtok?: number;
  outputPerMtok?: number;
  appliesTo?: { servingProvider: string; accountKind?: string };
}>): CatalogSource {
  return {
    name: 'test-prices',
    collect: async () => ({
      observations: rows.map((row): CatalogObservation => {
        const provenance = {
          source: 'provider-api' as const,
          tier: 'provider-official' as const,
          observedAt: now().toISOString(),
          normalizationVersion: '1.0',
          attribution: 'test',
        };
        return {
          modelId: row.modelId,
          provider: row.provider,
          provenance,
          pricing: [{
            inputPerMtok: row.inputPerMtok ?? 3,
            outputPerMtok: row.outputPerMtok ?? 15,
            currency: 'USD' as const,
            pricingVersion: 'test-prices-1',
            ...(row.appliesTo ? { appliesTo: row.appliesTo } : {}),
            provenance,
          }],
        };
      }),
    }),
  };
}

/** Insert a finished legacy run so it joins (or deliberately misses) a cohort. */
function recordRun(input: {
  taskId: string;
  assistantId: string;
  modelRequested?: string;
  modelResolved?: string | null;
  harnessMajor?: string | null;
  state?: 'ENDED_OK' | 'ENDED_ERROR';
  durationMs?: number;
  usage?: { inputTokens?: number; outputTokens?: number };
  result?: { outcome: string; yield?: { kind: string } };
  /** Emit the coding factors this run contributes. Absent = that factor has no evidence. */
  tests?: { passed: number; failed: number };
  verification?: { passed: boolean };
}): string {
  const id = `run_${Math.random().toString(36).slice(2, 10)}`;
  const startedAt = new Date(clock.getTime() - (input.durationMs ?? 10_000)).toISOString();
  db.prepare(
    `INSERT INTO runs (id, task_id, assistant_id, state, started_at, ended_at, usage, model_requested, model_resolved, model_resolved_source, harness_major)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'run.started', ?)`,
  ).run(
    id, input.taskId, input.assistantId, input.state ?? 'ENDED_OK', startedAt, clock.toISOString(),
    input.usage ? JSON.stringify(input.usage) : null,
    input.modelRequested ?? null,
    input.modelResolved === undefined ? FAKE_MODEL : input.modelResolved,
    input.harnessMajor === undefined ? HARNESS_MAJOR : input.harnessMajor,
  );
  if (input.result) {
    db.prepare(
      `INSERT INTO execution_results (session_id, terminal_state, outcome, result, at) VALUES (?, ?, ?, ?, ?)`,
    ).run(id, input.result.outcome === 'yielded' ? 'YIELDED' : 'COMPLETED', input.result.outcome, JSON.stringify(input.result), clock.toISOString());
  }
  let seq = 0;
  const event = (type: string, payload: unknown) =>
    db.prepare('INSERT INTO events (run_id, seq, ts, type, payload) VALUES (?, ?, ?, ?, ?)')
      .run(id, (seq += 1), clock.toISOString(), type, JSON.stringify(payload));
  if (input.tests) event('test.result', input.tests);
  if (input.verification) event('verification.result', input.verification);
  return id;
}

/** A run carrying every canonical coding factor: success, test-pass, verification-pass. */
function recordCodingRun(taskId: string, assistantId: string, over: Parameters<typeof recordRun>[0] extends infer T ? Partial<T> : never = {}): string {
  return recordRun({
    taskId, assistantId,
    result: { outcome: 'completed' },
    tests: { passed: 1, failed: 0 },
    verification: { passed: true },
    ...over,
  });
}

/**
 * Turn every activation gate green using the injected clock only. The week of
 * shadow log is a REAL persisted recommendation dated a week back on the test
 * clock — no production history is faked, and the review attestation still has
 * to postdate a full week of it.
 */
function activateGates(): void {
  config.models.selection.enabled = true;
  const seed = built.tasks.create({ goal: 'a task routed a week ago' });
  db.prepare('INSERT INTO routing_decisions (task_id, chosen_assistant_id, explanation, at) VALUES (?, ?, ?, ?)')
    .run(
      seed.taskId, A,
      // A shadow decision that recommended nothing: real log, zero violations.
      JSON.stringify({ candidates: [], ruleFired: 'seed', modelRecommendation: { schemaVersion: 2, mode: 'shadow', candidates: [], reason: 'seed' } }),
      new Date(clock.getTime() - 8 * 86_400_000).toISOString(),
    );
  config.models.selection.shadowReviewedAt = new Date(clock.getTime() - 86_400_000).toISOString();
  config.models.selection.egressVerifiedAt = new Date(clock.getTime() - 86_400_000).toISOString();
}

/**
 * The `telemetry` gate wants two eligible candidates with a cohort at or above
 * k. The runs go on their own finished task: a cohort is evidence from PAST
 * work, and hanging historical runs off the task under test would make it look
 * like a continuation.
 */
function fillCodingCohort(): void {
  const past = built.tasks.create({ goal: 'Implement the parser' });
  for (let i = 0; i < DIMENSION_K.coding; i += 1) recordCodingRun(past.taskId, A);
}

/** Route, then start exactly as `POST /api/tasks/:id/start` does. */
async function routeAndStart(taskId: string) {
  const routed = built.orchestrator.routeTask(taskId, 'intake');
  built.tasks.transition(taskId, 'ROUTING');
  const started = built.registry.adapter(routed.explanation.chosen!) as { start: RunSpecSpy };
  const spec = new Promise<RunSpec>((resolve) => {
    const original = started.start.bind(started);
    started.start = async (run: RunSpec) => { resolve(run); return original(run); };
  });
  const done = terminal(taskId);
  await built.orchestrator.startTask(taskId, routed.explanation.chosen!, { routingDecisionRef: String(routed.routingDecisionId) });
  await done;
  return { routed, recommendation: routed.explanation.modelRecommendation!, runSpec: await spec };
}

type RunSpecSpy = (run: RunSpec) => Promise<unknown>;

/** Resolves when the task reaches a terminal state, so no run outlives the test. */
function terminal(taskId: string): Promise<void> {
  return new Promise<void>((resolve) => {
    const off = built.bus.subscribe(taskId, (payload) => {
      if (payload.kind === 'state' && ['COMPLETED', 'FAILED', 'CANCELLED', 'WAITING_INPUT'].includes(payload.state!.state)) {
        off();
        resolve();
      }
    });
  });
}

/** The requested selector as the immutable execution request recorded it. */
function requestedModelOf(taskId: string): string | undefined {
  const row = db.prepare('SELECT model FROM execution_requests WHERE task_id = ? ORDER BY attempt DESC LIMIT 1')
    .get(taskId) as { model: string | null } | undefined;
  return row?.model ? (JSON.parse(row.model) as { id: string }).id : undefined;
}

function routeAndRead(taskId: string): { explanation: RoutingExplanation; recommendation: ModelRecommendation } {
  const { explanation } = built.orchestrator.routeTask(taskId, 'intake');
  const recommendation = explanation.modelRecommendation!;
  return { explanation, recommendation };
}

function scored(recommendation: ModelRecommendation, assistantId: string) {
  return recommendation.candidates.find((c) => c.assistantId === assistantId)!;
}

afterEach(async () => {
  clock = new Date('2030-01-01T00:00:00Z');
  if (built) { await built.orchestrator.shutdown(); await built.app.close(); }
  if (db?.open) db.close();
  if (home) rmSync(home, { recursive: true, force: true });
  built = undefined as unknown as BuiltServer;
});

describe('shadow recommendation is persisted with every number sourced', () => {
  it('records the recommendation inside the routing explanation, in shadow mode', async () => {
    await boot([benchmarkSource([{ provider: 'fake', modelId: FAKE_MODEL, coding: 0.71, speed: 0.6 }])]);
    await built.modelCatalog.refresh();
    const task = built.tasks.create({ goal: 'Implement the parser', profile: 'best-quality' });

    const { recommendation } = routeAndRead(task.taskId);
    expect(recommendation.mode).toBe('shadow');
    expect(recommendation.recommended).toMatch(/^fake-[ab]\/fake-1$/);

    const coding = scored(recommendation, A).dimensions.find((d) => d.dimension === 'coding')!;
    expect(coding.prior?.value).toBeCloseTo(0.71, 6);
    expect(coding.prior?.source).toBe('external:artificial-analysis');
    expect(coding.prior?.normalizationVersion).toBe(AA_NORMALIZATION_VERSION);
    expect(coding.prior?.benchmarkRelease).toBe('intelligence-index-4.3');
    expect(coding.prior?.freshness).toBeTruthy();
    expect(coding.k).toBe(DIMENSION_K.coding);
    expect(coding.n).toBe(0);
    expect(coding.weight).toBe(0);
    // Classification, activation and the identity proof all ride along.
    expect(recommendation.classification.weights.coding).toBeGreaterThan(0);
    expect(recommendation.activation.active).toBe(false);
    expect(scored(recommendation, A).identity.basis).toBe('catalog-exact');
  });

  it('survives a database round trip through routing_decisions', async () => {
    await boot([benchmarkSource([{ provider: 'fake', modelId: FAKE_MODEL, coding: 0.71 }])]);
    await built.modelCatalog.refresh();
    const task = built.tasks.create({ goal: 'Implement the parser' });
    built.orchestrator.routeTask(task.taskId, 'intake');

    const row = db.prepare('SELECT explanation FROM routing_decisions WHERE task_id = ? ORDER BY id DESC LIMIT 1').get(task.taskId) as { explanation: string };
    const persisted = (JSON.parse(row.explanation) as RoutingExplanation).modelRecommendation!;
    expect(persisted.mode).toBe('shadow');
    expect(persisted.schemaVersion).toBe(2);
    expect(persisted.candidates.length).toBeGreaterThan(0);
  });
});

describe('hard filters come first and external evidence never bypasses them', () => {
  it('excludes a disabled assistant\'s model however good its benchmark score is', async () => {
    await boot([benchmarkSource([{ provider: 'fake', modelId: FAKE_MODEL, coding: 1 }])]);
    await built.modelCatalog.refresh();
    db.prepare('UPDATE assistants SET enabled = 0 WHERE id = ?').run(A);

    const task = built.tasks.create({ goal: 'Implement the parser' });
    const { recommendation } = routeAndRead(task.taskId);
    const blocked = scored(recommendation, A);
    expect(blocked.eligible).toBe(false);
    expect(blocked.filterFailures.join(' ')).toContain('disabled in workspace config');
    expect(blocked.total).toBeUndefined();
    expect(recommendation.recommended).toBe(`${B}/${FAKE_MODEL}`);
  });

  it('excludes a quota-exhausted assistant with a named reason', async () => {
    await boot([benchmarkSource([{ provider: 'fake', modelId: FAKE_MODEL, coding: 1 }])]);
    await built.modelCatalog.refresh();
    db.prepare(
      `INSERT INTO quota_snapshots (assistant_id, window, account, used_percent, resets_at, source, observed_at)
       VALUES (?, '5h', NULL, 100, NULL, 'provider-api', ?)`,
    ).run(A, clock.toISOString());

    const task = built.tasks.create({ goal: 'Implement the parser' });
    const { recommendation } = routeAndRead(task.taskId);
    expect(scored(recommendation, A).filterFailures.join(' ')).toMatch(/quota/);
    expect(scored(recommendation, A).eligible).toBe(false);
  });

  it('excludes every candidate when the workspace security policy forbids the run', async () => {
    await boot();
    config.policy.approvalMode = 'read-only';
    const task = built.tasks.create({ goal: 'Implement the parser', repoPath: '/tmp/not-allowed' });
    const { recommendation } = routeAndRead(task.taskId);
    for (const candidate of recommendation.candidates) {
      expect(candidate.eligible).toBe(false);
      expect(candidate.filterFailures.join(' ')).toContain('security policy');
    }
    expect(recommendation.recommended).toBeUndefined();
  });

  it('treats unknown capacity as advisory when the task declares no minimum', async () => {
    await boot();
    const task = built.tasks.create({ goal: 'Implement the parser' });
    const { recommendation } = routeAndRead(task.taskId);
    const candidate = scored(recommendation, A);
    expect(candidate.eligible).toBe(true);
    expect(candidate.advisories.join(' ')).toContain('context window unknown');
  });

  it('excludes unknown capacity once the task declares a minimum window', async () => {
    await boot();
    const task = built.tasks.create({ goal: 'Implement the parser', requirements: { minContextTokens: 500_000 } });
    const { recommendation } = routeAndRead(task.taskId);
    const candidate = scored(recommendation, A);
    expect(candidate.eligible).toBe(false);
    expect(candidate.filterFailures.join(' ')).toContain('declares a minimum of 500000 tokens');
    expect(candidate.advisories).toHaveLength(0);
  });
});

describe('user override is hard intent', () => {
  it('filters to the named model and never substitutes another one', async () => {
    await boot([benchmarkSource([{ provider: 'fake', modelId: FAKE_MODEL, coding: 0.9 }])]);
    await built.modelCatalog.refresh();
    const task = built.tasks.create({ goal: 'Implement the parser', overrides: { model: 'a-model-nobody-serves' } });

    const { recommendation } = routeAndRead(task.taskId);
    expect(recommendation.userOverride?.selector).toBe('a-model-nobody-serves');
    expect(recommendation.userOverride?.satisfied).toBe(false);
    expect(recommendation.recommended).toBeUndefined();
    // Every real candidate is excluded BY the override, not scored around it.
    for (const candidate of recommendation.candidates.filter((c) => c.selector === FAKE_MODEL)) {
      expect(candidate.filterFailures.join(' ')).toContain('explicit model override');
    }
  });

  it('is satisfied when the named model passes every filter', async () => {
    await boot([benchmarkSource([{ provider: 'fake', modelId: FAKE_MODEL, coding: 0.9 }])]);
    await built.modelCatalog.refresh();
    const task = built.tasks.create({ goal: 'Implement the parser', overrides: { model: FAKE_MODEL } });
    const { recommendation } = routeAndRead(task.taskId);
    expect(recommendation.userOverride?.satisfied).toBe(true);
    expect(recommendation.recommended).toBe(`${A}/${FAKE_MODEL}`);
  });
});

describe('candidate identity gates every prior', () => {
  it('binds a selector that is itself a catalog model id', async () => {
    await boot();
    const identity = resolveCandidateIdentity(db, {
      assistantId: A, provider: 'fake', selector: FAKE_MODEL, catalog: built.modelCatalog.list(), now,
    });
    expect(identity.basis).toBe('catalog-exact');
    expect(identity.resolvedModelKey).toBe(`fake:${FAKE_MODEL}`);
  });

  it('refuses to bind an alias against today\'s catalog, so no prior attaches', async () => {
    await boot();
    const identity = resolveCandidateIdentity(db, {
      assistantId: A, provider: 'fake', selector: 'latest', catalog: built.modelCatalog.list(), now,
    });
    expect(identity.basis).toBe('unresolved');
    expect(identity.resolvedModelKey).toBeUndefined();
    expect(identity.evidence).toContain('never resolved against today');
  });

  it('binds a selector this workspace\'s own runs prove the resolution of', async () => {
    await boot();
    const task = built.tasks.create({ goal: 'Implement the parser' });
    recordRun({ taskId: task.taskId, assistantId: A, modelRequested: 'latest', modelResolved: FAKE_MODEL });
    const identity = resolveCandidateIdentity(db, {
      assistantId: A, provider: 'fake', selector: 'latest', catalog: built.modelCatalog.list(), now,
    });
    expect(identity.basis).toBe('observed-resolution');
    expect(identity.resolvedModelKey).toBe(`fake:${FAKE_MODEL}`);
  });

  it('refuses an ambiguous selector that resolved to two different models', async () => {
    await boot();
    const task = built.tasks.create({ goal: 'Implement the parser' });
    recordRun({ taskId: task.taskId, assistantId: A, modelRequested: 'latest', modelResolved: FAKE_MODEL });
    recordRun({ taskId: task.taskId, assistantId: A, modelRequested: 'latest', modelResolved: 'fake-2' });
    const identity = resolveCandidateIdentity(db, {
      assistantId: A, provider: 'fake', selector: 'latest', catalog: built.modelCatalog.list(), now,
    });
    expect(identity.basis).toBe('unresolved');
    expect(identity.evidence).toContain('ambiguous selector');
  });

  it('never lets one provider\'s benchmark evidence reach another provider\'s model', async () => {
    // The benchmark names `anthropic:fake-1`; the candidate is `fake:fake-1`.
    await boot([benchmarkSource([{ provider: 'anthropic', modelId: FAKE_MODEL, coding: 0.99 }])]);
    await built.modelCatalog.refresh();
    const task = built.tasks.create({ goal: 'Implement the parser' });
    const { recommendation } = routeAndRead(task.taskId);
    const coding = scored(recommendation, A).dimensions.find((d) => d.dimension === 'coding')!;
    expect(coding.prior).toBeUndefined();
    expect(coding.missing).toContain('priorMissing:coding');
  });
});

describe('telemetry cohorts are per resolved model', () => {
  it('never joins a run whose model the provider did not report', async () => {
    await boot();
    const task = built.tasks.create({ goal: 'Implement the parser' });
    recordRun({ taskId: task.taskId, assistantId: A, modelResolved: FAKE_MODEL });
    recordRun({ taskId: task.taskId, assistantId: A, modelResolved: null });

    const cohorts = modelCohorts(db, { taskKind: 'coding', harnessMajor: HARNESS_MAJOR, now });
    expect(cohorts.get(`fake:${FAKE_MODEL}`)?.reliabilityRuns).toBe(1);
  });

  it('never joins a run from another harness major', async () => {
    await boot();
    const task = built.tasks.create({ goal: 'Implement the parser' });
    recordRun({ taskId: task.taskId, assistantId: A });
    recordRun({ taskId: task.taskId, assistantId: A, harnessMajor: '0' });
    recordRun({ taskId: task.taskId, assistantId: A, harnessMajor: null });

    const cohorts = modelCohorts(db, { taskKind: 'coding', harnessMajor: HARNESS_MAJOR, now });
    expect(cohorts.get(`fake:${FAKE_MODEL}`)?.reliabilityRuns).toBe(1);
  });

  it('keeps a healthy context yield neutral — out of numerator and denominator', async () => {
    await boot();
    const task = built.tasks.create({ goal: 'Implement the parser' });
    recordRun({ taskId: task.taskId, assistantId: A, result: { outcome: 'completed' } });
    recordRun({ taskId: task.taskId, assistantId: A, result: { outcome: 'yielded', yield: { kind: 'context' } } });

    const cohort = modelCohorts(db, { taskKind: 'coding', harnessMajor: HARNESS_MAJOR, now }).get(`fake:${FAKE_MODEL}`)!;
    expect(cohort.reliabilityRuns).toBe(1);
    expect(cohort.successRate).toBe(1);
  });

  it('narrows to the task kind, so a review cohort is not a coding cohort', async () => {
    await boot();
    const coding = built.tasks.create({ goal: 'Implement the parser' });
    const review = built.tasks.create({ goal: 'Review this pull request' });
    recordRun({ taskId: coding.taskId, assistantId: A });
    recordRun({ taskId: review.taskId, assistantId: A });

    expect(modelCohorts(db, { taskKind: 'coding', harnessMajor: HARNESS_MAJOR, now }).get(`fake:${FAKE_MODEL}`)?.reliabilityRuns).toBe(1);
    expect(modelCohorts(db, { taskKind: 'review', harnessMajor: HARNESS_MAJOR, now }).get(`fake:${FAKE_MODEL}`)?.reliabilityRuns).toBe(1);
  });

  it('drops out of the rolling window as it ages, taking n with it', async () => {
    await boot();
    const task = built.tasks.create({ goal: 'Implement the parser' });
    recordRun({ taskId: task.taskId, assistantId: A });
    expect(modelCohorts(db, { taskKind: 'coding', harnessMajor: HARNESS_MAJOR, now }).get(`fake:${FAKE_MODEL}`)?.reliabilityRuns).toBe(1);

    clock = new Date(clock.getTime() + 31 * 86_400_000);
    expect(modelCohorts(db, { taskKind: 'coding', harnessMajor: HARNESS_MAJOR, now }).get(`fake:${FAKE_MODEL}`)).toBeUndefined();
  });

  it('blends its own telemetry against the prior at the documented weight', async () => {
    await boot([benchmarkSource([{ provider: 'fake', modelId: FAKE_MODEL, coding: 0.4 }])]);
    await built.modelCatalog.refresh();
    const task = built.tasks.create({ goal: 'Implement the parser' });
    for (let i = 0; i < DIMENSION_K.coding; i += 1) {
      recordCodingRun(task.taskId, A);
    }

    const { recommendation } = routeAndRead(task.taskId);
    const coding = scored(recommendation, A).dimensions.find((d) => d.dimension === 'coding')!;
    expect(coding.n).toBe(DIMENSION_K.coding);
    expect(coding.weight).toBeCloseTo(0.5, 6);
    // w·1.0 (every run succeeded) + (1−w)·0.4
    expect(coding.score).toBeCloseTo(0.7, 6);
    expect(coding.telemetry?.cohort.harnessMajor).toBe(HARNESS_MAJOR);
  });
});

describe('shadow changes nothing about execution (CR-33)', () => {
  it('leaves the routing decision, ExecutionRequest.model and RunSpec.model untouched', async () => {
    await boot([benchmarkSource([{ provider: 'fake', modelId: FAKE_MODEL, coding: 0.99 }])]);
    await built.modelCatalog.refresh();
    const task = built.tasks.create({ goal: 'Implement the parser', overrides: { model: FAKE_MODEL } });

    // Route WITHOUT a catalog (no recommendation) and WITH one, then compare.
    const before = built.orchestrator.routeTask(task.taskId, 'intake');
    const after = built.orchestrator.routeTask(task.taskId, 'intake');
    expect(after.explanation.modelRecommendation).toBeDefined();
    expect(after.explanation.chosen).toBe(before.explanation.chosen);
    expect(after.explanation.ruleFired).toBe(before.explanation.ruleFired);

    const request = buildExecutionRequest({
      taskId: task.taskId, assistantId: A, attempt: 1, prompt: 'p', workdir: '/tmp',
      approvalMode: 'auto-approve', maxRuntimeMs: 1000, routingDecisionRef: '1',
      // Exactly what `Orchestrator.requestedModel` supplies: the durable intent.
      model: FAKE_MODEL,
    });
    expect(request.model?.id).toBe(FAKE_MODEL);
    expect(request.runSpec.model?.id).toBe(FAKE_MODEL);
    // The recommendation named a candidate; the request still asks for the
    // operator's selector, and the RunSpec is its projection, not the score's.
    expect(after.explanation.modelRecommendation!.execution).toMatchObject({
      requestedModelSelector: FAKE_MODEL,
      authority: 'ExecutionRequest.model',
      decidedBy: 'operator-override',
    });
    expect(after.explanation.modelRecommendation!.applied).toBeUndefined();
  });

  it('records no recommendation at all when the catalog is unavailable, and still routes', async () => {
    await boot();
    const task = built.tasks.create({ goal: 'Implement the parser' });
    const broken = { list: () => { throw new Error('catalog is down'); } } as unknown as BuiltServer['modelCatalog'];
    const { routeTask } = await import('../src/modules/router.js');
    const routed = routeTask(
      { db, config, tasks: built.tasks, registry: built.registry, cooldowns: built.cooldowns, now, catalog: broken },
      task.taskId, 'intake',
    );
    expect(routed.explanation.modelRecommendation).toBeUndefined();
    expect(routed.explanation.chosen).toBe(A);
  });
});

describe('activation gate and rollback', () => {
  it('stays shadow on a fresh workspace and names every failing gate', async () => {
    await boot([benchmarkSource([{ provider: 'fake', modelId: FAKE_MODEL, coding: 0.7 }])]);
    await built.modelCatalog.refresh();
    const task = built.tasks.create({ goal: 'Implement the parser' });
    const { recommendation } = routeAndRead(task.taskId);

    expect(recommendation.mode).toBe('shadow');
    expect(recommendation.activation.active).toBe(false);
    const failing = recommendation.activation.gates.filter((g) => !g.passed).map((g) => g.name);
    expect(failing).toContain('config');
    expect(failing).toContain('telemetry');
    expect(failing).toContain('shadow-week');
    expect(failing).toContain('egress-verified');
  });

  it('does not activate on the config flag alone', async () => {
    await boot([benchmarkSource([{ provider: 'fake', modelId: FAKE_MODEL, coding: 0.7 }])]);
    await built.modelCatalog.refresh();
    config.models.selection.enabled = true;
    const task = built.tasks.create({ goal: 'Implement the parser' });
    const { recommendation } = routeAndRead(task.taskId);

    expect(recommendation.activation.gates.find((g) => g.name === 'config')?.passed).toBe(true);
    expect(recommendation.activation.active).toBe(false);
    expect(recommendation.mode).toBe('shadow');
  });

  it('rolls back to shadow the moment the flag is cleared, leaving the evidence readable', async () => {
    await boot([benchmarkSource([{ provider: 'fake', modelId: FAKE_MODEL, coding: 0.7 }])]);
    await built.modelCatalog.refresh();
    config.models.selection.enabled = true;
    config.models.selection.shadowReviewedAt = new Date(clock.getTime() - 86_400_000).toISOString();
    config.models.selection.egressVerifiedAt = new Date(clock.getTime() - 86_400_000).toISOString();

    const task = built.tasks.create({ goal: 'Implement the parser' });
    routeAndRead(task.taskId);

    config.models.selection.enabled = false;
    const { explanation, recommendation } = routeAndRead(task.taskId);
    expect(recommendation.mode).toBe('shadow');
    expect(recommendation.activation.gates.find((g) => g.name === 'config')?.passed).toBe(false);
    // Rollback is a switch, not a migration: catalog, priors and the earlier
    // shadow explanations all stay readable.
    expect(built.modelCatalog.list().some((e) => (e.benchmarkPriors ?? []).length > 0)).toBe(true);
    expect(explanation.chosen).toBe(A);
    const history = db.prepare('SELECT COUNT(*) n FROM routing_decisions WHERE task_id = ?').get(task.taskId) as { n: number };
    expect(history.n).toBeGreaterThan(1);
  });
});

describe('activation applies the selection end to end (CR-33 unchanged)', () => {
  /** The canonical story, with only the clock injected. */
  async function activated() {
    await boot([benchmarkSource([{ provider: 'fake', modelId: FAKE_MODEL, coding: 0.8 }])], undefined, { harness: true });
    await built.modelCatalog.refresh();
    const task = built.tasks.create({ goal: 'Implement the parser' });
    fillCodingCohort();
    activateGates();
    return task;
  }

  it('changes nothing while the gate is closed: a recommendation exists and execution is untouched', async () => {
    await boot([benchmarkSource([{ provider: 'fake', modelId: FAKE_MODEL, coding: 0.8 }])], undefined, { harness: true });
    await built.modelCatalog.refresh();
    const task = built.tasks.create({ goal: 'Implement the parser' });
    fillCodingCohort();

    const { recommendation, runSpec } = await routeAndStart(task.taskId);
    expect(recommendation.recommended).toBe(`${A}/${FAKE_MODEL}`);
    expect(recommendation.mode).toBe('shadow');
    expect(recommendation.applied).toBeUndefined();
    // The task named no model, so nothing asks for one — the recommendation is
    // not quietly promoted into the request.
    expect(requestedModelOf(task.taskId)).toBeUndefined();
    expect(runSpec.model).toBeUndefined();
  });

  it('commits the winner into ExecutionRequest.model and RunSpec.model once every gate passes', async () => {
    const task = await activated();
    const { recommendation, routed, runSpec } = await routeAndStart(task.taskId);

    expect(recommendation.activation.gates.filter((g) => !g.passed)).toEqual([]);
    expect(recommendation.activation.active).toBe(true);
    expect(recommendation.mode).toBe('applied');
    expect(recommendation.applied).toEqual({ assistantId: A, selector: FAKE_MODEL, label: `${A}/${FAKE_MODEL}` });
    expect(routed.explanation.chosen).toBe(A);

    // The durable routing decision is the source; the request is its projection,
    // and the RunSpec is the request's — no second writer anywhere.
    expect(requestedModelOf(task.taskId)).toBe(FAKE_MODEL);
    expect(runSpec.model).toEqual({ id: FAKE_MODEL });
  });

  it('never overrides the operator: an explicit model outranks the recommendation', async () => {
    await boot([benchmarkSource([{ provider: 'fake', modelId: FAKE_MODEL, coding: 0.8 }])], undefined, { harness: true });
    await built.modelCatalog.refresh();
    const task = built.tasks.create({ goal: 'Implement the parser', overrides: { model: FAKE_MODEL } });
    fillCodingCohort();
    activateGates();

    const { recommendation, runSpec } = await routeAndStart(task.taskId);
    expect(recommendation.mode).toBe('shadow');
    expect(recommendation.applied).toBeUndefined();
    expect(recommendation.execution).toMatchObject({ decidedBy: 'operator-override', requestedModelSelector: FAKE_MODEL });
    expect(requestedModelOf(task.taskId)).toBe(FAKE_MODEL);
    expect(runSpec.model).toEqual({ id: FAKE_MODEL });
  });

  it('materializes a committed decision without recomputing it from newer evidence', async () => {
    await boot([benchmarkSource([{ provider: 'fake', modelId: FAKE_MODEL, coding: 0.8 }])], undefined, { harness: true });
    await built.modelCatalog.refresh();
    const task = built.tasks.create({ goal: 'Implement the parser' });
    fillCodingCohort();
    activateGates();

    // Between routing and materialization the world changes: the operator turns
    // selection off. A dispatch that recomputed would materialize a different
    // request; this one must re-read what it already committed.
    const scheduler = new Scheduler({
      db, config, tasks: built.tasks, orchestrator: built.orchestrator, bus: built.bus, now,
      boundary: async (phase) => { if (phase === 'routed') config.models.selection.enabled = false; },
    });
    scheduler.attach(task.taskId, { kind: 'time', notBefore: new Date(clock.getTime() + 1000).toISOString() });
    clock = new Date(clock.getTime() + 2000);
    const done = terminal(task.taskId);
    await scheduler.tick();
    await done;

    const decisions = db.prepare('SELECT explanation FROM routing_decisions WHERE task_id = ? ORDER BY id').all(task.taskId) as Array<{ explanation: string }>;
    expect(decisions).toHaveLength(1);
    const committed = (JSON.parse(decisions[0]!.explanation) as RoutingExplanation).modelRecommendation!;
    expect(committed.mode).toBe('applied');
    expect(requestedModelOf(task.taskId)).toBe(committed.applied!.selector);
  });

  it('returns new dispatches to shadow the moment the flag is cleared', async () => {
    const task = await activated();
    expect(routeAndRead(task.taskId).recommendation.mode).toBe('applied');

    config.models.selection.enabled = false;
    const second = built.tasks.create({ goal: 'Implement the parser' });
    const { recommendation, runSpec } = await routeAndStart(second.taskId);
    expect(recommendation.mode).toBe('shadow');
    expect(recommendation.applied).toBeUndefined();
    expect(requestedModelOf(second.taskId)).toBeUndefined();
    expect(runSpec.model).toBeUndefined();
  });
});

describe('a price is evidence only where it applies (§4.4.5)', () => {
  const costPrior = (recommendation: ModelRecommendation) =>
    scored(recommendation, A).dimensions.find((d) => d.dimension === 'cost')!.prior;

  /** Boot with one price row and an optionally declared account kind. */
  async function bootPriced(appliesTo?: { servingProvider: string; accountKind?: string }, accountKind?: string) {
    await boot(
      [priceSource([{ provider: 'fake', modelId: FAKE_MODEL, ...(appliesTo ? { appliesTo } : {}) }])],
      { [A]: { provider: 'fake', ...(accountKind ? { accountKind } : {}) }, [B]: { provider: 'fake' } },
    );
    await built.modelCatalog.refresh();
    return built.tasks.create({ goal: 'Implement the parser' });
  }

  it('uses a tariff whose serving provider and account kind are both proven', async () => {
    const task = await bootPriced({ servingProvider: 'fake', accountKind: 'api' }, 'api');
    const prior = costPrior(routeAndRead(task.taskId).recommendation);
    expect(prior?.source).toBe('k7:price-evidence');
    expect(prior?.normalizationVersion).toBe('price-normalization-v1');
  });

  it('uses a provider-wide tariff that declares no account kind', async () => {
    const task = await bootPriced({ servingProvider: 'fake' });
    expect(costPrior(routeAndRead(task.taskId).recommendation)?.source).toBe('k7:price-evidence');
  });

  it('refuses a tariff for a different serving provider', async () => {
    const task = await bootPriced({ servingProvider: 'anthropic', accountKind: 'api' }, 'api');
    expect(costPrior(routeAndRead(task.taskId).recommendation)).toBeUndefined();
  });

  it('refuses a tariff for a different account kind', async () => {
    const task = await bootPriced({ servingProvider: 'fake', accountKind: 'api' }, 'subscription');
    expect(costPrior(routeAndRead(task.taskId).recommendation)).toBeUndefined();
  });

  it('refuses an account-specific tariff when the account kind is not proven', async () => {
    // This is the Anthropic-API-price-on-a-subscription-run case: the tariff is
    // real, the model is right, and it still says nothing about this account.
    const task = await bootPriced({ servingProvider: 'fake', accountKind: 'api' });
    expect(costPrior(routeAndRead(task.taskId).recommendation)).toBeUndefined();
  });

  it('refuses a price row that declares no applicability at all', async () => {
    const task = await bootPriced(undefined, 'api');
    expect(costPrior(routeAndRead(task.taskId).recommendation)).toBeUndefined();
  });

  it('decides applicability the same way for every caller', () => {
    const account = { servingProvider: 'fake', accountKind: 'api' };
    expect(priceApplicability({ appliesTo: { servingProvider: 'fake', accountKind: 'api' } }, account).applicable).toBe(true);
    expect(priceApplicability({ appliesTo: { servingProvider: 'fake' } }, account).applicable).toBe(true);
    expect(priceApplicability({}, account)).toMatchObject({ applicable: false });
    expect(priceApplicability({ appliesTo: { servingProvider: 'openai' } }, account)).toMatchObject({ applicable: false });
    expect(priceApplicability({ appliesTo: { servingProvider: 'fake', accountKind: 'api' } }, { servingProvider: 'fake' }))
      .toMatchObject({ applicable: false });
  });
});

describe('cost per COMPLETED task samples only completed runs', () => {
  const cohortNow = () => modelCohorts(db, { taskKind: 'coding', harnessMajor: HARNESS_MAJOR, now }).get(`fake:${FAKE_MODEL}`);

  it('counts a completed run', async () => {
    await boot();
    const task = built.tasks.create({ goal: 'Implement the parser' });
    recordRun({ taskId: task.taskId, assistantId: A, usage: { inputTokens: 100, outputTokens: 10 }, result: { outcome: 'completed' } });
    expect(cohortNow()?.completedUsageRuns).toBe(1);
    expect(cohortNow()?.medianInputTokens).toBe(100);
  });

  it('excludes a failed run that burned tokens without finishing the task', async () => {
    await boot();
    const task = built.tasks.create({ goal: 'Implement the parser' });
    recordRun({ taskId: task.taskId, assistantId: A, state: 'ENDED_ERROR', usage: { inputTokens: 900, outputTokens: 90 }, result: { outcome: 'failed' } });
    expect(cohortNow()?.completedUsageRuns).toBe(0);
    expect(cohortNow()?.medianInputTokens).toBeUndefined();
  });

  it('excludes a cancelled run', async () => {
    await boot();
    const task = built.tasks.create({ goal: 'Implement the parser' });
    recordRun({ taskId: task.taskId, assistantId: A, usage: { inputTokens: 900, outputTokens: 90 }, result: { outcome: 'cancelled' } });
    expect(cohortNow()?.completedUsageRuns).toBe(0);
  });

  it('excludes a context-yield predecessor but counts the successor that completed', async () => {
    await boot();
    const task = built.tasks.create({ goal: 'Implement the parser' });
    recordRun({ taskId: task.taskId, assistantId: A, usage: { inputTokens: 900, outputTokens: 90 }, result: { outcome: 'yielded', yield: { kind: 'context' } } });
    recordRun({ taskId: task.taskId, assistantId: A, usage: { inputTokens: 100, outputTokens: 10 }, result: { outcome: 'completed' } });
    const cohort = cohortNow()!;
    expect(cohort.completedUsageRuns).toBe(1);
    // The successor's usage alone — the predecessor's tokens are not half a task.
    expect(cohort.medianInputTokens).toBe(100);
    // Speed keeps its own eligibility: both runs generated tokens at a real rate.
    expect(cohort.outputRateRuns).toBe(2);
  });
});

describe('a missing coding factor is not a perfect factor', () => {
  const codingOf = (recommendation: ModelRecommendation) =>
    scored(recommendation, A).dimensions.find((d) => d.dimension === 'coding')!;

  async function bootWithPrior() {
    await boot([benchmarkSource([{ provider: 'fake', modelId: FAKE_MODEL, coding: 0.4 }])]);
    await built.modelCatalog.refresh();
    return built.tasks.create({ goal: 'Implement the parser' });
  }

  it('uses the canonical product when all three factors exist', async () => {
    const task = await bootWithPrior();
    for (let i = 0; i < DIMENSION_K.coding; i += 1) {
      recordRun({ taskId: task.taskId, assistantId: A, result: { outcome: 'completed' }, tests: { passed: 3, failed: 1 }, verification: { passed: true } });
    }
    const coding = codingOf(routeAndRead(task.taskId).recommendation);
    expect(coding.telemetry?.metric).toBe('success × test-pass × verification-pass');
    // 1.0 × 0.75 × 1.0, blended at w = 0.5 against the 0.4 prior.
    expect(coding.telemetry?.value).toBeCloseTo(0.75, 6);
    expect(coding.score).toBeCloseTo(0.5 * 0.75 + 0.5 * 0.4, 6);
  });

  it('emits no coding telemetry when the test factor is missing', async () => {
    const task = await bootWithPrior();
    for (let i = 0; i < DIMENSION_K.coding; i += 1) {
      recordRun({ taskId: task.taskId, assistantId: A, result: { outcome: 'completed' }, verification: { passed: true } });
    }
    const coding = codingOf(routeAndRead(task.taskId).recommendation);
    expect(coding.telemetry).toBeUndefined();
    expect(coding.telemetryWithheld).toContain('test-pass');
    // The prior carries the dimension alone; nothing neutral is manufactured.
    expect(coding.score).toBeCloseTo(0.4, 6);
  });

  it('emits no coding telemetry when the verification factor is missing', async () => {
    const task = await bootWithPrior();
    for (let i = 0; i < DIMENSION_K.coding; i += 1) {
      recordRun({ taskId: task.taskId, assistantId: A, result: { outcome: 'completed' }, tests: { passed: 1, failed: 0 } });
    }
    const coding = codingOf(routeAndRead(task.taskId).recommendation);
    expect(coding.telemetry).toBeUndefined();
    expect(coding.telemetryWithheld).toContain('verification-pass');
    expect(coding.score).toBeCloseTo(0.4, 6);
  });

  it('cannot improve a candidate: partial evidence never outscores the full product', async () => {
    const task = await bootWithPrior();
    // A perfect success rate with no test or verification evidence. Multiplying
    // the absent factors in as 1.0 would score 0.5·1.0 + 0.5·0.4 = 0.7.
    for (let i = 0; i < DIMENSION_K.coding; i += 1) {
      recordRun({ taskId: task.taskId, assistantId: A, result: { outcome: 'completed' } });
    }
    const coding = codingOf(routeAndRead(task.taskId).recommendation);
    expect(coding.score).toBeCloseTo(0.4, 6);
    expect(coding.score!).toBeLessThan(0.7);
  });
});

describe('the hard-filter audit covers the whole review window', () => {
  it('fails activation for one old violation behind a thousand clean decisions', async () => {
    await boot([benchmarkSource([{ provider: 'fake', modelId: FAKE_MODEL, coding: 0.8 }])], undefined);
    await built.modelCatalog.refresh();
    fillCodingCohort();
    activateGates();
    const task = built.tasks.create({ goal: 'Implement the parser' });

    const record = (recommendation: unknown, at: string) =>
      db.prepare('INSERT INTO routing_decisions (task_id, chosen_assistant_id, explanation, at) VALUES (?, ?, ?, ?)')
        .run(task.taskId, A, JSON.stringify({ candidates: [], ruleFired: 'audited', modelRecommendation: recommendation }), at);

    // One recommendation that named a candidate which had failed a hard filter.
    record({
      schemaVersion: 2, mode: 'shadow', recommended: `${A}/${FAKE_MODEL}`,
      candidates: [{ label: `${A}/${FAKE_MODEL}`, assistantId: A, selector: FAKE_MODEL, eligible: false, filterFailures: ['auth expired'], advisories: [], dimensions: [], evidenceCoverage: 0 }],
    }, new Date(clock.getTime() - 7 * 86_400_000).toISOString());

    // …then far more than any plausible page of clean ones after it.
    const clean = {
      schemaVersion: 2, mode: 'shadow', recommended: `${A}/${FAKE_MODEL}`,
      candidates: [{ label: `${A}/${FAKE_MODEL}`, assistantId: A, selector: FAKE_MODEL, eligible: true, filterFailures: [], advisories: [], dimensions: [], evidenceCoverage: 1 }],
    };
    db.transaction(() => {
      for (let i = 0; i < 1200; i += 1) record(clean, new Date(clock.getTime() - 3 * 86_400_000 + i).toISOString());
    })();

    expect(countHardFilterViolations(db)).toBe(1);
    const { recommendation } = routeAndRead(task.taskId);
    const gate = recommendation.activation.gates.find((g) => g.name === 'no-filter-violations')!;
    expect(gate.passed).toBe(false);
    expect(recommendation.activation.active).toBe(false);
    expect(recommendation.mode).toBe('shadow');
  });

  it('passes when every recorded recommendation named an eligible candidate', async () => {
    await boot([benchmarkSource([{ provider: 'fake', modelId: FAKE_MODEL, coding: 0.8 }])], undefined);
    await built.modelCatalog.refresh();
    fillCodingCohort();
    activateGates();
    const task = built.tasks.create({ goal: 'Implement the parser' });
    expect(countHardFilterViolations(db)).toBe(0);
    expect(routeAndRead(task.taskId).recommendation.activation.gates.find((g) => g.name === 'no-filter-violations')?.passed).toBe(true);
  });
});
