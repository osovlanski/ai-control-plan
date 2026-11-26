/**
 * qcq-04b: strong exit evidence (docs/agentic-os-qcq-review-packet.md 2.6.1).
 *
 * Every Harness provider that can spawn into a cgroup runs in its own transient scope, named for
 * its attempt: `aos-att-<attempt>.scope` in the plane user's manager, or `aos-run-<attempt>.scope`
 * in the agent user's manager (the scope `setup/run-as-agent` creates). A scope exists while any
 * process is in it, and every descendant stays in it whatever its parentage, so once the plane has
 * seen it populated, an empty or absent scope proves that every provider process is gone.
 *
 * The plane reads a unit through its cgroup file (`cgroup.events` under the owning user's
 * `user@<uid>.service`), not through `systemctl`, so it can read the agent's scope without
 * privilege. A host without a user manager and cgroup v2, or whose `/proc` hides other users'
 * processes (`hidepid`, which blinds the launcher scan), has no strong evidence on that lane: the
 * plane assigns no unit there and says why at boot.
 *
 * Tests install a fake through `setExitEvidence`, the same seam the plane reads.
 */
import { execFileSync, spawn } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import type { Db } from "../db/index.js";
import type { AgentUserConfig } from "../config.js";

export type UnitLane = "plane" | "agent";
/** `cgroup.events` says `populated 1` / `populated 0`; the unit's cgroup does not exist; or it cannot be read. */
export type UnitState = "populated" | "empty" | "absent" | "unreadable";

/**
 * The manager a unit was assigned under, recorded on the attempt at entry (#268 review): recovery
 * reads, scans for and stops the unit there, not under whatever the agent user is configured as by
 * then. `wrapper` is the agent lane's launcher path; `user` is who the stop runs as.
 */
export interface UnitOwner { uid: number; user?: string; group?: string; wrapper?: string }

export interface ExitEvidence {
  /** Why this host has no strong evidence on `lane`, or undefined when it has. */
  unavailable(lane: UnitLane): string | undefined;
  /** Who a unit assigned now on `lane` belongs to, for the attempt to record. */
  unitOwner(lane: UnitLane): UnitOwner | undefined;
  /**
   * The unit's state, read from its cgroup under `owner`'s manager (the lane's current one when the
   * attempt recorded none). `unit` carries its `.scope` suffix. A search or read the plane could not
   * complete (permissions) is `unreadable`, never `absent`.
   */
  readUnit(unit: string, lane: UnitLane, owner?: UnitOwner): UnitState;
  /**
   * Whether a live process on this boot carries the attempt id in any launcher form, matched as an
   * argv token: `--unit=aos-att-<id>`, `--unit=aos-run-<id>` (the agent wrapper after its
   * `exec systemd-run`), or `<wrapper> run <id>` (the wrapper itself, and sudo in front of it), for
   * `run-as-agent` and the recorded wrapper path. A scan that could not read every process says true.
   */
  launcherAlive(attemptId: string, owner?: UnitOwner): boolean;
  /** `/proc/sys/kernel/random/boot_id`: changes exactly at boot. */
  bootId(): string;
  /**
   * A process's start time (`/proc/<pid>/stat` field 22), so a reused pid is told from the plane
   * that entered an attempt: null when no such process exists, `unreadable` when it cannot be told.
   */
  processStart(pid: number): string | null | "unreadable";
  /** Stops the unit (the operator's stop) under `owner`'s manager. Resolves once asked; never throws. */
  stopUnit(unit: string, lane: UnitLane, owner?: UnitOwner): Promise<void>;
}

/** The unit an attempt's provider runs in, on its lane. */
export function attemptUnit(attemptId: string, lane: UnitLane): string {
  return `${lane === "plane" ? "aos-att" : "aos-run"}-${attemptId}.scope`;
}

/** No strong evidence anywhere: no unit is ever assigned. The default until a host installs one. */
export const NO_EXIT_EVIDENCE: ExitEvidence = {
  unavailable: () => "no exit-evidence reader is installed",
  unitOwner: () => undefined,
  readUnit: () => "unreadable",
  launcherAlive: () => true,
  bootId: () => "unavailable",
  processStart: () => "unreadable",
  stopUnit: async () => {},
};

const registry = new WeakMap<Db, ExitEvidence>();
/** Installs the host's evidence reader for this database's plane. */
export function setExitEvidence(db: Db, evidence: ExitEvidence): void { registry.set(db, evidence); }
export function exitEvidence(db: Db): ExitEvidence { return registry.get(db) ?? NO_EXIT_EVIDENCE; }

const ATTEMPT_ID = /^[A-Za-z0-9_-]{1,64}$/;
const CGROUP_ROOT = "/sys/fs/cgroup";

/** The host's reader: cgroup v2 files, `/proc` argv and the systemd user managers. */
export class SystemExitEvidence implements ExitEvidence {
  private readonly cgroupRoot: string;
  private readonly procRoot: string;
  private readonly planeUid: number;
  private agentUid?: number;
  private readonly reasons: Partial<Record<UnitLane, string | null>> = {};

  constructor(private readonly opts: {
    agentUser?: Pick<AgentUserConfig, "user" | "sudo" | "wrapper" | "group">;
    cgroupRoot?: string;
    procRoot?: string;
    env?: NodeJS.ProcessEnv;
    /** Off switch (`AGENT_PLANE_PROVIDER_SCOPES=off`): no unit is assigned on any lane. */
    disabled?: boolean;
  } = {}) {
    this.cgroupRoot = opts.cgroupRoot ?? CGROUP_ROOT;
    this.procRoot = opts.procRoot ?? "/proc";
    this.planeUid = typeof process.getuid === "function" ? process.getuid() : -1;
  }

  unavailable(lane: UnitLane): string | undefined {
    const cached = this.reasons[lane];
    if (cached !== undefined) return cached ?? undefined;
    const reason = this.check(lane);
    this.reasons[lane] = reason ?? null;
    return reason;
  }

  private check(lane: UnitLane): string | undefined {
    if (this.opts.disabled) return "provider scopes are turned off (AGENT_PLANE_PROVIDER_SCOPES=off)";
    if (process.platform !== "linux") return `no cgroup v2 on ${process.platform}`;
    if (!existsSync(join(this.cgroupRoot, "cgroup.controllers"))) return `no cgroup v2 hierarchy at ${this.cgroupRoot}`;
    if (lane === "plane") {
      const env = this.opts.env ?? process.env;
      if (this.planeUid < 0) return "the plane's uid is unknown";
      if (!env.XDG_RUNTIME_DIR) return "XDG_RUNTIME_DIR is unset, so systemd-run --user cannot reach the user manager";
      if (!existsSync(join(env.XDG_RUNTIME_DIR, "systemd", "private"))) return `no systemd user manager for uid ${this.planeUid}`;
      if (!this.managerDir(this.planeUid)) return `no cgroup for user@${this.planeUid}.service`;
      if (!onPath("systemd-run", env)) return "systemd-run is not on PATH";
      return undefined;
    }
    if (!this.opts.agentUser) return "execution.agentUser is not configured";
    const hidden = hidepid(this.procRoot);
    if (hidden) return `/proc is mounted with ${hidden}, so the launcher scan cannot see the agent's processes`;
    const uid = this.uidOf(this.opts.agentUser.user);
    if (uid === undefined) return `no uid for the agent user ${this.opts.agentUser.user}`;
    if (!this.managerDir(uid)) return `no cgroup for user@${uid}.service (is lingering enabled for ${this.opts.agentUser.user}?)`;
    return undefined;
  }

  private uidOf(user: string): number | undefined {
    if (this.agentUid !== undefined) return this.agentUid;
    try {
      const line = readFileSync("/etc/passwd", "utf8").split("\n").find((l) => l.startsWith(`${user}:`));
      const uid = line ? Number(line.split(":")[2]) : NaN;
      if (Number.isInteger(uid)) return (this.agentUid = uid);
    } catch { /* fall through to getent */ }
    try {
      const uid = Number(execFileSync("id", ["-u", user], { encoding: "utf8" }).trim());
      return Number.isInteger(uid) ? (this.agentUid = uid) : undefined;
    } catch {
      return undefined;
    }
  }

  private managerDir(uid: number): string | undefined {
    const dir = join(this.cgroupRoot, "user.slice", `user-${uid}.slice`, `user@${uid}.service`);
    return existsSync(dir) ? dir : undefined;
  }

  unitOwner(lane: UnitLane): UnitOwner | undefined {
    if (lane === "plane") return this.planeUid >= 0 ? { uid: this.planeUid } : undefined;
    const agent = this.opts.agentUser;
    const uid = agent ? this.uidOf(agent.user) : undefined;
    return agent && uid !== undefined ? { uid, user: agent.user, group: agent.group, wrapper: agent.wrapper } : undefined;
  }

  /**
   * The unit's cgroup directory, searched under the user manager (scopes land in `app.slice` or at
   * its root). `undefined`: the whole search completed and found nothing. `null`: it could not be
   * completed (no manager, a directory or entry the plane may not read), so nothing is proven absent.
   */
  private unitDir(unit: string, lane: UnitLane, owner?: UnitOwner): string | undefined | null {
    const uid = owner?.uid ?? (lane === "plane" ? this.planeUid : this.opts.agentUser ? this.uidOf(this.opts.agentUser.user) : undefined);
    if (uid === undefined || uid < 0) return null;
    const root = this.managerDir(uid);
    if (!root) return null;
    let level = [root];
    for (let depth = 0; depth < 3 && level.length; depth++) {
      const next: string[] = [];
      for (const dir of level) {
        const hit = statKind(join(dir, unit));
        if (hit === "dir") return join(dir, unit);
        if (hit === "unreadable") return null;
        let entries: string[];
        try { entries = readdirSync(dir); } catch (err) {
          if (isGone(err)) continue; // the slice itself went away mid-search
          return null;
        }
        for (const e of entries) {
          if (!e.endsWith(".slice")) continue;
          const kind = statKind(join(dir, e));
          if (kind === "dir") next.push(join(dir, e));
          else if (kind === "unreadable") return null;
        }
      }
      level = next;
    }
    return undefined;
  }

  readUnit(unit: string, lane: UnitLane, owner?: UnitOwner): UnitState {
    if (!/^aos-(att|run)-[A-Za-z0-9_-]{1,64}\.scope$/.test(unit)) return "unreadable";
    const dir = this.unitDir(unit, lane, owner);
    if (dir === null) return "unreadable";
    if (dir === undefined) return "absent";
    try {
      const events = readFileSync(join(dir, "cgroup.events"), "utf8");
      const m = events.match(/^populated (\d)$/m);
      if (!m) return "unreadable";
      return m[1] === "1" ? "populated" : "empty";
    } catch (err) {
      return (err as NodeJS.ErrnoException).code === "ENOENT" ? "absent" : "unreadable";
    }
  }

  launcherAlive(attemptId: string, owner?: UnitOwner): boolean {
    // An id we cannot match safely is never declared gone.
    if (!ATTEMPT_ID.test(attemptId)) return true;
    let pids: string[];
    try {
      pids = readdirSync(this.procRoot).filter((p) => /^\d+$/.test(p));
    } catch {
      return true; // no /proc: nothing can be proven absent
    }
    const wrappers = [owner?.wrapper, this.opts.agentUser?.wrapper].filter((w): w is string => !!w);
    for (const pid of pids) {
      let argv: string[];
      try {
        argv = readFileSync(join(this.procRoot, pid, "cmdline"), "utf8").split("\0");
      } catch (err) {
        if (isGone(err)) continue; // exited between the listing and the read
        return true; // a process the plane may not read could be the launcher: the scan is incomplete
      }
      if (launcherArgv(argv, attemptId, wrappers)) return true;
    }
    return false;
  }

  processStart(pid: number): string | null | "unreadable" {
    try {
      const stat = readFileSync(join(this.procRoot, String(pid), "stat"), "utf8");
      // The command name (field 2) is parenthesised and may hold spaces: fields resume after its last ')'.
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      return fields[19] ?? "unreadable"; // field 22 overall
    } catch (err) {
      return isGone(err) ? null : "unreadable";
    }
  }

  bootId(): string {
    try {
      return readFileSync(join(this.procRoot, "sys", "kernel", "random", "boot_id"), "utf8").trim() || "unavailable";
    } catch {
      return "unavailable";
    }
  }

  stopUnit(unit: string, lane: UnitLane, owner?: UnitOwner): Promise<void> {
    if (!/^aos-(att|run)-[A-Za-z0-9_-]{1,64}\.scope$/.test(unit)) return Promise.resolve();
    // The recorded launch-time agent identity, falling back to today's configuration.
    const configured = this.opts.agentUser;
    const agent = owner?.user && owner.wrapper && configured
      ? { ...configured, user: owner.user, group: owner.group ?? configured.group, wrapper: owner.wrapper }
      : configured;
    const [cmd, args] = lane === "plane"
      ? ["systemctl", ["--user", "stop", unit]]
      : agent
        ? [agent.sudo, ["-n", "-u", agent.user, "-g", agent.group, "--", agent.wrapper, "stop", unit.replace(/^aos-run-/, "").replace(/\.scope$/, "")]]
        : [undefined, []];
    if (!cmd) return Promise.resolve();
    return new Promise((done) => {
      try {
        const child = spawn(cmd, args as string[], { stdio: "ignore", ...(lane === "agent" ? { env: { PATH: "/usr/local/bin:/usr/bin:/bin", LANG: "C.UTF-8" } } : {}) });
        const timer = setTimeout(() => { child.kill("SIGKILL"); done(); }, 10_000);
        timer.unref();
        const end = () => { clearTimeout(timer); done(); };
        child.on("error", end);
        child.on("exit", end);
      } catch {
        done();
      }
    });
  }
}

/**
 * One process's argv carries the attempt in a launcher form. `wrappers` are the configured or
 * recorded wrapper paths, matched by full path or basename beside `run-as-agent`. Exported for tests.
 */
export function launcherArgv(argv: string[], attemptId: string, wrappers: string[] = []): boolean {
  const names = new Set(["run-as-agent", ...wrappers.map((w) => basename(w))]);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === `--unit=aos-att-${attemptId}` || a === `--unit=aos-run-${attemptId}`) return true;
    if ((names.has(basename(a)) || wrappers.includes(a)) && argv[i + 1] === "run" && argv[i + 2] === attemptId) return true;
  }
  return false;
}

/** The path no longer exists (ENOENT, or ESRCH for a process that just exited). */
function isGone(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException)?.code;
  return code === "ENOENT" || code === "ESRCH" || code === "ENOTDIR";
}
/** A directory, nothing there, or a path the plane may not inspect. */
function statKind(path: string): "dir" | "none" | "unreadable" {
  try { return statSync(path).isDirectory() ? "dir" : "none"; } catch (err) { return isGone(err) ? "none" : "unreadable"; }
}

function hidepid(procRoot: string): string | undefined {
  try {
    for (const line of readFileSync("/proc/mounts", "utf8").split("\n")) {
      const [, mount, type, options] = line.split(" ");
      if (type !== "proc" || mount !== procRoot) continue;
      const opt = options?.split(",").find((o) => o.startsWith("hidepid="));
      if (opt && !["hidepid=0", "hidepid=off"].includes(opt)) return opt;
    }
  } catch { /* no mount table: assume visible */ }
  return undefined;
}

function onPath(cmd: string, env: NodeJS.ProcessEnv): boolean {
  return (env.PATH ?? "").split(":").some((dir) => dir && existsSync(join(dir, cmd)));
}

/** A test double: the test sets each unit's state and the live launchers. */
export class FakeExitEvidence implements ExitEvidence {
  readonly units = new Map<string, UnitState>();
  readonly launchers = new Set<string>();
  readonly stopped: string[] = [];
  boot = "boot-fake-1";
  lanes: Record<UnitLane, string | undefined> = { plane: undefined, agent: undefined };
  unavailable(lane: UnitLane): string | undefined { return this.lanes[lane]; }
  /** Units read per owner uid, when a test sets them that way: `${uid}:${unit}`. */
  readonly ownedUnits = new Map<string, UnitState>();
  /** Live processes and their start times; a pid not listed does not exist. */
  readonly processes = new Map<number, string>([[process.pid, "self"]]);
  owners: Record<UnitLane, UnitOwner | undefined> = { plane: { uid: 1000 }, agent: { uid: 1001, user: "aos-agent", wrapper: "/usr/local/bin/run-as-agent" } };
  unitOwner(lane: UnitLane): UnitOwner | undefined { return this.owners[lane]; }
  readUnit(unit: string, _lane?: UnitLane, owner?: UnitOwner): UnitState {
    return (owner ? this.ownedUnits.get(`${owner.uid}:${unit}`) : undefined) ?? this.units.get(unit) ?? "absent";
  }
  launcherAlive(attemptId: string): boolean { return this.launchers.has(attemptId); }
  bootId(): string { return this.boot; }
  processStart(pid: number): string | null | "unreadable" { return this.processes.get(pid) ?? null; }
  /** The owner each stop was asked under, beside `stopped`. */
  readonly stopOwners: (UnitOwner | undefined)[] = [];
  async stopUnit(unit: string, _lane?: UnitLane, owner?: UnitOwner): Promise<void> { this.stopped.push(unit); this.stopOwners.push(owner); }
}
