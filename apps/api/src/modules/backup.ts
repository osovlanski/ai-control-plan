/**
 * P0-7b (docs/agentic-os-auto-copilot-plan.md §C.5 "Backup", D-11) — the plane database's local
 * backup and its fail-closed restore. The off-host upload (D-11: an OCI bucket, client-side
 * encrypted) is a `BackupDestination` that is not built here; `dir:` is the only one shipped.
 *
 * Backup: SQLite's online backup API on a read-only connection (the plane keeps running), then
 * `PRAGMA integrity_check` on the copy, then the copy and a manifest (name, time, sha256, size,
 * last migration) are renamed into place, 0600. Local copies older than `keepDays` are pruned;
 * only files this module named are ever removed.
 *
 * Restore (the plane must be stopped; a process holding the database open refuses it):
 * 1. verify the backup against its manifest (sha256) and `integrity_check`;
 * 2. write the `restored_at.json` marker FIRST, so any later failure still boots fail-closed;
 * 3. move the current database and its `-wal`/`-shm` aside (`<db>.pre-restore-<stamp>`), never delete;
 * 4. copy the backup to a temporary file next to the database, fsync, rename into place.
 */
import { createHash } from "node:crypto";
import { closeSync, constants, copyFileSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, readlinkSync, renameSync, rmSync, statSync, writeSync, chmodSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import Database from "better-sqlite3";
import { RESTORE_MARKER_FILE, type RestoreMarker } from "./autopilot-restore.js";

const NAME_RE = /^agent-plane-(\d{8}T\d{6}Z)\.db$/;

export interface BackupManifest {
  name: string;
  takenAt: string;
  sha256: string;
  bytes: number;
  integrity: "ok";
  lastMigration: string | null;
}

/** Where a copy goes after it is taken locally. `dir:` ships; the OCI bucket (D-11) plugs in here later. */
export interface BackupDestination {
  readonly label: string;
  put(localDb: string, localManifest: string): Promise<void>;
  /** Names of the `.db` copies held there, newest last. */
  list(): Promise<string[]>;
  /** Copies `<name>` and its manifest into `intoDir`; returns the local `.db` path. */
  get(name: string, intoDir: string): Promise<string>;
}

export function directoryDestination(dir: string): BackupDestination {
  if (!isAbsolute(dir)) throw new Error("a dir: backup destination must be an absolute path");
  return {
    label: `dir:${dir}`,
    async put(localDb, localManifest) {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      for (const src of [localDb, localManifest]) atomicCopy(src, join(dir, basename(src)));
    },
    async list() {
      return existsSync(dir) ? readdirSync(dir).filter((n) => NAME_RE.test(n)).sort() : [];
    },
    async get(name, intoDir) {
      if (!NAME_RE.test(name)) throw new Error(`not a backup name: ${name}`);
      mkdirSync(intoDir, { recursive: true, mode: 0o700 });
      for (const n of [name, manifestName(name)]) atomicCopy(join(dir, n), join(intoDir, n));
      return join(intoDir, name);
    },
  };
}

/** `dir:/abs/path` → a destination. Unknown schemes are refused, never ignored. */
export function parseDestination(spec: string): BackupDestination {
  const m = /^([a-z]+):(.+)$/.exec(spec);
  if (m?.[1] === "dir") return directoryDestination(m[2]!);
  throw new Error(`unknown backup destination ${JSON.stringify(spec)}: only dir:/absolute/path is built (the off-host bucket is D-11, not yet built)`);
}

const manifestName = (dbName: string) => dbName.replace(/\.db$/, ".json");
const stamp = (d: Date) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
const sha256File = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");

function fsyncPath(path: string): void {
  const fd = openSync(path, constants.O_RDONLY);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
function atomicWrite(path: string, data: string): void {
  const tmp = `${path}.tmp-${process.pid}`;
  const fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  try { writeSync(fd, data); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(tmp, path);
}
function atomicCopy(src: string, dest: string): void {
  const tmp = `${dest}.tmp-${process.pid}`;
  copyFileSync(src, tmp, constants.COPYFILE_EXCL);
  chmodSync(tmp, 0o600);
  fsyncPath(tmp);
  renameSync(tmp, dest);
}

function verifyFile(path: string): { lastMigration: string | null } {
  const db = new Database(path, { readonly: true, fileMustExist: true });
  try {
    const rows = db.pragma("integrity_check") as Array<{ integrity_check: string }>;
    if (rows.length !== 1 || rows[0]!.integrity_check !== "ok") throw new Error(`integrity_check failed on ${basename(path)}: ${rows.slice(0, 3).map((r) => r.integrity_check).join("; ")}`);
    const hasMigrations = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'").get();
    const last = hasMigrations ? (db.prepare("SELECT MAX(name) AS n FROM schema_migrations").get() as { n: string | null }).n : null;
    return { lastMigration: last };
  } finally { db.close(); }
}

/** Online backup of a live database into `localDir`, then prune and (optionally) copy off. */
export async function takeBackup(o: { dbPath: string; localDir: string; keepDays: number; destination?: BackupDestination; now?: () => Date }): Promise<{ manifest: BackupManifest; path: string; pruned: string[]; copiedTo?: string }> {
  const now = o.now ?? (() => new Date());
  const at = now();
  mkdirSync(o.localDir, { recursive: true, mode: 0o700 });
  const name = `agent-plane-${stamp(at)}.db`;
  const path = join(o.localDir, name);
  if (existsSync(path)) throw new Error(`${name} already exists`);
  const tmp = `${path}.tmp-${process.pid}`;
  const src = new Database(o.dbPath, { readonly: true, fileMustExist: true });
  try { await src.backup(tmp); } finally { src.close(); }
  let manifest: BackupManifest;
  try {
    chmodSync(tmp, 0o600);
    // The copy carries the plane's WAL mode; a backup is one self-contained file, so it is switched
    // to a rollback journal (no -wal/-shm beside it). The plane sets WAL again when it opens it.
    const copy = new Database(tmp, { fileMustExist: true });
    try { copy.pragma("journal_mode = DELETE"); } finally { copy.close(); }
    const { lastMigration } = verifyFile(tmp);
    fsyncPath(tmp);
    manifest = { name, takenAt: at.toISOString(), sha256: sha256File(tmp), bytes: statSync(tmp).size, integrity: "ok", lastMigration };
    renameSync(tmp, path);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
  const manifestPath = join(o.localDir, manifestName(name));
  atomicWrite(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  const pruned = pruneLocal(o.localDir, o.keepDays, at);
  if (o.destination) await o.destination.put(path, manifestPath);
  return { manifest, path, pruned, ...(o.destination ? { copiedTo: o.destination.label } : {}) };
}

/** Removes local copies (and their manifests) taken more than `keepDays` before `at`. Only files named by `takeBackup`. */
export function pruneLocal(localDir: string, keepDays: number, at: Date): string[] {
  const cutoff = at.getTime() - keepDays * 86_400_000;
  const removed: string[] = [];
  for (const n of readdirSync(localDir)) {
    const m = NAME_RE.exec(n);
    if (!m) continue;
    const s = m[1]!;
    const taken = Date.parse(`${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}T${s.slice(9, 11)}:${s.slice(11, 13)}:${s.slice(13, 15)}Z`);
    if (!(taken < cutoff)) continue;
    rmSync(join(localDir, n), { force: true });
    rmSync(join(localDir, manifestName(n)), { force: true });
    removed.push(n);
  }
  return removed;
}

export function listLocal(localDir: string): string[] {
  return existsSync(localDir) ? readdirSync(localDir).filter((n) => NAME_RE.test(n)).sort() : [];
}

/** Linux only: pids of this user's processes that hold `path` open. Elsewhere: unknown (empty). */
export function holdersOf(path: string, procRoot = "/proc"): number[] {
  const target = resolve(path);
  const out: number[] = [];
  let pids: string[];
  try { pids = readdirSync(procRoot).filter((n) => /^\d+$/.test(n)); } catch { return out; }
  for (const pid of pids) {
    if (Number(pid) === process.pid) continue;
    let fds: string[];
    try { fds = readdirSync(join(procRoot, pid, "fd")); } catch { continue; }
    for (const fd of fds) {
      try {
        const link = readlinkSync(join(procRoot, pid, "fd", fd));
        if (link === target || link === `${target}-wal`) { out.push(Number(pid)); break; }
      } catch { /* gone */ }
    }
  }
  return out;
}

export class RestoreScriptRefused extends Error {
  constructor(message: string) { super(message); this.name = "RestoreScriptRefused"; }
}

/**
 * Put `backupPath` back as the plane's database under `workspaceDir`. Refuses while a process
 * holds the database open. The marker goes first: from that moment the next boot is fail-closed.
 */
export function restoreBackup(o: { dbPath: string; workspaceDir: string; backupPath: string; now?: () => Date; procRoot?: string }): { marker: RestoreMarker; movedAside: string[]; markerPath: string } {
  const now = o.now ?? (() => new Date());
  const holders = holdersOf(o.dbPath, o.procRoot);
  if (holders.length > 0) throw new RestoreScriptRefused(`process(es) ${holders.join(", ")} hold ${o.dbPath} open: stop the plane first`);
  const mPath = join(dirname(o.backupPath), manifestName(basename(o.backupPath)));
  if (!NAME_RE.test(basename(o.backupPath))) throw new RestoreScriptRefused(`${basename(o.backupPath)} is not a backup this script took`);
  if (!existsSync(mPath)) throw new RestoreScriptRefused(`no manifest ${basename(mPath)} next to the backup`);
  const manifest = JSON.parse(readFileSync(mPath, "utf8")) as BackupManifest;
  const sha = sha256File(o.backupPath);
  if (manifest.name !== basename(o.backupPath) || manifest.sha256 !== sha) throw new RestoreScriptRefused(`${basename(o.backupPath)} does not match its manifest (sha256 ${sha.slice(0, 12)} vs ${String(manifest.sha256).slice(0, 12)})`);
  verifyFile(o.backupPath);

  // 2. The marker first.
  const at = now();
  const marker: RestoreMarker = { restoredAt: at.toISOString(), backup: manifest.name, backupTakenAt: manifest.takenAt, backupSha256: manifest.sha256 };
  mkdirSync(o.workspaceDir, { recursive: true });
  const markerPath = join(o.workspaceDir, RESTORE_MARKER_FILE);
  atomicWrite(markerPath, JSON.stringify(marker, null, 2) + "\n");

  // 3. The current database aside, never deleted.
  const movedAside: string[] = [];
  const aside = `${o.dbPath}.pre-restore-${stamp(at)}`;
  for (const suffix of ["", "-wal", "-shm"]) {
    if (!existsSync(o.dbPath + suffix)) continue;
    renameSync(o.dbPath + suffix, aside + suffix);
    movedAside.push(aside + suffix);
  }

  // 4. The copy, atomically.
  atomicCopy(o.backupPath, o.dbPath);
  fsyncPath(dirname(o.dbPath));
  return { marker, movedAside, markerPath };
}
