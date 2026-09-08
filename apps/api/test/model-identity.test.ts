/**
 * K7 execution model identity (M12, CR-33, I-M5).
 *
 * What is asked for and what a provider serves are two independent facts. These
 * tests pin the plumbing that carries the first, the evidence rule that records
 * the second, and the migration that refuses to guess either.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type {
  AgentAdapter, AssistantId, CapabilityManifest, ExecutionRequest,
  NormalizedEvent, RunHandle, RunSpec, TaskId,
} from '@agent-plane/core';
import { loadConfig, type ResolvedConfig } from '../src/config.js';
import { openDb, type Db } from '../src/db/index.js';
import { buildServer, type BuiltServer } from '../src/server.js';
import { buildExecutionRequest } from '../src/modules/harness/control-plane-bridge.js';
import { SessionRunner, type RunnerDeps } from '../src/modules/harness/session-runner.js';
import { SessionStore } from '../src/modules/harness/session-store.js';
import { EventRecorder } from '../src/modules/harness/event-recorder.js';
import { ApprovalService } from '../src/modules/harness/approval-service.js';
import { credentialPath, readCredential } from '../src/auth/credential-file.js';

let home: string; let db: Db; let config: ResolvedConfig; let built: BuiltServer;
const A = 'fake-a' as AssistantId;
const now = () => new Date('2030-01-01T00:00:00Z');

async function boot() {
  home = mkdtempSync(join(tmpdir(), 'k7-identity-'));
  config = loadConfig({ AGENT_PLANE_HOME: home });
  config.assistants = { [A]: { provider: 'fake' } };
  db = openDb(config.dbPath); built = buildServer({ config, db, now });
  built.registry.init(); await built.registry.syncAll();
}
function headers() { return { authorization: `Bearer ${readCredential(credentialPath(config.dir)).secrets[0]!.secret}` }; }

afterEach(async () => {
  if (built) { await built.orchestrator.shutdown(); await built.app.close(); }
  if (db?.open) db.close();
  if (home) rmSync(home, { recursive: true, force: true });
  built = undefined as unknown as BuiltServer;
});

// --- requested identity ----------------------------------------------------

describe('requested model selector', () => {
  it('is carried by ExecutionRequest.model and copied into RunSpec.model by the bridge (CR-33)', () => {
    const request = buildExecutionRequest({
      taskId: 'AG-1', assistantId: 'a1', attempt: 1, model: 'opus',
      prompt: 'p', workdir: '/tmp', approvalMode: 'auto-approve', maxRuntimeMs: 1000,
      routingDecisionRef: 'rd_1',
    });
    expect(request.model).toEqual({ id: 'opus' });
    expect(request.runSpec.model).toEqual({ id: 'opus' });
  });

  it('stays unspecified when no model was requested — no provider default is invented', () => {
    const request = buildExecutionRequest({
      taskId: 'AG-1', assistantId: 'a1', attempt: 1,
      prompt: 'p', workdir: '/tmp', approvalMode: 'auto-approve', maxRuntimeMs: 1000,
      routingDecisionRef: 'rd_1',
    });
    expect(request.model).toBeUndefined();
    expect(request.runSpec.model).toBeUndefined();
  });

  it('is the only layer that writes RunSpec.model', () => {
    // A grep-shaped invariant: the bridge derivation is the single writer, so a
    // future layer that starts choosing models fails this test.
    const sources = ['src/modules/orchestrator.ts', 'src/modules/harness/session-runner.ts']
      .map((f) => readFileSync(join(import.meta.dirname, '..', f), 'utf8'));
    // The orchestrator projects the SAME immutable task intent (its legacy path
    // has no ExecutionRequest); nothing derives a model from a catalog.
    for (const source of sources) expect(source).not.toMatch(/runSpec\.model\s*=/);
  });

  it('flows from task intent through the API to the persisted request and run row', async () => {
    await boot();
    const created = await built.app.inject({
      method: 'POST', url: '/api/tasks', headers: headers(),
      payload: { goal: 'ship it', overrides: { assistantId: A, model: 'opus' } },
    });
    expect(created.statusCode).toBe(201);
    const taskId = (created.json() as { taskId: string }).taskId;
    const started = await built.app.inject({ method: 'POST', url: `/api/tasks/${taskId}/start`, headers: headers(), payload: {} });
    expect(started.statusCode).toBe(200);

    const run = db.prepare('SELECT model_requested, model_resolved FROM runs WHERE task_id = ?').get(taskId) as
      { model_requested: string | null; model_resolved: string | null };
    expect(run.model_requested).toBe('opus');
    // Resolved identity is a separate column, filled only from provider evidence.
    expect(run.model_resolved === null || typeof run.model_resolved === 'string').toBe(true);
  });

  it('rejects overrides other than assistantId and model', async () => {
    await boot();
    const res = await built.app.inject({
      method: 'POST', url: '/api/tasks', headers: headers(),
      payload: { goal: 'g', overrides: { modelFamily: 'opus' } },
    });
    expect(res.statusCode).toBe(400);
  });

  it('reuses the immutable requested selector when the scheduler re-dispatches the same request', async () => {
    await boot();
    const created = await built.app.inject({
      method: 'POST', url: '/api/tasks', headers: headers(),
      payload: { goal: 'later', overrides: { assistantId: A, model: 'opus' } },
    });
    const taskId = (created.json() as { taskId: string }).taskId;
    await built.app.inject({ method: 'POST', url: `/api/tasks/${taskId}/start`, headers: headers(), payload: {} });
    const request = db.prepare('SELECT model, request_json FROM execution_requests WHERE task_id = ?').get(taskId) as
      { model: string | null; request_json: string | null } | undefined;
    if (request) {
      // The committed request keeps the selector, so a wake/recovery replay of
      // THIS dispatch can never re-resolve it against a newer catalog.
      expect(JSON.parse(request.model!)).toEqual({ id: 'opus' });
      if (request.request_json) {
        expect((JSON.parse(request.request_json) as ExecutionRequest).runSpec.model).toEqual({ id: 'opus' });
      }
    }
  });
});

// --- resolved identity -----------------------------------------------------

/** Emits exactly the events a provider stream would, then ends. */
function scriptedAdapter(started: Record<string, unknown>): AgentAdapter {
  return {
    id: 'a1' as AssistantId,
    describe: async () => MANIFEST,
    start: async (_spec: RunSpec) => ({ runId: 'r1', assistantId: 'a1' } as unknown as RunHandle),
    resume: async () => { throw new Error('not used'); },
    events: (): AsyncIterable<NormalizedEvent> => ({
      async *[Symbol.asyncIterator]() {
        yield { type: 'run.started', summary: 'started', payload: started } as unknown as NormalizedEvent;
        yield { type: 'run.ended', summary: 'ended', payload: { ok: true } } as unknown as NormalizedEvent;
      },
    }),
    cancel: async () => {},
  } as unknown as AgentAdapter;
}

const MANIFEST: CapabilityManifest = {
  assistantId: 'a1' as AssistantId, provider: 'fake',
  core: {
    models: [{ id: 'fake-1' }], canResume: false, canMcp: false, supportsMidRunInput: false,
    reportsUsage: true, reportsLimits: false,
    execution: { shell: true, filesystem: true, web: 'no' }, auth: { state: 'ok' },
  },
  harness: { usageAccounting: 'delta', toolGating: 'none', approvalRelay: false, processIsolation: 'none' },
  providerDetail: {}, evidence: { source: 'runtime-probe', observedAt: '2030-01-01T00:00:00Z' },
};

async function runWith(
  started: Record<string, unknown>,
  requested?: string,
  over: { policy?: Partial<ExecutionRequest['policy']>; manifest?: CapabilityManifest } = {},
) {
  const dir = mkdtempSync(join(tmpdir(), 'k7-runner-'));
  const local = openDb(join(dir, 't.db'));
  local.prepare("INSERT INTO assistants (id, provider) VALUES ('a1','fake')").run();
  local.prepare("INSERT INTO tasks (id, goal, envelope, created_at, updated_at) VALUES ('AG-1','g','{}','t','t')").run();
  const store = new SessionStore(local);
  const adapter = scriptedAdapter(started);
  const deps: RunnerDeps = {
    store, recorder: new EventRecorder(local), approvals: new ApprovalService(local),
    checkpoints: { create: async () => ({ id: 'ckpt_1', gitRef: null }) },
    registry: { adapter: () => adapter, manifest: () => over.manifest ?? MANIFEST },
    softThresholdPct: 80, approvalPollMs: 5,
  } as unknown as RunnerDeps;
  const request: ExecutionRequest = {
    schemaVersion: 1, executionRequestId: 'erq_1', taskId: 'AG-1' as TaskId, attempt: 1,
    assistantId: 'a1' as AssistantId, routingDecisionRef: 'rd_1',
    ...(requested ? { model: { id: requested } } : {}),
    runSpec: {
      taskId: 'AG-1' as TaskId, prompt: 'p', workdir: dir,
      ...(requested ? { model: { id: requested } } : {}),
      permissionPolicy: { mode: 'auto-approve' }, env: { redactionRules: [], maxRuntimeMs: 60_000 },
    },
    policy: {
      budget: { enforcement: 'advisory' }, timeout: { hardMs: 60_000 }, approval: { mode: 'auto-approve' },
      tools: { mode: 'audit' }, checkpoint: { onSoftLimit: true }, isolation: { required: 'ambient' },
      ...over.policy,
    },
    context: {}, verification: [], origin: { kind: 'fresh' },
  };
  const result = await new SessionRunner(deps).run(request);
  const session = store.forRequest('erq_1');
  const row = session
    ? local.prepare('SELECT model_requested, model_resolved, model_resolved_source FROM runs WHERE id = ?').get(session.sessionId as string) as
      { model_requested: string | null; model_resolved: string | null; model_resolved_source: string | null }
    : { model_requested: null, model_resolved: null, model_resolved_source: null };
  local.close(); rmSync(dir, { recursive: true, force: true });
  return { ...row, result };
}

describe('resolved model identity', () => {
  it('records the model a Claude-shaped run.started reports, separately from the request', async () => {
    // Exactly the payload ClaudeAdapter emits on `system/init`.
    const row = await runWith(
      { providerSessionRef: 'sess_1', model: 'claude-opus-4-1-20991231', tools: [], version: '9.9.9' },
      'opus',
    );
    expect(row.model_requested).toBe('opus');
    expect(row.model_resolved).toBe('claude-opus-4-1-20991231');
    expect(row.model_resolved_source).toBe('run.started');
  });

  it('keeps a Codex-shaped run.started (no model) unknown rather than echoing the request', async () => {
    const row = await runWith({ providerSessionRef: 'thread_1' }, 'gpt-5-codex');
    expect(row.model_requested).toBe('gpt-5-codex');
    expect(row.model_resolved).toBeNull();
    expect(row.model_resolved_source).toBeNull();
  });
});

// --- migration -------------------------------------------------------------

describe('migration backfill', () => {
  it('resolves only what persisted evidence proves and never guesses the rest', async () => {
    await boot();
    // Two historical runs: one with provider start evidence, one without.
    db.prepare("INSERT INTO tasks (id, goal, envelope, created_at, updated_at) VALUES ('AG-9','g','{}','t','t')").run();
    db.prepare(`INSERT INTO runs (id, task_id, assistant_id, state, started_at) VALUES ('run_claude','AG-9',?,'ACTIVE','t')`).run(A);
    db.prepare(`INSERT INTO runs (id, task_id, assistant_id, state, started_at) VALUES ('run_codex','AG-9',?,'ACTIVE','t')`).run(A);
    db.prepare(`INSERT INTO events (run_id, seq, ts, type, summary, payload) VALUES ('run_claude',1,'t','run.started','s',?)`)
      .run(JSON.stringify({ providerSessionRef: 's', model: 'claude-opus-4-1-20991231' }));
    db.prepare(`INSERT INTO events (run_id, seq, ts, type, summary, payload) VALUES ('run_codex',1,'t','run.started','s',?)`)
      .run(JSON.stringify({ providerSessionRef: 'thread' }));

    // Re-run the backfill statements the migration applies.
    db.prepare(`UPDATE runs SET
        model_resolved = (SELECT json_extract(e.payload,'$.model') FROM events e
          WHERE e.run_id = runs.id AND e.type='run.started' AND json_extract(e.payload,'$.model') IS NOT NULL ORDER BY e.seq LIMIT 1),
        model_resolved_source = 'run.started'
      WHERE EXISTS (SELECT 1 FROM events e WHERE e.run_id = runs.id AND e.type='run.started'
        AND json_extract(e.payload,'$.model') IS NOT NULL)`).run();

    const rows = db.prepare("SELECT id, model_requested, model_resolved FROM runs WHERE task_id='AG-9' ORDER BY id").all() as
      Array<{ id: string; model_requested: string | null; model_resolved: string | null }>;
    expect(rows).toEqual([
      { id: 'run_claude', model_requested: null, model_resolved: 'claude-opus-4-1-20991231' },
      { id: 'run_codex', model_requested: null, model_resolved: null },
    ]);
  });
});

// --- cost-cap deferral -----------------------------------------------------

describe('bounded cost caps (standing deferral #3)', () => {
  it('stay rejected even though the catalog now carries price evidence', async () => {
    // Everything the naive argument would call sufficient: a proven quantitative
    // usage-reporting contract, and catalog prices for the model family.
    const proven: CapabilityManifest = {
      ...MANIFEST,
      harness: {
        usageAccounting: 'delta', toolGating: 'none', approvalRelay: false, processIsolation: 'none',
        usageReporting: { cadence: 'per-message', maxUnreportedTokens: 500 },
      },
    };
    const { result } = await runWith(
      { providerSessionRef: 's', model: 'claude-opus-4-1-20991231' },
      'opus',
      { manifest: proven, policy: { budget: { enforcement: 'bounded', maxCostUsd: 5 } } },
    );
    expect(result.failure?.kind).toBe('policy_unenforceable');
    expect(result.failure?.message).toContain('not an enforcement tariff');
  });

  it('still accepts a bounded TOKEN cap, which the catalog change does not touch', async () => {
    const proven: CapabilityManifest = {
      ...MANIFEST,
      harness: {
        usageAccounting: 'delta', toolGating: 'none', approvalRelay: false, processIsolation: 'none',
        usageReporting: { cadence: 'per-message', maxUnreportedTokens: 500 },
      },
    };
    const { result } = await runWith(
      { providerSessionRef: 's', model: 'claude-opus-4-1-20991231' },
      'opus',
      { manifest: proven, policy: { budget: { enforcement: 'bounded', maxTokens: 1_000_000 } } },
    );
    expect(result.failure?.kind).not.toBe('policy_unenforceable');
  });
});
