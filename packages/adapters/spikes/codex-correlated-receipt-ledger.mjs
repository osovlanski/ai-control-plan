/* global process, console, setTimeout, clearTimeout, fetch */
// Real provider + HTTP + SQLite restart. Inputs stay in a private external fixture.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readlinkSync, realpathSync, writeFileSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { CodexAdapter } from '../src/codex.js';
import { CodexSessionInputAdapter } from '../src/codex-session-input.js';
import { codexSdkBinary } from '../src/codex-sdk-binary.js';
import { readCodexThreadHistory } from '../src/codex-app-server-history.js';
import { boot, seedSession } from '../../../apps/api/test/helpers/session-input.js';

if (process.env.LIVE_CODEX_CORRELATION !== '1') throw new Error('Explicit live opt-in required');
if (process.platform !== 'linux') throw new Error('This process-exit witness requires Linux procfs');
const fixture = JSON.parse(readFileSync(process.env.SPIKE_INPUT_PATH, 'utf8'));
const home = mkdtempSync('/tmp/codex-receipt-ledger-');
const workdir = mkdtempSync('/tmp/codex-receipt-work-');
execFileSync('git', ['init', '-q', workdir]);
const agent = new CodexAdapter('codex-a', { appServerInput: true });
const report = { cliVersion: execFileSync(codexSdkBinary(), ['--version'], { encoding: 'utf8' }).trim() };
const events = []; let handle, pump, workspace;
const deadline = setTimeout(() => { if (handle) void agent.cancel(handle); }, 120000);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function requireCheck(value, label) { if (!value) throw new Error(label); }
async function open(adapter) {
  workspace = boot(home, { adapters: id => id === 'codex-a' ? adapter : undefined });
  workspace.built.app.log.level = 'silent';
  return workspace.built.app.listen({ host: '127.0.0.1', port: 0 });
}
async function close() {
  if (!workspace) return;
  await workspace.built.app.close(); workspace.db.close(); workspace=undefined;
}
async function post(base, path, payload) {
  const response = await fetch(base + path, { method: 'POST', headers: { ...workspace.headers, 'content-type': 'application/json' }, body: JSON.stringify(payload) });
  return { status: response.status, body: await response.json() };
}
try {
  handle = await agent.start({ taskId: 'AG-CORRELATION-LIVE', workdir, prompt: fixture.initial, permissionPolicy: { mode: 'auto-approve' }, env: { redactionRules: [], maxRuntimeMs: 110000 } });
  pump = (async () => { for await (const event of agent.events(handle)) events.push(event); })();
  const until = Date.now()+60000;
  while (Date.now()<until && !events.some(e => e.type === 'tool.started' || e.type === 'run.ended')) await sleep(50);
  requireCheck(events.some(e => e.type === 'tool.started') && !events.some(e => e.type === 'run.ended'), 'no_live_tool');
  const binaryPath = realpathSync(codexSdkBinary());
  const childPids = readFileSync(`/proc/${process.pid}/task/${process.pid}/children`, 'utf8').trim().split(/\s+/).filter(Boolean).map(Number);
  const ownerPid = childPids.find(pid => { try { return readlinkSync(`/proc/${pid}/exe`) === binaryPath; } catch { return false; } });
  requireCheck(ownerPid, 'execution_owner_pid_unobserved');
  const adapter = agent.sessionInput;
  let sendCalls = 0;
  const deliver = adapter.deliver.bind(adapter);
  adapter.deliver = async (...args) => { sendCalls++; return deliver(...args); };
  let base = await open(adapter);
  const { sessionId } = seedSession(workspace.db, { assistantId: 'codex-a' });
  workspace.db.prepare('UPDATE runs SET provider_session_ref = ? WHERE id = ?').run(handle.providerSessionRef, sessionId);
  const target = { sessionId, assistantId: 'codex-a', providerSessionRef: handle.providerSessionRef };
  requireCheck((await adapter.enable(target)).available, 'enable_failed');
  const text = fixture.followup+' '+randomUUID();
  const rows = [];
  for (let i=0;i<2;i++) {
    const result = await post(base, `/api/sessions/${sessionId}/inputs`, { clientMessageId: randomUUID(), text });
    requireCheck(result.status===202 && result.body.state==='accepted' && result.body.deliveryUnknown, 'initial_not_unknown');
    rows.push(result.body);
  }
  report.initial = { rowCount: rows.length, allUnknown: rows.every(r=>r.deliveryUnknown), sendCalls, responseFields: Object.keys(rows[0]).sort() };
  await close(); // The real provider keeps running while the plane/database is closed.
  await pump;
  requireCheck(events.some(e=>e.type==='run.ended' && e.payload?.ok===true), 'provider_not_completed');
  let ownerExited = false;
  const exitDeadline = Date.now()+10000;
  while (Date.now()<exitDeadline) {
    try { process.kill(ownerPid, 0); } catch (error) { if (error.code==='ESRCH') { ownerExited=true; break; } throw error; }
    await sleep(50);
  }
  requireCheck(ownerExited, 'provider_process_not_exited');
  let connectionCalls=0, coldSendCalls=0;
  const cold = new CodexSessionInputAdapter('codex-a', () => { connectionCalls++; return undefined; });
  const coldDeliver = cold.deliver.bind(cold);
  cold.deliver = async (...args) => { coldSendCalls++; return coldDeliver(...args); };
  base=await open(cold);
  const receipts=[];
  for (const row of rows) {
    const result=await post(base, `/api/inputs/${row.id}/retry`, {});
    requireCheck(result.body.state==='delivered' && result.body.deliveryUnknown===false, 'cold_lookup_not_delivered');
    requireCheck(result.body.providerReceipt?.messageId===row.id && result.body.providerReceipt?.ackLevel==='provider-accepted', 'receipt_not_correlated');
    requireCheck(workspace.built.sessionInputs.attempts(row.id).length===1, 'unexpected_extra_attempt');
    receipts.push(result.body.providerReceipt);
  }
  const history=await readCodexThreadHistory(handle.providerSessionRef);
  const items=history.turns.flatMap(t=>t.items ?? []).filter(i=>i.type==='userMessage');
  report.recovery={ databaseReopened:true, providerExited:ownerExited, freshAdapterHasGrant:(await cold.probeTarget(target)).available, connectionCalls, coldSendCalls, totalOriginalSends:sendCalls, allDelivered:true, separateProviderReferences:receipts[0].reference!==receipts[1].reference, ackLevels:receipts.map(r=>r.ackLevel), callerIdCounts:rows.map(row=>items.filter(i=>i.clientId===row.id).length), attemptsPerMessage:rows.map(row=>workspace.built.sessionInputs.attempts(row.id).length), receiptFields:Object.keys(receipts[0]).sort() };
  requireCheck(connectionCalls===0 && coldSendCalls===0 && sendCalls===2 && report.recovery.callerIdCounts.every(n=>n===1), 'unexpected_replay');
  report.verdict='PASS';
} catch {
  report.verdict='FAIL'; process.exitCode=1;
} finally {
  clearTimeout(deadline);
  if(handle) await agent.cancel(handle);
  await pump; await close();
  rmSync(home,{recursive:true,force:true}); rmSync(workdir,{recursive:true,force:true});
  writeFileSync(process.env.SPIKE_REPORT_PATH,JSON.stringify(report,null,2)+'\n',{mode:0o600});
  console.log(JSON.stringify(report));
}
