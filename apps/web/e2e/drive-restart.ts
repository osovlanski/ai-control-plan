/** Manual acceptance: run against pnpm dev with dev-fake-preload.mjs and a scratch home. */
import { chromium, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { readFileSync, readdirSync, mkdirSync } from 'node:fs';
import { mintBootstrapToken } from '../../api/src/auth/bootstrap-token.js';
process.chdir(new URL('../../../', import.meta.url).pathname);
const home = process.env.AGENT_PLANE_HOME ?? '/tmp/web-restart-drive';
const origin = process.env.AGENT_PLANE_API_URL ?? 'http://127.0.0.1:4296';
const web = process.env.AGENT_PLANE_WEB_URL ?? 'http://127.0.0.1:5296';
const secret = JSON.parse(readFileSync(`${home}/personal/api-credential.json`, 'utf8')).secrets.at(-1);
async function api(path: string, data?: unknown) {
  const r = await fetch(origin + path, { method: data === undefined ? 'GET' : 'POST', headers: { authorization: `Bearer ${secret.secret}`, 'content-type': 'application/json' }, body: data === undefined ? undefined : JSON.stringify(data) });
  if (!r.ok) throw Error(`${r.status} ${await r.text()}`);
  return r.json();
}
const browser = await chromium.launch({headless:true});
const context = await browser.newContext({viewport:{width:1440,height:1000}});
const server = createServer((_q,r) => { const token = mintBootstrapToken(secret, {aud:origin,lo:launcher,cap:secret.capabilities,exp:Math.floor(Date.now()/1000)+60}); r.setHeader('content-type','text/html'); r.end(`<form method=POST action="${origin}/api/auth/bootstrap"><input name=token value="${token}"></form><script>document.forms[0].submit()</script>`); });
await new Promise<void>(r => server.listen(0,'127.0.0.1',r));
const launcher = `http://127.0.0.1:${(server.address() as {port:number}).port}`;
const page = await context.newPage();
page.setDefaultNavigationTimeout(120_000);
page.setDefaultTimeout(30_000);
await page.goto(launcher); await page.waitForURL(`${origin}/**`,{timeout:90000}); server.close();
const {taskId} = process.env.DRIVE_RECOVER_TASK ? {taskId:process.env.DRIVE_RECOVER_TASK} : await api('/api/tasks',{goal:'Recover the fake run [FAKE:LATE_SESSION] [FAKE:APPROVAL]'});
if (!process.env.DRIVE_RECOVER_TASK) {
await api(`/api/tasks/${taskId}/start`,{assistantId:'fake-a'});
await expect.poll(async()=> (await api(`/api/tasks/${taskId}/sessions`)).find((s:{endedAt:string|null})=>!s.endedAt)?.sessionState,{timeout:30000}).toBe('AWAITING_APPROVAL');
const apiPid = readdirSync('/proc').filter(p=>/^\d+$/.test(p)).find(p=>{try {return readFileSync(`/proc/${p}/environ`,'utf8').includes(`AGENT_PLANE_HOME=${home}\0`) && readFileSync(`/proc/${p}/cmdline`,'utf8').includes('preflight.cjs') && readFileSync(`/proc/${p}/cmdline`,'utf8').endsWith('src/index.ts\0');}catch{return false;}});
if (!apiPid) throw Error('API child PID not found');
process.kill(Number(apiPid),'SIGKILL');
console.log(`kill -9 API child ${apiPid}; task ${taskId}`);
await new Promise(r=>setTimeout(r,1000));
console.log('Restart the scratch pnpm dev process; waiting for recovery.');
}
await expect.poll(async()=>{try{return ['WAITING_INPUT','AWAITING_APPROVAL','RUNNING','COMPLETED'].includes((await api(`/api/tasks/${taskId}`)).state);}catch{return false;}},{timeout:180000}).toBe(true);
await page.goto(`${web}/#/missions/${taskId}`);
const detail = page.locator('.task-detail');
mkdirSync('docs/demo/assets/restart-cost-basis',{recursive:true});
if ((await api(`/api/tasks/${taskId}`)).state === 'WAITING_INPUT') {
await detail.getByRole('button',{name:'Restart',exact:true}).click();
await page.screenshot({path:'docs/demo/assets/restart-cost-basis/restart-confirmation.png'});
await detail.getByRole('button',{name:'Confirm restart',exact:true}).click();
}
if ((await api(`/api/tasks/${taskId}`)).state !== 'COMPLETED') {
await expect.poll(async()=> (await api(`/api/tasks/${taskId}/sessions`)).find((s:{endedAt:string|null})=>!s.endedAt)?.sessionState,{timeout:30000}).toBe('AWAITING_APPROVAL');
const sessions=await api(`/api/tasks/${taskId}/sessions`);
const live=sessions.find((s:{endedAt:string|null})=>!s.endedAt);
const session=await api(`/api/sessions/${live.sessionId}`);
await api(`/api/tasks/${taskId}/input`,{kind:'approval',requestId:session.approvals.find((a:{state:string})=>a.state==='pending').providerRequestId,approved:true});
}
await expect.poll(async()=> (await api(`/api/tasks/${taskId}`)).state,{timeout:30000}).toBe('COMPLETED');
await page.reload();
await expect(detail.getByText('COMPLETED',{exact:true}).first()).toBeVisible({timeout:30_000});
await page.screenshot({path:'docs/demo/assets/restart-cost-basis/restart-completed.png'});
await detail.getByRole('button',{name:'Composition',exact:true}).click();
const budget=await api(`/api/tasks/${taskId}/composition/budget`);
if (!budget.runs.some((r:{cost:{method:string;basis?:string}})=>r.cost.method==='measured'&&r.cost.basis==='in_run')) throw Error('No measured in_run cost');
await expect(detail.getByText('in_run',{exact:true}).first()).toBeVisible({timeout:30_000});
await page.screenshot({path:'docs/demo/assets/restart-cost-basis/measured-in-run.png',fullPage:true});
console.log(JSON.stringify({taskId,state:'COMPLETED',costs:budget.runs.map((r:{cost:unknown})=>r.cost)}));
await browser.close();
