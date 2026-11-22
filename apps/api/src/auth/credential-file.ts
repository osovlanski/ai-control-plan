import { closeSync, existsSync, fsyncSync, lstatSync, openSync, readdirSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { AUTOPILOT_OPERATE_CAPABILITY, COMMAND_CAPABILITIES, INGEST_CAPABILITIES, MCP_CREDENTIAL_CAPABILITIES, OBSERVABILITY_CAPABILITIES, registerSecret } from "@agent-plane/core";

export interface CredentialSecret { kid: string; secret: string; capabilities: string[]; createdAt: string; notAfter: string | null }
export interface CredentialFile { version: 1; secrets: CredentialSecret[] }
export const credentialPath = (dir: string) => join(dir, "api-credential.json");
const FULL_CAPABILITIES = (): string[] => [...OBSERVABILITY_CAPABILITIES, ...COMMAND_CAPABILITIES, ...INGEST_CAPABILITIES];
const fresh = (now = new Date(), name?: string): CredentialSecret => ({ kid: `k_${name ? `${name}_` : ""}${randomBytes(4).toString("hex")}`, secret: randomBytes(32).toString("base64url"), capabilities: FULL_CAPABILITIES(), createdAt: now.toISOString(), notAfter: null });

/**
 * 2.14 (mcp-api-grants, docs/adr/mcp-connector.md finding): a named credential lives in its own
 * file beside the main one, so the MCP service can hold a narrow secret that rotating the main
 * credential never expires, and so the MCP process never reads the main secret. The plane accepts
 * every active secret of the main file and of each named file.
 */
export const CREDENTIAL_NAME = /^[a-z][a-z0-9-]{0,31}$/;
export const namedCredentialPath = (dir: string, name: string): string => {
  if (!CREDENTIAL_NAME.test(name)) throw new Error(`Invalid credential name ${JSON.stringify(name)}: use ${CREDENTIAL_NAME.source}`);
  return join(dir, `api-credential.${name}.json`);
};
const NAMED_FILE = /^api-credential\.([a-z][a-z0-9-]{0,31})\.json$/;
/** The named credential files present in `dir`, sorted by name. */
export function namedCredentialPaths(dir: string): string[] {
  let entries: string[];
  try { entries = readdirSync(dir); } catch { return []; }
  return entries.filter((f) => NAMED_FILE.test(f)).sort().map((f) => join(dir, f));
}

export function validateCredentialFile(path: string): void {
  const s = lstatSync(path);
  if (!s.isFile() || s.isSymbolicLink() || s.uid !== process.getuid?.() || (s.mode & 0o077) !== 0) throw new Error(`Unsafe credential file ${path}; run: chmod 600 ${path} && chown $(id -u) ${path}`);
}
export function readCredential(path: string): CredentialFile {
  validateCredentialFile(path);
  const value = JSON.parse(readFileSync(path, "utf8")) as CredentialFile;
  if (value.version !== 1 || !Array.isArray(value.secrets) || value.secrets.length === 0) throw new Error(`Invalid credential file ${path}`);
  for (const item of value.secrets) { if (!item.kid || !item.secret || !Array.isArray(item.capabilities)) throw new Error(`Invalid credential file ${path}`);
    // P0-A2: the operator capability lives only behind the operator secret, whose hash alone is on this machine.
    if (item.capabilities.includes(AUTOPILOT_OPERATE_CAPABILITY)) throw new Error(`Invalid credential file ${path}: ${AUTOPILOT_OPERATE_CAPABILITY} may not be granted by a stored credential`);
    registerSecret(item.secret); }
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
  try { return fn(); } finally { rmSync(lock, { force: true }); }
}
export function atomicWriteCredential(path: string, value: CredentialFile): void {
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(tmp, JSON.stringify(value,null,2)+"\n", { mode: 0o600 }); const fd=openSync(tmp,"r"); fsyncSync(fd); closeSync(fd); renameSync(tmp,path); const dfd=openSync(dirname(path),"r"); fsyncSync(dfd); closeSync(dfd);
}
export function rotateCredential(path: string, graceSeconds: number, capabilities?: string[], now = new Date(), opts: { fallback?: readonly string[]; name?: string } = {}): CredentialSecret {
  if (capabilities?.includes(AUTOPILOT_OPERATE_CAPABILITY)) throw new Error(`${AUTOPILOT_OPERATE_CAPABILITY} may not be granted by a stored credential; use rotate-operate`);
  // Rotation expires only the secrets of THIS file: a named credential is a separate file.
  return withCredentialLock(path, () => { const file=readCredential(path); const active=file.secrets.filter(s=>isActive(s,now)); const cap=capabilities ?? active.at(-1)?.capabilities ?? [...(opts.fallback ?? FULL_CAPABILITIES())]; const until=new Date(now.getTime()+graceSeconds*1000).toISOString(); for (const s of active) s.notAfter=until; const next={...fresh(now,opts.name),capabilities:cap}; file.secrets.push(next); atomicWriteCredential(path,file); registerSecret(next.secret); return next; });
}

/**
 * Mints (first call) or rotates the named credential `name`. Default capabilities are the MCP set
 * (`tasks.read`, `tasks.create`, `tasks.start`), never the full set, so a named credential is narrow
 * unless `--capabilities` says otherwise. Other credential files are not touched.
 */
export function rotateNamedCredential(dir: string, name: string, graceSeconds: number, capabilities?: string[], now = new Date()): CredentialSecret {
  if (capabilities?.includes(AUTOPILOT_OPERATE_CAPABILITY)) throw new Error(`${AUTOPILOT_OPERATE_CAPABILITY} may not be granted by a stored credential; use rotate-operate`);
  if (capabilities && capabilities.length === 0) throw new Error("a named credential needs at least one capability");
  const path = namedCredentialPath(dir, name);
  if (!existsSync(path)) {
    const first = { ...fresh(now, name), capabilities: [...(capabilities ?? MCP_CREDENTIAL_CAPABILITIES)] };
    // `wx`: two concurrent first mints cannot both win; the loser falls through to a rotation.
    try { writeFileSync(path, JSON.stringify({ version: 1, secrets: [first] }, null, 2) + "\n", { flag: "wx", mode: 0o600 }); registerSecret(first.secret); return first; }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e; }
  }
  return rotateCredential(path, graceSeconds, capabilities, now, { fallback: MCP_CREDENTIAL_CAPABILITIES, name });
}

export class CredentialStore {
  private file: CredentialFile; private named: CredentialSecret[]; private reloadPromise?: Promise<void>; private lastReload=0;
  /** `namedDir`: also accept the named credential files in that directory (the server passes its config dir). */
  constructor(readonly path:string, readonly now:()=>Date=()=>new Date(), readonly namedDir?:string) { this.file=readCredential(path); this.named=this.readNamed(); }
  private readNamed():CredentialSecret[]{ return this.namedDir ? namedCredentialPaths(this.namedDir).flatMap(p=>readCredential(p).secrets) : []; }
  /** The main file's secrets only (what the CLI, `open` and the browser use). */
  all(){ return this.file.secrets; }
  active(){ return [...this.file.secrets,...this.named].filter(s=>isActive(s,this.now())); }
  byKid(kid:string){ return this.active().find(s=>s.kid===kid); }
  /** A main-file secret only: bootstrap never mints a browser session from a named credential. */
  mainByKid(kid:string){ return this.file.secrets.find(s=>s.kid===kid&&isActive(s,this.now())); }
  async reloadOnMiss():Promise<void>{ if(this.reloadPromise) return this.reloadPromise; const wait=Math.max(0,250-(Date.now()-this.lastReload)); this.reloadPromise=new Promise(r=>setTimeout(r,wait)).then(()=>{this.file=readCredential(this.path);this.named=this.readNamed();this.lastReload=Date.now();}).finally(()=>{this.reloadPromise=undefined;}); return this.reloadPromise; }
}
