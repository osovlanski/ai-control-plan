import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { CredentialSecret } from "./credential-file.js";

export interface BootstrapPayload { aud:string; kid:string; jti:string; exp:number; lo:string; cap:string[] }
const enc=(x:unknown)=>Buffer.from(JSON.stringify(x)).toString("base64url");
export function mintBootstrapToken(secret:CredentialSecret, input:Omit<BootstrapPayload,"kid"|"jti">):string{
  const head=enc({alg:"HS256",typ:"acp-bootstrap"}); const payload=enc({...input,kid:secret.kid,jti:randomBytes(16).toString("base64url")}); const signed=`${head}.${payload}`; return `${signed}.${createHmac("sha256",secret.secret).update(signed).digest("base64url")}`;
}
export function parseBootstrapToken(token:string):{header:{alg:string;typ:string};payload:BootstrapPayload;signingInput:string;signature:Buffer}|null{
  try { const [h,p,s,...rest]=token.split("."); if(!h||!p||!s||rest.length) return null; const header=JSON.parse(Buffer.from(h,"base64url").toString()) as {alg:string;typ:string}; const payload=JSON.parse(Buffer.from(p,"base64url").toString()) as BootstrapPayload; if(header.alg!=="HS256"||header.typ!=="acp-bootstrap"||!payload.lo||!Array.isArray(payload.cap)) return null; return {header,payload,signingInput:`${h}.${p}`,signature:Buffer.from(s,"base64url")}; } catch{return null;}
}
export function verifyBootstrapSignature(parsed:NonNullable<ReturnType<typeof parseBootstrapToken>>, secret:CredentialSecret):boolean{ const expected=createHmac("sha256",secret.secret).update(parsed.signingInput).digest(); return expected.length===parsed.signature.length&&timingSafeEqual(expected,parsed.signature); }
