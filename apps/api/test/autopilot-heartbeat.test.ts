/**
 * P0-7a (docs/agentic-os-auto-copilot-plan.md §C.5, D-14): the external heartbeat. The ping goes
 * to a fake fetch; the gap figures in the morning report are re-derived from the injected clock.
 */
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AGENT_USER_DEFAULTS, loadConfig } from "../src/config.js";
import type { MorningReport } from "../src/modules/autopilot-report.js";
import type { HeartbeatFetch } from "../src/modules/autopilot-heartbeat.js";
import { bootRig, type Rig } from "./helpers/composer-cockpit.js";

const T0 = Date.parse("2030-01-01T23:00:00.000Z");
const MIN = 60_000;
const INTERVAL = 10 * MIN;
const URL = "https://hc.example.invalid/ping/FAKE-check-not-real";
let rig: Rig | undefined;
let instant = T0;
const now = () => new Date(instant);
const at = (ms: number) => new Date(ms).toISOString();

afterEach(async () => {
  await rig?.close();
  rig = undefined;
  instant = T0;
});

interface Call { url: string; method: string; redirect: string }
async function boot(opts: { urlFileMode?: number; answer?: () => number | Error } = {}) {
  const calls: Call[] = [];
  let answer = opts.answer ?? (() => 200);
  const fetch: HeartbeatFetch = async (url, init) => {
    calls.push({ url, method: init.method, redirect: init.redirect });
    const a = answer();
    if (a instanceof Error) throw a;
    return { status: a };
  };
  rig = await bootRig({
    now,
    requireRevision: true,
    assistants: { "fake-claude": { provider: "fake", options: { agentUser: true } } },
    configure: (config) => {
      const tree = join(config.dir, "..", "aos");
      mkdirSync(join(tree, "worktrees"), { recursive: true });
      mkdirSync(join(tree, "profiles"), { recursive: true });
      chmodSync(join(tree, "profiles"), 0o2750);
      config.execution.agentUser = { ...AGENT_USER_DEFAULTS, profilesRoot: join(tree, "profiles"), worktreesRoot: join(tree, "worktrees") };
      config.scheduler = { ...config.scheduler!, resources: { "oci-heavy": 1 } };
      const urlFile = join(config.dir, "heartbeat-url");
      writeFileSync(urlFile, `${URL}\n`);
      chmodSync(urlFile, opts.urlFileMode ?? 0o600);
      config.autopilot.heartbeat = { urlFile, intervalMs: INTERVAL };
    },
    autopilotHostGate: () => ({ ok: true }),
    autopilotHeartbeatFetch: fetch,
  });
  return { calls, setAnswer: (f: () => number | Error) => { answer = f; } };
}

const post = (url: string, body: unknown = {}) => rig!.built.app.inject({ method: "POST", url, headers: rig!.auth(), payload: body as object });
const tick = () => rig!.built.heartbeat!.tick();
const ledger = () => rig!.db.prepare("SELECT at, kind, ok, http_status, error FROM autopilot_heartbeats ORDER BY id").all() as Array<{ at: string; kind: string; ok: number | null; http_status: number | null; error: string | null }>;
const report = async () => {
  const res = await rig!.built.app.inject({ method: "GET", url: "/api/autopilot/report", headers: rig!.auth() });
  const text = await rig!.built.app.inject({ method: "GET", url: "/api/autopilot/report?format=text", headers: rig!.auth() });
  return { body: res.json() as MorningReport, text: text.body };
};

describe("autopilot external heartbeat (P0-7a, D-14)", () => {
  it("pings only while the autopilot is live, as a bare GET that refuses redirects, and never stores the URL", async () => {
    const { calls } = await boot();
    await tick();
    expect(calls).toHaveLength(0); // stopped since boot: no ping, no row
    expect(ledger()).toEqual([]);

    rig!.built.autopilot.addWindow({ opensAt: at(instant - MIN), closesAt: at(instant + 8 * 60 * MIN), maxItems: 3 }, "op_test");
    rig!.built.autopilot.start("op_test");
    await tick();
    expect(calls[0]).toEqual({ url: URL, method: "GET", redirect: "error" });
    instant += INTERVAL;
    await tick();
    expect(ledger().filter((r) => r.kind === "ping")).toHaveLength(calls.length);

    expect((await post("/api/autopilot/stop", { mode: "now" })).statusCode).toBe(200);
    await tick();
    const rows = ledger();
    expect(rows.at(-1)).toMatchObject({ kind: "paused", ok: null });
    expect(rows.filter((r) => r.kind === "paused")).toHaveLength(1); // only once per ping run
    expect(JSON.stringify(rows)).not.toContain("FAKE-check-not-real");
  });

  it("reports a dead plane's silence and failed pings as gaps, and stopped time as none", async () => {
    const { setAnswer } = await boot();
    const opens = instant - MIN;
    rig!.built.autopilot.addWindow({ opensAt: at(opens), closesAt: at(instant + 8 * 60 * MIN), maxItems: 3 }, "op_test");
    rig!.built.autopilot.start("op_test");
    await tick(); // 23:00 ok
    instant += INTERVAL; await tick(); // 23:10 ok
    // The plane is down for 50 minutes: no ticks at all.
    instant += 50 * MIN; await tick(); // 00:00 ok -> a silence gap 23:10 → 00:00
    setAnswer(() => 503);
    instant += INTERVAL; await tick(); // 00:10 fails
    setAnswer(() => new TypeError("fetch failed for https://hc.example.invalid/ping/FAKE-check-not-real"));
    instant += INTERVAL; await tick(); // 00:20 fails
    setAnswer(() => 200);
    instant += INTERVAL; await tick(); // 00:30 ok -> a failed gap 00:10 → 00:30
    rig!.built.autopilot.stop("now");
    instant += INTERVAL; await tick(); // 00:40 paused
    instant += 3 * 60 * MIN; // stopped for three hours: not a gap

    const errors = ledger().filter((r) => r.ok === 0).map((r) => r.error);
    expect(errors).toEqual(["http 503", "ping failed (TypeError)"]);

    const { body, text } = await report();
    expect(body.heartbeat).toEqual({
      tracked: true, intervalMs: INTERVAL, pings: 6, failed: 2,
      gaps: [
        { kind: "silence", from: at(T0 + INTERVAL), to: at(T0 + INTERVAL + 50 * MIN), ms: 50 * MIN },
        { kind: "failed", from: at(T0 + 70 * MIN), to: at(T0 + 90 * MIN), ms: 20 * MIN },
      ],
      detail: expect.any(String),
    });
    expect(text).toContain("Heartbeat: 6 ping(s), 2 failed; gaps 2");
    expect(text).toContain("silence 2030-01-01T23:10:00.000Z → 2030-01-02T00:00:00.000Z (50m)");
    expect(text).not.toContain("FAKE-check-not-real");
  });

  it("reports trailing silence after the last ping when the plane died and never came back", async () => {
    await boot();
    rig!.built.autopilot.addWindow({ opensAt: at(instant), closesAt: at(instant + 2 * 60 * MIN), maxItems: 3 }, "op_test");
    rig!.built.autopilot.start("op_test");
    await tick(); // 23:00, then nothing until the window closed at 01:00
    instant += 5 * 60 * MIN;
    const { body } = await report();
    expect(body.heartbeat.gaps).toEqual([{ kind: "silence", from: at(T0), to: at(T0 + 120 * MIN), ms: 120 * MIN }]);
  });

  it("records a loose url file as a failed ping without calling out", async () => {
    const { calls } = await boot({ urlFileMode: 0o644 });
    rig!.built.autopilot.start("op_test");
    await tick();
    expect(calls).toHaveLength(0);
    expect(ledger()).toEqual([expect.objectContaining({ kind: "ping", ok: 0, error: "heartbeat url file must be a regular file of this user with mode 0600 or tighter" })]);
  });

  it("validates autopilot.heartbeat in config, defaulting the interval to 10 minutes", () => {
    const home = mkdtempSync(join(tmpdir(), "hb-config-"));
    mkdirSync(join(home, "personal"), { recursive: true });
    const load = (yaml: string) => { writeFileSync(join(home, "personal", "config.yaml"), yaml); return loadConfig({ AGENT_PLANE_HOME: home }); };
    expect(load("autopilot:\n  heartbeat:\n    urlFile: /run/aos/hb\n").autopilot.heartbeat).toEqual({ urlFile: "/run/aos/hb", intervalMs: INTERVAL });
    expect(load("autopilot: {}\n").autopilot.heartbeat).toBeUndefined();
    expect(() => load("autopilot:\n  heartbeat:\n    urlFile: rel/hb\n")).toThrow(/urlFile must be an absolute path/);
    expect(() => load("autopilot:\n  heartbeat:\n    urlFile: /hb\n    intervalMs: 1000\n")).toThrow(/at least 60000/);
    expect(() => load("autopilot:\n  heartbeat:\n    urlFile: /hb\n    url: https://x\n")).toThrow(/unknown key/);
  });
});
