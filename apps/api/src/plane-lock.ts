/**
 * One live plane per workspace database (#272 round 5). Boot recovery clears every lease and decides
 * every live session on the premise that whatever held them is dead, so a second plane booting
 * beside a running one would fail its sessions. The entry therefore refuses to boot while another
 * plane holds the workspace.
 *
 * The lock is an exclusive SQLite transaction held open on a file of its own: the kernel drops its
 * file lock when the holder dies, whatever way it dies, so there is no stale-lock case and no pid
 * or start-time guess. Only the entry takes it; `buildServer` composes whatever it is given.
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import type { Db } from "./db/index.js";

export const PLANE_LOCK_FILE = "plane.lock.db";

export class PlaneLockHeldError extends Error {
  constructor(readonly path: string) {
    super(`Another plane is running on this workspace (lock ${path}). Stop it first; two planes on one database would fail each other's sessions.`);
    this.name = "PlaneLockHeldError";
  }
}

export interface PlaneLock { release(): void }

/** Held for the life of the process: a lock whose handle is collected closes its connection and drops the lock. */
const heldLocks = new Set<Database.Database>();

/** Takes the workspace's lock, or throws `PlaneLockHeldError` at once when another process holds it. */
export function acquirePlaneLock(dir: string): PlaneLock {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, PLANE_LOCK_FILE);
  const lockDb = new Database(path, { timeout: 0 });
  try {
    lockDb.exec("BEGIN EXCLUSIVE");
  } catch (err) {
    lockDb.close();
    if ((err as { code?: string }).code === "SQLITE_BUSY") throw new PlaneLockHeldError(path);
    throw err;
  }
  heldLocks.add(lockDb);
  return { release: () => { if (heldLocks.delete(lockDb)) lockDb.close(); } };
}

/**
 * Migration 060 records a lease's holder; a plane from before it does not. A session lease with no
 * holder that has not expired belongs to such a plane that is still running (or died within one
 * lease TTL), and the lock cannot see it. Waits for the latest such expiry; a plane that is alive
 * renews its lease past it, and that is refused. Returns once no unexpired lease is left without a
 * holder. A legacy run of an old plane holds no lease and cannot be seen: stop the old plane first.
 */
export async function waitForPre060Planes(db: Db, opts: { now?: () => Date; sleep?: (ms: number) => Promise<void> } = {}): Promise<void> {
  const now = opts.now ?? (() => new Date());
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const latest = (): string | null => (db.prepare(
    "SELECT MAX(lease_expires_at) AS e FROM runs WHERE lease_token IS NOT NULL AND lease_incarnation IS NULL AND ended_at IS NULL",
  ).get() as { e: string | null }).e;
  const first = latest();
  if (!first || first <= now().toISOString()) return;
  await sleep(Math.max(0, new Date(first).getTime() - now().getTime()) + 1_000);
  const after = latest();
  if (after && after > first) throw new Error("A plane from before migration 060 is still running (its lease was renewed). Stop it before booting this one.");
}
