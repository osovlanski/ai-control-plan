/* global process, console, setTimeout, clearTimeout, WebSocket */
// Manual experiment. Never serialize RPC bodies, input text, identifiers, or diagnostics.
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { CodexAppServerProtocol } from '../src/codex-app-server-protocol.js';
import { codexSdkBinary } from '../src/codex-app-server-runtime.js';

if (process.env.LIVE_CODEX_CORRELATION !== '1') throw new Error('Explicit live opt-in required');
const fixture = JSON.parse(readFileSync(process.env.SPIKE_INPUT_PATH, 'utf8'));
const cli = codexSdkBinary();
const report = { cliVersion: execFileSync(cli, ['--version'], { encoding: 'utf8' }).trim(), transport: 'websocket', cases: [] };
const workdir = mkdtempSync('/tmp/codex-correlation-');
execFileSync('git', ['init', '-q', workdir]);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const active = new Set();
const clients = new Set();
const keys = value => Object.keys(value ?? {}).sort();
const textOf = item => (item.content ?? []).filter(c => c.type === 'text').map(c => c.text).join('\n');
function summarize(items, id, text) {
  const matches = items.filter(item => item.type === 'userMessage' && textOf(item).includes(text));
  return {
    itemFields: [...new Set(matches.flatMap(keys))].sort(),
    callerIdPresent: matches.some(item => item.clientId === id || item.id === id),
    clientIdPresent: matches.some(item => item.clientId === id),
    providerItemIdPresent: matches.some(item => typeof item.id === 'string' && item.id !== id),
    providerItemIdEqualsCallerId: matches.some(item => item.id === id),
    matchingItemCount: matches.length,
    callerCorrelatedItemCount: matches.filter(item => item.clientId === id).length,
    distinctClientIdCount: new Set(matches.map(item => item.clientId).filter(Boolean)).size,
    duplicateEffectCount: matches.reduce((n, item) => n + textOf(item).split(text).length - 1, 0),
  };
}
async function until(check, label, ms = 90000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const result = check(); if (result) return result; await sleep(50); }
  throw new Error(label);
}
async function owner(transport = 'websocket') {
  if (transport === 'stdio') {
    const child = spawn(cli, ['app-server', '--listen', 'stdio://'], { cwd: workdir, stdio: ['pipe', 'pipe', 'pipe'] });
    child.stderr.resume(); active.add(child); child.on('exit', () => active.delete(child));
    const events = [];
    const rpc = new CodexAppServerProtocol(child.stdin, child.stdout, frame => { if (frame.method) events.push(frame); }, 15000);
    child.on('exit', () => rpc.disconnect());
    await rpc.initialize();
    return { child, transport, events, client: { events, request: rpc.request.bind(rpc), close: () => rpc.disconnect() } };
  }
  const socket = createServer(); socket.listen(0, '127.0.0.1'); await once(socket, 'listening');
  const port = socket.address().port; await new Promise(resolve => socket.close(resolve));
  const child = spawn(cli, ['app-server', '--listen', `ws://127.0.0.1:${port}`], { cwd: workdir, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.resume(); child.stderr.resume(); active.add(child);
  child.on('exit', () => active.delete(child));
  const server = { child, transport, events: [], url: `ws://127.0.0.1:${port}` };
  for (let attempt = 0; attempt < 100; attempt++) {
    try { server.client = await connect(server); return server; } catch { await sleep(100); }
  }
  throw new Error('server_connect_timeout');
}
async function stop(server) {
  server.client?.close();
  if (server.child.exitCode === null && server.child.signalCode === null) {
    const exited = once(server.child, 'exit'); server.child.kill('SIGKILL'); await exited;
  }
}
async function connect(server) {
  const ws = new WebSocket(server.url); const pending = new Map(); const events = []; let next = 0;
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = () => reject(new Error('socket_connect')); });
  const client = {
    events,
    close() { ws.close(); clients.delete(client); },
    request(method, params, boundary) {
      const id = ++next;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(new Error('rpc_timeout')); }, 15000);
        pending.set(id, { resolve, reject, timer, boundary });
        ws.send(JSON.stringify({ id, method, params }));
        if (boundary === 'before-response') {
          clearTimeout(timer); pending.delete(id); client.close();
          resolve({ withheld: true, providerResponseObserved: false });
        }
      });
    },
  };
  clients.add(client);
  ws.onmessage = event => {
    const frame = JSON.parse(String(event.data));
    if (frame.method) {
      if (frame.id !== undefined) ws.send(JSON.stringify({ id: frame.id, error: { code: -32601, message: 'Unsupported in experiment' } }));
      events.push(frame); server.events.push(frame); return;
    }
    const p = pending.get(frame.id); if (!p) return;
    clearTimeout(p.timer); pending.delete(frame.id);
    if (p.boundary === 'after-provider-response') {
      client.close(); p.resolve({ withheld: true, providerResponseObserved: true, providerRpcSucceeded: !frame.error, responseFields: keys(frame.result), errorFields: keys(frame.error) });
    } else p.resolve(frame);
  };
  ws.onclose = () => { for (const p of pending.values()) { clearTimeout(p.timer); p.reject(new Error('disconnected')); } pending.clear(); };
  const init = await client.request('initialize', { clientInfo: { name: 'correlation_spike', version: '1' } });
  if (init.error) throw new Error('initialize_rejected');
  ws.send(JSON.stringify({ method: 'initialized', params: {} }));
  return client;
}
async function reconnect(server, threadId) {
  server.client.close();
  server.client = await connect(server);
  const response = await server.client.request('thread/resume', { threadId });
  if (response.error) throw new Error('thread_open_rejected');
  return response.result.thread;
}
async function start(server, threadId) {
  const c = server.client;
  const response = await c.request(threadId ? 'thread/resume' : 'thread/start', { ...(threadId ? { threadId } : {}), cwd: workdir, approvalPolicy: 'never', sandbox: 'workspace-write' });
  if (response.error) throw new Error('thread_open_rejected');
  threadId = response.result.thread.id;
  const from = c.events.length;
  const turn = await c.request('turn/start', { threadId, input: [{ type: 'text', text: fixture.initial }] });
  if (turn.error) throw new Error('turn_start_rejected');
  const turnId = turn.result.turn.id;
  await until(() => c.events.slice(from).some(e => e.method === 'item/started' && e.params?.threadId === threadId && e.params?.item?.type === 'commandExecution'), 'active_tool_not_observed');
  return { threadId, turnId, from };
}
async function finish(server, target, interrupt = false) {
  if (interrupt) await server.client.request('turn/interrupt', { threadId: target.threadId, turnId: target.turnId });
  // A reconnect may miss a notification; a provider-authored terminal history
  // status is also observable, provided the provider says the thread is idle.
  const deadline = Date.now() + 90000;
  while (Date.now() < deadline) {
    const event = server.events.find(e => e.method === 'turn/completed' && e.params?.turn?.id === target.turnId);
    if (event) return event.params.turn.status;
    const response = await server.client.request('thread/read', { threadId: target.threadId, includeTurns: true });
    const thread = response.result?.thread;
    const turn = thread?.turns?.find(t => t.id === target.turnId);
    if (thread?.status?.type === 'idle' && turn && ['completed','interrupted','failed'].includes(turn.status)) return turn.status;
    await sleep(250);
  }
  throw new Error('turn_not_terminal');
}
async function read(server, threadId) {
  const frame = await server.client.request('thread/read', { threadId, includeTurns: true });
  if (frame.error) throw new Error('history_read_rejected');
  return (frame.result.thread.turns ?? []).flatMap(t => t.items ?? []);
}
function entry(name, id = 'msg_' + randomUUID(), text = fixture.followup + ' ' + randomUUID()) {
  return { name, id, text, attempts: [] };
}
async function send(server, target, item, boundary, wrongTurn = false) {
  const params = { threadId: target.threadId, expectedTurnId: wrongTurn ? randomUUID() : target.turnId, input: [{ type: 'text', text: item.text }], clientUserMessageId: item.id };
  if (item.omitCaller) delete params.clientUserMessageId;
  const turnActiveBeforeRequest = !server.events.some(e => e.method === 'turn/completed' && e.params?.turn?.id === target.turnId);
  const frame = await server.client.request('turn/steer', params, boundary);
  item.attempts.push({ turnActiveBeforeRequest, requestFields: keys(params), inputFields: keys(params.input[0]), responseFields: frame.responseFields ?? keys(frame.result), errorFields: frame.errorFields ?? keys(frame.error), rejected: !!frame.error, errorCode: frame.error?.code ?? null, callerReceivedResponse: !frame.withheld, providerResponseObserved: frame.providerResponseObserved ?? true, providerRpcSucceeded: frame.providerRpcSucceeded ?? (frame.withheld ? null : !frame.error), timingBoundary: boundary ?? 'response-received', callerIdInResponse: JSON.stringify(frame.result ?? {}).includes(item.id) });
  if ((!wrongTurn && (frame.error || frame.providerRpcSucceeded === false)) || (wrongTurn && !frame.error)) {
    report.failedAttempt = item.attempts.at(-1); throw new Error('unexpected_steer_result');
  }
}
async function capture(server, target, items, status, restart = true) {
  const live = await read(server, target.threadId);
  const events = [...new Map(server.events.filter(e => e.method === 'item/completed' && e.params?.threadId === target.threadId).map(e => e.params?.item).filter(Boolean).map(i => [i.id, i])).values()];
  let fresh = [];
  if (restart) { await stop(server); server = await owner(server.transport); fresh = await read(server, target.threadId); }
  for (const item of items) {
    const current = summarize(live, item.id, item.text); const durable = summarize(fresh, item.id, item.text);
    report.cases.push({ name: item.name, transport: server.transport, cliVersion: report.cliVersion, attempts: item.attempts, terminalStatus: status, liveNotification: summarize(events, item.id, item.text), liveHistory: current, freshProcessHistory: durable, callerCorrelationDurableAfterRestart: durable.callerIdPresent, providerItemIdStableAfterRestart: current.matchingItemCount > 0 ? live.filter(i => i.type === 'userMessage' && textOf(i).includes(item.text)).every(i => fresh.some(j => j.id === i.id)) : null, duplicateEffectCount: durable.duplicateEffectCount });
  }
  writeFileSync(process.env.SPIKE_REPORT_PATH, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  return server;
}
try {
  let s = await owner(); let t = await start(s);
  const unique = entry('unique-id-unique-text');
  const a = entry('same-text-distinct-id-a'); const b = entry('same-text-distinct-id-b', randomUUID(), a.text);
  const dup = entry('duplicate-id-concurrent-live-turn'); const seq = entry('duplicate-id-after-rpc-response');
  const recon = entry('duplicate-id-after-disconnect-reconnect'); const wrong = entry('wrong-expected-turn-id');
  await send(s,t,unique); await send(s,t,a); await send(s,t,b);
  await Promise.all([send(s,t,dup),send(s,t,dup)]);
  await send(s,t,seq); await send(s,t,seq);
  await send(s,t,recon); await reconnect(s,t.threadId); await send(s,t,recon);
  await send(s,t,wrong,undefined,true);
  let status = await finish(s,t);
  s = await capture(s,t,[unique,a,b,dup,seq,recon,wrong],status);
  // Reuse the exact logical id/text after provider restart, in a new active turn.
  t = await start(s,t.threadId); const restarted = entry('duplicate-id-after-provider-restart',unique.id,unique.text);
  await send(s,t,restarted); status=await finish(s,t); s=await capture(s,t,[restarted],status);
  // Same caller id after the model response, without restarting the provider.
  t=await start(s); const complete=entry('duplicate-id-after-completed-response'); await send(s,t,complete); await finish(s,t);
  t=await start(s,t.threadId); await send(s,t,complete); status=await finish(s,t); s=await capture(s,t,[complete],status);
  for (const boundary of ['before-response','after-provider-response']) {
    t=await start(s); const item=entry('disconnect-'+boundary); await send(s,t,item,boundary);
    await reconnect(s,t.threadId); status=await finish(s,t); s=await capture(s,t,[item],status);
  }
  t=await start(s); const interrupted=entry('interrupted-turn-after-steer-response'); await send(s,t,interrupted);
  status=await finish(s,t,true); s=await capture(s,t,[interrupted],status);
  t=await start(s); const folded=entry('interrupted-turn-after-durable-fold'); await send(s,t,folded);
  await until(() => s.events.some(e => e.method === 'item/completed' && e.params?.item?.type === 'userMessage' && e.params.item.clientId === folded.id), 'fold_not_observed');
  status=await finish(s,t,true); s=await capture(s,t,[folded],status);
  t=await start(s); const uncorrelated=entry('provider-id-without-caller-id-control'); uncorrelated.omitCaller=true; await send(s,t,uncorrelated);
  status=await finish(s,t); s=await capture(s,t,[uncorrelated],status);
  t=await start(s); const crash=entry('provider-crash-after-acceptance-before-caller-response'); await send(s,t,crash,'after-provider-response');
  await stop(s); s=await owner(); const before=await read(s,t.threadId);
  // Do not replay this ambiguous send: report only what the fresh provider knows.
  report.cases.push({name:crash.name,cliVersion:report.cliVersion,attempts:crash.attempts,timingBoundary:'SIGKILL-after-provider-response-before-fold',freshProcessHistory:summarize(before,crash.id,crash.text),callerCorrelationDurableAfterRestart:summarize(before,crash.id,crash.text).callerIdPresent,duplicateEffectCount:summarize(before,crash.id,crash.text).duplicateEffectCount});
  await stop(s);
  s=await owner('stdio'); t=await start(s); const stdio=entry('stdio-unique-id-durable-history');
  await send(s,t,stdio); status=await finish(s,t); s=await capture(s,t,[stdio],status); await stop(s);
  report.verdict='MATRIX_COMPLETED';
} catch (error) {
  report.verdict='BLOCKED';
  // Only our fixed diagnostic labels are allowed, never a raw provider/socket error.
  const allowed=['server_connect_timeout','socket_connect','rpc_timeout','disconnected','initialize_rejected','thread_open_rejected','turn_start_rejected','active_tool_not_observed','turn_not_terminal','history_read_rejected','unexpected_steer_result','fold_not_observed'];
  report.failure=allowed.includes(error.message)?error.message:'unclassified_harness_failure';
  process.exitCode=1;
} finally {
  for (const c of clients) c.close();
  for (const p of active) p.kill('SIGKILL');
  writeFileSync(process.env.SPIKE_REPORT_PATH,JSON.stringify(report,null,2)+'\n',{mode:0o600});
  console.log(JSON.stringify({verdict:report.verdict,cases:report.cases.length,failure:report.failure}));
}
