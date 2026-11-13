/**
 * P0-3 (docs/agentic-os-auto-copilot-plan.md §C.2.6, §C.2.5): the host gate and the close
 * schedule.
 *
 * G8 off-host: a cgroup v2 tree laid out like `user-<uid>.slice` on a fixture directory. The next
 * launch is refused `host_busy` when a child is still alive after settlement, when a process was
 * moved to another cgroup in the slice, when `cgroup.events` is unreadable, and when the disk is
 * below the floor; then the same four through the real scheduler and launch check. The real
 * kernel tree and the close timer (G20) run on the OCI box: `docs/autopilot/p0-3-host-drive.md`.
 */
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AGENT_USER_DEFAULTS, ADMISSION_DEFAULTS, loadConfig, type AdmissionConfig } from "../src/config.js";
import { agentSliceCensus, hostGate, hostGateFromConfig, readCloseSchedule, writeCloseSchedule, type HostProbes } from "../src/modules/host-admission.js";
import { bootRig, type Rig } from "./helpers/composer-cockpit.js";

const UID = 1002;
const GB = 1024 ** 3;
let root: string;
let probes: HostProbes;
let load = 0.2;
let mem = 4 * GB;
let disk = 40 * GB;

/** A cgroup directory: `populated` and `cgroup.procs`, as the kernel shows them. */
function cg(rel: string, pids: number[] = [], populated?: boolean) {
  const dir = join(root, "sys", "user.slice", `user-${UID}.slice`, rel);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "cgroup.procs"), pids.map((p) => `${p}\n`).join(""));
  writeFileSync(join(dir, "cgroup.events"), `populated ${(populated ?? pids.length > 0) ? 1 : 0}\nfrozen 0\n`);
}
function comm(pid: number, name: string) {
  mkdirSync(join(root, "proc", String(pid)), { recursive: true });
  writeFileSync(join(root, "proc", String(pid), "comm"), `${name}\n`);
}
/** Propagate `populated` upwards, as the kernel's recursive flag does. */
function settle() {
  const walk = (dir: string): boolean => {
    let any = readFileSync(join(dir, "cgroup.procs"), "utf8").trim().length > 0;
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory() && walk(join(dir, e.name))) any = true;
    }
    writeFileSync(join(dir, "cgroup.events"), `populated ${any ? 1 : 0}\nfrozen 0\n`);
    return any;
  };
  walk(join(root, "sys", "user.slice", `user-${UID}.slice`));
}
/** The idle agent slice with linger on: only the user manager, in init.scope. */
function idleSlice() {
  cg("");
  cg(`user@${UID}.service`);
  cg(`user@${UID}.service/init.scope`, [900, 901]);
  cg(`user@${UID}.service/app.slice`);
  comm(900, "systemd");
  comm(901, "(sd-pam)");
  settle();
}
const admission = (over: Partial<AdmissionConfig> = {}): AdmissionConfig => ({ ...ADMISSION_DEFAULTS, diskPath: "/var/lib/aos/worktrees", ...over });

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "host-admission-"));
  mkdirSync(join(root, "etc"), { recursive: true });
  writeFileSync(join(root, "etc", "passwd"), `root:x:0:0::/root:/bin/bash\nubuntu:x:1001:1001::/home/ubuntu:/bin/bash\naos-agent:x:${UID}:1003::/home/aos-agent:/usr/sbin/nologin\n`);
  load = 0.2; mem = 4 * GB; disk = 40 * GB;
  probes = {
    cgroupRoot: join(root, "sys"), procRoot: join(root, "proc"), passwdPath: join(root, "etc", "passwd"),
    load1: () => load, cpuCount: () => 1, memAvailable: () => mem, diskFree: () => disk,
  };
  idleSlice();
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const gate = (over: Partial<AdmissionConfig> = {}) => hostGate({ admission: admission(over), agentUser: "aos-agent", probes });

describe("host gate (G8, off-host)", () => {
  it("admits an idle slice holding only the user manager", () => {
    expect(agentSliceCensus(probes, UID)).toEqual([]);
    expect(gate()).toEqual({ ok: true });
  });

  it("child alive after settlement: a scope that outlived its session refuses", () => {
    cg(`user@${UID}.service/app.slice/aos-run-t1.scope`, [4242]);
    settle();
    const r = gate();
    expect(r).toMatchObject({ ok: false, detail: expect.stringContaining("aos-run-t1.scope: 1 process(es)") });
  });

  it("a process moved to another cgroup in the slice refuses, wherever it went", () => {
    cg(`user@${UID}.service/app.slice/hidden.service`, [5000]);
    settle();
    expect(gate()).toMatchObject({ ok: false, detail: expect.stringContaining("hidden.service") });

    idleSlice();
    rmSync(join(root, "sys", "user.slice", `user-${UID}.slice`, `user@${UID}.service`, "app.slice", "hidden.service"), { recursive: true });
    cg("session-3.scope", [5001]); // a login session of the agent user, outside its manager
    settle();
    expect(gate()).toMatchObject({ ok: false, detail: expect.stringContaining("session-3.scope") });
  });

  it("a process moved into the manager's init.scope refuses", () => {
    cg(`user@${UID}.service/init.scope`, [900, 901, 5002]);
    comm(5002, "bash");
    settle();
    expect(gate()).toMatchObject({ ok: false, detail: expect.stringContaining("init.scope: 3 process(es), not only the user manager") });
    // Same count as the manager, but one of them is not the manager.
    cg(`user@${UID}.service/init.scope`, [900, 5002]);
    settle();
    expect(gate()).toMatchObject({ ok: false });
  });

  it("an unreadable cgroup.events throws (the launch check maps a throw to host_busy)", () => {
    const events = join(root, "sys", "user.slice", `user-${UID}.slice`, `user@${UID}.service`, "cgroup.events");
    rmSync(events);
    expect(() => gate()).toThrow(/cgroup\.events/);
    writeFileSync(events, "frozen 0\n");
    expect(() => gate()).toThrow(/no populated line/);
    // A missing slice (no linger, no agent user) is unreadable too, never "empty".
    rmSync(join(root, "sys", "user.slice"), { recursive: true });
    expect(() => gate()).toThrow();
  });

  it("disk below the floor refuses; so do load and memory", () => {
    disk = 4 * GB;
    expect(gate()).toMatchObject({ ok: false, detail: expect.stringMatching(/free disk on \/var\/lib\/aos\/worktrees 4096 MB is below 5120 MB/) });
    disk = 40 * GB; mem = 512 * 1024 * 1024;
    expect(gate()).toMatchObject({ ok: false, detail: expect.stringContaining("available memory 512 MB") });
    mem = 4 * GB; load = 2;
    expect(gate()).toMatchObject({ ok: false, detail: expect.stringContaining("load 2.00 per CPU") });
    load = Number.NaN;
    expect(() => gate()).toThrow(/load average unreadable/);
  });

  it("an unknown agent user is unreadable", () => {
    expect(() => hostGate({ admission: admission(), agentUser: "nobody-here", probes })).toThrow(/no uid/);
  });
});

describe("close schedule", () => {
  it("is written atomically, 0640, and drops windows closed over a day ago", () => {
    const path = join(root, "windows");
    const now = new Date("2030-01-02T12:00:00Z");
    writeCloseSchedule(path, [
      { opensAt: "2030-01-02T22:00:00.000Z", closesAt: "2030-01-03T05:00:00.000Z" },
      { opensAt: "2029-12-30T22:00:00.000Z", closesAt: "2029-12-31T05:00:00.000Z" },
      { opensAt: "2030-01-01T22:00:00.000Z", closesAt: "2030-01-02T05:00:00.000Z" },
    ], now);
    expect(statSync(path).mode & 0o777).toBe(0o640);
    expect(readCloseSchedule(path)).toEqual([
      { opens: Date.parse("2030-01-01T22:00:00Z") / 1000, closes: Date.parse("2030-01-02T05:00:00Z") / 1000 },
      { opens: Date.parse("2030-01-02T22:00:00Z") / 1000, closes: Date.parse("2030-01-03T05:00:00Z") / 1000 },
    ]);
    expect(readFileSync(path, "utf8")).toMatch(/^# aos close schedule/);
  });

  it("the gate refuses when the schedule does not list the open window's close", () => {
    const path = join(root, "windows");
    const closesAt = "2030-01-03T05:00:00.000Z";
    const g = (w: string | undefined) => hostGate({ admission: admission(), agentUser: "aos-agent", probes, closeSchedule: path, openWindowClosesAt: () => w });
    expect(() => g(closesAt)).toThrow(); // no schedule at all: unreadable
    writeCloseSchedule(path, [{ opensAt: "2030-01-02T22:00:00.000Z", closesAt: "2030-01-03T04:00:00.000Z" }], new Date("2030-01-02T22:00:00Z"));
    expect(g(closesAt)).toMatchObject({ ok: false, detail: expect.stringContaining("does not list this window's close") });
    writeCloseSchedule(path, [{ opensAt: "2030-01-02T22:00:00.000Z", closesAt }], new Date("2030-01-02T22:00:00Z"));
    expect(g(closesAt)).toEqual({ ok: true });
  });
});

describe("scheduler.admission config", () => {
  let home: string;
  beforeEach(() => { home = mkdtempSync(join(tmpdir(), "admission-cfg-")); chmodSync(home, 0o700); });
  afterEach(() => rmSync(home, { recursive: true, force: true }));
  const load = (yaml: string) => {
    mkdirSync(join(home, "w"), { recursive: true, mode: 0o700 });
    writeFileSync(join(home, "w", "config.yaml"), yaml);
    return loadConfig({ AGENT_PLANE_HOME: home, AGENT_PLANE_WORKSPACE: "w" } as NodeJS.ProcessEnv);
  };

  it("fills defaults per pool; diskPath follows the agent worktrees", () => {
    const c = load("execution:\n  harnessModes: { single: true }\n  agentUser: {}\nscheduler:\n  enabled: true\n  resources: { oci-heavy: 1 }\n  admission:\n    oci-heavy: { minFreeDiskMb: 8000 }\n");
    expect(c.scheduler!.admission!["oci-heavy"]).toEqual({ ...ADMISSION_DEFAULTS, minFreeDiskMb: 8000, diskPath: AGENT_USER_DEFAULTS.worktreesRoot });
    expect(c.scheduler!.resources).toEqual({ "oci-heavy": 1 });
    expect(c.execution.agentUser!.closeSchedule).toBe("/var/lib/aos/schedule/windows");
  });

  it("refuses an undeclared pool, an unknown key and a bad value", () => {
    expect(() => load("scheduler:\n  enabled: true\n  admission:\n    oci-heavy: {}\n")).toThrow(/not declared in scheduler.resources/);
    expect(() => load("scheduler:\n  enabled: true\n  resources: { p: 1 }\n  admission:\n    p: { maxLoad: 2 }\n")).toThrow(/unknown key\(s\): maxLoad/);
    expect(() => load("scheduler:\n  enabled: true\n  resources: { p: 1 }\n  admission:\n    p: { minFreeMemMb: -1 }\n")).toThrow(/positive number/);
    expect(() => load("scheduler:\n  enabled: true\n  resources: { p: 1 }\n  admission:\n    p: { diskPath: rel/x }\n")).toThrow(/absolute, normalized/);
  });
});

/* ------------------------------------------- through the launch check -- */

const T0 = Date.parse("2030-01-01T23:00:00.000Z");
const MIN = 60_000;
let rig: Rig | undefined;
let instant = T0;
afterEach(async () => { await rig?.close(); rig = undefined; instant = T0; });

async function boot(real: "fixture" | "default") {
  rig = await bootRig({
    now: () => new Date(instant),
    requireRevision: true,
    assistants: { "fake-claude": { provider: "fake", options: { agentUser: true } } },
    configure: (config) => {
      const tree = join(config.dir, "..", "aos");
      mkdirSync(join(tree, "worktrees"), { recursive: true });
      mkdirSync(join(tree, "profiles"), { recursive: true });
      mkdirSync(join(tree, "schedule"), { recursive: true });
      chmodSync(join(tree, "profiles"), 0o2750);
      config.execution.agentUser = { ...AGENT_USER_DEFAULTS, profilesRoot: join(tree, "profiles"), worktreesRoot: join(tree, "worktrees"), closeSchedule: join(tree, "schedule", "windows") };
      config.scheduler = { ...config.scheduler!, resources: { "oci-heavy": 1 } };
      if (real === "fixture") config.scheduler.admission = { "oci-heavy": admission({ diskPath: join(tree, "worktrees") }) };
    },
    // "default": nothing injected, so the server builds the real gate from config.
    ...(real === "fixture" ? { autopilotHostGate: () => hostGateFromConfig(rig!.config, { windows: () => rig!.built.autopilot.windows(), openWindow: () => rig!.built.autopilot.openWindow(), now: () => new Date(instant) }, probes)() } : {}),
  });
  return rig;
}
const ap = () => rig!.built.autopilot;
const at = (ms: number) => new Date(ms).toISOString();
function openAndAdmit() {
  ap().addWindow({ opensAt: at(instant - MIN), closesAt: at(instant + 8 * 60 * MIN), maxItems: 3 }, "op_test");
  ap().attest({ extraUsageOff: true, autoReloadOff: true }, "op_test");
  ap().start("op_test");
  const reserved = ap().reserve({ itemId: "item-1", reservationId: "res-1", reservationSha: "0".repeat(40) });
  return ap().admit(reserved.id, { goal: "Ship the feature", repoPath: rig!.repo }).taskId!;
}
async function sweep(taskId: string, states: readonly string[]) {
  const moved = new Promise<string>((resolve) => {
    const off = rig!.built.bus.subscribe(taskId, (p) => { if (p.kind === "state" && states.includes(p.state!.state)) { off(); resolve(p.state!.state); } });
  });
  await rig!.built.scheduler.tick();
  return moved;
}
const parked = (taskId: string) => rig!.built.scheduler.events(taskId).filter((e) => e.type === "autopilot.parked").map((e) => e.payload);
const runs = (taskId: string) => rig!.db.prepare("SELECT id FROM runs WHERE task_id = ?").all(taskId);
const SETTLED = ["COMPLETED", "FAILED", "CANCELLED", "WAITING_INPUT"] as const;

describe("host gate through the launch check (G8)", () => {
  it("refuses host_busy in all four G8 cases, starts nothing, and launches once the host is clear", async () => {
    await boot("fixture");
    const taskId = openAndAdmit();
    const events = join(root, "sys", "user.slice", `user-${UID}.slice`, `user@${UID}.service`, "cgroup.events");
    const cases: Array<[string, () => void, () => void, RegExp]> = [
      ["child alive", () => { cg(`user@${UID}.service/app.slice/aos-run-old.scope`, [4242]); settle(); }, () => { rmSync(join(root, "sys", "user.slice", `user-${UID}.slice`, `user@${UID}.service`, "app.slice", "aos-run-old.scope"), { recursive: true }); settle(); }, /aos-run-old\.scope/],
      ["moved", () => { cg(`user@${UID}.service/app.slice/hidden.service`, [5000]); settle(); }, () => { rmSync(join(root, "sys", "user.slice", `user-${UID}.slice`, `user@${UID}.service`, "app.slice", "hidden.service"), { recursive: true }); settle(); }, /hidden\.service/],
      ["unreadable", () => rmSync(events), () => settle(), /unreadable/],
      ["disk", () => { disk = GB; }, () => { disk = 40 * GB; }, /free disk/],
    ];
    for (const [, close, clear, detail] of cases) {
      close();
      expect(await sweep(taskId, ["WAITING_RESOURCE"])).toBe("WAITING_RESOURCE");
      expect(parked(taskId).at(-1)).toMatchObject({ reason: "host_busy", park: "time", detail: expect.stringMatching(detail) });
      expect(runs(taskId)).toHaveLength(0);
      clear();
      instant += 2 * MIN + 1000;
    }
    expect(await sweep(taskId, SETTLED)).toBe("COMPLETED");
    // The check wrote the close timer's schedule for the window the plane holds.
    expect(readCloseSchedule(rig!.config.execution.agentUser!.closeSchedule)).toEqual([{ opens: (T0 - MIN) / 1000, closes: (T0 + 8 * 60 * MIN) / 1000 }]);
  });

  it("refuses when the close schedule cannot be written, so nothing runs that the timer does not know about", async () => {
    await boot("fixture");
    rmSync(join(rig!.config.dir, "..", "aos", "schedule"), { recursive: true });
    const taskId = openAndAdmit();
    expect(await sweep(taskId, ["WAITING_RESOURCE"])).toBe("WAITING_RESOURCE");
    expect(parked(taskId)[0]).toMatchObject({ reason: "host_busy", detail: expect.stringMatching(/unreadable/) });
    expect(runs(taskId)).toHaveLength(0);
  });

  it("the default wiring is fail-closed without scheduler.admission", async () => {
    await boot("default");
    const taskId = openAndAdmit();
    expect(await sweep(taskId, ["WAITING_RESOURCE"])).toBe("WAITING_RESOURCE");
    expect(parked(taskId)[0]).toMatchObject({ reason: "host_busy", detail: "scheduler.admission.oci-heavy is not configured" });
    expect(runs(taskId)).toHaveLength(0);
  });
});
