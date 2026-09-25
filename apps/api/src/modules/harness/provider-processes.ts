/**
 * Kernel ownership of provider processes (F1/F2, plans/harness-parity-report.md).
 *
 * - F1: the runner's lease renewal reads provider liveness from here, not from
 *   the first provider event.
 * - F2: a fenced or orphaned session's provider process tree is terminated —
 *   SIGTERM, a grace period, then SIGKILL — and a restart reaps the process
 *   trees a dead incarnation of this workspace left behind.
 *
 * Identity across a crash: at boot the kernel stamps `AGENT_PLANE_INCARNATION`
 * (`<workspace key>:<api pid>`) into its own environment. Every provider it
 * spawns inherits it, and so do their descendants. The boot reap kills every
 * process carrying this workspace's key whose owning API pid is no longer a
 * live node process. ponytail: the reap reads `/proc`, so it is Linux-only; on
 * other platforms it logs that it skipped. Add a `ps eww` reader if a macOS
 * host ever runs unattended.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ProviderProcess } from "@agent-plane/core";

export const INCARNATION_ENV = "AGENT_PLANE_INCARNATION";
/** SIGTERM → SIGKILL grace. The Claude CLI flushes its transcript on SIGTERM well inside this. */
export const DEFAULT_TERMINATE_GRACE_MS = 5_000;

export type TerminateOutcome = "gone" | "exited" | "killed";
export type ProcessLog = (message: string, fields: Record<string, unknown>) => void;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Alive = exists and is not a zombie. A zombie has exited; only its parent's wait is pending. */
export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EPERM") return false;
  }
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3) !== "Z";
  } catch {
    return true; // no /proc: kill(0) is the whole answer
  }
}

/** Every descendant of `pid` (children first). One `ps` call; empty when `ps` is unavailable. */
export function descendants(pid: number): number[] {
  let table: string;
  try {
    table = execFileSync("ps", ["-A", "-o", "pid=,ppid="], { encoding: "utf8" });
  } catch {
    return [];
  }
  const children = new Map<number, number[]>();
  for (const line of table.split("\n")) {
    const [c, p] = line.trim().split(/\s+/).map(Number);
    if (!c || p === undefined || Number.isNaN(p)) continue;
    children.set(p, [...(children.get(p) ?? []), c]);
  }
  const out: number[] = [];
  const queue = [...(children.get(pid) ?? [])];
  while (queue.length) {
    const next = queue.shift()!;
    if (out.includes(next)) continue;
    out.push(next);
    queue.push(...(children.get(next) ?? []));
  }
  return out;
}

function signal(pid: number, sig: NodeJS.Signals): void {
  try {
    process.kill(pid, sig);
  } catch {
    // already gone, or not ours to signal
  }
}

/**
 * SIGTERM `pids`, wait up to `graceMs`, SIGKILL whatever is left. The tree is
 * snapshotted BEFORE the first signal: a child reparented to init after its
 * parent exits is still in the set.
 */
export async function terminatePids(pids: number[], graceMs = DEFAULT_TERMINATE_GRACE_MS): Promise<TerminateOutcome> {
  const live = pids.filter(processAlive);
  if (live.length === 0) return "gone";
  for (const pid of live) signal(pid, "SIGTERM");
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline && live.some(processAlive)) await sleep(25);
  const left = live.filter(processAlive);
  if (left.length === 0) return "exited";
  for (const pid of left) signal(pid, "SIGKILL");
  const hard = Date.now() + 1_000;
  while (Date.now() < hard && left.some(processAlive)) await sleep(25);
  return "killed";
}

export function terminateProcessTree(pid: number, graceMs = DEFAULT_TERMINATE_GRACE_MS): Promise<TerminateOutcome> {
  return terminatePids([pid, ...descendants(pid)], graceMs);
}

/** Per-incarnation map session → provider process. Only this process's own spawns are in it. */
export class ProviderProcessTracker {
  private readonly bySession = new Map<string, ProviderProcess>();
  /** A second caller (the run's own unwind racing a fence or a takeover) waits for the same kill. */
  private readonly inflight = new Map<string, Promise<TerminateOutcome>>();

  constructor(
    private readonly graceMs = DEFAULT_TERMINATE_GRACE_MS,
    private readonly log?: ProcessLog,
  ) {}

  track(sessionId: string, proc: ProviderProcess): void {
    this.bySession.set(sessionId, proc);
  }

  get(sessionId: string): ProviderProcess | undefined {
    return this.bySession.get(sessionId);
  }

  /** Terminate the session's provider tree (idempotent). `untracked` = this incarnation never spawned one. */
  terminate(sessionId: string, reason: string): Promise<TerminateOutcome | "untracked"> {
    const pending = this.inflight.get(sessionId);
    if (pending) return pending;
    const proc = this.bySession.get(sessionId);
    if (!proc) return Promise.resolve("untracked");
    this.bySession.delete(sessionId);
    const done = terminateProcessTree(proc.pid, this.graceMs)
      .then((outcome) => {
        this.log?.("provider process terminated", { sessionId, pid: proc.pid, reason, outcome });
        return outcome;
      })
      .finally(() => this.inflight.delete(sessionId));
    this.inflight.set(sessionId, done);
    return done;
  }
}

export function workspaceKey(workspaceDir: string): string {
  return createHash("sha256").update(workspaceDir).digest("hex").slice(0, 12);
}

/** Stamp this incarnation into the environment every provider spawn inherits. Call once, before any spawn. */
export function markIncarnation(workspaceDir: string): string {
  const tag = `${workspaceKey(workspaceDir)}:${process.pid}`;
  process.env[INCARNATION_ENV] = tag;
  return tag;
}

function readEnvVar(pid: string, name: string, procRoot: string): string | undefined {
  try {
    const prefix = `${name}=`;
    return readFileSync(join(procRoot, pid, "environ"), "utf8").split("\0").find((e) => e.startsWith(prefix))?.slice(prefix.length);
  } catch {
    return undefined; // exited, or not readable by this uid — never ours then
  }
}

function ancestors(): Set<number> {
  const out = new Set<number>([process.pid]);
  let pid = process.ppid;
  for (let i = 0; i < 64 && pid > 1; i++) {
    out.add(pid);
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      pid = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
    } catch {
      break;
    }
  }
  return out;
}

/** The owner is gone unless its pid is a live node process. A pid reused by a node process is left alone. */
function ownerAlive(pid: number, procRoot: string): boolean {
  if (!processAlive(pid)) return false;
  try {
    return readFileSync(join(procRoot, String(pid), "cmdline"), "utf8").includes("node");
  } catch {
    return false;
  }
}

/**
 * Boot reap: terminate every process tree stamped with this workspace's key by
 * an incarnation that is no longer alive. Never touches this process or its
 * ancestors, and never touches another workspace's providers.
 */
export async function reapStrayProviders(
  workspaceDir: string,
  opts: { graceMs?: number; log?: ProcessLog; procRoot?: string } = {},
): Promise<number[]> {
  const procRoot = opts.procRoot ?? "/proc";
  if (!existsSync(join(procRoot, "self"))) {
    opts.log?.("stray provider reap skipped: no /proc on this platform", { workspaceDir });
    return [];
  }
  const key = `${workspaceKey(workspaceDir)}:`;
  const current = process.env[INCARNATION_ENV];
  const protectedPids = ancestors();
  const strays: number[] = [];
  const owners = new Map<number, boolean>();
  for (const entry of readdirSync(procRoot)) {
    if (!/^\d+$/.test(entry) || protectedPids.has(Number(entry))) continue;
    const tag = readEnvVar(entry, INCARNATION_ENV, procRoot);
    if (!tag || !tag.startsWith(key) || tag === current) continue;
    const owner = Number(tag.slice(key.length));
    if (!owners.has(owner)) owners.set(owner, ownerAlive(owner, procRoot));
    if (owners.get(owner)) continue;
    strays.push(Number(entry));
  }
  if (strays.length === 0) return [];
  const outcome = await terminatePids(strays, opts.graceMs ?? DEFAULT_TERMINATE_GRACE_MS);
  opts.log?.("reaped stray provider processes from a dead incarnation", { workspaceDir, pids: strays, outcome });
  return strays;
}
