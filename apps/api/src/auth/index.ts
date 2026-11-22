import { randomBytes, timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { AUTOPILOT_OPERATE_CAPABILITY, CONTROL_PLANE_API_VERSION, capabilityGranted, redactSecrets, registerSecret } from "@agent-plane/core";
import { matchOperateSecret, operateSecretPath } from "./operate-secret.js";
import type { ResolvedConfig } from "../config.js";
import type { Db } from "../db/index.js";
import type { CredentialStore } from "./credential-file.js";
import { parseBootstrapToken, verifyBootstrapSignature } from "./bootstrap-token.js";
import { REMOTE_PUBLIC_ROUTES, REMOTE_SESSION_ROUTES, RemoteAuth } from "./remote.js";

/**
 * `auth`: `{require}` for every API route, `null` for bootstrap only, and `{remote}` for the B2
 * remote-listener auth routes only (login/callback are "public", session/activity/logout "session").
 */
declare module "fastify" { interface FastifyContextConfig { auth?: null|{require:string}|{remote:"public"|"session"} } interface FastifyRequest { cred?: AuthenticatedCredential } }
export interface Session { kid:string; capabilities:string[]; expiresAt:number }
export type SessionMap=Map<string,Session>;
export interface AuthenticatedCredential { kind:"bearer"|"cookie"|"remote"; capabilities:string[]; kid:string }
/** Headers only a reverse proxy adds. The local listener is never a proxy target, so a request carrying one is misrouted. */
const PROXY_HEADERS=["tailscale-user-login","tailscale-user-name","x-forwarded-for","x-forwarded-host","x-forwarded-proto","forwarded"];

export function registerAuth(app:FastifyInstance, deps:{config:ResolvedConfig;credentials:CredentialStore;sessions:SessionMap;db:Db;now:()=>Date}):RemoteAuth|undefined{
  const {config,credentials,sessions,db,now}=deps; const origin=`http://${config.api.host}:${config.api.port}`;
  // B2 (D-B): the remote listener's gate. Absent unless `api.remote` is configured; the local path below is unchanged.
  const remote=config.api.remote?new RemoteAuth({config:config.api.remote,workspace:config.workspace,db,now,log:app.log}):undefined;
  app.addContentTypeParser("application/x-www-form-urlencoded",{parseAs:"string"},(_req,body,done)=>{try{done(null,Object.fromEntries(new URLSearchParams(body as string)))}catch(e){done(e as Error)}});
  app.addHook("onRoute", route=>{ const path=String(route.url); if(path.startsWith("/api/") && route.config?.auth===undefined) throw new Error(`Route ${String(route.method)} ${path} must declare config.auth`); if(route.config?.auth===null && !(path==="/api/auth/bootstrap"&&String(route.method)==="POST")) throw new Error(`Only POST /api/auth/bootstrap may use config.auth=null`); const r=route.config?.auth; if(r&&"remote" in r&&!((r.remote==="public"&&REMOTE_PUBLIC_ROUTES.has(path))||(r.remote==="session"&&REMOTE_SESSION_ROUTES.has(path)))) throw new Error(`Route ${String(route.method)} ${path} may not use config.auth.remote=${r.remote}`); });
  app.addHook("onRequest",async(req,reply)=>{
    if(remote?.isRemote(req.raw)) return remote.onRequest(req,reply);
    if(remote&&PROXY_HEADERS.some(h=>req.headers[h]!==undefined)) return reply.code(421).send({error:"misdirected request"});
    const path=req.url.split("?")[0]!; if(!path.startsWith("/api/")) return; const rule=req.routeOptions.config?.auth; if(rule===null) return;
    if(rule&&"remote" in rule) return reply.code(404).send({error:"not found"});
    const cred=await authenticate(req,credentials,sessions,now,operateSecretPath(config.dir));
    if(!cred){ reply.header("X-Control-Plane-Api-Version",CONTROL_PLANE_API_VERSION).header("WWW-Authenticate","Bearer"); return reply.code(401).send({error:"unauthenticated"}); }
    if(rule===undefined) return;
    // 2.14: `commands.write` implies `tasks.create` and `tasks.start`.
    if(!capabilityGranted(cred.capabilities,rule.require)) return reply.code(403).send({error:`${rule.require} required`});
    if(cred.kind==="cookie"){const site=req.headers["sec-fetch-site"]; const o=req.headers.origin; if(!(site==="same-origin"||site==="none"||o===origin)) return reply.code(403).send({error:"cross-origin"});}
    req.cred=cred;
  });
  app.post<{Body:{token?:string}}>("/api/auth/bootstrap",{config:{auth:null}},async(req,reply)=>{
    const token=req.body?.token; if(!token) return reply.code(400).send({error:"bootstrap rejected"}); registerSecret(token); const parsed=parseBootstrapToken(token); if(!parsed) return reply.code(400).send({error:"bootstrap rejected"});
    if(req.headers.origin!==parsed.payload.lo || req.headers["sec-fetch-site"]==="cross-site") return reply.code(403).send({error:"bootstrap rejected"});
    if(parsed.payload.aud!==origin || parsed.payload.exp<=Math.floor(now().getTime()/1000)) return reply.code(401).send({error:"bootstrap rejected"});
    let secret=credentials.mainByKid(parsed.payload.kid); if(!secret){await credentials.reloadOnMiss();secret=credentials.mainByKid(parsed.payload.kid);} if(!secret||!verifyBootstrapSignature(parsed,secret)) return reply.code(401).send({error:"bootstrap rejected"});
    try { db.prepare("INSERT INTO bootstrap_jti (jti, expires_at) VALUES (?, ?)").run(parsed.payload.jti,parsed.payload.exp); } catch(e){ if((e as {code?:string}).code?.startsWith("SQLITE_CONSTRAINT")) return reply.code(401).send({error:"bootstrap rejected"}); throw e; }
    const sid=randomBytes(32).toString("base64url");registerSecret(sid);sessions.set(sid,{kid:secret.kid,capabilities:parsed.payload.cap.filter(c=>secret!.capabilities.includes(c)),expiresAt:now().getTime()+config.api.auth.sessionTtlSeconds*1000});
    return reply.code(303).header("location",`${origin}/`).header("set-cookie",`__Host-acp_session=${sid}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${config.api.auth.sessionTtlSeconds}`).header("referrer-policy","no-referrer").header("cache-control","no-store").send();
  });
  const sweep=setInterval(()=>db.prepare("DELETE FROM bootstrap_jti WHERE expires_at <= ?").run(Math.floor(now().getTime()/1000)),60_000); sweep.unref(); app.addHook("onClose",()=>clearInterval(sweep));
  if(remote){ const n=remote.revokeOnBoot(); if(n>0) app.log.info({event:"remote.boot",revoked:n},"remote sessions revoked at boot"); remote.registerRoutes(app); }
  return remote;
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
