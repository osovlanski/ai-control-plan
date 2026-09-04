import { test, expect, request, type BrowserContext } from "@playwright/test";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../../api/src/config.js";
import { openDb, type Db } from "../../api/src/db/index.js";
import { buildServer, type BuiltServer } from "../../api/src/server.js";
import { credentialPath, readCredential, rotateCredential } from "../../api/src/auth/credential-file.js";
import { mintBootstrapToken } from "../../api/src/auth/bootstrap-token.js";

let home:string,db:Db,built:BuiltServer;let clock=new Date("2026-09-03T12:00:00Z");const apiOrigin="http://127.0.0.1:4176";
test.beforeAll(async()=>{home=mkdtempSync(join(tmpdir(),"acp-e2e-"));const config=loadConfig({AGENT_PLANE_HOME:home});db=openDb(config.dbPath);built=buildServer({config,db,now:()=>clock});built.registry.init();await built.app.listen({host:"127.0.0.1",port:4176});});
test.afterAll(async()=>{await built.app.close();db.close();rmSync(home,{recursive:true,force:true});});
const current=()=>readCredential(credentialPath(loadConfig({AGENT_PLANE_HOME:home}).dir)).secrets.at(-1)!;
const bearer=()=>({Authorization:`Bearer ${current().secret}`});
async function launcher():Promise<{url:string;token:string;server:Server}>{let served=false;let token="";const server=createServer((_,res)=>{if(served){res.writeHead(410).end();return;}served=true;res.setHeader("content-type","text/html");res.end(`<form method=POST action="${apiOrigin}/api/auth/bootstrap"><input name=token value="${token}"></form><script>document.forms[0].submit()</script>`);server.close();});await new Promise<void>(r=>server.listen(0,"127.0.0.1",r));const addr=server.address() as {port:number};const url=`http://127.0.0.1:${addr.port}`;token=mintBootstrapToken(current(),{aud:apiOrigin,lo:url,cap:current().capabilities,exp:Math.floor(clock.getTime()/1000)+10});return{url,token,server};}
async function authenticate(context:BrowserContext){const l=await launcher();const page=await context.newPage();await page.goto(l.url);await expect(page.getByText("Agent Control Plane")).toBeVisible();return{page,token:l.token,origin:l.url};}

test("a launcher bootstrap loads the SPA, authenticates fetch, and sends an SSE frame",async({context})=>{const {page}=await authenticate(context);expect(await page.evaluate(()=>fetch("/api/workspace").then(r=>r.status))).toBe(200);const client=await request.newContext({baseURL:apiOrigin,extraHTTPHeaders:bearer()});const made=await client.post("/api/tasks",{data:{goal:"e2e stream"}});const id=(await made.json()).taskId;expect(await page.evaluate(id=>new Promise<string>(resolve=>{const es=new EventSource(`/api/tasks/${id}/events/stream`,{withCredentials:true});es.onmessage=e=>{es.close();resolve(e.data)};}),id)).toContain("state");await client.dispose();});
test("b the HttpOnly session cookie is invisible to JavaScript",async({context})=>{const {page}=await authenticate(context);expect(await page.evaluate(()=>document.cookie)).not.toContain("__Host-acp_session");});
test("c foreign-origin bootstrap and cookie mutation are rejected",async({context})=>{await authenticate(context);const l=await launcher();l.server.close();const cookie=(await context.cookies()).find(c=>c.name==="__Host-acp_session")!;const client=await request.newContext({baseURL:apiOrigin,extraHTTPHeaders:{Origin:"https://evil.example","Sec-Fetch-Site":"cross-site",Cookie:`${cookie.name}=${cookie.value}`}});expect((await client.post("/api/auth/bootstrap",{form:{token:l.token}})).status()).toBe(403);expect((await client.post("/api/tasks",{data:{goal:"evil"}})).status()).toBe(403);await client.dispose();});
test("d a consumed bootstrap token cannot be replayed",async({context})=>{const {token,origin}=await authenticate(context);const client=await request.newContext({baseURL:apiOrigin,extraHTTPHeaders:{Origin:origin}});expect((await client.post("/api/auth/bootstrap",{form:{token}})).status()).toBe(401);await client.dispose();});
test("e rotation past grace transitions the open SPA to expired",async({context})=>{const {page}=await authenticate(context);const config=loadConfig({AGENT_PLANE_HOME:home});rotateCredential(credentialPath(config.dir),300,undefined,clock);clock=new Date(clock.getTime()+301000);await page.reload();await expect(page.getByText(/Session expired/)).toBeVisible();});
test("f bearer remains valid through grace and the new bearer works",async()=>{const config=loadConfig({AGENT_PLANE_HOME:home});const old=current();const next=rotateCredential(credentialPath(config.dir),300,undefined,clock);const client=await request.newContext({baseURL:apiOrigin});expect((await client.get("/api/tasks",{headers:{Authorization:`Bearer ${next.secret}`}})).status()).toBe(200);expect((await client.get("/api/tasks",{headers:{Authorization:`Bearer ${old.secret}`}})).status()).toBe(200);await client.dispose();});
