/**
 * #272 review (Codex, 2026-11-27, round 5): seven failures, every one needing a second live plane on
 * one database (a renewal racing boot, a pre-060 runner under a new boot, a lease taken between
 * boot's checks, a handoff racing boot, a sweep beside a healthy sibling, a runner killed beside a
 * surviving API, expiry between boot phases). Boot recovery clears every lease on the premise that
 * whatever held them is dead, so the fix is the premise: the entry holds an exclusive workspace lock
 * and refuses to boot while another plane holds it.
 *
 *   1. A second process on the workspace is refused at once, and the lock is free again when its
 *      holder dies, however it dies.
 *   2. A plane from before migration 060 (a lease with no recorded holder) is waited for: gone within
 *      one lease TTL is booted over, still renewing is refused.
 *   3. Boot clears every unfinished session's lease and the holder it recorded.
 *   4. The real entry (`src/index.ts`) exits nonzero while the lock is held.
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { openDb, type Db } from "../src/db/index.js";
import { PlaneLockHeldError, acquirePlaneLock, waitForPre060Planes } from "../src/plane-lock.js";
import { SessionStore } from "../src/modules/harness/session-store.js";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "qcq-04b-r272-r5-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const lockScript = (d: string) => `
  const { acquirePlaneLock } = await import(${JSON.stringify(join(process.cwd(), "src/plane-lock.ts"))});
  acquirePlaneLock(${JSON.stringify(d)}); console.log("held"); setInterval(() => {}, 1000);`;

describe("the workspace lock", () => {
  it("refuses a second holder in this process and is free again once released", () => {
    const first = acquirePlaneLock(dir);
    expect(() => acquirePlaneLock(dir)).toThrow(PlaneLockHeldError);
    first.release();
    acquirePlaneLock(dir).release();
  });

  it("refuses a second process while the first lives, and frees when it is killed", async () => {
    const holder = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", lockScript(dir)], { cwd: process.cwd(), stdio: ["ignore", "pipe", "inherit"] });
    try {
      await new Promise<void>((resolve, reject) => {
        holder.stdout!.on("data", (b: Buffer) => { if (b.toString().includes("held")) resolve(); });
        holder.on("exit", (c) => reject(new Error(`holder exited ${c}`)));
      });
      expect(() => acquirePlaneLock(dir)).toThrow(PlaneLockHeldError);
      holder.kill("SIGKILL");
      await new Promise((r) => holder.on("exit", r));
      acquirePlaneLock(dir).release(); // a killed holder leaves no stale lock
    } finally {
      holder.kill("SIGKILL");
    }
  }, 30_000);

  it("a lock nobody keeps a reference to is still held after a garbage collection", () => {
    acquirePlaneLock(dir); // the handle is dropped on purpose
    (globalThis as { gc?: () => void }).gc?.();
    expect(() => acquirePlaneLock(dir)).toThrow(PlaneLockHeldError);
  });

  it("the real entry exits nonzero, naming the lock, while another plane holds the workspace", () => {
    const held = acquirePlaneLock(loadConfig({ AGENT_PLANE_HOME: dir }).dir);
    try {
      const res = spawnSync(process.execPath, ["--import", "tsx", "src/index.ts"], {
        cwd: process.cwd(), encoding: "utf8", timeout: 30_000,
        env: { ...process.env, AGENT_PLANE_HOME: dir, AGENT_PLANE_API_PORT: "0" },
      });
      expect(res.status).toBe(1);
      expect(res.stderr).toContain("Another plane is running on this workspace");
    } finally { held.release(); }
  }, 40_000);
});

describe("a plane from before migration 060", () => {
  let db: Db;
  beforeEach(() => {
    db = openDb(join(dir, "t.db"));
    db.prepare("INSERT INTO assistants (id, provider) VALUES ('a1','fake')").run();
    db.prepare("INSERT INTO tasks (id, goal, envelope, created_at, updated_at) VALUES ('AG-1','g','{}','t','t')").run();
  });
  afterEach(() => db.close());
  const lease = (expires: string, holder: string | null) =>
    db.prepare("INSERT INTO runs (id, task_id, assistant_id, state, started_at, execution_request_id, session_state, lease_token, lease_expires_at, lease_incarnation) VALUES ('run_old', 'AG-1', 'a1', 'ACTIVE', 't', 'erq', 'RUNNING', 'lease_old', ?, ?)").run(expires, holder);

  it("is waited for until its lease lapses, then booted over", async () => {
    const t0 = Date.parse("2026-11-27T12:00:00.000Z");
    let clock = t0;
    lease(new Date(t0 + 40_000).toISOString(), null);
    const slept: number[] = [];
    await waitForPre060Planes(db, { now: () => new Date(clock), sleep: async (ms) => { slept.push(ms); clock += ms; } });
    expect(slept).toEqual([41_000]);
  });

  it("is refused when its lease is renewed meanwhile", async () => {
    const t0 = Date.parse("2026-11-27T12:00:00.000Z");
    let clock = t0;
    lease(new Date(t0 + 40_000).toISOString(), null);
    const sleep = async (ms: number) => { clock += ms; db.prepare("UPDATE runs SET lease_expires_at = ? WHERE id = 'run_old'").run(new Date(clock + 60_000).toISOString()); };
    await expect(waitForPre060Planes(db, { now: () => new Date(clock), sleep })).rejects.toThrow(/before migration 060/);
  });

  it("does not wait for a lease that names a holder, or one already expired", async () => {
    lease("2999-01-01T00:00:00.000Z", "inc_x");
    await waitForPre060Planes(db, { sleep: async () => { throw new Error("must not wait"); } });
    db.prepare("UPDATE runs SET lease_incarnation = NULL, lease_expires_at = '2000-01-01T00:00:00.000Z'").run();
    await waitForPre060Planes(db, { sleep: async () => { throw new Error("must not wait"); } });
  });

  it("boot clears every unfinished session's lease and recorded holder", () => {
    lease("2999-01-01T00:00:00.000Z", "inc_x");
    expect(new SessionStore(db).voidAllLeases()).toBe(1);
    expect(db.prepare("SELECT lease_token, lease_expires_at, lease_incarnation FROM runs WHERE id = 'run_old'").get())
      .toEqual({ lease_token: null, lease_expires_at: null, lease_incarnation: null });
  });
});
