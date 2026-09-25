/**
 * F1/F2 (plans/harness-parity-report.md): the fencing lease rides the provider
 * process's liveness, and no provider process outlives its session.
 *
 * Real OS children stand in for the provider CLI (`sleep`, `sh`); one fake
 * clock is shared by SessionStore, SessionRunner and HarnessRecovery, so the
 * 60s lease TTL is crossed without waiting for it. Linux-only: the reap reads
 * `/proc`.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  AgentAdapter,
  AssistantId,
  CapabilityManifest,
  ExecutionRequest,
  NormalizedEvent,
  RunId,
  TaskId,
} from "@agent-plane/core";
import { openDb, type Db } from "../../src/db/index.js";
import { ApprovalService } from "../../src/modules/harness/approval-service.js";
import { EventRecorder } from "../../src/modules/harness/event-recorder.js";
import {
  INCARNATION_ENV,
  PROVIDER_GROUPS_DIR,
  ProviderProcessTracker,
  markIncarnation,
  processAlive,
  reapStrayProviders,
  workspaceKey,
} from "../../src/modules/harness/provider-processes.js";
import { HarnessRecovery } from "../../src/modules/harness/recovery.js";
import { SessionFencedError, SessionRunner } from "../../src/modules/harness/session-runner.js";
import { SessionStore } from "../../src/modules/harness/session-store.js";

const onLinux = process.platform === "linux";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let dir: string;
let db: Db;
let nowMs: number;
const now = () => new Date(nowMs);
let store: SessionStore;
let children: ChildProcess[];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "harness-liveness-"));
  db = openDb(join(dir, "t.db"));
  db.prepare("INSERT INTO assistants (id, provider) VALUES ('a1','fake')").run();
  db.prepare("INSERT INTO tasks (id, goal, envelope, created_at, updated_at) VALUES ('AG-1','g','{}','t','t')").run();
  nowMs = Date.parse("2026-09-25T12:00:00.000Z");
  store = new SessionStore(db, now);
  children = [];
});
afterEach(() => {
  for (const c of children) if (c.pid && processAlive(c.pid)) c.kill("SIGKILL");
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const MANIFEST: CapabilityManifest = {
  assistantId: "a1" as AssistantId,
  provider: "fake",
  core: {
    models: [{ id: "fake-1" }],
    canResume: false,
    canMcp: false,
    supportsMidRunInput: false,
    reportsUsage: false,
    reportsLimits: false,
    execution: { shell: true, filesystem: true, web: "no" },
    auth: { state: "ok" },
  },
  harness: { usageAccounting: "none", toolGating: "none", approvalRelay: false, processIsolation: "none" },
  providerDetail: {},
  evidence: { source: "runtime-probe", observedAt: "t" },
};

function request(): ExecutionRequest {
  return {
    schemaVersion: 1,
    executionRequestId: "erq_1",
    taskId: "AG-1" as TaskId,
    attempt: 1,
    assistantId: "a1" as AssistantId,
    routingDecisionRef: "rd_1",
    runSpec: {
      taskId: "AG-1" as TaskId,
      prompt: "p",
      workdir: dir,
      permissionPolicy: { mode: "auto-approve" },
      env: { redactionRules: [], maxRuntimeMs: 30 * 60_000 },
    },
    policy: {
      budget: { enforcement: "advisory" },
      timeout: { hardMs: 30 * 60_000 },
      approval: { mode: "auto-approve" },
      tools: { mode: "audit" },
      checkpoint: { onSoftLimit: true },
      isolation: { required: "ambient" },
    },
    context: {},
    verification: [],
    origin: { kind: "fresh" },
  };
}

function track(child: ChildProcess): ChildProcess {
  children.push(child);
  return child;
}

/**
 * A provider that spawns a real child and never emits an event — the stream
 * stays silent even after the child dies, like a wedged adapter.
 */
function silentProvider(command: string, args: string[]): { adapter: AgentAdapter; child: () => ChildProcess } {
  let child: ChildProcess | undefined;
  const adapter: AgentAdapter = {
    id: "a1" as AssistantId,
    describe: async () => MANIFEST,
    start: async () => {
      child = track(spawn(command, args, { stdio: "ignore" }));
      return { runId: "r1" as RunId, assistantId: "a1" as AssistantId };
    },
    resume: async () => ({ runId: "r1" as RunId, assistantId: "a1" as AssistantId }),
    events: () => ({ [Symbol.asyncIterator]: () => ({ next: () => new Promise<IteratorResult<NormalizedEvent>>(() => {}) }) }),
    providerProcess: () =>
      child?.pid
        ? {
            pid: child.pid,
            spawnedAt: new Date().toISOString(),
            alive: () => child!.exitCode === null && child!.signalCode === null,
          }
        : undefined,
    cancel: async () => {}, // deliberately does nothing: the kernel, not the adapter, must kill it
  };
  return { adapter, child: () => child! };
}

function harness(adapter: AgentAdapter, graceMs = 5_000) {
  const logs: Array<{ message: string; fields: Record<string, unknown> }> = [];
  const log = (message: string, fields: Record<string, unknown>) => logs.push({ message, fields });
  const processes = new ProviderProcessTracker(graceMs, log);
  const registry = { adapter: () => adapter, manifest: () => MANIFEST };
  const runner = new SessionRunner({
    store,
    recorder: new EventRecorder(db, undefined, undefined, now),
    approvals: new ApprovalService(db),
    checkpoints: { create: async () => ({ id: "ckpt_1", gitRef: null }) },
    registry,
    softThresholdPct: 80,
    approvalPollMs: 5, // heartbeat every 25ms of real time
    now,
    processes,
    log,
  });
  const recovery = new HarnessRecovery({
    store,
    approvals: new ApprovalService(db),
    checkpoints: { create: async () => ({ id: "ckpt_r", gitRef: null }) },
    registry,
    now,
    processes,
  });
  return { runner, recovery, processes, logs };
}

/** Advance the shared clock, then let the real-time heartbeat tick. */
async function advance(ms: number): Promise<void> {
  nowMs += ms;
  await sleep(80);
}

async function until(cond: () => boolean, ms = 3_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await sleep(10);
  }
}

describe.skipIf(!onLinux)("F1: the lease rides provider-process liveness", () => {
  it("a provider silent for 90s is not orphaned; once it dies, the session is", async () => {
    const { adapter, child } = silentProvider("sleep", ["1000"]);
    const { runner, recovery, logs } = harness(adapter);
    const { sessionId, done } = runner.start(request());
    done.catch(() => {});
    await until(() => store.get(sessionId)?.state === "STARTING" && child()?.pid !== undefined);

    for (let t = 0; t < 90_000; t += 10_000) {
      await advance(10_000);
      const swept = await recovery.sweepExpiredLeases();
      expect(swept.filter((o) => o.sessionId === sessionId)).toEqual([]);
    }
    expect(store.get(sessionId)!.state).toBe("STARTING");
    expect(logs.some((l) => l.message === "provider silent: no first event yet")).toBe(true);

    child().kill("SIGKILL");
    await until(() => child().signalCode !== null);
    await advance(61_000);
    const swept = await recovery.sweepExpiredLeases();
    expect(swept).toEqual([expect.objectContaining({ sessionId, action: "orphaned" })]);
    expect(store.get(sessionId)!.state).toBe("FAILED");
    expect(logs.some((l) => l.message === "provider process exited; lease renewal stopped")).toBe(true);

    // The runner notices it lost the session and unwinds instead of hanging on the silent stream.
    await expect(done).rejects.toBeInstanceOf(SessionFencedError);
  }, 20_000);
});

/** `sh` ignoring SIGTERM, with a grandchild that inherits the ignore: only SIGKILL ends the tree. */
const TERM_PROOF = 'trap "" TERM; sleep 1000 & echo $! > "$0"; wait';

function termProof(pidFile: string): ChildProcess {
  return track(spawn("sh", ["-c", TERM_PROOF, pidFile], { stdio: "ignore" }));
}

async function grandchildPid(pidFile: string): Promise<number> {
  const { readFileSync, existsSync } = await import("node:fs");
  await until(() => existsSync(pidFile) && readFileSync(pidFile, "utf8").trim() !== "");
  return Number(readFileSync(pidFile, "utf8").trim());
}

describe.skipIf(!onLinux)("F2: no provider process outlives its session", () => {
  it("an orphaned session's SIGTERM-proof tree is SIGKILLed by recovery", async () => {
    const pidFile = join(dir, "gc.pid");
    const { adapter } = silentProvider("true", []);
    const { recovery, processes, logs } = harness(adapter, 200);
    // A session a runner left in STARTING without renewing (runner wedged).
    store.recordRequest(request());
    const sessionId = store.createSession("erq_1").sessionId as string;
    const t = store.acquireLease(sessionId)!;
    store.transition(sessionId, { expectedVersion: 0, from: "PREPARED", to: "STARTING", leaseToken: t });
    const sh = termProof(pidFile);
    const gc = await grandchildPid(pidFile);
    processes.track(sessionId, { pid: sh.pid!, spawnedAt: new Date(nowMs).toISOString(), alive: () => processAlive(sh.pid!) });

    nowMs += 61_000;
    const swept = await recovery.sweepExpiredLeases();
    expect(swept).toEqual([expect.objectContaining({ sessionId, action: "orphaned" })]);
    expect(processAlive(sh.pid!)).toBe(false);
    expect(processAlive(gc)).toBe(false);
    expect(logs).toContainEqual(
      expect.objectContaining({ message: "provider process terminated", fields: expect.objectContaining({ outcome: "killed" }) }),
    );
  }, 10_000);

  it("a runner whose lease is taken fences and kills its provider tree", async () => {
    const pidFile = join(dir, "gc.pid");
    const { adapter, child } = silentProvider("sh", ["-c", TERM_PROOF, pidFile]);
    const { runner, logs } = harness(adapter, 200);
    const { sessionId, done } = runner.start(request());
    done.catch(() => {});
    const gc = await grandchildPid(pidFile);
    await until(() => logs.some((l) => l.message === "provider spawned"));

    // Another owner takes the session (e.g. a sweeper on another incarnation).
    db.prepare("UPDATE runs SET lease_token = 'lease_other' WHERE id = ?").run(sessionId);

    await expect(done).rejects.toBeInstanceOf(SessionFencedError);
    expect(processAlive(child().pid!)).toBe(false);
    expect(processAlive(gc)).toBe(false);
    expect(logs).toContainEqual(expect.objectContaining({ message: "session fenced" }));
  }, 10_000);
});

describe.skipIf(!onLinux)("F2: boot reap", () => {
  let savedTag: string | undefined;
  beforeEach(() => {
    savedTag = process.env[INCARNATION_ENV];
  });
  afterEach(() => {
    if (savedTag === undefined) delete process.env[INCARNATION_ENV];
    else process.env[INCARNATION_ENV] = savedTag;
  });

  /** What a dead incarnation left on disk: the provider groups it recorded at spawn. */
  const recordGroups = (workspace: string, owner: string, pids: number[]) => {
    mkdirSync(join(workspace, PROVIDER_GROUPS_DIR), { recursive: true });
    writeFileSync(join(workspace, PROVIDER_GROUPS_DIR, owner), pids.map((p) => `${p}\n`).join(""));
  };
  const deadPid = () => spawnSync("sh", ["-c", "echo $$"], { encoding: "utf8" }).stdout.trim();
  const pgidOf = (pid: number) => Number(readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1]!.split(" ")[2]);

  it("kills this workspace's recorded strays from a dead incarnation, and nothing else", async () => {
    const workspace = join(dir, "ws");
    const other = join(dir, "other-ws");
    const current = markIncarnation(workspace);
    const deadOwner = deadPid();
    const tagged = (tag: string) =>
      track(spawn("sleep", ["1000"], { stdio: "ignore", detached: true, env: { ...process.env, [INCARNATION_ENV]: tag } }));

    const stray = tagged(`${workspaceKey(workspace)}:${deadOwner}`);
    const otherWorkspace = tagged(`${workspaceKey(other)}:${deadOwner}`);
    const live = tagged(current);
    await until(() => [stray, otherWorkspace, live].every((c) => c.pid !== undefined));
    await sleep(50); // let exec land so /proc/<pid>/environ is the child's
    recordGroups(workspace, deadOwner, [stray.pid!]);
    recordGroups(other, deadOwner, [otherWorkspace.pid!]);
    recordGroups(workspace, String(process.pid), [live.pid!]);

    const reaped = await reapStrayProviders(workspace, { graceMs: 200 });
    expect(reaped).toEqual([stray.pid]);
    await until(() => stray.signalCode !== null || stray.exitCode !== null);
    expect(processAlive(otherWorkspace.pid!)).toBe(true);
    expect(processAlive(live.pid!)).toBe(true);
    expect(existsSync(join(workspace, PROVIDER_GROUPS_DIR, deadOwner))).toBe(false);
    expect(existsSync(join(workspace, PROVIDER_GROUPS_DIR, String(process.pid)))).toBe(true);
  }, 10_000);

  it("a tagged daemon that detached from its provider survives a restart; the provider's group is still reaped", async () => {
    const workspace = join(dir, "ws");
    markIncarnation(workspace);
    const tag = `${workspaceKey(workspace)}:${deadPid()}`;
    const pids = join(dir, "pids");
    // A provider, spawned as the kernel spawns one (own group): its hook starts a
    // daemon that detaches (setsid), and it runs a tool child that stays in its group.
    const provider = track(spawn("sh", ["-c", `setsid sleep 1000 & echo $! > ${pids}.daemon; sleep 1000 & echo $! > ${pids}.tool; wait`],
      { stdio: "ignore", detached: true, env: { ...process.env, [INCARNATION_ENV]: tag } }));
    // A second provider that already exited and left a tool child in its group, reparented to init.
    const exited = track(spawn("sh", ["-c", `sleep 1000 & echo $! > ${pids}.orphan`],
      { stdio: "ignore", detached: true, env: { ...process.env, [INCARNATION_ENV]: tag } }));
    // A tagged process in no recorded group: the tag alone must not condemn it.
    const unrecorded = track(spawn("sleep", ["1000"], { stdio: "ignore", detached: true, env: { ...process.env, [INCARNATION_ENV]: tag } }));
    const read = (f: string) => (existsSync(f) ? Number(readFileSync(f, "utf8").trim()) || undefined : undefined);
    await until(() => [".daemon", ".tool", ".orphan"].every((f) => read(pids + f) !== undefined) && exited.exitCode !== null);
    await sleep(50);
    const daemon = read(pids + ".daemon")!;
    const tool = read(pids + ".tool")!;
    const orphan = read(pids + ".orphan")!;
    expect(pgidOf(daemon)).toBe(daemon); // it really left the provider's group
    expect(pgidOf(tool)).toBe(provider.pid);
    expect(pgidOf(orphan)).toBe(exited.pid);
    recordGroups(workspace, tag.split(":")[1]!, [provider.pid!, exited.pid!]);

    try {
      const reaped = await reapStrayProviders(workspace, { graceMs: 200 });
      expect(reaped.sort((a, b) => a - b)).toEqual([provider.pid!, tool, orphan].sort((a, b) => a - b));
      await until(() => ![provider.pid!, tool, orphan].some(processAlive));
      expect(processAlive(daemon)).toBe(true);
      expect(processAlive(unrecorded.pid!)).toBe(true);
    } finally {
      for (const pid of [daemon, tool, orphan]) if (processAlive(pid)) process.kill(pid, "SIGKILL");
    }
  }, 10_000);
});
