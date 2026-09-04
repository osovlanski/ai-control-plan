import { closeSync, fsyncSync, lstatSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { COMMAND_CAPABILITIES, OBSERVABILITY_CAPABILITIES, registerSecret } from "@agent-plane/core";

export interface CredentialSecret { kid: string; secret: string; capabilities: string[]; createdAt: string; notAfter: string | null }
export interface CredentialFile { version: 1; secrets: CredentialSecret[] }
export const credentialPath = (dir: string) => join(dir, "api-credential.json");
const fresh = (now = new Date()): CredentialSecret => ({ kid: `k_${randomBytes(4).toString("hex")}`, secret: randomBytes(32).toString("base64url"), capabilities: [...OBSERVABILITY_CAPABILITIES, ...COMMAND_CAPABILITIES], createdAt: now.toISOString(), notAfter: null });

export function validateCredentialFile(path: string): void {
  const s = lstatSync(path);
  if (!s.isFile() || s.isSymbolicLink() || s.uid !== process.getuid?.() || (s.mode & 0o077) !== 0) throw new Error(`Unsafe credential file ${path}; run: chmod 600 ${path} && chown $(id -u) ${path}`);
}
export function readCredential(path: string): CredentialFile {
  validateCredentialFile(path);
  const value = JSON.parse(readFileSync(path, "utf8")) as CredentialFile;
  if (value.version !== 1 || !Array.isArray(value.secrets) || value.secrets.length === 0) throw new Error(`Invalid credential file ${path}`);
  for (const item of value.secrets) { if (!item.kid || !item.secret || !Array.isArray(item.capabilities)) throw new Error(`Invalid credential file ${path}`); registerSecret(item.secret); }
  return value;
}
export function ensureCredential(dir: string): CredentialFile {
  const path = credentialPath(dir);
  try { writeFileSync(path, JSON.stringify({ version: 1, secrets: [fresh()] }, null, 2) + "\n", { flag: "wx", mode: 0o600 }); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e; }
  return readCredential(path);
}
export function isActive(s: CredentialSecret, now: Date): boolean { return s.notAfter === null || Date.parse(s.notAfter) > now.getTime(); }
export function withCredentialLock<T>(path: string, fn: () => T): T {
  const lock = `${path}.lock`;
  for (;;) {
    try { writeFileSync(lock, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }), { flag: "wx", mode: 0o600 }); break; }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e; const x = JSON.parse(readFileSync(lock,"utf8")) as {pid:number;startedAt:string}; let dead=false; try { process.kill(x.pid,0); } catch (z) { dead=(z as NodeJS.ErrnoException).code==="ESRCH"; } if (!dead && Date.now()-Date.parse(x.startedAt)<=30000) throw new Error(`Credential rotation lock held: ${lock}`); unlinkSync(lock); }
  }
  try { return fn(); } finally { try { unlinkSync(lock); } catch {} }
}
export function atomicWriteCredential(path: string, value: CredentialFile): void {
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(tmp, JSON.stringify(value,null,2)+"\n", { mode: 0o600 }); const fd=openSync(tmp,"r"); fsyncSync(fd); closeSync(fd); renameSync(tmp,path); const dfd=openSync(dirname(path),"r"); fsyncSync(dfd); closeSync(dfd);
}
export function rotateCredential(path: string, graceSeconds: number, capabilities?: string[], now = new Date()): CredentialSecret {
  return withCredentialLock(path, () => { const file=readCredential(path); const active=file.secrets.filter(s=>isActive(s,now)); const cap=capabilities ?? active.at(-1)?.capabilities ?? [...OBSERVABILITY_CAPABILITIES,...COMMAND_CAPABILITIES]; const until=new Date(now.getTime()+graceSeconds*1000).toISOString(); for (const s of active) s.notAfter=until; const next={...fresh(now),capabilities:cap}; file.secrets.push(next); atomicWriteCredential(path,file); registerSecret(next.secret); return next; });
}

export class CredentialStore {
  private file: CredentialFile; private reloadPromise?: Promise<void>; private lastReload=0;
  constructor(readonly path:string, readonly now:()=>Date=()=>new Date()) { this.file=readCredential(path); }
  all(){ return this.file.secrets; }
  active(){ return this.file.secrets.filter(s=>isActive(s,this.now())); }
  byKid(kid:string){ return this.active().find(s=>s.kid===kid); }
  async reloadOnMiss():Promise<void>{ if(this.reloadPromise) return this.reloadPromise; const wait=Math.max(0,250-(Date.now()-this.lastReload)); this.reloadPromise=new Promise(r=>setTimeout(r,wait)).then(()=>{this.file=readCredential(this.path);this.lastReload=Date.now();}).finally(()=>{this.reloadPromise=undefined;}); return this.reloadPromise; }
}
