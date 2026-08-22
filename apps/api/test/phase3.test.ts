import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { openDb } from "../src/db/index.js";
import { Registry } from "../src/modules/registry.js";
import { EventRetention } from "../src/modules/retention.js";
import { msUntilDailyHour } from "../src/modules/jobs.js";
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function setup() {
  const home = mkdtempSync(join(tmpdir(), "agent-plane-p3-")); dirs.push(home);
  mkdirSync(join(home, "personal")); writeFileSync(join(home, "personal", "config.yaml"), "assistants:\n  personal-fake:\n    provider: fake\n");
  const config = loadConfig({ AGENT_PLANE_HOME: home }); const db = openDb(config.dbPath);
  return { db, config };
}
describe("Phase 3 jobs", () => {
  it("skips describe while the cheap fingerprint is unchanged and records model changes", async () => {
    const { db, config } = setup(); let models = ["fake-1"];
    const registry = new Registry(db, config, async () => ({ fingerprint: models.join(","), version: "1.0", authState: "ok", models, configHash: "abc" }));
    registry.init(); const describe = vi.spyOn(registry.adapter("personal-fake"), "describe");
    await registry.syncChanged("personal-fake"); await registry.syncChanged("personal-fake");
    expect(describe).toHaveBeenCalledTimes(1);
    models = ["fake-1", "fake-2"]; await registry.syncChanged("personal-fake");
    expect(describe).toHaveBeenCalledTimes(2);
    expect(registry.recentChanges()).toEqual(expect.arrayContaining([expect.objectContaining({ field: "core.models", new_value: "fake-1,fake-2" })]));
    db.close();
  });
  it("gzip-archives old terminal-task events transactionally", () => {
    const { db } = setup();
    db.prepare("INSERT INTO assistants(id,provider) VALUES('a','fake')").run();
    db.prepare("INSERT INTO tasks(id,goal,state,envelope,created_at,updated_at) VALUES('t','g','COMPLETED','{}','2020-01-01','2020-01-01')").run();
    db.prepare("INSERT INTO runs(id,task_id,assistant_id,state,started_at) VALUES('r','t','a','ENDED_OK','2020-01-01')").run();
    db.prepare("INSERT INTO events(run_id,seq,ts,type,summary,payload,raw) VALUES('r',1,'2020-01-01','message','safe','{}','{}')").run();
    const retention = new EventRetention(db); expect(retention.archive(new Date("2020-03-01"))).toEqual({ tasks: 1, events: 1 });
    expect(db.prepare("SELECT COUNT(*) n FROM events").get()).toEqual({ n: 0 });
    expect(retention.events("t")).toHaveLength(1); db.close();
  });
  it("schedules the next local configured hour", () => {
    expect(msUntilDailyHour(7, new Date("2026-08-22T06:30:00"))).toBe(30 * 60 * 1000);
  });
});
