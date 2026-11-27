/**
 * #272 review (Codex, 2026-11-27, round 4): the regression tests that survive round 5. Findings 1, 2
 * and 4 (overlapping planes) are superseded by the workspace lock: see `qcq-04b-part1-review-r5.test.ts`.
 *
 *   3. A missing /proc mount is not proof that a process is gone.
 *   5. The boot reaper keeps a unit's tracking record until the unit reads absent or empty, however
 *      the installed wrapper answered the stop.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { openDb, type Db } from "../src/db/index.js";
import { configureExitProofs, incarnationState, stopExitWatches } from "../src/modules/attempts.js";
import { FakeExitEvidence, SystemExitEvidence, setExitEvidence } from "../src/modules/exit-evidence.js";
import { AGENT_UNITS_DIR } from "../src/modules/harness/provider-processes.js";
import { buildServer, type BuiltServer } from "../src/server.js";

let dir: string; let db: Db; let ev: FakeExitEvidence;
const dbs: Db[] = [];
function open(path = join(dir, "t.db")): Db {
  const d = openDb(path); dbs.push(d);
  setExitEvidence(d, ev);
  return d;
}
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "qcq-04b-r272-r4-"));
  ev = new FakeExitEvidence();
  db = open();
  db.prepare("INSERT INTO assistants (id, provider) VALUES ('a1','fake')").run();
  db.prepare("INSERT INTO tasks (id, goal, envelope, created_at, updated_at) VALUES ('AG-1','g','{}','t','t')").run();
  configureExitProofs(db, { watchMs: 5, stopEvidenceMs: 150 });
});
afterEach(() => {
  for (const d of dbs.splice(0)) { if (d.open) { stopExitWatches(d); d.close(); } }
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("finding 3: a missing /proc mount does not make a live holder look dead", () => {
  it("reads every pid as unreadable when procfs is not there, and gone only when this process is listed", () => {
    const absent = new SystemExitEvidence({ procRoot: join(dir, "no-proc") });
    expect(absent.processStart(4242)).toBe("unreadable"); // before the fix: null (gone)
    const proc = join(dir, "proc"); mkdirSync(join(proc, String(process.pid)), { recursive: true });
    expect(new SystemExitEvidence({ procRoot: proc }).processStart(4242)).toBeNull();
  });

  it("another plane's incarnation stays alive on a host with no procfs", () => {
    db.prepare("INSERT INTO plane_incarnations (incarnation_id, pid, proc_start, boot_id, started_at) VALUES ('inc_other', 424242, '99', 'unavailable', 't')").run();
    setExitEvidence(db, new SystemExitEvidence({ procRoot: join(dir, "no-proc") }));
    expect(incarnationState(db, "inc_other")).toBe("alive");
  });
});

describe("finding 5: the reaper keeps a unit's record until the unit is gone", () => {
  let home: string; let built: BuiltServer | undefined; let d: Db;
  afterEach(async () => {
    if (built) { await built.orchestrator.shutdown(); await built.app.close(); built = undefined; }
    if (d?.open) { stopExitWatches(d); d.close(); }
    if (home) rmSync(home, { recursive: true, force: true });
  });

  it("a stop the wrapper answered with success, over a scope that is still populated, is retried next boot", async () => {
    home = mkdtempSync(join(tmpdir(), "qcq-04b-r272-r4-reap-"));
    const config = loadConfig({ AGENT_PLANE_HOME: home });
    config.execution.harnessModes.single = true;
    d = openDb(config.dbPath); built = buildServer({ config, db: d });
    setExitEvidence(d, ev);
    const unit = "aos-run-ses_pre.scope";
    ev.units.set(unit, "populated"); // the wrapper swallowed a failed `systemctl stop`
    const dirOf = join(config.dir, AGENT_UNITS_DIR); mkdirSync(dirOf, { recursive: true });
    const file = join(dirOf, "3999999");
    writeFileSync(file, "ses_pre\n");

    await built.orchestrator.reconcileOnBoot();
    expect(ev.stopped).toEqual([unit]);
    expect(existsSync(file)).toBe(true); // before the fix: removed, and nothing ever retried
    ev.units.set(unit, "empty");
    ev.stopped.length = 0;
    await built.orchestrator.reconcileOnBoot();
    expect(ev.stopped).toEqual([unit]);
    expect(existsSync(file)).toBe(false);
  });
});
