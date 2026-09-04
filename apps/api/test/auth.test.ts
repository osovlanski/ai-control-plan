import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig, type ResolvedConfig } from "../src/config.js";
import { openDb, type Db } from "../src/db/index.js";
import { buildServer, type BuiltServer } from "../src/server.js";
import { atomicWriteCredential, credentialPath, readCredential, rotateCredential, type CredentialSecret } from "../src/auth/credential-file.js";
import { mintBootstrapToken } from "../src/auth/bootstrap-token.js";

let home:string,config:ResolvedConfig,db:Db,built:BuiltServer; let clock=new Date("2026-09-03T12:00:00.000Z");
beforeEach(()=>{home=mkdtempSync(join(tmpdir(),"acp-auth-"));config=loadConfig({AGENT_PLANE_HOME:home});db=openDb(config.dbPath);const errorCanary=readCredential(credentialPath(config.dir)).secrets.at(-1)!.secret;built=buildServer({config,db,now:()=>clock,registerExtraRoutes:app=>{app.get("/api/test-error",{config:{auth:{require:"tasks.read"}}},()=>{throw new Error(`handler failed with ${errorCanary}`);});}});built.registry.init();});
afterEach(async()=>{await built.app.close();db.close();rmSync(home,{recursive:true,force:true});});
const secret=()=>readCredential(credentialPath(config.dir)).secrets.at(-1)!;
const bearer=(s:CredentialSecret=secret())=>({authorization:`Bearer ${s.secret}`});
function setCaps(capabilities:string[]){const file=readCredential(credentialPath(config.dir));const next={kid:`k_${randomBytes(4).toString("hex")}`,secret:randomBytes(32).toString("base64url"),capabilities,createdAt:clock.toISOString(),notAfter:null};file.secrets.push(next);atomicWriteCredential(credentialPath(config.dir),file);return next;}
const token=(s=secret(),override:Record<string,unknown>={})=>mintBootstrapToken(s,{aud:`http://${config.api.host}:${config.api.port}`,lo:"http://127.0.0.1:9999",cap:s.capabilities,exp:Math.floor(clock.getTime()/1000)+10,...override});
const bootstrap=(t:string,origin="http://127.0.0.1:9999")=>built.app.inject({method:"POST",url:"/api/auth/bootstrap",headers:{origin,"content-type":"application/x-www-form-urlencoded"},payload:new URLSearchParams({token:t}).toString()});

describe("authenticated transport and command authorization",()=>{
  it("1 rejects every representative unauthenticated API request and advertises v2",async()=>{for(const [method,url] of [["GET","/api/meta"],["GET","/api/workspace"],["GET","/api/health"],["POST","/api/tasks"],["GET","/api/tasks/x/events/stream"]] as const)expect((await built.app.inject({method,url})).statusCode).toBe(401);const r=await built.app.inject({method:"GET",url:"/api/meta"});expect(r.headers["x-control-plane-api-version"]).toBe("2.0");expect(r.headers["www-authenticate"]).toBe("Bearer");});
  it("2 read-only reads and cannot write",async()=>{const s=setCaps(["tasks.read"]);expect((await built.app.inject({method:"GET",url:"/api/tasks",headers:bearer(s)})).statusCode).toBe(200);expect((await built.app.inject({method:"POST",url:"/api/tasks",headers:bearer(s),payload:{goal:"x"}})).statusCode).toBe(403);});
  it("3 write-only writes and cannot read",async()=>{const s=setCaps(["commands.write"]);expect((await built.app.inject({method:"POST",url:"/api/tasks",headers:bearer(s),payload:{goal:"x"}})).statusCode).toBe(201);expect((await built.app.inject({method:"GET",url:"/api/tasks",headers:bearer(s)})).statusCode).toBe(403);});
  it("4 full credential accesses both and meta omits workspace",async()=>{expect((await built.app.inject({method:"POST",url:"/api/tasks",headers:bearer(),payload:{goal:"x"}})).statusCode).toBe(201);const r=await built.app.inject({method:"GET",url:"/api/meta",headers:bearer()});expect(r.statusCode).toBe(200);expect(r.json()).not.toHaveProperty("workspace");});
  it("5 exchanges a one-time token for the hardened cookie",async()=>{const r=await bootstrap(token());expect(r.statusCode).toBe(303);expect(r.headers.location).toBe("http://127.0.0.1:4176/");expect(r.headers["set-cookie"]).toMatch(/^__Host-acp_session=.*HttpOnly; Secure; SameSite=Strict; Path=\//);expect(r.headers["set-cookie"]).not.toContain("Domain");expect(r.headers["referrer-policy"]).toBe("no-referrer");expect(r.headers["cache-control"]).toBe("no-store");});
  it("6 rejects replay, including concurrent and restarted servers",async()=>{const t=token();expect((await bootstrap(t)).statusCode).toBe(303);expect((await bootstrap(t)).statusCode).toBe(401);const t2=token();const rs=await Promise.all([bootstrap(t2),bootstrap(t2)]);expect(rs.map(r=>r.statusCode).sort()).toEqual([303,401]);await built.app.close();built=buildServer({config,db,now:()=>clock});expect((await bootstrap(t)).statusCode).toBe(401);});
  it("7 rejects expiry",async()=>expect((await bootstrap(token(secret(),{exp:Math.floor(clock.getTime()/1000)-1}))).statusCode).toBe(401));
  it("8 rejects wrong audience, signature, origin, absent origin and absent token",async()=>{expect((await bootstrap(token(secret(),{aud:"http://bad"}))).statusCode).toBe(401);const t=token();expect((await bootstrap(t.slice(0,-1)+"x")).statusCode).toBe(401);for(const origin of ["http://127.0.0.1:9998","http://127.0.0.1:4176",undefined])expect((await built.app.inject({method:"POST",url:"/api/auth/bootstrap",headers:{...(origin?{origin}:{}),"content-type":"application/x-www-form-urlencoded"},payload:new URLSearchParams({token:t}).toString()})).statusCode).toBe(403);expect((await built.app.inject({method:"POST",url:"/api/auth/bootstrap",headers:{"content-type":"application/x-www-form-urlencoded"},payload:""})).statusCode).toBe(400);});
  it("9 rejects cross-site cookie mutation",async()=>{const r=await bootstrap(token());const cookie=String(r.headers["set-cookie"]).split(";")[0]!;expect((await built.app.inject({method:"POST",url:"/api/tasks",headers:{cookie,origin:"https://evil.example","sec-fetch-site":"cross-site"},payload:{goal:"x"}})).statusCode).toBe(403);});
  it("9b authenticates unknown API paths before returning 404",async()=>{expect((await built.app.inject({method:"GET",url:"/api/does-not-exist"})).statusCode).toBe(401);expect((await built.app.inject({method:"GET",url:"/api/does-not-exist",headers:bearer()})).statusCode).toBe(404);});
  it("9c enforces natural read capabilities",async()=>{const s=setCaps(["sessions.read"]);expect((await built.app.inject({method:"GET",url:"/api/sessions?groupId=x",headers:bearer(s)})).statusCode).toBe(200);expect((await built.app.inject({method:"GET",url:"/api/tasks",headers:bearer(s)})).statusCode).toBe(403);expect((await built.app.inject({method:"GET",url:"/api/tasks/x/routing",headers:bearer(s)})).statusCode).toBe(403);});
  it("10 keeps an old bearer through grace then expires it",async()=>{const a=secret();const b=rotateCredential(credentialPath(config.dir),300,undefined,clock);expect((await built.app.inject({method:"GET",url:"/api/tasks",headers:bearer(b)})).statusCode).toBe(200);expect((await built.app.inject({method:"GET",url:"/api/tasks",headers:bearer(a)})).statusCode).toBe(200);clock=new Date(clock.getTime()+301000);expect((await built.app.inject({method:"GET",url:"/api/tasks",headers:bearer(a)})).statusCode).toBe(401);});
  it("11 expires browser sessions with their minting key",async()=>{const r=await bootstrap(token());const cookie=String(r.headers["set-cookie"]).split(";")[0]!;rotateCredential(credentialPath(config.dir),300,undefined,clock);clock=new Date(clock.getTime()+301000);expect((await built.app.inject({method:"GET",url:"/api/tasks",headers:{cookie,origin:"http://127.0.0.1:4176"}})).statusCode).toBe(401);});
  it("12 redacts exact credential literals before durable storage and responses",async()=>{const canary=secret().secret;const made=await built.app.inject({method:"POST",url:"/api/tasks",headers:bearer(),payload:{goal:`keep ${canary} secret`,constraints:[canary]}});expect(made.body).not.toContain(canary);expect(made.body).toContain("[REDACTED]");const rows=JSON.stringify(db.prepare("SELECT goal,envelope FROM tasks").all());expect(rows).not.toContain(canary);expect(rows).toContain("[REDACTED]");});
  it("12b redacts exact credential literals from SSE frames and uncaught error bodies", async () => {
    const canary = secret().secret;
    const made = await built.app.inject({ method: "POST", url: "/api/tasks", headers: bearer(), payload: { goal: "SSE canary" } });
    const taskId = made.json().taskId as string;
    await built.app.listen({ host: "127.0.0.1", port: 0 });
    const address = built.app.server.address();
    if (!address || typeof address === "string") throw new Error("test server did not bind TCP");
    const controller = new AbortController();
    const response = await fetch(`http://127.0.0.1:${address.port}/api/tasks/${taskId}/events/stream`, {
      headers: bearer(),
      signal: controller.signal,
    });
    built.bus.publish(taskId, {
      kind: "event",
      event: { runId: "run_canary" as never, seq: 1, ts: clock.toISOString(), type: "message", summary: canary, payload: { canary } },
    });
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let frame = "";
    while (!frame.includes("[REDACTED]")) {
      const part = await reader.read();
      if (part.done) break;
      frame += decoder.decode(part.value, { stream: true });
    }
    controller.abort();
    expect(frame).toContain("data:");
    expect(frame).toContain("[REDACTED]");
    expect(frame).not.toContain(canary);

    const failed = await built.app.inject({ method: "GET", url: "/api/test-error", headers: bearer() });
    expect(failed.statusCode).toBe(500);
    expect(failed.body).toContain("[REDACTED]");
    expect(failed.body).not.toContain(canary);
  });
  it("13 serves parallel authenticated requests without spurious failures during rotation",async()=>{const old=secret();const pending=Array.from({length:20},()=>built.app.inject({method:"GET",url:"/api/tasks",headers:bearer(old)}));const next=rotateCredential(credentialPath(config.dir),300,undefined,clock);pending.push(...Array.from({length:20},()=>built.app.inject({method:"GET",url:"/api/tasks",headers:bearer(next)})));expect((await Promise.all(pending)).every(r=>r.statusCode===200)).toBe(true);});
  it("14 rejects a route without explicit auth metadata at startup",()=>{expect(()=>buildServer({config,db,registerExtraRoutes:app=>{app.get("/api/unsafe",()=>({}));}})).toThrow(/must declare config.auth/);});
});
