/**
 * Crash recovery replays the routing decision a dispatch stored before the crash. An assistant
 * disabled in between (workspace config or the operator overlay, migration 051) must not start:
 * the dispatch re-parks without calling a provider, and the successor routes afresh.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AssistantId } from '@agent-plane/core';
import { loadConfig, type ResolvedConfig } from '../src/config.js';
import { openDb, type Db } from '../src/db/index.js';
import { buildServer, type BuiltServer } from '../src/server.js';
import { Scheduler, type SchedulerDeps } from '../src/modules/scheduler.js';

let home: string; let db: Db; let config: ResolvedConfig; let built: BuiltServer;
let instant = Date.parse('2030-01-01T00:00:00Z');
const now = () => new Date(instant);
const A = 'fake-a' as AssistantId; const B = 'fake-b' as AssistantId;

async function boot(harness: boolean) {
  home = mkdtempSync(join(tmpdir(), 'rec-dis-'));
  config = loadConfig({ AGENT_PLANE_HOME: home });
  config.assistants = { [A]: { provider: 'fake' }, [B]: { provider: 'fake' } };
  config.execution.harnessModes.single = harness;
  db = openDb(config.dbPath); built = buildServer({ config, db, now });
  built.registry.init(); await built.registry.syncAll();
}
const scheduler = (boundary?: SchedulerDeps['boundary']) => new Scheduler({ db, config, tasks: built.tasks, orchestrator: built.orchestrator, bus: built.bus, now, boundary });
function terminal(id: string) {
  return new Promise<void>(resolve => {
    const off = built.bus.subscribe(id, p => {
      if (p.kind === 'state' && ['COMPLETED', 'FAILED', 'CANCELLED', 'WAITING_INPUT'].includes(p.state!.state)) { off(); resolve(); }
    });
  });
}
/** A dispatch that crashed right after its routing decision was stored: phase `reserved`, decision set. */
async function crashAfterRouting() {
  const s = scheduler(async phase => { if (phase === 'routed') throw new Error('crash'); });
  const t = built.tasks.create({ goal: 'do the work' });
  s.attach(t.taskId, { kind: 'time', notBefore: new Date(instant + 1000).toISOString() });
  await s.runNow(t.taskId).catch(() => {});
  await built.orchestrator.reconcileOnBoot();
  const d = s.dispatches(t.taskId)[0]!;
  expect(d.phase).toBe('reserved'); expect(d.routing_decision_id).not.toBeNull();
  const chosen = (JSON.parse((db.prepare('SELECT explanation FROM routing_decisions WHERE id = ?').get(d.routing_decision_id) as { explanation: string }).explanation) as { chosen: string }).chosen as AssistantId;
  return { id: t.taskId, chosen };
}

afterEach(async () => {
  if (built) { await built.orchestrator.shutdown(); await built.app.close(); }
  if (db?.open) db.close();
  if (home) rmSync(home, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe.each([false, true])('recovery of a stored decision for a disabled assistant (Harness=%s)', harness => {
  it.each([
    ['operator overlay', (id: AssistantId) => { built.registry.setOperatorState(id, 'disabled'); }],
    ['workspace config', (id: AssistantId) => { db.prepare('UPDATE assistants SET enabled = 0 WHERE id = ?').run(id); }],
  ])('does not start an assistant disabled by %s; the successor routes elsewhere', async (_name, disable) => {
    await boot(harness);
    const { id, chosen } = await crashAfterRouting();
    const other = chosen === A ? B : A;
    const spies = { [A]: vi.spyOn(built.registry.adapter(A), 'start'), [B]: vi.spyOn(built.registry.adapter(B), 'start') };
    disable(chosen);
    const recovered = scheduler();
    await recovered.reconcileOnBoot();
    expect(spies[chosen]).not.toHaveBeenCalled();
    const first = recovered.dispatches(id)[0]!;
    expect(first.phase).toBe('reparked'); expect(first.reason).toBe('assistant_disabled');
    // The successor is a time wait; it wakes and routes afresh onto the remaining assistant.
    expect(built.tasks.get(id)?.state).toBe('WAITING_RESOURCE');
    const done = terminal(id); instant += 120_000; await recovered.tick(); await done;
    expect(spies[chosen]).not.toHaveBeenCalled();
    expect(spies[other]).toHaveBeenCalledTimes(1);
    expect(recovered.dispatches(id).at(-1)).toMatchObject({ phase: 'started' });
  });

  it('still starts the stored assistant when nothing was disabled', async () => {
    await boot(harness);
    const { id, chosen } = await crashAfterRouting();
    const start = vi.spyOn(built.registry.adapter(chosen), 'start');
    const recovered = scheduler(); const done = terminal(id); await recovered.reconcileOnBoot(); await done;
    expect(start).toHaveBeenCalledTimes(1);
    expect(recovered.dispatches(id)).toHaveLength(1);
  });
});
