/**
 * K13 A1 — last-N identity binding (docs/agentic-os-k13-alias-identity.md §2, §5).
 *
 * An alias selector binds to a dated model id only when the newest N = 3 runs
 * on this assistant that requested it all report the same id and the newest is
 * at most F = 14 days old. Older runs never block, an alias table never binds,
 * and a bound prior never resurrects a hard-filtered candidate (I-M2).
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AA_NORMALIZATION_VERSION,
  HARNESS_MAJOR,
  OBSERVED_RESOLUTION_FRESHNESS_DAYS,
  OBSERVED_RESOLUTION_RULE,
  OBSERVED_RESOLUTION_RUNS,
  type AssistantId,
  type ModelRecommendation,
  type RoutingExplanation,
} from '@agent-plane/core';
import { loadConfig, type ResolvedConfig } from '../src/config.js';
import { openDb, type Db } from '../src/db/index.js';
import { buildServer, type BuiltServer } from '../src/server.js';
import type { CatalogObservation, CatalogSource } from '../src/modules/model-catalog.js';
import { resolveCandidateIdentity } from '../src/modules/model-selection.js';

const A = 'fake-a' as AssistantId;
/** The alias the fake assistant advertises, and the two dated ids it can resolve to. */
const ALIAS = 'fake-latest';
const OLD_ID = 'fake-2029-06';
const NEW_ID = 'fake-2030-01';
const DAY = 86_400_000;

let home: string;
let db: Db;
let config: ResolvedConfig;
let built: BuiltServer;
let clock = new Date('2030-01-01T00:00:00Z');
const now = () => clock;
let seq = 0;

/**
 * Provider-official identity rows for both dated ids, each listing the alias the
 * way the price seed lists `opus`, plus an external coding prior on each, so a
 * binding visibly changes whether a prior attaches.
 */
function datedIdSource(): CatalogSource {
  return {
    name: 'test-dated-ids',
    collect: async () => {
      const observations: CatalogObservation[] = [];
      for (const [modelId, coding] of [[OLD_ID, 0.6], [NEW_ID, 0.8]] as const) {
        const official = {
          source: 'provider-api' as const, tier: 'provider-official' as const,
          observedAt: now().toISOString(), normalizationVersion: '1.0', attribution: 'test',
        };
        observations.push({ modelId, provider: 'fake', aliases: [ALIAS], provenance: official, contextWindowTokens: 200_000 } as CatalogObservation);
        const bench = {
          source: 'external:artificial-analysis' as const, tier: 'external-benchmark' as const,
          observedAt: now().toISOString(), normalizationVersion: AA_NORMALIZATION_VERSION, attribution: 'test',
          benchmark: { release: 'intelligence-index-4.3', category: 'coding' },
        };
        observations.push({
          modelId, provider: 'fake', provenance: bench,
          benchmarks: [{
            dimension: 'coding', normalized: coding, raw: { metric: 'coding_index', value: coding * 100, unit: 'index-0-100' },
            sourceModelId: modelId, normalizationVersion: AA_NORMALIZATION_VERSION, provenance: bench, freshness: 'fresh',
          }],
        });
      }
      return { observations };
    },
  };
}

async function boot(sources: CatalogSource[] = [datedIdSource()]) {
  home = mkdtempSync(join(tmpdir(), 'k13-a1-'));
  config = loadConfig({ AGENT_PLANE_HOME: home });
  config.assistants = { [A]: { provider: 'fake', options: { models: [{ id: ALIAS }] } } };
  // A4: priors attach only under a fresh base-config attestation; these tests are about everything else.
  config.models.selection.baseConfigAttestedAt = new Date(clock.getTime() - 86_400_000).toISOString();
  db = openDb(config.dbPath);
  built = buildServer({ config, db, now, modelCatalogSources: sources });
  built.registry.init();
  await built.registry.syncAll();
  await built.modelCatalog.refresh();
}

afterEach(async () => {
  clock = new Date('2030-01-01T00:00:00Z');
  if (built) { await built.orchestrator.shutdown(); await built.app.close(); }
  if (db?.open) db.close();
  if (home) rmSync(home, { recursive: true, force: true });
  built = undefined as unknown as BuiltServer;
});

/** One finished run that requested `requested` and was reported served as `resolved`, `daysAgo` before the clock. */
function recordRun(taskId: string, resolved: string | null, daysAgo: number, opts: { requested?: string; assistantId?: string; cliVersion?: string } = {}): void {
  const id = `run_${(seq += 1)}_${Math.random().toString(36).slice(2, 8)}`;
  const startedAt = new Date(clock.getTime() - daysAgo * DAY).toISOString();
  db.prepare(
    `INSERT INTO runs (id, task_id, assistant_id, state, started_at, ended_at, model_requested, model_resolved, model_resolved_source, harness_major)
     VALUES (?, ?, ?, 'ENDED_OK', ?, ?, ?, ?, 'run.started', ?)`,
  ).run(id, taskId, opts.assistantId ?? A, startedAt, startedAt, opts.requested ?? ALIAS, resolved, HARNESS_MAJOR);
  db.prepare("INSERT INTO events (run_id, seq, ts, type, payload) VALUES (?, 1, ?, 'run.started', ?)")
    .run(id, startedAt, JSON.stringify({ model: resolved, ...(opts.cliVersion ? { version: opts.cliVersion } : {}) }));
}

function identity(selector = ALIAS, provider = 'fake', assistantId: string = A) {
  return resolveCandidateIdentity(db, { assistantId, provider, selector, catalog: built.modelCatalog.list(), now });
}

/** Route, then read the explanation back from `routing_decisions` — the persisted record, not the return value. */
function routeAndReadPersisted(taskId: string): ModelRecommendation {
  built.orchestrator.routeTask(taskId, 'intake');
  const row = db.prepare('SELECT explanation FROM routing_decisions WHERE task_id = ? ORDER BY id DESC LIMIT 1').get(taskId) as { explanation: string };
  return (JSON.parse(row.explanation) as RoutingExplanation).modelRecommendation!;
}

describe('K13 A1 defaults', () => {
  it('N = 3, F = 14 days', () => {
    expect(OBSERVED_RESOLUTION_RUNS).toBe(3);
    expect(OBSERVED_RESOLUTION_FRESHNESS_DAYS).toBe(14);
  });
});

describe('last-N agreement binds an alias only on N fresh agreeing runs', () => {
  it('an advertised selector the catalog lists as an alias is not catalog-exact', async () => {
    await boot();
    const id = identity();
    expect(id.basis).toBe('unresolved');
    expect(id.resolvedModelKey).toBeUndefined();
    expect(id.evidence).toContain(`listed as an alias of fake:${OLD_ID}, fake:${NEW_ID}`);
  });

  it('N−1 agreeing runs ⇒ unresolved', async () => {
    await boot();
    const task = built.tasks.create({ goal: 'g' });
    for (let i = 0; i < OBSERVED_RESOLUTION_RUNS - 1; i += 1) recordRun(task.taskId, NEW_ID, i);
    const id = identity();
    expect(id.basis).toBe('unresolved');
    expect(id.resolvedModelKey).toBeUndefined();
    expect(id.evidence).toContain('only 2 of the 3 agreeing runs required');
    expect(id.observation).toMatchObject({ runsExamined: 2, requiredRuns: 3, resolvedIds: [NEW_ID] });
  });

  it('N agreeing ⇒ bound, naming N, the newest observedAt and the CLI versions seen', async () => {
    await boot();
    const task = built.tasks.create({ goal: 'g' });
    recordRun(task.taskId, NEW_ID, 3, { cliVersion: '2.1.280' });
    recordRun(task.taskId, NEW_ID, 2, { cliVersion: '2.1.284' });
    recordRun(task.taskId, NEW_ID, 1);
    const id = identity();
    expect(id.basis).toBe('observed-resolution');
    expect(id.resolvedModelKey).toBe(`fake:${NEW_ID}`);
    const newest = new Date(clock.getTime() - DAY).toISOString();
    expect(id.observation).toEqual({
      rule: OBSERVED_RESOLUTION_RULE,
      requiredRuns: 3,
      freshnessDays: 14,
      runsExamined: 3,
      resolvedIds: [NEW_ID],
      newestObservedAt: newest,
      cliVersions: ['2.1.280', '2.1.284'],
    });
    expect(id.evidence).toContain('the last 3 runs');
    expect(id.evidence).toContain(`newest ${newest}`);
    expect(id.evidence).toContain('CLI 2.1.280, 2.1.284');
  });

  it('a disagreement inside the last N ⇒ unresolved, naming both ids', async () => {
    await boot();
    const task = built.tasks.create({ goal: 'g' });
    recordRun(task.taskId, NEW_ID, 3);
    recordRun(task.taskId, OLD_ID, 2);
    recordRun(task.taskId, NEW_ID, 1);
    const id = identity();
    expect(id.basis).toBe('unresolved');
    expect(id.evidence).toContain(`disagree (${OLD_ID}, ${NEW_ID})`);
    expect(id.observation?.resolvedIds).toEqual([OLD_ID, NEW_ID]);
  });

  it('older disagreeing runs outside the last N do not block: a moved alias rebinds after N new runs', async () => {
    await boot();
    const task = built.tasks.create({ goal: 'g' });
    for (const d of [10, 9, 8, 7]) recordRun(task.taskId, OLD_ID, d);
    for (const d of [3, 2, 1]) recordRun(task.taskId, NEW_ID, d);
    const id = identity();
    expect(id.basis).toBe('observed-resolution');
    expect(id.resolvedModelKey).toBe(`fake:${NEW_ID}`);
    expect(id.observation?.runsExamined).toBe(3);
  });

  it('newest run older than F ⇒ unresolved', async () => {
    await boot();
    const task = built.tasks.create({ goal: 'g' });
    for (const d of [17, 16, 15]) recordRun(task.taskId, NEW_ID, d);
    const id = identity();
    expect(id.basis).toBe('unresolved');
    expect(id.evidence).toContain('started 15.0 days ago, older than 14 days');
    // Exactly F days old still binds: the window is inclusive.
    recordRun(task.taskId, NEW_ID, 14);
    expect(identity().basis).toBe('observed-resolution');
  });

  it('only counts runs that requested this selector on this assistant with a reported resolution', async () => {
    await boot();
    const task = built.tasks.create({ goal: 'g' });
    recordRun(task.taskId, NEW_ID, 3);
    recordRun(task.taskId, NEW_ID, 2);
    recordRun(task.taskId, null, 1); // provider reported nothing
    recordRun(task.taskId, OLD_ID, 1, { requested: 'fake-other' }); // another selector
    db.prepare("INSERT INTO assistants (id, provider, enabled) VALUES ('fake-b', 'fake', 1)").run();
    recordRun(task.taskId, OLD_ID, 1, { assistantId: 'fake-b' }); // another assistant
    expect(identity().basis).toBe('unresolved');
    expect(identity().observation?.runsExamined).toBe(2);
  });
});

describe('a binding adds evidence, never availability', () => {
  it('a bound candidate gets its prior; with a hard-filter failure it still has no total', async () => {
    await boot();
    const seed = built.tasks.create({ goal: 'seed' });
    for (const d of [3, 2, 1]) recordRun(seed.taskId, NEW_ID, d);

    const ok = routeAndReadPersisted(built.tasks.create({ goal: 'Implement the parser' }).taskId);
    const bound = ok.candidates.find((c) => c.selector === ALIAS)!;
    expect(bound.identity.basis).toBe('observed-resolution');
    expect(bound.eligible).toBe(true);
    expect(bound.dimensions.find((d) => d.dimension === 'coding')!.prior?.value).toBe(0.8);
    expect(bound.total).toBeDefined();

    // Same bound identity, but the task needs a context window the bound model lacks.
    const filtered = routeAndReadPersisted(
      built.tasks.create({ goal: 'Implement the parser', requirements: { minContextTokens: 1_000_000 } }).taskId,
    );
    const hard = filtered.candidates.find((c) => c.selector === ALIAS)!;
    expect(hard.identity.basis).toBe('observed-resolution');
    expect(hard.eligible).toBe(false);
    expect(hard.filterFailures.join(' ')).toContain('below the task\'s declared minimum');
    expect(hard.total).toBeUndefined();
    expect(filtered.recommended).toBeUndefined();
  });
});

describe('opus never binds through the price-seed alias', () => {
  it('a Claude assistant advertising `opus` stays unresolved with no runs, though the seed lists `opus` on claude-opus-5-5', async () => {
    await boot([]);
    config.assistants = { 'personal-claude': { provider: 'anthropic' } };
    built.registry.init();
    await built.registry.syncAll();
    await built.modelCatalog.refresh();
    const catalog = built.modelCatalog.list();
    // Preconditions the rule is up against: discovery put `anthropic:opus` in the
    // catalog, and the price seed lists `opus` as an alias of a dated id.
    expect(catalog.some((e) => e.modelKey === 'anthropic:opus')).toBe(true);
    expect(catalog.find((e) => e.modelKey === 'anthropic:claude-opus-5-5')?.aliases.map((a) => a.value)).toContain('opus');

    const id = identity('opus', 'anthropic', 'personal-claude');
    expect(id.basis).toBe('unresolved');
    expect(id.resolvedModelKey).toBeUndefined();
    expect(id.evidence).toContain('never resolved against today');

    // It binds only once its own runs prove it, and then to what they reported.
    const task = built.tasks.create({ goal: 'g' });
    for (const d of [3, 2, 1]) recordRun(task.taskId, 'claude-opus-5-5', d, { requested: 'opus', assistantId: 'personal-claude', cliVersion: '2.1.290' });
    const bound = identity('opus', 'anthropic', 'personal-claude');
    expect(bound.basis).toBe('observed-resolution');
    expect(bound.resolvedModelKey).toBe('anthropic:claude-opus-5-5');
  });
});
