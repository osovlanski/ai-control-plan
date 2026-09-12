import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type AssistantId, canTransition } from '@agent-plane/core';
import { loadConfig, type ResolvedConfig } from '../src/config.js';
import { openDb, type Db } from '../src/db/index.js';
import { buildServer, type BuiltServer } from '../src/server.js';
import { Scheduler, type SchedulerDeps } from '../src/modules/scheduler.js';
import { credentialPath, readCredential } from '../src/auth/credential-file.js';

let home: string; let db: Db; let config: ResolvedConfig; let built: BuiltServer;
let instant = Date.parse('2030-01-01T00:00:00Z');
const now = () => new Date(instant);
const A = 'fake-a' as AssistantId; const B = 'fake-b' as AssistantId;
async function boot(harness = false) {
  home = mkdtempSync(join(tmpdir(), 'k1-'));
  config = loadConfig({ AGENT_PLANE_HOME: home });
  config.assistants = { [A]: { provider: 'fake' }, [B]: { provider: 'fake' } };
  config.execution.harnessModes.single = harness;
  db = openDb(config.dbPath); built = buildServer({ config, db, now });
  built.registry.init(); await built.registry.syncAll();
}
function scheduler(boundary?: SchedulerDeps['boundary']) {
  return new Scheduler({ db, config, tasks: built.tasks, orchestrator: built.orchestrator, bus: built.bus, now, boundary });
}
function task(s: Scheduler, pin?: AssistantId, goal = 'do the work') {
  const t = built.tasks.create({ goal, overrides: pin ? { assistantId: pin } : undefined });
  s.attach(t.taskId, { kind: 'time', notBefore: new Date(instant + 1000).toISOString() });
  return t.taskId;
}
function terminal(id: string) {
  return new Promise<void>(resolve => {
    const off = built.bus.subscribe(id, p => {
      if (p.kind === 'state' && ['COMPLETED','FAILED','CANCELLED','WAITING_INPUT'].includes(p.state!.state)) { off(); resolve(); }
    });
  });
}
function gate() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; }
function headers() { return { authorization: `Bearer ${readCredential(credentialPath(config.dir)).secrets[0]!.secret}` }; }
afterEach(async () => {
  vi.useRealTimers();
  if (built) { await built.orchestrator.shutdown(); await built.app.close(); }
  if (db?.open) db.close();
  if (home) rmSync(home, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe.each([false, true])('K1 durable dispatch (Harness=%s)', harness => {
  it('routes only at wake, with current cooldowns and a single correlated owner', async () => {
    await boot(harness); const s = scheduler(); const id = task(s);
    const a = vi.spyOn(built.registry.adapter(A), 'start'); const b = vi.spyOn(built.registry.adapter(B), 'start');
    expect(db.prepare('SELECT * FROM routing_decisions WHERE task_id = ?').all(id)).toHaveLength(0);
    expect(built.tasks.get(id)?.state).toBe('WAITING_RESOURCE');
    built.cooldowns.penalize(A, 'limit', 'changed since creation');
    instant += 1000; const done = terminal(id); await s.tick(); await done;
    expect(a).not.toHaveBeenCalled(); expect(b).toHaveBeenCalledTimes(1);
    expect(s.dispatches(id)).toHaveLength(1);
    expect(s.dispatches(id)[0]).toMatchObject({ phase: 'started', condition_generation: 1 });
    const run = db.prepare('SELECT * FROM runs WHERE task_id = ?').get(id) as { dispatch_id: string; execution_request_id: string | null };
    expect(run.dispatch_id).toBe(s.dispatches(id)[0]!.dispatch_id);
    if (harness) expect(run.execution_request_id).toBe(run.dispatch_id);
  });
  it('two concurrent wakes consume one generation; run-now uses wake; replaced wakes are stale', async () => {
    await boot(harness); const entered = gate(); const release = gate();
    const s = scheduler(async phase => { if (phase === 'reserved') { entered.resolve(); await release.promise; } });
    const id = task(s); s.attach(id, { kind: 'time', notBefore: now().toISOString() });
    expect(await s.wake(id, 1, 'timer')).toMatchObject({ outcome: 'stale' });
    const spy = vi.spyOn(s, 'wake'); const done = terminal(id); const first = s.runNow(id, 2); await entered.promise;
    expect(await s.wake(id, 2, 'event')).toMatchObject({ outcome: 'stale' });
    expect(s.dispatches(id)).toHaveLength(1);
    expect(spy).toHaveBeenCalledWith(id, 2, 'operator');
    release.resolve(); await first; await done;
  });
  it.each(['before-wake','reserved','start_attempted'] as const)('cancel at %s prevents provider startup', async boundary => {
    await boot(harness); const s = scheduler(async phase => { if (phase === boundary) await s.cancel(id); });
    const id = task(s); const a = vi.spyOn(built.registry.adapter(A), 'start');
    if (boundary === 'before-wake') await s.cancel(id);
    await s.runNow(id).catch(() => {});
    expect(built.tasks.get(id)?.state).toBe('CANCELLED'); expect(a).not.toHaveBeenCalled();
    expect(db.prepare('SELECT * FROM runs WHERE task_id = ?').all(id)).toHaveLength(0);
    expect(await s.runNow(id)).toMatchObject({ outcome: 'stale' });
  });
  it('restarts reserved work after the complete execution boot sweep, once', async () => {
    await boot(harness); const s = scheduler(async phase => { if (phase === 'reserved') throw new Error('crash'); });
    const id = task(s); const a = vi.spyOn(built.registry.adapter(A), 'start');
    await expect(s.runNow(id)).rejects.toThrow('crash');
    await built.orchestrator.reconcileOnBoot();
    expect(built.tasks.get(id)?.state).toBe('ROUTING');
    const recovered = scheduler(); const done = terminal(id); await recovered.reconcileOnBoot(); await done;
    await recovered.reconcileOnBoot(); expect(a).toHaveBeenCalledTimes(1); expect(recovered.dispatches(id)[0]!.phase).toBe('started');
  });
  it('holds an attempted start without a session; only proven fresh Harness absence can repark', async () => {
    await boot(harness); const s = scheduler(async phase => { if (phase === 'start_attempted') throw new Error('crash'); });
    const id = task(s); const a = vi.spyOn(built.registry.adapter(A), 'start');
    await expect(s.runNow(id)).rejects.toThrow('crash');
    await built.orchestrator.reconcileOnBoot(); const recovered = scheduler(); await recovered.reconcileOnBoot();
    expect(built.tasks.get(id)?.state).toBe('ROUTING'); expect(a).not.toHaveBeenCalled();
    instant += 60_001; await recovered.reconcileOnBoot();
    expect(a).not.toHaveBeenCalled();
    if (harness) { expect(recovered.condition(id)).toMatchObject({ generation: 2, autoWakes: 1, reason: 'start_ambiguous' }); }
    else { expect(built.tasks.get(id)?.state).toBe('ROUTING'); expect(recovered.dispatches(id)[0]!.phase).toBe('start_attempted'); }
  });
  it('recovers the run/session committed before the started phase update without replay', async () => {
    await boot(harness); const s = scheduler(async phase => { if (phase === 'session_created') throw new Error('crash'); });
    const id = task(s); const a = vi.spyOn(built.registry.adapter(A), 'start'); const done = terminal(id);
    await expect(s.runNow(id)).rejects.toThrow('crash'); await done;
    await built.orchestrator.reconcileOnBoot(); const recovered = scheduler(); await recovered.reconcileOnBoot();
    expect(a).toHaveBeenCalledTimes(1); expect(recovered.dispatches(id)[0]).toMatchObject({ phase: 'started', session_id: expect.any(String) });
  });
  it('cancel during an in-flight provider start reaches the successor', async () => {
    await boot(harness); const s = scheduler(); const id = task(s, undefined, '[FAKE:APPROVAL]');
    const adapter = built.registry.adapter(A); const original = adapter.start.bind(adapter); const entered = gate(); const release = gate();
    vi.spyOn(adapter, 'start').mockImplementation(async spec => { entered.resolve(); await release.promise; return original(spec); });
    const cancelled = gate(); const originalCancel = adapter.cancel.bind(adapter);
    const cancel = vi.spyOn(adapter, 'cancel').mockImplementation(async handle => { await originalCancel(handle); cancelled.resolve(); }); const wake = s.runNow(id); await entered.promise;
    await s.cancel(id); release.resolve(); await wake;
    await cancelled.promise;
    expect(cancel).toHaveBeenCalled(); expect(built.tasks.get(id)?.state).toBe('CANCELLED');
    if (harness) expect((db.prepare('SELECT cancel_requested FROM runs WHERE task_id = ?').get(id) as { cancel_requested: number }).cancel_requested).toBe(1);
  });
});

it('assistant pins survive replacement, block fallback, and retry with a bounded time wait', async () => {
  await boot(); const s = scheduler(); const id = task(s, A); const originalIntent = built.tasks.get(id)!.intent_json;
  built.cooldowns.penalize(A, 'limit', 'busy'); const b = vi.spyOn(built.registry.adapter(B), 'start');
  await s.runNow(id); expect(s.condition(id)).toMatchObject({ generation: 2, autoWakes: 1 });
  await s.runNow(id); await s.runNow(id);
  expect(built.tasks.get(id)).toMatchObject({ state: 'WAITING_INPUT', pause_kind: 'no_candidate', intent_json: originalIntent });
  expect(b).not.toHaveBeenCalled();
  expect(s.events(id).at(-1)?.payload.autoWakes).toBe(3);
});

it('enforces open-dispatch uniqueness and stores no resolved choices on waits', async () => {
  await boot(); const s = scheduler(async () => { throw new Error('crash'); }); const id = task(s);
  await s.runNow(id).catch(() => {});
  db.prepare("INSERT INTO wait_conditions(task_id,generation,state,kind,not_before,created_by,created_at,auto_wakes,history,consumed_at,consumed_by,reason) SELECT task_id, 2, 'consumed', kind, not_before, created_by, created_at, auto_wakes, history, consumed_at, consumed_by, reason FROM wait_conditions WHERE task_id = ?").run(id);
  expect(() => db.prepare("INSERT INTO dispatches SELECT 'duplicate',task_id,2,origin,checkpoint_id,execution_path,phase,routing_decision_id,session_id,created_at,updated_at,reason FROM dispatches WHERE task_id = ?").run(id)).toThrow(/UNIQUE/);
  const columns = db.prepare('PRAGMA table_info(wait_conditions)').all() as { name: string }[];
  expect(columns.some(c => /^(assistant_id|model|composition)$/.test(c.name))).toBe(false);
});

it.each(['approval_pending','verification_failed','comparison_pending','handoff_requested','dependency_failed'] as const)('never defers %s', async pause => {
  await boot(); expect(canTransition('WAITING_INPUT','WAITING_RESOURCE',pause)).toBe(false);
  const id = built.tasks.create({ goal: 'paused' }).taskId; built.tasks.transition(id,'ROUTING'); built.tasks.transition(id,'WAITING_INPUT',pause);
  expect(() => scheduler().attach(id,{kind:'time',notBefore:now().toISOString()})).toThrow(/operator decision/);
});

it('disabled timer preserves waits and run-now API still uses generation checking', async () => {
  await boot(); config.scheduler = { enabled: false }; const id = task(built.scheduler); const spy = vi.spyOn(built.scheduler, 'wake');
  instant += 5000; await built.scheduler.reconcileOnBoot(); expect(built.tasks.get(id)?.state).toBe('WAITING_RESOURCE');
  const read = await built.app.inject({ method:'GET',url:'/api/tasks',headers:headers() }); expect(read.json()[0]).toMatchObject({ schedulerEnabled: false, wait: { generation: 1 } });
  const stale = await built.app.inject({method:'POST',url:`/api/tasks/${id}/run-now`,headers:headers(),payload:{generation:0}}); expect(stale.statusCode).toBe(409);
  const done = terminal(id); const run = await built.app.inject({method:'POST',url:`/api/tasks/${id}/run-now`,headers:headers(),payload:{generation:1}}); await done;
  expect(run.statusCode).toBe(200); expect(spy).toHaveBeenCalledWith(id,1,'operator');
});

it('creates and replaces waits through the authorized API, rejects deferred kinds and invalid inputs atomically', async () => {
  await boot();
  for (const wait of [{kind:'dependency',notBefore:now().toISOString()},{kind:'time',notBefore:'tomorrow'}]) {
    expect((await built.app.inject({method:'POST',url:'/api/tasks',headers:headers(),payload:{goal:'later',wait}})).statusCode).toBe(400);
  }
  expect(built.tasks.list()).toHaveLength(0);
  const created = await built.app.inject({method:'POST',url:'/api/tasks',headers:headers(),payload:{goal:'later',wait:{kind:'time',notBefore:now().toISOString()}}});
  expect(created.statusCode).toBe(201); expect(created.json().status.state).toBe('WAITING_RESOURCE'); const id = created.json().taskId as string;
  const replaced = await built.app.inject({method:'POST',url:`/api/tasks/${id}/wait`,headers:headers(),payload:{kind:'time',notBefore:now().toISOString()}});
  expect(replaced.json().generation).toBe(2);
  expect((await built.app.inject({method:'POST',url:`/api/tasks/${id}/run-now`,payload:{generation:2}})).statusCode).toBe(401);
});

it('re-arms after a throwing timer wake and evaluates overdue waits on boot', async () => {
  await boot(); vi.useFakeTimers(); const s = scheduler(); const id = task(s); const wake = vi.spyOn(s,'wake').mockRejectedValueOnce(new Error('tick failed'));
  s.startTimer(); instant += 1000; await vi.advanceTimersByTimeAsync(1000); expect(wake).toHaveBeenCalledTimes(1);
  const done = terminal(id); await vi.advanceTimersByTimeAsync(1); await done; expect(wake).toHaveBeenCalledTimes(2); s.stop();
});

it('uses telemetry changed after task creation in the accepted wake explanation', async () => {
  await boot(); const s = scheduler();
  const id = built.tasks.create({ goal: 'review this', profile: 'fastest' }).taskId;
  s.attach(id, { kind:'time', notBefore: now().toISOString() });
  // Real durable telemetry rows, recorded after the wait, not a router stub.
  for (const [assistant, duration] of [[A,9000],[B,1000]] as const) {
    const t = built.tasks.create({ goal:'review earlier work' }).taskId;
    db.prepare("INSERT INTO runs(id,task_id,assistant_id,state,started_at,ended_at) VALUES(?,?,?,'ENDED_OK',?,?)")
      .run(`history-${assistant}`,t,assistant,new Date(Date.now()-duration).toISOString(),new Date().toISOString());
  }
  const done = terminal(id); await s.runNow(id); await done;
  const decision = db.prepare('SELECT explanation FROM routing_decisions WHERE task_id = ?').get(id) as { explanation:string };
  expect(JSON.parse(decision.explanation)).toMatchObject({chosen:B,ruleFired:expect.stringContaining('lowest median run time')});
});

it.each([false,true])('ignores settlement held across scheduler ownership (Harness=%s)', async harness => {
  await boot(harness); const entered = gate(); const release = gate();
  const original = built.checkpoints.create.bind(built.checkpoints);
  vi.spyOn(built.checkpoints,'create').mockImplementation(async (...args) => {
    const cp = await original(...args);
    if (args[2] === 'handoff') { entered.resolve(); await release.promise; }
    return cp;
  });
  const id = built.tasks.create({ goal:'[FAKE:LIMIT]' }).taskId;
  const noticed = gate(); const messages: string[] = [];
  built.bus.subscribe(id,p => { if (p.notice) { messages.push(p.notice.text); if (p.notice.text.includes('stale settlement')) noticed.resolve(); } });
  built.tasks.transition(id,'ROUTING'); await built.orchestrator.startTask(id,A);
  await entered.promise;
  // Construct the K2-adjacent stale callback race without implementing conversion.
  db.prepare("UPDATE tasks SET state = 'WAITING_RESOURCE', envelope = json_set(envelope,'$.status.state','WAITING_RESOURCE') WHERE id = ?").run(id);
  release.resolve(); await noticed.promise;
  expect(built.tasks.get(id)?.state).toBe('WAITING_RESOURCE');
  expect(messages.some(m => m.includes('stale settlement'))).toBe(true);
  expect(db.prepare('SELECT * FROM runs WHERE task_id = ?').all(id)).toHaveLength(1);
});

it('requires explicit operator reconciliation before re-arming an ambiguous legacy start', async () => {
  await boot(); const s = scheduler(async phase => { if (phase === 'start_attempted') throw new Error('crash'); });
  const id = task(s); await s.runNow(id).catch(() => {}); const recovered = scheduler();
  expect(await recovered.runNow(id,1)).toMatchObject({ outcome:'stale',reason:expect.stringContaining('confirmNoLiveOwner') });
  const done = terminal(id); await recovered.runNow(id,1,true); await done;
  expect(recovered.condition(id)).toMatchObject({generation:2,state:'consumed',autoWakes:1});
  expect(recovered.dispatches(id).map(d=>d.phase)).toEqual(['aborted','started']);
});

it('boot evaluates an overdue active condition, and scheduler events are durable and redacted', async () => {
  await boot(); const s = scheduler(); const id = task(s);
  s.attach(id,{kind:'time',notBefore:new Date(instant-1000).toISOString(),reason:'authorization: Bearer sk-abcdefghijklmnopqrstuvwxyz123456'});
  const done = terminal(id); await s.reconcileOnBoot(); await done;
  expect(s.dispatches(id)).toHaveLength(1);
  const events = s.events(id); expect(events.map(e=>e.type)).toContain('dispatch.started');
  expect(JSON.stringify(s.condition(id))).not.toContain('sk-abcdefghijklmnopqrstuvwxyz123456');
  expect(events.every(e=>e.taskId === id && Number.isInteger(e.id))).toBe(true);
});

it('migration 014 backfills intent and conservatively classifies historical pauses', async () => {
  await boot();
  // Exercise the actual migration against a pre-K1 database, rather than
  // checking only a freshly-created schema.
  const { readdirSync, readFileSync } = await import('node:fs');
  const Database = (await import('better-sqlite3')).default;
  const old = new Database(':memory:');
  try {
    const directory = new URL('../src/db/migrations/',import.meta.url);
    for (const name of readdirSync(directory).filter(n=>n.endsWith('.sql') && n < '014_').sort()) old.exec(readFileSync(new URL(name,directory),'utf8'));
    old.prepare("INSERT INTO tasks(id,goal,state,profile,repo_path,envelope,created_at,updated_at) VALUES('old','preserve me','WAITING_INPUT','fastest','/repo',?,'t','t')")
      .run(JSON.stringify({constraints:['keep tests'],repository:{path:'/repo',branch:'task/old'}}));
    old.exec(readFileSync(new URL('014_durable_dispatch.sql',directory),'utf8'));
    const row = old.prepare("SELECT intent_json,pause_kind,state FROM tasks WHERE id = 'old'").get() as {intent_json:string;pause_kind:string;state:string};
    expect(row).toMatchObject({pause_kind:'unknown',state:'WAITING_INPUT'});
    expect(JSON.parse(row.intent_json)).toMatchObject({goal:'preserve me',constraints:['keep tests'],profile:'fastest',repository:{path:'/repo'}});
  } finally { old.close(); }
});

it('the session insertion transaction refuses cancelled dispatches even when called directly', async () => {
  await boot(true);
  const { SessionStore } = await import('../src/modules/harness/session-store.js');
  const s = scheduler(async phase=>{if(phase==='start_attempted')throw new Error('crash');}); const id = task(s);
  await s.runNow(id).catch(()=>{}); const dispatch = s.dispatches(id)[0]!; await s.cancel(id);
  const store = new SessionStore(db);

  expect(()=>store.createSession(dispatch.dispatch_id)).toThrow(/no longer owns/);
  expect(db.prepare('SELECT * FROM runs WHERE task_id = ?').all(id)).toHaveLength(0);
});

it('dispatch ownership blocks alternate starts, handoffs, and parallel mode changes', async () => {
  await boot(); const s = scheduler(async phase=>{if(phase==='reserved')throw new Error('crash');}); const id = task(s);
  expect(()=>built.tasks.transition(id,'ROUTING')).toThrow(/wake/);
  await expect(built.orchestrator.startTask(id,A)).rejects.toThrow(/Scheduler/);
  await s.runNow(id).catch(()=>{});
  await expect(built.orchestrator.handoff(id,B)).rejects.toThrow(/Scheduler/);
  await expect(built.orchestrator.startParallel(id,[A,B],'compare')).rejects.toThrow(/Scheduler/);
  expect(built.tasks.get(id)?.mode).toBe('single');
});

it('reopens the durable database and continues a reserved dispatch with preserved intent', async () => {
  await boot(); const s = scheduler(async phase=>{if(phase==='reserved')throw new Error('crash');}); const id = task(s,A);
  const intent = built.tasks.get(id)!.intent_json; await s.runNow(id).catch(()=>{});
  await built.app.close(); db.close(); db = openDb(config.dbPath); built = buildServer({config,db,now}); built.registry.init(); await built.registry.syncAll();
  const start = vi.spyOn(built.registry.adapter(A),'start'); const done = terminal(id);
  await built.orchestrator.reconcileOnBoot(); await built.scheduler.reconcileOnBoot(); await done;
  expect(built.tasks.get(id)!.intent_json).toBe(intent); expect(start).toHaveBeenCalledTimes(1);
  expect(built.scheduler.dispatches(id)).toHaveLength(1);
});

it('a slow provider start does not block another due task or timer re-arming', async () => {
  await boot(); vi.useFakeTimers(); const s = scheduler(); const slow = task(s,A); const fast = task(s,B);
  const release = gate(); const entered = gate(); const adapter = built.registry.adapter(A); const original = adapter.start.bind(adapter);
  vi.spyOn(adapter,'start').mockImplementation(async spec=>{entered.resolve();await release.promise;return original(spec);});
  const slowDone = terminal(slow); const fastDone = terminal(fast); s.startTimer(); instant += 1000;
  await vi.advanceTimersByTimeAsync(1000); await entered.promise; await fastDone;
  expect(built.tasks.get(slow)?.state).toBe('ROUTING'); expect(s.status().armed).toBe(true);
  release.resolve(); await slowDone; s.stop();
});

it.each([false,true])('normal recovery owns a persisted session/run even if dispatch phase was lost (Harness=%s)', async harness => {
  await boot(harness); const s = scheduler(async phase=>{if(phase==='start_attempted')throw new Error('crash');}); const id = task(s);
  await s.runNow(id).catch(()=>{}); const d = s.dispatches(id)[0]!;
  if (harness) {
    const { SessionStore } = await import('../src/modules/harness/session-store.js');
    const store = new SessionStore(db);

    store.createSession(d.dispatch_id);
  } else {
    db.prepare("INSERT INTO runs(id,task_id,assistant_id,state,started_at,dispatch_id) VALUES('crashed-run',?,?,'STARTING',?,?)").run(id,A,now().toISOString(),d.dispatch_id);
  }
  const start = vi.spyOn(built.registry.adapter(A),'start');
  await built.orchestrator.reconcileOnBoot(); await scheduler().reconcileOnBoot();
  expect(s.dispatches(id)[0]!.phase).toBe('started'); expect(start).not.toHaveBeenCalled();
  expect(['WAITING_INPUT','FAILED']).toContain(built.tasks.get(id)?.state);
});

it.each([false,true])('a dispatched task preserves existing automatic failover behavior (Harness=%s)', async harness => {
  await boot(harness); const s = scheduler(); const id = task(s,undefined,'[FAKE:LIMIT]');
  const done = terminal(id); await s.runNow(id); await done;
  expect(built.tasks.get(id)?.state).toBe('COMPLETED');
  const runs = db.prepare('SELECT assistant_id FROM runs WHERE task_id = ? ORDER BY rowid').all(id);
  expect(runs).toEqual([{assistant_id:A},{assistant_id:B}]);
});

it('scheduler read endpoints expose status and generation without permitting unauthenticated access', async () => {
  await boot(); const id = task(built.scheduler);
  const read = await built.app.inject({method:'GET',url:`/api/tasks/${id}/wait`,headers:headers()});
  expect(read.statusCode).toBe(200); expect(read.json()).toMatchObject({condition:{generation:1,state:'active'},openDispatch:null});
  const status = await built.app.inject({method:'GET',url:'/api/scheduler/status',headers:headers()});
  expect(status.statusCode).toBe(200); expect(status.json()).toMatchObject({enabled:true,armed:false,openDispatches:0});
  expect((await built.app.inject({method:'GET',url:'/api/scheduler/status'})).statusCode).toBe(401);
});

it.each([false,true])('cancel after started keeps the dispatch and reaches its execution owner (Harness=%s)', async harness => {
  await boot(harness); config.policy.approvalMode = 'prompt-on-escalation'; const s = scheduler(); const id = task(s,undefined,'[FAKE:APPROVAL]');
  const awaitingApproval = gate(); built.bus.subscribe(id,p=>{if(p.event?.type==='approval.requested')awaitingApproval.resolve();});
  const cancelled = gate(); const adapter = built.registry.adapter(A); const original = adapter.cancel.bind(adapter);
  vi.spyOn(adapter,'cancel').mockImplementation(async handle=>{await original(handle);cancelled.resolve();});
  await s.runNow(id); await awaitingApproval.promise; expect(s.dispatches(id)[0]!.phase).toBe('started');
  await s.cancel(id); await cancelled.promise;
  expect(built.tasks.get(id)?.state).toBe('CANCELLED'); expect(s.events(id).at(-1)!.type).toBe('wait.cancelled');
  if(harness) expect((db.prepare('SELECT cancel_requested FROM runs WHERE task_id = ?').get(id) as {cancel_requested:number}).cancel_requested).toBe(1);
});

it('rejects an unrelated execution owner alongside an open dispatch', async () => {
  await boot(); const s = scheduler(async phase=>{if(phase==='reserved')throw new Error('crash');}); const id = task(s);
  await s.runNow(id).catch(()=>{});
  db.prepare("INSERT INTO runs(id,task_id,assistant_id,state,started_at) VALUES('unrelated',?,?,'ACTIVE',?)").run(id,A,now().toISOString());
  await expect(built.orchestrator.cancelTask(id)).rejects.toThrow(/mixed live ownership/);
  await expect(built.orchestrator.createCheckpoint(id)).rejects.toThrow(/mixed live ownership/);
  expect(built.tasks.get(id)?.state).toBe('ROUTING');
});

it('continuation uses the specified checkpoint snapshot, independent of trigger and newer checkpoints', async () => {
  await boot(); const id = built.tasks.create({goal:'continue carefully'}).taskId;
  const envelope = built.tasks.envelope(id); envelope.completed = ['anchored progress']; built.tasks.saveEnvelope(envelope);
  const first = await built.checkpoints.create(id,null,'manual');
  envelope.completed = ['newer unrelated progress']; built.tasks.saveEnvelope(envelope); await built.checkpoints.create(id,null,'manual');
  const start = vi.spyOn(built.registry.adapter(A),'start'); built.tasks.transition(id,'ROUTING'); const done = terminal(id);
  await built.orchestrator.startTask(id,A,{trigger:'initial',continuation:{kind:'checkpoint',checkpointId:first.id}}); await done;
  expect(start.mock.calls[0]![0].prompt).toContain('anchored progress');
  expect(start.mock.calls[0]![0].prompt).not.toContain('newer unrelated progress');
});

describe('K4 dependency waits', () => {
  /** Drives a task to a terminal state through the real transition chokepoint. */
  function settle(id: string, to: 'COMPLETED' | 'FAILED' | 'CANCELLED') {
    built.tasks.transition(id, 'ROUTING');
    if (to === 'COMPLETED') built.tasks.transition(id, 'RUNNING');
    built.tasks.transition(id, to);
  }
  function dependent(s: Scheduler, dependsOn: string[], onDependencyFailure?: 'cancel' | 'wake-anyway' | 'wait-input') {
    const t = built.tasks.create({ goal: 'run the reviewer' });
    s.attach(t.taskId, { kind: 'dependency', dependsOn, onDependencyFailure });
    return t.taskId;
  }
  /** The terminal hook defers its wakes to a microtask; let it drain. */
  const drain = () => new Promise<void>(resolve => setTimeout(resolve, 0));

  it('wakes only when every required dependency is terminal', async () => {
    await boot(); const s = scheduler();
    const one = built.tasks.create({ goal: 'implement' }).taskId;
    const two = built.tasks.create({ goal: 'document' }).taskId;
    const id = dependent(s, [one, two]);
    expect(built.tasks.get(id)?.state).toBe('WAITING_RESOURCE');

    settle(one, 'COMPLETED'); await drain();
    expect(built.tasks.get(id)?.state).toBe('WAITING_RESOURCE');
    expect(s.dispatches(id)).toHaveLength(0);
    expect(await s.wake(id, 1, 'timer')).toMatchObject({ outcome: 'stale', reason: /unfinished dependency/ });

    const done = terminal(id); settle(two, 'COMPLETED'); await done;
    expect(built.tasks.get(id)?.state).toBe('COMPLETED');
    expect(s.dispatches(id)).toHaveLength(1);
    expect(s.dispatches(id)[0]).toMatchObject({ origin: 'wake', condition_generation: 1, phase: 'started' });
  });

  it('the terminal event alone wakes the dependant; the timer never has to fire', async () => {
    await boot(); const s = scheduler();
    const dep = built.tasks.create({ goal: 'implement' }).taskId;
    const id = dependent(s, [dep]);
    const tick = vi.spyOn(s, 'tick'); const wake = vi.spyOn(s, 'wake');
    const done = terminal(id); settle(dep, 'COMPLETED'); await done;
    expect(tick).not.toHaveBeenCalled();
    expect(wake).toHaveBeenCalledWith(id, 1, 'event');
    expect(built.tasks.get(id)?.state).toBe('COMPLETED');
  });

  it.each([
    ['wait-input' as const, 'WAITING_INPUT', 'expired'],
    ['cancel' as const, 'CANCELLED', 'cancelled'],
  ])('a failed dependency applies onDependencyFailure=%s', async (policy, state, conditionState) => {
    await boot(); const s = scheduler();
    const dep = built.tasks.create({ goal: 'implement' }).taskId;
    const id = dependent(s, [dep], policy);
    settle(dep, 'FAILED'); await drain();
    expect(built.tasks.get(id)?.state).toBe(state);
    expect(s.condition(id)).toMatchObject({ state: conditionState });
    expect(s.dispatches(id)).toHaveLength(0);
    expect(s.events(id).map(e => e.type)).toContain('dependency.failed');
    if (policy === 'wait-input') expect(built.tasks.get(id)?.pause_kind).toBe('dependency_failed');
  });

  it('onDependencyFailure=wake-anyway dispatches despite the failure', async () => {
    await boot(); const s = scheduler();
    const dep = built.tasks.create({ goal: 'implement' }).taskId;
    const id = dependent(s, [dep], 'wake-anyway');
    const done = terminal(id); settle(dep, 'FAILED'); await done;
    expect(built.tasks.get(id)?.state).toBe('COMPLETED');
    expect(s.dispatches(id)[0]).toMatchObject({ phase: 'started' });
  });

  it('defaults to wait-input so a failure never bypasses a person', async () => {
    await boot(); const s = scheduler();
    const dep = built.tasks.create({ goal: 'implement' }).taskId;
    const id = dependent(s, [dep]);
    expect(s.condition(id)?.onDependencyFailure).toBe('wait-input');
    settle(dep, 'CANCELLED'); await drain();
    expect(built.tasks.get(id)?.state).toBe('WAITING_INPUT');
    expect(built.tasks.get(id)?.pause_kind).toBe('dependency_failed');
  });

  it('rejects self-dependency and a three-task cycle at attach', async () => {
    await boot(); const s = scheduler();
    const a = built.tasks.create({ goal: 'a' }).taskId;
    const b = built.tasks.create({ goal: 'b' }).taskId;
    const c = built.tasks.create({ goal: 'c' }).taskId;
    expect(() => s.attach(a, { kind: 'dependency', dependsOn: [a] })).toThrow(/cannot depend on itself/);
    s.attach(a, { kind: 'dependency', dependsOn: [b] });
    s.attach(b, { kind: 'dependency', dependsOn: [c] });
    expect(() => s.attach(c, { kind: 'dependency', dependsOn: [a] })).toThrow(/cycle/);
    // The rejected attach left no trace: c keeps no condition and stays CREATED.
    expect(s.condition(c)).toBeUndefined();
    expect(built.tasks.get(c)?.state).toBe('CREATED');
  });

  it('treats a dependency deleted after attach as FAILED', async () => {
    await boot(); const s = scheduler();
    const dep = built.tasks.create({ goal: 'implement' }).taskId;
    const id = dependent(s, [dep], 'wait-input');
    db.prepare('DELETE FROM tasks WHERE id = ?').run(dep);
    await s.tick();
    expect(built.tasks.get(id)?.state).toBe('WAITING_INPUT');
    expect(built.tasks.get(id)?.pause_kind).toBe('dependency_failed');
    expect(s.events(id).find(e => e.type === 'dependency.failed')?.payload.failed).toEqual([dep]);
  });

  it('reuses the generation-aware wake: a stale generation and a replaced condition are no-ops', async () => {
    await boot(); const s = scheduler();
    const dep = built.tasks.create({ goal: 'implement' }).taskId;
    const other = built.tasks.create({ goal: 'other' }).taskId;
    const id = dependent(s, [dep]);
    settle(dep, 'COMPLETED');
    // Replacing the condition before the deferred wake runs makes generation 1 stale.
    s.attach(id, { kind: 'dependency', dependsOn: [other] });
    await drain();
    expect(s.condition(id)).toMatchObject({ generation: 2, state: 'active' });
    expect(s.dispatches(id)).toHaveLength(0);
    expect(await s.wake(id, 1, 'timer')).toMatchObject({ outcome: 'stale' });
    const done = terminal(id); settle(other, 'COMPLETED'); await done;
    expect(s.dispatches(id)[0]).toMatchObject({ condition_generation: 2, phase: 'started' });
  });

  it('operator run-now overrides an unmet dependency, as it overrides a time wait', async () => {
    await boot(); const s = scheduler();
    const dep = built.tasks.create({ goal: 'implement' }).taskId;
    const id = dependent(s, [dep]);
    const done = terminal(id); const result = await s.runNow(id); await done;
    expect(result).toMatchObject({ outcome: 'dispatched' });
    expect(s.dispatches(id)[0]).toMatchObject({ origin: 'run-now', phase: 'started' });
    expect(built.tasks.get(dep)?.state).toBe('CREATED');
  });

  it('rejects a malformed dependency wait and keeps quota/time waits unchanged', async () => {
    await boot(); const s = scheduler();
    const id = built.tasks.create({ goal: 'x' }).taskId;
    expect(() => s.attach(id, { kind: 'dependency', dependsOn: [] })).toThrow(/at least one dependency/);
    expect(() => s.attach(id, { kind: 'dependency', dependsOn: ['a'], onDependencyFailure: 'explode' as never })).toThrow(/onDependencyFailure/);
    expect(() => s.attach(id, { kind: 'nonsense' as never, notBefore: now().toISOString() })).toThrow(/time, quota, dependency or resource/);
    s.attach(id, { kind: 'time', notBefore: new Date(instant + 1000).toISOString() });
    expect(s.condition(id)).toMatchObject({ kind: 'time', dependsOn: [] });
  });

  it('a dependency wait never sets the timer deadline, but the capped sweep still evaluates it', async () => {
    await boot(); const s = scheduler();
    const dep = built.tasks.create({ goal: 'implement' }).taskId;
    const id = dependent(s, [dep]);
    // The event hook is the wake path; a bare tick with the dependency unmet
    // must leave the condition exactly as it was.
    await s.tick();
    expect(s.condition(id)).toMatchObject({ generation: 1, state: 'active' });
    built.tasks.transition(dep, 'ROUTING'); built.tasks.transition(dep, 'RUNNING');
    db.prepare("UPDATE tasks SET state = 'COMPLETED' WHERE id = ?").run(dep); // terminal without the event
    const done = terminal(id); await s.tick(); await done;
    expect(built.tasks.get(id)?.state).toBe('COMPLETED');
  });
});
