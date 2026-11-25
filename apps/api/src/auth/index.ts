import { randomBytes, timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { AUTOPILOT_OPERATE_CAPABILITY, CONTROL_PLANE_API_VERSION, capabilityGranted, redactSecrets, registerSecret } from "@agent-plane/core";
import { matchOperateSecret, operateSecretPath } from "./operate-secret.js";
import type { ResolvedConfig } from "../config.js";
import type { Db } from "../db/index.js";
import type { CredentialStore } from "./credential-file.js";
import { parseBootstrapToken, verifyBootstrapSignature } from "./bootstrap-token.js";
import { REMOTE_SESSION_RULE, isRemoteRequest, registerRemoteAuth } from "./remote/index.js";
import { isApiRequest, isOriginForm } from "./request-target.js";

// `listener` scopes a route to one listener (B2, D-B): the other answers 404 before any auth.
declare module "fastify" { interface FastifyContextConfig { auth?: null|{require:string}; listener?: "local"|"remote" } interface FastifyRequest { cred?: AuthenticatedCredential } }
/** The only routes that may declare `auth: null`; the remote two are registered only with `api.remote`. */
const PUBLIC_ROUTES = new Set(["POST /api/auth/bootstrap", "GET /api/auth/login", "GET /api/auth/callback"]);
export interface Session { kid:string; capabilities:string[]; expiresAt:number }
export type SessionMap=Map<string,Session>;
export interface AuthenticatedCredential { kind:"bearer"|"cookie"|"remote"; capabilities:string[]; kid:string }

export function registerAuth(app:FastifyInstance, deps:{config:ResolvedConfig;credentials:CredentialStore;sessions:SessionMap;db:Db;now:()=>Date}):void{
  const {config,credentials,sessions,db,now}=deps; const origin=`http://${config.api.host}:${config.api.port}`;
  app.addContentTypeParser("application/x-www-form-urlencoded",{parseAs:"string"},(_req,body,done)=>{try{done(null,Object.fromEntries(new URLSearchParams(body as string)))}catch(e){done(e as Error)}});
  app.addHook("onRoute", route=>{ const path=String(route.url); if(path.startsWith("/api/") && route.config?.auth===undefined) throw new Error(`Route ${String(route.method)} ${path} must declare config.auth`); const methods=Array.isArray(route.method)?route.method.map(String):[String(route.method)]; if(route.config?.auth===null && !methods.every(m=>PUBLIC_ROUTES.has(`${m==="HEAD"?"GET":m} ${path}`))) throw new Error(`Only ${[...PUBLIC_ROUTES].join(", ")} may use config.auth=null`); });
  // B2: the remote listener's gate. Undefined without `api.remote`, and then no request is ever remote.
  // Every boot revokes remote sessions a previous process minted, whether or not remote mode is still configured.
  const remote=registerRemoteAuth(app,{config,db,now}); if(!remote) db.prepare("UPDATE remote_sessions SET revoked_at = ?, revoked_reason = 'restart' WHERE revoked_at IS NULL").run(now().getTime());
  app.addHook("onRequest",async(req,reply)=>{
    // C1: absolute-form (`GET http://host/api/x`) and `*` targets are refused on both listeners before anything else.
    if(!isOriginForm(req.raw.url)) return reply.code(400).send({error:"bad request target"});
    if(isRemoteRequest(req.raw)) return remote ? remote.onRequest(req,reply) : reply.code(404).send({error:"not found"});
    // C1: the matched route decides, not the raw target (`/%61pi/tasks` routes to `/api/tasks`).
    if(!isApiRequest(req)) return; if(req.routeOptions.config?.listener==="remote") return reply.code(404).send({error:"not found"}); const rule=req.routeOptions.config?.auth; if(rule===null) return;
    const cred=await authenticate(req,credentials,sessions,now,operateSecretPath(config.dir));
    if(!cred){ reply.header("X-Control-Plane-Api-Version",CONTROL_PLANE_API_VERSION).header("WWW-Authenticate","Bearer"); return reply.code(401).send({error:"unauthenticated"}); }
    if(rule===undefined) return;
    // 2.14: `commands.write` implies `tasks.create` and `tasks.start`.
    if(rule.require!==REMOTE_SESSION_RULE&&!capabilityGranted(cred.capabilities,rule.require)) return reply.code(403).send({error:`${rule.require} required`});
    if(cred.kind==="cookie"){const site=req.headers["sec-fetch-site"]; const o=req.headers.origin; if(!(site==="same-origin"||site==="none"||o===origin)) return reply.code(403).send({error:"cross-origin"});}
    req.cred=cred;
  });
  // C1 fail-closed backstop: whatever a gate missed, a route that declares a rule never runs without a
  // credential, and a listener-scoped route never runs on the other listener.
  app.addHook("preHandler",async(req,reply)=>{
    const cfg=req.routeOptions.config; const remoteReq=isRemoteRequest(req.raw);
    if((cfg?.listener==="local"&&remoteReq)||(cfg?.listener==="remote"&&!remoteReq)) return reply.code(404).send({error:"not found"});
    if(cfg?.auth&&!req.cred){ req.log.error({event:"auth",action:"backstop",route:req.routeOptions.url},"route with an auth rule reached its handler without a credential"); reply.header("X-Control-Plane-Api-Version",CONTROL_PLANE_API_VERSION); return reply.code(401).send({error:"unauthenticated"}); }
  });
  app.post<{Body:{token?:string}}>("/api/auth/bootstrap",{config:{auth:null,listener:"local"}},async(req,reply)=>{
    const token=req.body?.token; if(!token) return reply.code(400).send({error:"bootstrap rejected"}); registerSecret(token); const parsed=parseBootstrapToken(token); if(!parsed) return reply.code(400).send({error:"bootstrap rejected"});
    if(req.headers.origin!==parsed.payload.lo || req.headers["sec-fetch-site"]==="cross-site") return reply.code(403).send({error:"bootstrap rejected"});
    if(parsed.payload.aud!==origin || parsed.payload.exp<=Math.floor(now().getTime()/1000)) return reply.code(401).send({error:"bootstrap rejected"});
    let secret=credentials.mainByKid(parsed.payload.kid); if(!secret){await credentials.reloadOnMiss();secret=credentials.mainByKid(parsed.payload.kid);} if(!secret||!verifyBootstrapSignature(parsed,secret)) return reply.code(401).send({error:"bootstrap rejected"});
    try { db.prepare("INSERT INTO bootstrap_jti (jti, expires_at) VALUES (?, ?)").run(parsed.payload.jti,parsed.payload.exp); } catch(e){ if((e as {code?:string}).code?.startsWith("SQLITE_CONSTRAINT")) return reply.code(401).send({error:"bootstrap rejected"}); throw e; }
    const sid=randomBytes(32).toString("base64url");registerSecret(sid);sessions.set(sid,{kid:secret.kid,capabilities:parsed.payload.cap.filter(c=>secret!.capabilities.includes(c)),expiresAt:now().getTime()+config.api.auth.sessionTtlSeconds*1000});
    return reply.code(303).header("location",`${origin}/`).header("set-cookie",`__Host-acp_session=${sid}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${config.api.auth.sessionTtlSeconds}`).header("referrer-policy","no-referrer").header("cache-control","no-store").send();
  });
  // B2: which side the browser is on. The local answer carries no secret; the remote one carries the CSRF token.
  app.get("/api/auth/session",{config:{auth:{require:REMOTE_SESSION_RULE}}},async(req,reply)=>{ if(isRemoteRequest(req.raw)&&remote) return remote.describe(req,reply); return reply.header("cache-control","no-store").send({mode:"local"}); });
  const sweep=setInterval(()=>db.prepare("DELETE FROM bootstrap_jti WHERE expires_at <= ?").run(Math.floor(now().getTime()/1000)),60_000); sweep.unref(); app.addHook("onClose",()=>clearInterval(sweep));
}
async function authenticate(req:FastifyRequest,store:CredentialStore,sessions:SessionMap,now:()=>Date,operatePath:string):Promise<AuthenticatedCredential|null>{
  const auth=req.headers.authorization; if(auth?.startsWith("Bearer ")){const raw=auth.slice(7); let match=findSecret(raw,store);
    // P0-A2: the operator secret is matched by hash and carries exactly one capability. It is
    // checked before the reload, so presenting it never costs the credential file a re-read.
    if(!match){const kid=matchOperateSecret(operatePath,raw); if(kid){registerSecret(raw); return {kind:"bearer",capabilities:[AUTOPILOT_OPERATE_CAPABILITY],kid};}}
    if(!match){await store.reloadOnMiss();match=findSecret(raw,store);} return match?{kind:"bearer",capabilities:match.capabilities,kid:match.kid}:null;}
  const cookie=req.headers.cookie; if(!cookie)return null; const vals=cookie.split(";").map(x=>x.trim()).filter(x=>x.startsWith("__Host-acp_session=")); if(vals.length!==1)return null; const sid=vals[0]!.slice("__Host-acp_session=".length);const s=sessions.get(sid);if(!s||s.expiresAt<=now().getTime())return null;await store.reloadOnMiss();const key=store.byKid(s.kid);return key?{kind:"cookie",capabilities:s.capabilities,kid:s.kid}:null;
}
function findSecret(raw:string,store:CredentialStore){const b=Buffer.from(raw);return store.active().find(s=>{const x=Buffer.from(s.secret);return x.length===b.length&&timingSafeEqual(x,b)});}
export const redactAuthText=redactSecrets;
