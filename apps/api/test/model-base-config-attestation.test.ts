/**
 * K13 A4 — base-config attestation (docs/agentic-os-k13-alias-identity.md §2, §5, Q3).
 *
 * The plane sets no effort, but it cannot see the operator's own Claude
 * settings. A benchmark prior therefore attaches to a bound candidate only
 * while `models.selection.baseConfigAttestedAt` is set, not in the future, and
 * at most 30 days old. The attestation moves evidence only: it never touches a
 * hard filter, eligibility, or the activation gate.
 *
 * The toggle is driven through the workspace config file on a fake workspace,
 * with an injected clock, and read back from the persisted routing explanation.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AA_NORMALIZATION_VERSION,
  HARNESS_MAJOR,
  type AssistantId,
  type ModelRecommendation,
  type RoutingExplanation,
} from '@agent-plane/core';
import { loadConfig, type ResolvedConfig } from '../src/config.js';
import { openDb, type Db } from '../src/db/index.js';
import { buildServer, type BuiltServer } from '../src/server.js';
import type { CatalogObservation, CatalogSource } from '../src/modules/model-catalog.js';
import { BASE_CONFIG_ATTESTATION_DAYS, baseConfigAttestation } from '../src/modules/model-selection.js';

const A = 'fake-a' as AssistantId;
const ALIAS = 'fake-latest';
const DATED_ID = 'fake-2030-01';
const DAY = 86_400_000;
const CLOCK = new Date('2030-01-01T00:00:00Z');
const daysBefore = (n: number) => new Date(CLOCK.getTime() - n * DAY).toISOString();

let home: string;
let db: Db;
let config: ResolvedConfig;
let built: BuiltServer;
let seq = 0;
const now = () => CLOCK;

/** A provider-official dated id that lists the alias, with an external coding prior of 0.8. */
function source(): CatalogSource {
  return {
    name: 'test-dated-id',
    collect: async () => {
      const official = {
        source: 'provider-api' as const, tier: 'provider-official' as const,
        observedAt: CLOCK.toISOString(), normalizationVersion: '1.0', attribution: 'test',
      };
      const bench = {
        source: 'external:artificial-analysis' as const, tier: 'external-benchmark' as const,
        observedAt: CLOCK.toISOString(), normalizationVersion: AA_NORMALIZATION_VERSION, attribution: 'test',
        benchmark: { release: 'intelligence-index-4.3', category: 'coding' },
      };
      const observations: CatalogObservation[] = [
        { modelId: DATED_ID, provider: 'fake', aliases: [ALIAS], provenance: official, contextWindowTokens: 200_000 } as CatalogObservation,
        {
          modelId: DATED_ID, provider: 'fake', provenance: bench,
          benchmarks: [{
            dimension: 'coding', normalized: 0.8, raw: { metric: 'coding_index', value: 80, unit: 'index-0-100' },
            sourceModelId: DATED_ID, normalizationVersion: AA_NORMALIZATION_VERSION, provenance: bench, freshness: 'fresh',
          }],
        },
      ];
      return { observations };
    },
  };
}

/** Boot a fake workspace whose config.yaml carries (or omits) the attestation. */
async function boot(attestedAt?: string, extraYaml = '') {
  home = mkdtempSync(join(tmpdir(), 'k13-a4-'));
  const dir = join(home, 'personal');
  mkdirSync(dir, { recursive: true });
  const models = attestedAt === undefined ? '' : `models:\n  selection:\n    baseConfigAttestedAt: "${attestedAt}"\n`;
  writeFileSync(join(dir, 'config.yaml'), models + extraYaml);
  config = loadConfig({ AGENT_PLANE_HOME: home });
  config.assistants = { [A]: { provider: 'fake', options: { models: [{ id: ALIAS }] } } };
  db = openDb(config.dbPath);
  built = buildServer({ config, db, now, modelCatalogSources: [source()] });
  built.registry.init();
  await built.registry.syncAll();
  await built.modelCatalog.refresh();

  // Three fresh agreeing runs bind the alias, so a prior is available to withhold.
  const seed = built.tasks.create({ goal: 'seed' });
  for (const d of [3, 2, 1]) {
    const id = `run_${(seq += 1)}`;
    const startedAt = daysBefore(d);
    db.prepare(
      `INSERT INTO runs (id, task_id, assistant_id, state, started_at, ended_at, model_requested, model_resolved, model_resolved_source, harness_major)
       VALUES (?, ?, ?, 'ENDED_OK', ?, ?, ?, ?, 'run.started', ?)`,
    ).run(id, seed.taskId, A, startedAt, startedAt, ALIAS, DATED_ID, HARNESS_MAJOR);
    db.prepare("INSERT INTO events (run_id, seq, ts, type, payload) VALUES (?, 1, ?, 'run.started', ?)")
      .run(id, startedAt, JSON.stringify({ model: DATED_ID }));
  }
}

afterEach(async () => {
  if (built) { await built.orchestrator.shutdown(); await built.app.close(); }
  if (db?.open) db.close();
  if (home) rmSync(home, { recursive: true, force: true });
  built = undefined as unknown as BuiltServer;
});

/** Route, then read the explanation back from `routing_decisions` — the persisted record. */
function persisted(requirements?: { minContextTokens: number }): ModelRecommendation {
  const taskId = built.tasks.create({ goal: 'Implement the parser', ...(requirements ? { requirements } : {}) }).taskId;
  built.orchestrator.routeTask(taskId, 'intake');
  const row = db.prepare('SELECT explanation FROM routing_decisions WHERE task_id = ? ORDER BY id DESC LIMIT 1').get(taskId) as { explanation: string };
  return (JSON.parse(row.explanation) as RoutingExplanation).modelRecommendation!;
}

const candidateOf = (rec: ModelRecommendation) => rec.candidates.find((c) => c.selector === ALIAS)!;
const codingOf = (rec: ModelRecommendation) => candidateOf(rec).dimensions.find((d) => d.dimension === 'coding')!;

describe('baseConfigAttestation (pure)', () => {
  it('the window is 30 days', () => expect(BASE_CONFIG_ATTESTATION_DAYS).toBe(30));

  it('unset is not an attestation, and the reason names the key', () => {
    const r = baseConfigAttestation(undefined, CLOCK);
    expect(r.fresh).toBe(false);
    expect(r.reason).toContain('models.selection.baseConfigAttestedAt is not set');
  });

  it('a future timestamp is not an attestation', () => {
    const r = baseConfigAttestation(new Date(CLOCK.getTime() + 1000).toISOString(), CLOCK);
    expect(r.fresh).toBe(false);
    expect(r.reason).toContain('in the future');
  });

  it('older than 30 days is not an attestation; exactly 30 days still is', () => {
    expect(baseConfigAttestation(daysBefore(30), CLOCK).fresh).toBe(true);
    const stale = baseConfigAttestation(new Date(CLOCK.getTime() - 30 * DAY - 1000).toISOString(), CLOCK);
    expect(stale.fresh).toBe(false);
    expect(stale.reason).toContain('older than 30 days');
  });

  it('the same timestamp is fresh or stale as the injected clock moves', () => {
    const at = daysBefore(10);
    expect(baseConfigAttestation(at, CLOCK).fresh).toBe(true);
    expect(baseConfigAttestation(at, new Date(CLOCK.getTime() + 25 * DAY)).fresh).toBe(false);
  });
});

describe('config key', () => {
  it('is optional, passes through when set, and must be an ISO timestamp', async () => {
    home = mkdtempSync(join(tmpdir(), 'k13-a4-cfg-'));
    expect(loadConfig({ AGENT_PLANE_HOME: home }).models.selection.baseConfigAttestedAt).toBeUndefined();
    rmSync(home, { recursive: true, force: true });

    await boot('2029-12-25T00:00:00.000Z');
    expect(config.models.selection.baseConfigAttestedAt).toBe('2029-12-25T00:00:00.000Z');
    expect(config.models.selection.enabled).toBe(false); // setting it enables nothing
    await built.orchestrator.shutdown(); await built.app.close(); db.close(); built = undefined as unknown as BuiltServer;
    rmSync(home, { recursive: true, force: true });

    home = mkdtempSync(join(tmpdir(), 'k13-a4-cfg-'));
    mkdirSync(join(home, 'personal'), { recursive: true });
    writeFileSync(join(home, 'personal', 'config.yaml'), 'models:\n  selection:\n    baseConfigAttestedAt: "last tuesday"\n');
    expect(() => loadConfig({ AGENT_PLANE_HOME: home })).toThrow(/baseConfigAttestedAt must be an ISO 8601 timestamp/);
  });
});

describe('persisted explanation: unset, stale, future, fresh', () => {
  it('unset: the bound candidate gets no prior and the advisory says why', async () => {
    await boot();
    const rec = persisted();
    expect(candidateOf(rec).identity.basis).toBe('observed-resolution');
    expect(codingOf(rec).prior).toBeUndefined();
    expect(candidateOf(rec).advisories.join(' ')).toContain('benchmark prior withheld: models.selection.baseConfigAttestedAt is not set');
  });

  it('stale (45 days): no prior, and the advisory names the age', async () => {
    await boot(daysBefore(45));
    const rec = persisted();
    expect(codingOf(rec).prior).toBeUndefined();
    expect(candidateOf(rec).advisories.join(' ')).toContain('is 45.0 days old, older than 30 days');
  });

  it('future: no prior, and the advisory says so', async () => {
    await boot(new Date(CLOCK.getTime() + 5 * DAY).toISOString());
    const rec = persisted();
    expect(codingOf(rec).prior).toBeUndefined();
    expect(candidateOf(rec).advisories.join(' ')).toContain('in the future');
  });

  it('fresh (2 days): the prior attaches and no withholding advisory is recorded', async () => {
    await boot(daysBefore(2));
    const rec = persisted();
    expect(codingOf(rec).prior?.value).toBe(0.8);
    expect(candidateOf(rec).advisories.join(' ')).not.toContain('prior withheld');
  });

  it('a candidate whose identity is unresolved is unaffected by the attestation', async () => {
    await boot(daysBefore(2));
    db.prepare('UPDATE runs SET model_resolved = NULL').run();
    const rec = persisted();
    expect(candidateOf(rec).identity.basis).toBe('unresolved');
    expect(codingOf(rec).prior).toBeUndefined();
    expect(candidateOf(rec).advisories.join(' ')).not.toContain('prior withheld');
  });
});

describe('the attestation never touches a gate or a hard filter', () => {
  it('eligibility, filter failures and mode are identical with and without it', async () => {
    const view = (rec: ModelRecommendation) => ({
      mode: rec.mode,
      activation: JSON.stringify(rec.activation),
      candidates: rec.candidates.map((c) => ({ selector: c.selector, eligible: c.eligible, filterFailures: c.filterFailures })),
    });
    await boot();
    const without = view(persisted());
    const withoutFiltered = view(persisted({ minContextTokens: 1_000_000 }));
    await built.orchestrator.shutdown(); await built.app.close(); db.close(); built = undefined as unknown as BuiltServer;
    rmSync(home, { recursive: true, force: true });

    await boot(daysBefore(2));
    expect(view(persisted())).toEqual(without);
    expect(view(persisted({ minContextTokens: 1_000_000 }))).toEqual(withoutFiltered);
  });

  it('a fresh attestation does not resurrect a hard-filtered candidate', async () => {
    await boot(daysBefore(2));
    const rec = persisted({ minContextTokens: 1_000_000 });
    const c = candidateOf(rec);
    expect(c.eligible).toBe(false);
    expect(c.total).toBeUndefined();
    expect(rec.recommended).toBeUndefined();
  });
});
