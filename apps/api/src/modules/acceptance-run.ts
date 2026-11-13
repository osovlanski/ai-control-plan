/**
 * P0-4 (docs/agentic-os-auto-copilot-plan.md §C.2.7) — acceptance runs.
 *
 * An attempt whose task COMPLETED (`settled`) is accepted or not by the item's acceptance
 * commands, never by the agent that did the work:
 *
 * 1. **Trusted commands.** They come from `docs/progress/backlog.yaml` at the trusted ref
 *    (`origin/main`: merged and reviewed), read with `git show`, never from the task worktree.
 *    Each command says whether it is `replaySafe` (default false).
 * 2. **Checkpoint + lineage.** The task worktree is committed (`commitCheckpoint`) and the
 *    reservation commit must be an ancestor of that SHA (§C.2.2).
 * 3. **A fresh snapshot per run.** `git worktree add --detach <sha>` into a new directory for
 *    every `run_no`, never reused. Tracked files are made read-only (0440, 0550 when executable;
 *    directories 0550); only the item's declared `writable` paths are 2770.
 * 4. **Offline.** Commands run through an `AcceptanceExecutor` that must declare itself offline.
 *    The production one is the agent wrapper's `accept` mode: `aos-agent`, its own systemd scope
 *    with `RuntimeMaxSec`, and a new network namespace (no interfaces but a down loopback).
 * 5. **Capped.** Each command runs under `min(its timeoutSec, the run's deadline)`, where the
 *    deadline is `min(now + budget − used, closes_at − graceMs)` (§C.2.3); acceptance time is
 *    charged to the attempt's runtime budget like a provider session.
 * 6. **Tree hash before and after.** Every tracked path's mode, size, content hash, inode and
 *    change time; any difference (even a write that restored the bytes) makes the run `blocked`.
 * 7. **Replay-safe rule.** A run cut by a crash may be replaced by a new `run_no` on a new
 *    snapshot only when every command is `replaySafe`; otherwise the attempt is `blocked` and the
 *    effects the plane cannot know are listed for itay.
 *
 * An empty command list, a missing `acceptance` or a failed lineage check is `blocked`, never
 * `passed`. A passing run's `sha` is the attempt's verified SHA, which publication (P0-5) reads.
 *
 * Not here: who calls `accept` (the in-plane dispatcher, P0-6), the `git fetch` of the trusted
 * ref (P0-6 fetches before it selects), and the host probes (P0-3; `agentIdle` is injected).
 */
import { spawn, execFile, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, rmSync, symlinkSync } from "node:fs";
import { isAbsolute, join, normalize, sep } from "node:path";
import { promisify } from "node:util";
import { parse as parseYaml } from "yaml";
import type { AgentUserConfig, ResolvedAutopilotConfig } from "../config.js";
import type { Db } from "../db/index.js";
import { commitCheckpoint } from "../repo/git.js";

const execFileP = promisify(execFile);

/* ---------------------------------------------------------------- spec -- */

export interface AcceptanceCommand { run: string; replaySafe: boolean; timeoutSec?: number }
/**
 * `writable`: directories the run may write (created 2770 when absent). `writableFiles`: single
 * files that may not exist yet, written in the backlog as `{ file: <path> }`; each becomes a
 * dangling symlink into a writable side directory, so the parent stays read-only.
 */
export interface AcceptanceSpec { commands: AcceptanceCommand[]; writable: string[]; writableFiles: string[] }
/** Holds the targets of `writableFiles`; never a tracked path. */
export const WRITABLE_FILES_DIR = ".aos-writable";
export const BACKLOG_PATH = "docs/progress/backlog.yaml";
export const TRUSTED_REF = "origin/main";
/** The wrapper's own `RuntimeMaxSec` bound. */
const MAX_COMMAND_SECONDS = 14_400;

/** A repo-relative path that stays inside the snapshot and is not git's own. */
function safeRelative(p: unknown): string | undefined {
  if (typeof p !== "string" || !p || p.includes("\0") || isAbsolute(p) || p.includes("\\")) return undefined;
  const n = normalize(p).replace(/\/+$/, "");
  if (!n || n === "." || n.startsWith("..") || n.split("/").some((s) => s === ".." || s === ".git")) return undefined;
  return n;
}

/**
 * The item's acceptance from the backlog text, validated. A problem is a reason to block, so it
 * names what is wrong; it never falls back to a default command.
 */
export function parseBacklogAcceptance(text: string, itemId: string): { spec: AcceptanceSpec } | { problem: string } {
  let doc: unknown;
  try { doc = parseYaml(text); } catch (err) { return { problem: `the backlog is not valid YAML: ${err instanceof Error ? err.message : String(err)}` }; }
  const items = (doc as { items?: unknown } | null)?.items;
  if (!Array.isArray(items)) return { problem: "the backlog has no items list" };
  const matches = items.filter((i) => (i as { id?: unknown } | null)?.id === itemId);
  if (matches.length === 0) return { problem: `item ${itemId} is not in the backlog` };
  if (matches.length > 1) return { problem: `item ${itemId} appears ${matches.length} times in the backlog` };
  const acceptance = (matches[0] as { acceptance?: unknown }).acceptance as { commands?: unknown; writable?: unknown } | undefined | null;
  if (!acceptance || typeof acceptance !== "object") return { problem: `item ${itemId} has no acceptance` };
  if (!Array.isArray(acceptance.commands) || acceptance.commands.length === 0) return { problem: `item ${itemId} has an empty acceptance command list` };
  const commands: AcceptanceCommand[] = [];
  for (const [i, raw] of acceptance.commands.entries()) {
    const c = raw as { run?: unknown; replaySafe?: unknown; timeoutSec?: unknown } | null;
    if (typeof c?.run !== "string" || !c.run.trim() || c.run.includes("\0")) return { problem: `acceptance command ${i + 1} of ${itemId} has no run string` };
    if (c.replaySafe !== undefined && typeof c.replaySafe !== "boolean") return { problem: `acceptance command ${i + 1} of ${itemId}: replaySafe must be a boolean` };
    if (c.timeoutSec !== undefined && (!Number.isInteger(c.timeoutSec) || (c.timeoutSec as number) < 1 || (c.timeoutSec as number) > MAX_COMMAND_SECONDS)) {
      return { problem: `acceptance command ${i + 1} of ${itemId}: timeoutSec must be an integer in 1..${MAX_COMMAND_SECONDS}` };
    }
    commands.push({ run: c.run, replaySafe: c.replaySafe === true, ...(c.timeoutSec !== undefined ? { timeoutSec: c.timeoutSec as number } : {}) });
  }
  const writable: string[] = [];
  const writableFiles: string[] = [];
  if (acceptance.writable !== undefined) {
    if (!Array.isArray(acceptance.writable)) return { problem: `acceptance.writable of ${itemId} must be a list` };
    for (const w of acceptance.writable) {
      const isFile = !!w && typeof w === "object" && Object.keys(w).length === 1 && "file" in w;
      const safe = safeRelative(isFile ? (w as { file: unknown }).file : w);
      if (!safe || safe.split("/")[0] === WRITABLE_FILES_DIR) return { problem: `acceptance.writable of ${itemId} has an unsafe path: ${JSON.stringify(w)}` };
      (isFile ? writableFiles : writable).push(safe);
    }
  }
  return { spec: { commands, writable, writableFiles } };
}

async function git(repo: string, args: string[]): Promise<string> {
  // Hooks off: nothing from any repository runs as the plane user.
  const { stdout } = await execFileP("git", ["-c", "core.hooksPath=/dev/null", "-C", repo, ...args], { maxBuffer: 32 * 1024 * 1024 });
  return stdout.trim();
}

/** The trusted source: the backlog at `ref`, resolved to a commit first so the row names exactly what was read. */
export async function readTrustedAcceptance(source: { repoPath: string; ref?: string; path?: string }, itemId: string):
  Promise<{ ref: string; sourceSha?: string } & ({ spec: AcceptanceSpec } | { problem: string })> {
  const ref = source.ref ?? TRUSTED_REF;
  let sourceSha: string;
  try { sourceSha = await git(source.repoPath, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]); } catch { return { ref, problem: `the trusted ref ${ref} does not resolve` }; }
  let text: string;
  try { text = await git(source.repoPath, ["show", `${sourceSha}:${source.path ?? BACKLOG_PATH}`]); } catch { return { ref, sourceSha, problem: `${source.path ?? BACKLOG_PATH} does not exist at ${ref}` }; }
  return { ref, sourceSha, ...parseBacklogAcceptance(text, itemId) };
}

/* ------------------------------------------------------------ snapshot -- */

/**
 * A fingerprint of every tracked path: mode, size, sha256 of the content (the link target for a
 * symlink), inode and ctime. ctime cannot be set by the writer, so a write that restores the
 * original bytes still changes the fingerprint (G28).
 */
export function hashTrackedTree(root: string, paths: readonly string[]): { hash: string; entries: Map<string, string> } {
  const entries = new Map<string, string>();
  const all = createHash("sha256");
  for (const p of [...paths].sort()) {
    let entry: string;
    try {
      const st = lstatSync(join(root, p), { bigint: true });
      const content = st.isSymbolicLink() ? Buffer.from(readlinkSync(join(root, p))) : st.isFile() ? readFileSync(join(root, p)) : Buffer.alloc(0);
      entry = `${st.mode.toString(8)}:${st.size}:${createHash("sha256").update(content).digest("hex")}:${st.ino}:${st.ctimeNs}`;
    } catch {
      entry = "missing";
    }
    entries.set(p, entry);
    all.update(p).update("\0").update(entry).update("\n");
  }
  return { hash: all.digest("hex"), entries };
}

async function trackedPaths(snapshot: string): Promise<string[]> {
  const out = await git(snapshot, ["ls-files", "-z"]);
  return out.split("\0").filter(Boolean);
}

/** Tracked tree read-only; the declared writable paths (created if absent) group-writable, setgid. */
function lockDown(snapshot: string, writable: readonly string[], writableFiles: readonly string[] = []): void {
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      const st = lstatSync(p);
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) { walk(p); chmodSync(p, 0o2550); } else chmodSync(p, st.mode & 0o111 ? 0o550 : 0o440);
    }
  };
  // Directories keep setgid: what the plane creates below (writable dirs, the side dir) must stay
  // group `aos`, or the agent, which reaches them only through that group, cannot write them.
  walk(snapshot);
  chmodSync(snapshot, 0o2550);
  for (const w of writable) {
    // Every missing ancestor stays read-only; only the declared path itself opens.
    const parts = w.split("/");
    for (let i = 1; i <= parts.length; i++) {
      const p = join(snapshot, ...parts.slice(0, i));
      if (!existsSync(p)) {
        withOwnerWrite(join(snapshot, ...parts.slice(0, i - 1)), () => mkdirSync(p));
        chmodSync(p, i === parts.length ? 0o2770 : 0o2550);
      }
    }
    const open = (p: string): void => {
      const st = lstatSync(p);
      if (st.isSymbolicLink()) return;
      if (st.isDirectory()) { chmodSync(p, 0o2770); for (const n of readdirSync(p)) open(join(p, n)); } else chmodSync(p, 0o660);
    };
    open(join(snapshot, w));
  }
  if (writableFiles.length === 0) return;
  const side = join(snapshot, WRITABLE_FILES_DIR);
  withOwnerWrite(snapshot, () => mkdirSync(side));
  chmodSync(side, 0o2770);
  for (const f of writableFiles) {
    const p = join(snapshot, f);
    const st = (() => { try { return lstatSync(p); } catch { return undefined; } })();
    if (st?.isFile()) { chmodSync(p, 0o660); continue; } // tracked: writable, and the tree hash still sees any change
    if (st) throw new Error(`writable file ${f} exists and is not a regular file`);
    const parts = f.split("/");
    for (let i = 1; i < parts.length; i++) {
      const dir = join(snapshot, ...parts.slice(0, i));
      if (!existsSync(dir)) { withOwnerWrite(join(snapshot, ...parts.slice(0, i - 1)), () => mkdirSync(dir)); chmodSync(dir, 0o2550); }
    }
    const target = join(WRITABLE_FILES_DIR, f.replaceAll("/", "__"));
    const up = "../".repeat(parts.length - 1);
    withOwnerWrite(join(snapshot, ...parts.slice(0, -1)), () => symlinkSync(up + target, p));
  }
}

/** Create something in a read-only directory we own, then put its mode back. */
function withOwnerWrite(dir: string, fn: () => void): void {
  const mode = lstatSync(dir).mode & 0o7777;
  chmodSync(dir, mode | 0o700);
  try { fn(); } finally { chmodSync(dir, mode); }
}

/** Owner write back on everything we own, then the worktree goes. Best effort: a leftover is quarantined by P0-7. */
async function removeSnapshot(repo: string, snapshot: string): Promise<void> {
  const unlock = (p: string): void => {
    try {
      const st = lstatSync(p);
      if (st.isSymbolicLink()) return;
      if (st.isDirectory()) { chmodSync(p, (st.mode & 0o7777) | 0o700); for (const n of readdirSync(p)) unlock(join(p, n)); }
    } catch { /* not ours */ }
  };
  unlock(snapshot);
  try { await git(repo, ["worktree", "remove", "--force", snapshot]); } catch { /* fall through */ }
  try { rmSync(snapshot, { recursive: true, force: true }); } catch { /* left for reconciliation */ }
  try { await git(repo, ["worktree", "prune"]); } catch { /* ignore */ }
}

/* ------------------------------------------------------------ executor -- */

export interface AcceptanceExecRequest { unit: string; cwd: string; command: string; timeoutMs: number }
export interface AcceptanceExecResult { exitCode: number | null; signal: string | null; output: string }
export interface AcceptanceExecutor {
  /** True only when the executor itself guarantees no network for the command. */
  readonly offline: boolean;
  /** Resolves when the command's process ends, however it ends. Abort stops it. */
  exec(req: AcceptanceExecRequest, signal: AbortSignal): Promise<AcceptanceExecResult>;
  /** Stop the command's scope. Never throws. */
  stop(unit: string): Promise<void>;
}

const OUTPUT_TAIL = 8 * 1024;
const UNIT = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * The production executor: `sudo -n -u aos-agent run-as-agent accept <unit> <secs> <cwd> -- /bin/sh -c <cmd>`.
 * The wrapper's `accept` mode is `run` plus `unshare --user --net`, so the scope has no network;
 * `RuntimeMaxSec=<secs>` kills it at the deadline even if the plane is dead.
 */
export function agentAcceptanceExecutor(agent: Pick<AgentUserConfig, "sudo" | "user" | "group" | "wrapper">): AcceptanceExecutor {
  const base = ["-n", "-u", agent.user, "-g", agent.group, "--", agent.wrapper];
  const env = { PATH: "/usr/local/bin:/usr/bin:/bin", LANG: "C.UTF-8" };
  const stop = (unit: string): Promise<void> => new Promise((done) => {
    if (!UNIT.test(unit)) return done();
    let child: ChildProcess;
    try { child = spawn(agent.sudo, [...base, "stop", unit], { env, stdio: "ignore" }); } catch { return done(); }
    const timer = setTimeout(() => { child.kill("SIGKILL"); done(); }, 10_000);
    timer.unref();
    child.on("error", () => { clearTimeout(timer); done(); });
    child.on("exit", () => { clearTimeout(timer); done(); });
  });
  return {
    offline: true,
    stop,
    exec: (req, signal) => new Promise((resolve, reject) => {
      if (!UNIT.test(req.unit)) return reject(new Error("acceptance unit id is not a safe unit name"));
      const secs = Math.ceil(req.timeoutMs / 1000);
      if (secs < 1 || secs > MAX_COMMAND_SECONDS) return reject(new Error(`acceptance runtime bound must be 1..${MAX_COMMAND_SECONDS} s, got ${secs}`));
      const child = spawn(agent.sudo, [...base, "accept", req.unit, String(secs), req.cwd, "--", "/bin/sh", "-c", req.command], { env, stdio: ["ignore", "pipe", "pipe"] });
      let tail = "";
      const take = (b: Buffer) => { tail = (tail + b.toString("utf8")).slice(-OUTPUT_TAIL); };
      child.stdout?.on("data", take);
      child.stderr?.on("data", take);
      let settled = false;
      const finish = (code: number | null, sig: string | null) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        resolve({ exitCode: code, signal: sig, output: tail });
      };
      // Stopping the scope ends every process in it. sudo relays SIGTERM to its child as well, and
      // SIGKILL follows. The plane does not wait for pipes a stray grandchild may still hold.
      const onAbort = () => {
        void stop(req.unit).finally(() => {
          child.kill("SIGTERM");
          setTimeout(() => child.kill("SIGKILL"), 5_000).unref();
        });
      };
      signal.addEventListener("abort", onAbort, { once: true });
      child.on("error", (err) => { signal.removeEventListener("abort", onAbort); reject(err); });
      child.on("exit", (code, sig) => { if (signal.aborted) setTimeout(() => finish(code, sig), 1_000).unref(); });
      child.on("close", (code, sig) => finish(code, sig));
    }),
  };
}

/* -------------------------------------------------------------- runner -- */

export type AcceptanceRunState = "preparing" | "running" | "passed" | "failed" | "blocked" | "cut" | "crashed";
type CommandStatus = "pending" | "running" | "passed" | "failed" | "timed_out" | "cut" | "stopped" | "crashed";
interface CommandRecord extends AcceptanceCommand { status: CommandStatus; exitCode?: number | null; signal?: string | null; startedAt?: string; endedAt?: string; outputTail?: string }

export interface AcceptanceRun {
  id: string; attemptId: string; runNo: number; sha?: string; sourceRef: string; sourceSha?: string; snapshotPath?: string;
  state: AcceptanceRunState; reason?: string; commands: CommandRecord[]; writable: Array<string | { file: string }>;
  treeBefore?: string; treeAfter?: string; treeDiff?: string[]; unknownEffects?: string[];
  deadlineAt?: string; deadlineBound?: "budget" | "window"; startedAt: string; endedAt?: string;
}

/** What `accept` did. `started: false` means the attempt was not touched or only parked; nothing ran. */
export type AcceptanceOutcome =
  | { started: false; reason: string; attemptState: string }
  | { started: true; run: AcceptanceRun; attemptState: string };

export interface AcceptanceDeps {
  db: Db;
  bounds: Pick<ResolvedAutopilotConfig, "minSliceMs" | "graceMs">;
  executor: AcceptanceExecutor;
  /** Where the trusted backlog lives (the control-plane checkout) and at which ref. */
  backlog: { repoPath: string; ref?: string; path?: string };
  /** A directory inside the wrapper's allowed tree (`<agent worktreesRoot>/acceptance`). */
  snapshotsRoot: string;
  now?: () => Date;
  /** How often a running command looks for `stop now`. */
  pollMs?: number;
  /** §C.2.7 step 2: "after the run's scope is empty". P0-3 supplies the slice probe; absent = only the plane's own run rows are checked. */
  agentIdle?: () => { ok: true } | { ok: false; detail: string };
  /** TEST-ONLY: accept an executor that does not declare itself offline. */
  allowOnlineExecutor?: boolean;
}

interface RunRow {
  id: string; attempt_id: string; run_no: number; sha: string | null; source_ref: string; source_sha: string | null; snapshot_path: string | null;
  state: AcceptanceRunState; reason: string | null; commands_json: string; writable_json: string; tree_before: string | null; tree_after: string | null;
  tree_diff_json: string | null; unknown_effects_json: string | null; deadline_at: string | null; deadline_bound: "budget" | "window" | null;
  started_at: string; ended_at: string | null;
}
interface AttemptRow { id: string; item_id: string; reservation_sha: string | null; task_id: string | null; state: string; runtime_budget_ms: number }

const FINAL_ATTEMPT = ["published", "closed", "failed", "blocked", "cancelled", "conflict", "external"];

export class AcceptanceRunner {
  private readonly db: Db;
  private readonly now: () => Date;
  /** The live run of THIS process, so `stopNow` can reach it without waiting for a poll. */
  private live?: { runId: string; abort: AbortController };

  constructor(private readonly d: AcceptanceDeps) {
    if (!d.executor.offline && !d.allowOnlineExecutor) throw new Error("acceptance needs an offline executor (§C.2.7 step 4)");
    this.db = d.db;
    this.now = d.now ?? (() => new Date());
  }

  private iso(): string { return this.now().toISOString(); }

  /* ------------------------------------------------------------ reads -- */

  private toRun(r: RunRow): AcceptanceRun {
    return {
      id: r.id, attemptId: r.attempt_id, runNo: r.run_no, ...(r.sha ? { sha: r.sha } : {}), sourceRef: r.source_ref,
      ...(r.source_sha ? { sourceSha: r.source_sha } : {}), ...(r.snapshot_path ? { snapshotPath: r.snapshot_path } : {}),
      state: r.state, ...(r.reason ? { reason: r.reason } : {}), commands: JSON.parse(r.commands_json) as CommandRecord[],
      writable: JSON.parse(r.writable_json) as Array<string | { file: string }>, ...(r.tree_before ? { treeBefore: r.tree_before } : {}),
      ...(r.tree_after ? { treeAfter: r.tree_after } : {}), ...(r.tree_diff_json ? { treeDiff: JSON.parse(r.tree_diff_json) as string[] } : {}),
      ...(r.unknown_effects_json ? { unknownEffects: JSON.parse(r.unknown_effects_json) as string[] } : {}),
      ...(r.deadline_at ? { deadlineAt: r.deadline_at } : {}), ...(r.deadline_bound ? { deadlineBound: r.deadline_bound } : {}),
      startedAt: r.started_at, ...(r.ended_at ? { endedAt: r.ended_at } : {}),
    };
  }
  run(id: string): AcceptanceRun | undefined {
    const r = this.db.prepare("SELECT * FROM acceptance_runs WHERE id = ?").get(id) as RunRow | undefined;
    return r ? this.toRun(r) : undefined;
  }
  runs(attemptId: string): AcceptanceRun[] {
    return (this.db.prepare("SELECT * FROM acceptance_runs WHERE attempt_id = ? ORDER BY run_no").all(attemptId) as RunRow[]).map((r) => this.toRun(r));
  }
  /** The SHA acceptance passed on: what publication (P0-5) pushes, and nothing else. */
  verifiedSha(attemptId: string): string | undefined {
    return (this.db.prepare("SELECT sha FROM acceptance_runs WHERE attempt_id = ? AND state = 'passed' ORDER BY run_no DESC LIMIT 1").get(attemptId) as { sha: string } | undefined)?.sha;
  }

  private attemptRow(id: string): AttemptRow | undefined {
    return this.db.prepare("SELECT id, item_id, reservation_sha, task_id, state, runtime_budget_ms FROM autopilot_attempts WHERE id = ?").get(id) as AttemptRow | undefined;
  }
  /** Same columns P0-2's `setState` writes; a final state also cancels what is left of the task (invariant 3). */
  private setAttempt(id: string, state: string, reason: string | null): void {
    const at = this.iso();
    const final = FINAL_ATTEMPT.includes(state);
    this.db.prepare("UPDATE autopilot_attempts SET state = ?, reason = ?, updated_at = ?, final_at = ? WHERE id = ?").run(state, reason, at, final ? at : null, id);
    if (!final) return;
    const taskId = this.attemptRow(id)?.task_id;
    if (!taskId) return;
    this.db.prepare("UPDATE wait_conditions SET state = 'cancelled' WHERE task_id = ? AND state = 'active'").run(taskId);
    this.db.prepare("UPDATE dispatches SET phase = 'cancelled', reason = ?, updated_at = ? WHERE task_id = ? AND phase = 'reserved'").run(`autopilot attempt ${state}`, at, taskId);
  }
  private usedMs(attemptId: string): number {
    return (this.db.prepare("SELECT COALESCE(SUM(ms),0) AS ms FROM autopilot_runtime WHERE attempt_id = ?").get(attemptId) as { ms: number }).ms;
  }
  private autopilotStatus(): string {
    return (this.db.prepare("SELECT status FROM autopilot_state WHERE id = 1").get() as { status: string } | undefined)?.status ?? "stopped";
  }

  /* ----------------------------------------------------------- accept -- */

  /**
   * Run acceptance for an attempt that is `settled`, `suspended` with a completed task (cut by
   * the window before or during acceptance), or `accepting` after a crash that allowed a replay.
   * One call is one run. Resolves when the run has a verdict and the attempt has moved.
   */
  async accept(attemptId: string): Promise<AcceptanceOutcome> {
    const attempt = this.attemptRow(attemptId);
    if (!attempt) throw new Error(`attempt ${attemptId} does not exist`);
    const notStarted = (reason: string): AcceptanceOutcome => ({ started: false, reason, attemptState: this.attemptRow(attemptId)!.state });
    const task = attempt.task_id
      ? this.db.prepare("SELECT state, repo_path, worktree_path FROM tasks WHERE id = ?").get(attempt.task_id) as { state: string; repo_path: string | null; worktree_path: string | null } | undefined
      : undefined;
    if (!task || task.state !== "COMPLETED") return notStarted(`the attempt's task is ${task?.state ?? "missing"}, not COMPLETED`);
    const prior = this.runs(attemptId);
    const last = prior.at(-1);
    const replay = attempt.state === "accepting" && last?.state === "crashed" && last.commands.every((c) => c.replaySafe);
    const resumable = attempt.state === "settled" || attempt.state === "suspended" || replay;
    if (!resumable) return notStarted(`attempt is ${attempt.state}; acceptance starts from settled, suspended, or a replay-safe crash`);

    // §C.2.9: nothing new while the autopilot is not running (a drain finishes the phase it is in; acceptance is a new one).
    const status = this.autopilotStatus();
    if (status !== "running") return notStarted(`autopilot is ${status}`);

    // §C.2.7 step 2: the run's scope is empty.
    const liveRun = this.db.prepare("SELECT id FROM runs WHERE task_id = ? AND ended_at IS NULL LIMIT 1").get(attempt.task_id) as { id: string } | undefined;
    if (liveRun) return notStarted(`session ${liveRun.id} of the task is still live`);
    let idle: { ok: true } | { ok: false; detail: string };
    try { idle = this.d.agentIdle?.() ?? { ok: true }; } catch (err) { idle = { ok: false, detail: `agent slice unreadable: ${err instanceof Error ? err.message : String(err)}` }; }
    if (!idle.ok) return notStarted(idle.detail);

    // §C.2.3 deadline, recomputed; acceptance is charged to the attempt's budget.
    const nowMs = this.now().getTime();
    const window = this.db.prepare("SELECT id, closes_at FROM autopilot_windows WHERE opens_at <= ? AND closes_at > ? ORDER BY opens_at DESC LIMIT 1")
      .get(this.iso(), this.iso()) as { id: string; closes_at: string } | undefined;
    const remainingBudget = attempt.runtime_budget_ms - this.usedMs(attemptId);
    if (remainingBudget <= 0) {
      this.setAttempt(attemptId, "failed", "budget_exhausted: no runtime left for acceptance");
      return notStarted("budget_exhausted");
    }
    const closesMs = window ? Date.parse(window.closes_at) : 0;
    if (!window || closesMs - nowMs < this.d.bounds.minSliceMs) {
      // G25: acceptance that would cross the close is not started; the attempt waits for the next window.
      this.setAttempt(attemptId, "suspended", "window_closed: acceptance waits for the next window");
      return notStarted("window_closed");
    }
    const byBudget = nowMs + remainingBudget;
    const byWindow = closesMs - this.d.bounds.graceMs;
    const deadlineAtMs = Math.min(byBudget, byWindow);
    const bound = byBudget <= byWindow ? "budget" as const : "window" as const;

    // Checkpoint + lineage + trusted commands. Each failure is a blocked run, never a pass.
    const runId = `acr_${randomUUID()}`;
    const runNo = (last?.runNo ?? 0) + 1;
    const startedAt = this.iso();
    const source = await readTrustedAcceptance(this.d.backlog, attempt.item_id);
    let sha: string | undefined;
    let problem: string | undefined;
    if (replay) {
      sha = last!.sha;
      if (!sha) problem = "the crashed run has no checkpoint SHA";
    } else if (!task.worktree_path || !task.repo_path) {
      problem = "the task has no worktree to checkpoint";
    } else {
      try { sha = (await commitCheckpoint(task.worktree_path, `aos checkpoint: item ${attempt.item_id}`)) ?? undefined; } catch (err) { problem = `checkpoint commit failed: ${err instanceof Error ? err.message : String(err)}`; }
      if (!problem && !sha) problem = "checkpoint commit produced no SHA";
    }
    if (!problem && !attempt.reservation_sha) problem = "the attempt has no reservation SHA; lineage cannot be checked";
    if (!problem) {
      try { await git(task.repo_path!, ["merge-base", "--is-ancestor", attempt.reservation_sha!, sha!]); } catch { problem = `lineage: reservation ${attempt.reservation_sha} is not an ancestor of ${sha}`; }
    }
    if (!problem && "problem" in source) problem = source.problem;
    const spec = !problem && "spec" in source ? source.spec : undefined;
    const commands: CommandRecord[] = (spec?.commands ?? []).map((c) => ({ ...c, status: "pending" as const }));
    const deadlineAt = new Date(deadlineAtMs).toISOString();

    if (problem || !spec) {
      this.db.transaction(() => {
        this.db.prepare(`INSERT INTO acceptance_runs(id, attempt_id, run_no, sha, source_ref, source_sha, state, reason, commands_json, writable_json, deadline_at, deadline_bound, started_at, ended_at)
          VALUES(?,?,?,?,?,?,'blocked',?,?,?,?,?,?,?)`).run(runId, attemptId, runNo, sha ?? null, source.ref, source.sourceSha ?? null, problem ?? "no acceptance",
          JSON.stringify(commands), "[]", deadlineAt, bound, startedAt, this.iso());
        this.setAttempt(attemptId, "blocked", `acceptance: ${problem ?? "no acceptance"}`);
      })();
      return { started: true, run: this.run(runId)!, attemptState: "blocked" };
    }

    // `settled` → `accepting` with the run row, one transaction (§C.2.1).
    const snapshot = join(this.d.snapshotsRoot, runId);
    this.db.transaction(() => {
      this.db.prepare(`INSERT INTO acceptance_runs(id, attempt_id, run_no, sha, source_ref, source_sha, snapshot_path, state, commands_json, writable_json, deadline_at, deadline_bound, started_at)
        VALUES(?,?,?,?,?,?,?,'preparing',?,?,?,?,?)`).run(runId, attemptId, runNo, sha, source.ref, source.sourceSha ?? null, snapshot,
        JSON.stringify(commands), JSON.stringify([...spec.writable, ...spec.writableFiles.map((file) => ({ file }))]), deadlineAt, bound, startedAt);
      this.setAttempt(attemptId, "accepting", null);
    })();

    const t0 = this.now().getTime();
    let verdict: { state: "passed" | "failed" | "blocked" | "cut"; reason?: string; attempt: string; attemptReason: string | null };
    let treeDiff: string[] | undefined;
    let treeAfter: string | undefined;
    try {
      mkdirSync(this.d.snapshotsRoot, { recursive: true });
      await git(task.repo_path!, ["worktree", "add", "--detach", snapshot, sha!]);
      lockDown(snapshot, spec.writable, spec.writableFiles);
      const paths = await trackedPaths(snapshot);
      const before = hashTrackedTree(snapshot, paths);
      this.db.prepare("UPDATE acceptance_runs SET state = 'running', tree_before = ? WHERE id = ?").run(before.hash, runId);

      const outcome = await this.runCommands(runId, snapshot, commands, deadlineAtMs);

      const after = hashTrackedTree(snapshot, paths);
      treeAfter = after.hash;
      if (after.hash !== before.hash) treeDiff = paths.filter((p) => before.entries.get(p) !== after.entries.get(p)).slice(0, 20);

      if (outcome.kind === "stopped") verdict = { state: "blocked", reason: "stop now", attempt: "cancelled", attemptReason: "stop: acceptance stopped" };
      else if (treeDiff) verdict = { state: "blocked", reason: `tracked tree changed during the run: ${treeDiff.join(", ")}`, attempt: "blocked", attemptReason: "acceptance: tracked tree changed" };
      else if (outcome.kind === "passed") verdict = { state: "passed", attempt: "accepted", attemptReason: null };
      else if (outcome.kind === "failed") verdict = { state: "failed", reason: outcome.reason, attempt: "failed", attemptReason: `acceptance failed: ${outcome.reason}` };
      else if (bound === "budget") verdict = { state: "cut", reason: "attempt budget reached", attempt: "failed", attemptReason: "budget_exhausted: acceptance cut at the deadline" };
      else if (commands.every((c) => c.replaySafe)) verdict = { state: "cut", reason: "window deadline reached", attempt: "suspended", attemptReason: "window_closed: acceptance cut; a new run in the next window" };
      else verdict = { state: "cut", reason: "window deadline reached", attempt: "blocked", attemptReason: "acceptance cut during a command that is not replay-safe" };
    } catch (err) {
      verdict = { state: "blocked", reason: `acceptance could not run: ${err instanceof Error ? err.message : String(err)}`, attempt: "blocked", attemptReason: "acceptance could not run" };
    } finally {
      await removeSnapshot(task.repo_path!, snapshot);
    }

    const ms = Math.max(0, this.now().getTime() - t0);
    this.db.transaction(() => {
      this.db.prepare("UPDATE acceptance_runs SET state = ?, reason = ?, tree_after = ?, tree_diff_json = ?, ended_at = ? WHERE id = ?")
        .run(verdict.state, verdict.reason ?? null, treeAfter ?? null, treeDiff ? JSON.stringify(treeDiff) : null, this.iso(), runId);
      // Invariant 4, extended: acceptance time is a runtime row keyed by the run, written once.
      this.db.prepare("INSERT OR IGNORE INTO autopilot_runtime(session_id, attempt_id, ms, recorded_at) VALUES(?,?,?,?)").run(`acceptance:${runId}`, attemptId, ms, this.iso());
      const current = this.attemptRow(attemptId)!;
      if (!FINAL_ATTEMPT.includes(current.state)) this.setAttempt(attemptId, verdict.attempt, verdict.attemptReason);
    })();
    return { started: true, run: this.run(runId)!, attemptState: this.attemptRow(attemptId)!.state };
  }

  private async runCommands(runId: string, cwd: string, commands: CommandRecord[], deadlineAtMs: number):
    Promise<{ kind: "passed" } | { kind: "failed"; reason: string } | { kind: "cut" } | { kind: "stopped" }> {
    const save = () => this.db.prepare("UPDATE acceptance_runs SET commands_json = ? WHERE id = ?").run(JSON.stringify(commands), runId);
    const short = runId.slice(4, 16);
    for (const [i, c] of commands.entries()) {
      if (this.autopilotStatus() === "stopped") { c.status = "stopped"; save(); return { kind: "stopped" }; }
      const left = deadlineAtMs - this.now().getTime();
      if (left < 1000) { c.status = "cut"; save(); return { kind: "cut" }; }
      const own = c.timeoutSec !== undefined ? c.timeoutSec * 1000 : Infinity;
      const timeoutMs = Math.min(own, left);
      const capByDeadline = timeoutMs === left;
      // Recorded BEFORE the process exists: a crash from here on is an unknown effect unless replay-safe.
      c.status = "running"; c.startedAt = this.iso(); save();

      const abort = new AbortController();
      this.live = { runId, abort };
      let why: "timeout" | "stopped" | undefined;
      const timer = setTimeout(() => { why ??= "timeout"; abort.abort(); }, timeoutMs);
      const poll = setInterval(() => {
        let stopped: boolean;
        try { stopped = this.autopilotStatus() === "stopped"; } catch { stopped = true; } // the database is gone: the plane is going down
        if (stopped) { why ??= "stopped"; abort.abort(); }
      }, this.d.pollMs ?? 1000);
      abort.signal.addEventListener("abort", () => { why ??= "stopped"; }, { once: true });
      let result: AcceptanceExecResult;
      try {
        result = await this.d.executor.exec({ unit: `acc-${short}-${i + 1}`, cwd, command: c.run, timeoutMs }, abort.signal);
      } finally {
        clearTimeout(timer); clearInterval(poll); this.live = undefined;
      }
      c.endedAt = this.iso(); c.exitCode = result.exitCode; c.signal = result.signal; c.outputTail = result.output;
      if (why === "stopped") { c.status = "stopped"; save(); return { kind: "stopped" }; }
      if (why === "timeout") {
        if (capByDeadline) { c.status = "cut"; save(); return { kind: "cut" }; }
        c.status = "timed_out"; save(); return { kind: "failed", reason: `command ${i + 1} timed out after ${c.timeoutSec} s: ${c.run}` };
      }
      if (result.exitCode !== 0) { c.status = "failed"; save(); return { kind: "failed", reason: `command ${i + 1} exited ${result.exitCode ?? result.signal}: ${c.run}` }; }
      c.status = "passed"; save();
    }
    return { kind: "passed" };
  }

  /** §C.2.9 `stop now` in `accepting`: the scope is stopped, the run `blocked`, the attempt `cancelled`. Polling does the same within `pollMs`. */
  stopNow(): boolean {
    if (!this.live) return false;
    this.live.abort.abort();
    return true;
  }

  /**
   * Boot, before anything dispatches: a run left `preparing`/`running` by a crash is `crashed`.
   * When every command is replay-safe the attempt stays `accepting` and the next `accept` makes a
   * new run on a new snapshot. Otherwise the attempt is `blocked` and the commands whose effects
   * are unknown are listed. Leftover scopes are stopped and leftover snapshots removed.
   */
  async reconcileOnBoot(): Promise<AcceptanceRun[]> {
    const rows = this.db.prepare("SELECT * FROM acceptance_runs WHERE state IN ('preparing','running')").all() as RunRow[];
    const out: AcceptanceRun[] = [];
    for (const r of rows) {
      const run = this.toRun(r);
      const short = run.id.slice(4, 16);
      for (const [i, c] of run.commands.entries()) if (c.status === "running") await this.d.executor.stop(`acc-${short}-${i + 1}`);
      const started = run.commands.filter((c) => c.status !== "pending");
      const replaySafe = run.commands.every((c) => c.replaySafe);
      const unknown = replaySafe ? [] : started.map((c) => `${c.status === "running" ? "interrupted" : "completed"}: ${c.run}${c.replaySafe ? "" : " (not replay-safe)"}`);
      const commands = run.commands.map((c) => (c.status === "running" ? { ...c, status: "crashed" as const } : c));
      this.db.transaction(() => {
        this.db.prepare("UPDATE acceptance_runs SET state = 'crashed', reason = ?, commands_json = ?, unknown_effects_json = ?, ended_at = ? WHERE id = ?")
          .run(replaySafe ? "plane stopped mid-run; every command is replay-safe" : "plane stopped mid-run; a command is not replay-safe",
            JSON.stringify(commands), unknown.length ? JSON.stringify(unknown) : null, this.iso(), run.id);
        const attempt = this.attemptRow(run.attemptId);
        if (attempt?.state === "accepting") {
          if (replaySafe) this.setAttempt(run.attemptId, "accepting", "acceptance crashed; replay allowed");
          else this.setAttempt(run.attemptId, "blocked", `acceptance crashed with unknown effects: ${unknown.join("; ")}`);
        }
        this.db.prepare("INSERT OR IGNORE INTO autopilot_runtime(session_id, attempt_id, ms, recorded_at) VALUES(?,?,?,?)")
          .run(`acceptance:${run.id}`, run.attemptId, Math.max(0, this.now().getTime() - Date.parse(run.startedAt)), this.iso());
      })();
      if (run.snapshotPath) {
        const repo = (this.db.prepare("SELECT t.repo_path FROM autopilot_attempts a JOIN tasks t ON t.id = a.task_id WHERE a.id = ?").get(run.attemptId) as { repo_path: string | null } | undefined)?.repo_path;
        if (repo && existsSync(run.snapshotPath) && run.snapshotPath.startsWith(this.d.snapshotsRoot + sep)) await removeSnapshot(repo, run.snapshotPath);
      }
      out.push(this.run(run.id)!);
    }
    return out;
  }
}
