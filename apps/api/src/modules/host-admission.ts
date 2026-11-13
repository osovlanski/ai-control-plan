/**
 * P0-3 (docs/agentic-os-auto-copilot-plan.md §C.2.6, §C.2.5) — the host gate.
 *
 * Observation only. The gate is check 8 of the autopilot's launch check (`autopilot.ts`), run
 * early in `startTask` and last in `SessionRunner` before a provider process exists. It refuses
 * (`host_busy`) when the box is loaded, short of memory or disk, or when anything still runs in
 * the agent user's `user-<uid>.slice` apart from its own systemd manager. Enforcement is the
 * systemd bounds: `RuntimeMaxSec` on every scope (`setup/run-as-agent`) and the close timer
 * (`setup/aos-close.timer`), which reads the schedule this module writes.
 *
 * Every read is synchronous on purpose: the launch check runs inside one SQLite transaction.
 * Anything unreadable throws, and the caller treats a throw as not admitted.
 */
import { closeSync, constants, existsSync, fsyncSync, openSync, readdirSync, readFileSync, renameSync, statfsSync, writeSync } from "node:fs";
import { cpus, loadavg } from "node:os";
import { basename, dirname, join } from "node:path";
import type { AdmissionConfig, ResolvedConfig } from "../config.js";

export type HostGateResult = { ok: true } | { ok: false; detail: string };

/** Where the gate looks. Every field has the real host's value; tests point them at a fixture tree. */
export interface HostProbes {
  /** cgroup v2 mount. */
  cgroupRoot: string;
  /** For `/proc/<pid>/comm`. */
  procRoot: string;
  /** For the agent user's uid. */
  passwdPath: string;
  load1: () => number;
  cpuCount: () => number;
  /** Bytes, from `MemAvailable` (free alone undercounts reclaimable cache). */
  memAvailable: () => number;
  /** Free bytes for an unprivileged user on the filesystem holding `path`. */
  diskFree: (path: string) => number;
}

export const REAL_PROBES: HostProbes = {
  cgroupRoot: "/sys/fs/cgroup",
  procRoot: "/proc",
  passwdPath: "/etc/passwd",
  load1: () => loadavg()[0]!,
  cpuCount: () => Math.max(1, cpus().length),
  memAvailable: () => {
    const m = /^MemAvailable:\s+(\d+)\s+kB$/m.exec(readFileSync("/proc/meminfo", "utf8"));
    if (!m) throw new Error("MemAvailable missing from /proc/meminfo");
    return Number(m[1]) * 1024;
  },
  diskFree: (path) => { const s = statfsSync(path); return Number(s.bavail) * Number(s.bsize); },
};

const MB = 1024 * 1024;

function uidOf(passwd: string, user: string): number {
  for (const line of passwd.split("\n")) {
    const f = line.split(":");
    if (f[0] === user && f.length >= 3 && /^\d+$/.test(f[2]!)) return Number(f[2]);
  }
  throw new Error(`no uid for ${user}`);
}

/** The systemd user manager's own init.scope legitimately holds `systemd` and `(sd-pam)`. */
const MANAGER_COMMS = new Set(["systemd", "(sd-pam)"]);

/**
 * Every process in the agent's slice except its user manager, as `"<cgroup>: <n> process(es)"`.
 * `populated` in `cgroup.events` is recursive (cgroup v2), so an unpopulated subtree is skipped
 * without descending. A process moved anywhere else in the slice is still found, and one moved
 * into `init.scope` is found unless it also names itself like the manager (stated in the PR).
 */
export function agentSliceCensus(probes: Pick<HostProbes, "cgroupRoot" | "procRoot">, uid: number): string[] {
  const root = join(probes.cgroupRoot, "user.slice", `user-${uid}.slice`);
  const busy: string[] = [];
  const walk = (dir: string, rel: string): void => {
    const events = readFileSync(join(dir, "cgroup.events"), "utf8");
    const m = /^populated ([01])$/m.exec(events);
    if (!m) throw new Error(`${rel}/cgroup.events has no populated line`);
    if (m[1] === "0") return;
    const pids = readFileSync(join(dir, "cgroup.procs"), "utf8").split("\n").map((s) => s.trim()).filter(Boolean);
    if (basename(dir) === "init.scope" && basename(dirname(dir)) === `user@${uid}.service`) {
      const foreign = pids.filter((pid) => {
        let comm: string;
        try { comm = readFileSync(join(probes.procRoot, pid, "comm"), "utf8").trim(); } catch { return false; } // exited meanwhile
        return !MANAGER_COMMS.has(comm);
      });
      if (foreign.length > 0 || pids.length > 2) busy.push(`${rel}: ${pids.length} process(es), not only the user manager`);
    } else if (pids.length > 0) {
      busy.push(`${rel}: ${pids.length} process(es)`);
    }
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) walk(join(dir, entry.name), `${rel}/${entry.name}`);
    }
  };
  walk(root, `user-${uid}.slice`);
  return busy;
}

export interface HostGateOptions {
  admission: AdmissionConfig;
  /** The agent user; its slice is censused. */
  agentUser: string;
  /** The close-timer schedule. The gate refuses when it does not cover the open window's close. */
  closeSchedule?: string;
  /** The open window's `closesAt`, if any. */
  openWindowClosesAt?: () => string | undefined;
  probes?: HostProbes;
}

/** §C.2.6: one gate call. Returns the first reason it is not admitted; throws when a probe is unreadable. */
export function hostGate(o: HostGateOptions): HostGateResult {
  const p = o.probes ?? REAL_PROBES;
  const a = o.admission;
  const perCpu = p.load1() / p.cpuCount();
  if (!Number.isFinite(perCpu)) throw new Error("load average unreadable");
  if (perCpu > a.maxLoadPerCpu) return { ok: false, detail: `load ${perCpu.toFixed(2)} per CPU is above ${a.maxLoadPerCpu}` };
  const mem = p.memAvailable();
  if (!(mem >= a.minFreeMemMb * MB)) return { ok: false, detail: `available memory ${Math.floor(mem / MB)} MB is below ${a.minFreeMemMb} MB` };
  const disk = p.diskFree(a.diskPath);
  if (!(disk >= a.minFreeDiskMb * MB)) return { ok: false, detail: `free disk on ${a.diskPath} ${Math.floor(disk / MB)} MB is below ${a.minFreeDiskMb} MB` };
  const busy = agentSliceCensus(p, uidOf(readFileSync(p.passwdPath, "utf8"), o.agentUser));
  if (busy.length > 0) return { ok: false, detail: `agent slice is not empty: ${busy.slice(0, 3).join("; ")}${busy.length > 3 ? ` (+${busy.length - 3} more)` : ""}` };
  const closesAt = o.openWindowClosesAt?.();
  if (o.closeSchedule && closesAt) {
    const want = Math.floor(Date.parse(closesAt) / 1000);
    if (!readCloseSchedule(o.closeSchedule).some((w) => w.closes === want)) {
      return { ok: false, detail: `close schedule ${o.closeSchedule} does not list this window's close ${closesAt}` };
    }
  }
  return { ok: true };
}

/**
 * The gate the composition root installs. Fail-closed: with no `scheduler.admission.<pool>` for
 * the autopilot's pool, or no agent user, every launch is refused, naming the missing key.
 */
export interface PlaneWindows {
  /** Every window the plane holds that has not closed. */
  windows: () => Array<{ opensAt: string; closesAt: string }>;
  openWindow: () => { closesAt: string } | undefined;
  now?: () => Date;
}

export function hostGateFromConfig(config: ResolvedConfig, plane?: PlaneWindows, probes?: HostProbes): () => HostGateResult {
  return () => {
    const pool = config.autopilot.pool;
    const admission = config.scheduler?.admission?.[pool];
    if (!admission) return { ok: false, detail: `scheduler.admission.${pool} is not configured` };
    const agent = config.execution.agentUser;
    if (!agent) return { ok: false, detail: "execution.agentUser is not configured" };
    // The close timer must know tonight's close before anything runs: the schedule is rewritten
    // from the database at every check, so a window added by any path is covered. A failed write
    // leaves the old file, and the check below then refuses.
    if (plane) syncCloseSchedule(config, plane.windows(), plane.now?.());
    const openWindowClosesAt = plane ? () => plane.openWindow()?.closesAt : undefined;
    return hostGate({
      admission, agentUser: agent.user, closeSchedule: agent.closeSchedule,
      ...(openWindowClosesAt ? { openWindowClosesAt } : {}), ...(probes ? { probes } : {}),
    });
  };
}

/* ------------------------------------------------------- close schedule -- */

/**
 * The file `setup/aos-close` reads, as `<opens-epoch> <closes-epoch>` lines. It lives in a
 * plane-owned 2750 directory: the agent can read it and cannot change it. Written atomically,
 * 0640, so the timer never sees half a file. Windows that closed over a day ago are dropped.
 */
export function writeCloseSchedule(path: string, windows: Array<{ opensAt: string; closesAt: string }>, now = new Date()): void {
  const floor = now.getTime() - 24 * 3_600_000;
  const lines = windows
    .filter((w) => Date.parse(w.closesAt) > floor)
    .map((w) => `${Math.floor(Date.parse(w.opensAt) / 1000)} ${Math.floor(Date.parse(w.closesAt) / 1000)}`)
    .sort();
  const body = `# aos close schedule: <opens-epoch> <closes-epoch>; written by the plane at ${now.toISOString()}\n${lines.join("\n")}${lines.length ? "\n" : ""}`;
  const tmp = `${path}.tmp-${process.pid}`;
  const fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC, 0o640);
  try { writeSync(fd, body); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(tmp, path);
}

export function readCloseSchedule(path: string): Array<{ opens: number; closes: number }> {
  const out: Array<{ opens: number; closes: number }> = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const m = /^(\d{1,12}) (\d{1,12})$/.exec(line.trim());
    if (m) out.push({ opens: Number(m[1]), closes: Number(m[2]) });
  }
  return out;
}

/** Writes the schedule when the agent user is configured and its directory exists. Returns why not, if not. */
export function syncCloseSchedule(config: ResolvedConfig, windows: Array<{ opensAt: string; closesAt: string }>, now?: Date): string | undefined {
  const path = config.execution.agentUser?.closeSchedule;
  if (!path) return "execution.agentUser is not configured";
  if (!existsSync(dirname(path))) return `${dirname(path)} does not exist (run setup/aos-setup)`;
  writeCloseSchedule(path, windows, now);
  return undefined;
}
