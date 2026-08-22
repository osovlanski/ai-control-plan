import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { openDb } from "../src/db/index.js";
import { Registry } from "../src/modules/registry.js";
import { EventRetention } from "../src/modules/retention.js";
import { msUntilDailyHour, scheduleDailyJobs } from "../src/modules/jobs.js";
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function setup() {
  const home = mkdtempSync(join(tmpdir(), "agent-plane-p3-")); dirs.push(home);
  mkdirSync(join(home, "personal")); writeFileSync(join(home, "personal", "config.yaml"), "assistants:\n  personal-fake:\n    provider: fake\n");
  const config = loadConfig({ AGENT_PLANE_HOME: home }); const db = openDb(config.dbPath);
  return { db, config };
}
describe("Phase 3 jobs", () => {
  it("skips describe while the fingerprint is unchanged, and re-describes when it moves", async () => {
    const { db, config } = setup(); let models = ["fake-1"];
    const registry = new Registry(db, config, async () => ({ fingerprint: models.join(","), version: "1.0", authState: "ok", models, configHash: models.join(",") }));
    registry.init(); const describe = vi.spyOn(registry.adapter("personal-fake"), "describe");
    await registry.syncChanged("personal-fake"); await registry.syncChanged("personal-fake");
    expect(describe).toHaveBeenCalledTimes(1);
    models = ["fake-1", "fake-2"]; await registry.syncChanged("personal-fake");
    expect(describe).toHaveBeenCalledTimes(2);
    // The probe reports what it uniquely knows (config identity). Capability
    // changes themselves come from describe() via sync()'s manifest diff, so a
    // config edit that does not change what the assistant can do is recorded
    // as a config change — not as a phantom model change.
    expect(registry.recentChanges()).toEqual(
      expect.arrayContaining([expect.objectContaining({ field: "provider.configHash" })]),
    );
    expect(registry.recentChanges()).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ field: "core.models" })]),
    );
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

describe("capability probe vs. adapter authority", () => {
  it("keeps describe()'s auth answer when the probe cannot see env credentials", async () => {
    const { db, config } = setup();
    // The real-world shape of the bug: the adapter authenticates via an env
    // var, the file-only probe sees nothing. Lower-priority local-config
    // evidence must not overwrite the runtime probe's answer, or the router
    // hard-filters a perfectly usable assistant.
    const registry = new Registry(db, config, async () => ({
      fingerprint: "fp-1",
      version: "1.0",
      authState: "missing",
      models: [],
      configHash: "abc",
    }));
    registry.init();
    await registry.syncChanged("personal-fake");

    const manifest = registry.manifest("personal-fake")!;
    expect(manifest.core.auth.state).toBe("ok"); // from describe(), not the probe
    expect(manifest.providerDetail.version).toBe("1.0"); // probe still enriches
    db.close();
  });

  it("does not let a config scrape replace the adapter's model list", async () => {
    const { db, config } = setup();
    const registry = new Registry(db, config, async () => ({
      fingerprint: "fp-1",
      version: "1.0",
      authState: "ok",
      models: ["scraped-from-config"],
      configHash: "abc",
    }));
    registry.init();
    await registry.syncChanged("personal-fake");

    expect(registry.manifest("personal-fake")!.core.models.map((m) => m.id)).toEqual(["fake-1"]);
    db.close();
  });

  it("never uses a synchronous spawn, which would freeze the whole API", () => {
    // Asserted structurally rather than by timing, on purpose. "Does not block
    // the event loop" is unobservable when the spawn is instant, and the spawn
    // IS instant wherever the CLI is absent (it fails with ENOENT in a
    // microtask). A setImmediate race therefore passes or fails depending on
    // whether `claude` happens to be installed — which is nothing to do with
    // the property under test. The property that matters is that this module
    // never reaches for the synchronous API: execFileSync on the boot and
    // daily-job path froze every request, SSE stream and in-flight run for up
    // to the 5s timeout, per provider.
    const source = readFileSync(new URL("../src/modules/capability-probe.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/\bexecFileSync\b/);
    expect(source).toMatch(/promisify\(execFile\)/);
  });

  it("degrades to a well-formed result when the provider CLI is not installed", async () => {
    // The CI environment has no provider CLIs, which makes it the right place
    // to assert this: a missing binary must produce "unavailable", not a throw
    // that would take the daily sync down with it.
    const { probeCapability } = await import("../src/modules/capability-probe.js");
    const probe = await probeCapability("anthropic");
    expect(probe.fingerprint).toBeTruthy();
    expect(typeof probe.version).toBe("string");
    expect(probe.version.length).toBeGreaterThan(0);

    // An unknown provider has no CLI to interrogate at all.
    const unknown = await probeCapability("not-a-real-provider");
    expect(unknown.version).toBe("in-process");
  });
});

describe("daily job resilience", () => {
  it("survives a failing job, reports it, and still reschedules", async () => {
    const { db, config } = setup();
    const registry = new Registry(db, config, async () => {
      throw new Error("probe exploded");
    });
    registry.init();
    const retention = {
      archive: () => {
        throw new Error("archive exploded");
      },
    } as unknown as EventRetention;
    const errors: string[] = [];

    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-22T06:00:00"));
    const stop = scheduleDailyJobs(7, registry, retention, {
      error: (_detail, message) => errors.push(message),
    });

    // First firing: both halves throw. Neither may escape as an unhandled
    // throw (that would kill the API process), and the job must re-arm.
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000 + 100);
    expect(errors).toEqual(["daily capability sync failed", "daily event retention failed"]);

    // Second firing proves the reschedule survived the failure.
    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);
    expect(errors).toHaveLength(4);

    stop();
    vi.useRealTimers();
    db.close();
  });
});
