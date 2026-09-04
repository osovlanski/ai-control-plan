import { randomBytes, timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { CONTROL_PLANE_API_VERSION, redactSecrets, registerSecret } from "@agent-plane/core";
import type { ResolvedConfig } from "../config.js";
import type { Db } from "../db/index.js";
import type { CredentialStore } from "./credential-file.js";
import { parseBootstrapToken, verifyBootstrapSignature } from "./bootstrap-token.js";

declare module "fastify" { interface FastifyContextConfig { auth?: null|{require:string} } interface FastifyRequest { cred?: AuthenticatedCredential } }
export interface Session { kid:string; capabilities:string[]; expiresAt:number }
export type SessionMap=Map<string,Session>;
export interface AuthenticatedCredential { kind:"bearer"|"cookie"; capabilities:string[]; kid:string }

export function registerAuth(app:FastifyInstance, deps:{config:ResolvedConfig;credentials:CredentialStore;sessions:SessionMap;db:Db;now:()=>Date}):void{
  const {config,credentials,sessions,db,now}=deps; const origin=`http://${config.api.host}:${config.api.port}`;
  app.addContentTypeParser("application/x-www-form-urlencoded",{parseAs:"string"},(_req,body,done)=>{try{done(null,Object.fromEntries(new URLSearchParams(body as string)))}catch(e){done(e as Error)}});
  app.addHook("onRoute", route=>{ const path=String(route.url); if(path.startsWith("/api/") && route.config?.auth===undefined) throw new Error(`Route ${String(route.method)} ${path} must declare config.auth`); if(route.config?.auth===null && !(path==="/api/auth/bootstrap"&&String(route.method)==="POST")) throw new Error(`Only POST /api/auth/bootstrap may use config.auth=null`); });
  app.addHook("onRequest",async(req,reply)=>{
    const path=req.url.split("?")[0]!; if(!path.startsWith("/api/")) return; const rule=req.routeOptions.config?.auth; if(rule===null) return;
    const cred=await authenticate(req,credentials,sessions,now);
    if(!cred){ reply.header("X-Control-Plane-Api-Version",CONTROL_PLANE_API_VERSION).header("WWW-Authenticate","Bearer"); return reply.code(401).send({error:"unauthenticated"}); }
    if(rule===undefined) return;
    if(!cred.capabilities.includes(rule.require)) return reply.code(403).send({error:`${rule.require} required`});
    if(cred.kind==="cookie"){const site=req.headers["sec-fetch-site"]; const o=req.headers.origin; if(!(site==="same-origin"||site==="none"||o===origin)) return reply.code(403).send({error:"cross-origin"});}
    req.cred=cred;
  });
  app.post<{Body:{token?:string}}>("/api/auth/bootstrap",{config:{auth:null}},async(req,reply)=>{
    const token=req.body?.token; if(!token) return reply.code(400).send({error:"bootstrap rejected"}); registerSecret(token); const parsed=parseBootstrapToken(token); if(!parsed) return reply.code(400).send({error:"bootstrap rejected"});
    if(req.headers.origin!==parsed.payload.lo || req.headers["sec-fetch-site"]==="cross-site") return reply.code(403).send({error:"bootstrap rejected"});
    if(parsed.payload.aud!==origin || parsed.payload.exp<=Math.floor(now().getTime()/1000)) return reply.code(401).send({error:"bootstrap rejected"});
    let secret=credentials.byKid(parsed.payload.kid); if(!secret){await credentials.reloadOnMiss();secret=credentials.byKid(parsed.payload.kid);} if(!secret||!verifyBootstrapSignature(parsed,secret)) return reply.code(401).send({error:"bootstrap rejected"});
    try { db.prepare("INSERT INTO bootstrap_jti (jti, expires_at) VALUES (?, ?)").run(parsed.payload.jti,parsed.payload.exp); } catch(e){ if((e as {code?:string}).code?.startsWith("SQLITE_CONSTRAINT")) return reply.code(401).send({error:"bootstrap rejected"}); throw e; }
    const sid=randomBytes(32).toString("base64url");registerSecret(sid);sessions.set(sid,{kid:secret.kid,capabilities:parsed.payload.cap.filter(c=>secret!.capabilities.includes(c)),expiresAt:now().getTime()+config.api.auth.sessionTtlSeconds*1000});
    return reply.code(303).header("location",`${origin}/`).header("set-cookie",`__Host-acp_session=${sid}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${config.api.auth.sessionTtlSeconds}`).header("referrer-policy","no-referrer").header("cache-control","no-store").send();
  });
  const sweep=setInterval(()=>db.prepare("DELETE FROM bootstrap_jti WHERE expires_at <= ?").run(Math.floor(now().getTime()/1000)),60_000); sweep.unref(); app.addHook("onClose",()=>clearInterval(sweep));
}
async function authenticate(req:FastifyRequest,store:CredentialStore,sessions:SessionMap,now:()=>Date):Promise<AuthenticatedCredential|null>{
  const auth=req.headers.authorization; if(auth?.startsWith("Bearer ")){const raw=auth.slice(7); let match=findSecret(raw,store); if(!match){await store.reloadOnMiss();match=findSecret(raw,store);} return match?{kind:"bearer",capabilities:match.capabilities,kid:match.kid}:null;}
  const cookie=req.headers.cookie; if(!cookie)return null; const vals=cookie.split(";").map(x=>x.trim()).filter(x=>x.startsWith("__Host-acp_session=")); if(vals.length!==1)return null; const sid=vals[0]!.slice("__Host-acp_session=".length);const s=sessions.get(sid);if(!s||s.expiresAt<=now().getTime())return null;await store.reloadOnMiss();const key=store.byKid(s.kid);return key?{kind:"cookie",capabilities:s.capabilities,kid:s.kid}:null;
}
function findSecret(raw:string,store:CredentialStore){const b=Buffer.from(raw);return store.active().find(s=>{const x=Buffer.from(s.secret);return x.length===b.length&&timingSafeEqual(x,b)});}
export const redactAuthText=redactSecrets;
