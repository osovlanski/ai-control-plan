/**
 * qcq-04b: `SystemExitEvidence` against fake cgroup v2 and `/proc` trees (packet 2.6.1), and the
 * launcher argv forms, including the agent wrapper's exec window (test 5 r6): after the wrapper's
 * `exec systemd-run`, argv carries `--unit=aos-run-<id>` while the scope does not exist yet.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SystemExitEvidence, attemptUnit, launcherArgv } from "../src/modules/exit-evidence.js";

let root: string, cgroup: string, proc: string, runtime: string, bin: string;
const uid = typeof process.getuid === "function" ? process.getuid() : 0;
const ID = "att_0a1b2c3d";

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "exit-evidence-"));
  cgroup = join(root, "cgroup"); proc = join(root, "proc"); runtime = join(root, "run"); bin = join(root, "bin");
  mkdirSync(join(cgroup, "user.slice", `user-${uid}.slice`, `user@${uid}.service`, "app.slice"), { recursive: true });
  writeFileSync(join(cgroup, "cgroup.controllers"), "cpu memory pids\n");
  mkdirSync(join(proc, "sys", "kernel", "random"), { recursive: true });
  writeFileSync(join(proc, "sys", "kernel", "random", "boot_id"), "3f1c-boot\n");
  mkdirSync(join(runtime, "systemd", "private"), { recursive: true });
  mkdirSync(bin);
  writeFileSync(join(bin, "systemd-run"), "#!/bin/sh\n"); chmodSync(join(bin, "systemd-run"), 0o755);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const reader = (over: Partial<ConstructorParameters<typeof SystemExitEvidence>[0]> = {}) =>
  new SystemExitEvidence({ cgroupRoot: cgroup, procRoot: proc, env: { XDG_RUNTIME_DIR: runtime, PATH: bin }, ...over });
function scope(unit: string, events: string | null) {
  const d = join(cgroup, "user.slice", `user-${uid}.slice`, `user@${uid}.service`, "app.slice", unit);
  mkdirSync(d, { recursive: true });
  if (events !== null) writeFileSync(join(d, "cgroup.events"), events);
}
function pid(n: number, argv: string[]) {
  mkdirSync(join(proc, String(n)), { recursive: true });
  writeFileSync(join(proc, String(n), "cmdline"), argv.join("\0") + "\0");
}

describe.runIf(process.platform === "linux")("SystemExitEvidence over fake trees", () => {
  it("has strong evidence on the plane lane when the user manager, its cgroup and systemd-run are there", () => {
    expect(reader().unavailable("plane")).toBeUndefined();
    expect(reader({ env: { PATH: bin } }).unavailable("plane")).toMatch(/XDG_RUNTIME_DIR is unset/);
    expect(reader({ env: { XDG_RUNTIME_DIR: runtime, PATH: "/nonexistent" } }).unavailable("plane")).toMatch(/systemd-run is not on PATH/);
    expect(reader({ disabled: true }).unavailable("plane")).toMatch(/AGENT_PLANE_PROVIDER_SCOPES=off/);
    expect(reader({ cgroupRoot: join(root, "none") }).unavailable("plane")).toMatch(/no cgroup v2 hierarchy/);
    expect(reader().unavailable("agent")).toMatch(/execution.agentUser is not configured/);
  });

  it("reads a unit populated, empty, absent, or unreadable", () => {
    const unit = attemptUnit(ID, "plane");
    expect(unit).toBe(`aos-att-${ID}.scope`);
    const ev = reader();
    expect(ev.readUnit(unit, "plane")).toBe("absent");
    scope(unit, "populated 1\nfrozen 0\n");
    expect(ev.readUnit(unit, "plane")).toBe("populated");
    scope(unit, "populated 0\nfrozen 0\n");
    expect(ev.readUnit(unit, "plane")).toBe("empty");
    scope(unit, "frozen 0\n");
    expect(ev.readUnit(unit, "plane")).toBe("unreadable");
    // A name that is not an attempt unit is never read, so it is never proof of anything.
    expect(ev.readUnit("aos-att-x;rm.scope", "plane")).toBe("unreadable");
    expect(ev.readUnit("ssh.service", "plane")).toBe("unreadable");
    // No user manager cgroup: unreadable, not absent.
    expect(reader({ cgroupRoot: join(root, "none") }).readUnit(unit, "plane")).toBe("unreadable");
  });

  it("finds a launcher by argv token, including the agent wrapper's exec window", () => {
    const ev = reader();
    pid(10, ["/usr/bin/node", "server.js"]);
    expect(ev.launcherAlive(ID)).toBe(false);
    // The wrapper has exec'd systemd-run: the scope does not exist yet, argv names it.
    pid(11, ["systemd-run", "--user", "--scope", "--quiet", "--collect", `--unit=aos-run-${ID}`, "--", "claude"]);
    expect(ev.launcherAlive(ID)).toBe(true);
    expect(ev.readUnit(attemptUnit(ID, "agent"), "plane")).toBe("absent");
    rmSync(join(proc, "11"), { recursive: true });
    pid(12, ["sudo", "-n", "-u", "agent", "--", "/usr/local/libexec/agent-plane/run-as-agent", "run", ID]);
    expect(ev.launcherAlive(ID)).toBe(true);
    // A malformed id is never declared gone.
    expect(ev.launcherAlive("att x")).toBe(true);
    expect(ev.bootId()).toBe("3f1c-boot");
  });
});

describe("launcherArgv", () => {
  it("matches exact tokens only", () => {
    expect(launcherArgv(["systemd-run", `--unit=aos-att-${ID}`], ID)).toBe(true);
    expect(launcherArgv(["systemd-run", `--unit=aos-att-${ID}2`], ID)).toBe(false);
    expect(launcherArgv(["echo", `--unit=aos-att-${ID}`, "x"].slice(0, 1), ID)).toBe(false);
    expect(launcherArgv(["run-as-agent", "run", ID], ID)).toBe(true);
    expect(launcherArgv(["run-as-agent", "stop", ID], ID)).toBe(false);
    expect(launcherArgv(["grep", ID], ID)).toBe(false);
  });
});
