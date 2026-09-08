/**
 * M14 K9 — SessionRunner context observation over the FakeAdapter (§12 layer 3).
 *
 * OBSERVATION ONLY. Asserts: a truthful `context.observed` per turn boundary
 * with a monotonic per-session sequence; a quota-only `usage.updated` produces
 * NO observation (token accounting is not occupancy); an `unavailable` sample
 * produces nothing (no fabricated number); a scripted `compact_boundary`
 * becomes `context.compaction.observed` and a fresh (relieved) observation
 * follows; and no compaction command is ever issued.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  AssistantId,
  CapabilityManifest,
  ContextObservation,
  ExecutionRequest,
  TaskId,
} from "@agent-plane/core";
import { FakeAdapter, type FakeScript } from "@agent-plane/adapters";
import { openDb, type Db } from "../../src/db/index.js";
import { EventRecorder } from "../../src/modules/harness/event-recorder.js";
import { ApprovalService } from "../../src/modules/harness/approval-service.js";
import { SessionRunner, type RunnerDeps } from "../../src/modules/harness/session-runner.js";
import { SessionStore } from "../../src/modules/harness/session-store.js";

let dir: string;
let db: Db;
let store: SessionStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "k9-observer-"));
  db = openDb(join(dir, "t.db"));
  db.prepare("INSERT INTO assistants (id, provider) VALUES ('a1','fake')").run();
  db.prepare("INSERT INTO tasks (id, goal, envelope, created_at, updated_at) VALUES ('AG-1','g','{}','t','t')").run();
  store = new SessionStore(db);
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const baseManifest = (context: CapabilityManifest["context"]): CapabilityManifest => ({
  assistantId: "a1" as AssistantId,
  provider: "fake",
  core: {
    models: [{ id: "fake-1" }],
    canResume: true,
    canMcp: false,
    supportsMidRunInput: true,
    reportsUsage: true,
    reportsLimits: true,
    execution: { shell: true, filesystem: true, web: "no" },
    auth: { state: "ok" },
  },
  harness: { usageAccounting: "delta", toolGating: "none", approvalRelay: true, processIsolation: "none" },
  context,
  providerDetail: {},
  evidence: { source: "runtime-probe", observedAt: "t" },
});

const PROVIDER_REPORTED = baseManifest({
  occupancy: "provider-reported",
  effectiveWindow: "provider-reported",
  compact: "none",
  autoManagement: "none",
  observesAutoCompaction: true,
});

function deps(manifest: CapabilityManifest, script?: FakeScript): RunnerDeps {
  return {
    store,
    recorder: new EventRecorder(db),
    approvals: new ApprovalService(db),
    checkpoints: { create: async () => ({ id: `ckpt_${Math.random().toString(36).slice(2)}`, gitRef: null }) },
    registry: { adapter: () => new FakeAdapter("a1" as AssistantId, script), manifest: () => manifest },
    softThresholdPct: 80,
    approvalPollMs: 5,
  };
}

function request(prompt: string, over: Partial<ExecutionRequest> = {}): ExecutionRequest {
  return {
    schemaVersion: 1,
    executionRequestId: "erq_1",
    taskId: "AG-1" as TaskId,
    attempt: 1,
    assistantId: "a1" as AssistantId,
    routingDecisionRef: "rd_1",
    runSpec: {
      taskId: "AG-1" as TaskId,
      prompt,
      workdir: dir,
      permissionPolicy: { mode: "auto-approve" },
      env: { redactionRules: [], maxRuntimeMs: 60_000 },
    },
    policy: {
      budget: { enforcement: "advisory" },
      timeout: { hardMs: 60_000 },
      approval: { mode: "auto-approve" },
      tools: { mode: "audit" },
      checkpoint: { onSoftLimit: true },
      isolation: { required: "ambient" },
    },
    context: {},
    verification: [],
    origin: { kind: "fresh" },
    ...over,
  };
}

const rows = (type: string) =>
  (
    db
      .prepare("SELECT payload FROM events WHERE run_id = ? AND type = ? ORDER BY seq")
      .all(store.forRequest("erq_1")!.sessionId as string, type) as Array<{ payload: string | null }>
  ).map((r) => (r.payload ? (JSON.parse(r.payload) as Record<string, unknown>) : {}));

const seqOf = (type: string) =>
  (
    db
      .prepare("SELECT seq FROM events WHERE run_id = ? AND type = ? ORDER BY seq")
      .all(store.forRequest("erq_1")!.sessionId as string, type) as Array<{ seq: number }>
  ).map((r) => r.seq);

describe("K9 SessionRunner observation", () => {
  it("records a truthful observation per turn with a monotonic per-session sequence", async () => {
    const runner = new SessionRunner(deps(PROVIDER_REPORTED));
    const result = await runner.run(request("[FAKE:CONTEXT:0.46]"));
    expect(result.outcome).toBe("completed");

    const observed = rows("context.observed") as unknown as ContextObservation[];
    expect(observed.length).toBeGreaterThanOrEqual(2); // one per assistant message
    expect(observed.map((o) => o.sequence)).toEqual(observed.map((_, i) => i + 1));
    for (const o of observed) {
      expect(o.occupancySource).toBe("provider-reported");
      expect(o.occupancyTokens).toBe(92_000);
      expect(o.pressure).toBeCloseTo(0.46, 4);
      expect(o.freshness).toBe("live");
    }
  });

  it("occupancy known but effective window unknown → tokens, no percentage", async () => {
    const runner = new SessionRunner(deps(PROVIDER_REPORTED));
    await runner.run(request("[FAKE:CONTEXT:nowindow]"));
    const observed = rows("context.observed") as unknown as ContextObservation[];
    expect(observed.length).toBeGreaterThan(0);
    for (const o of observed) {
      expect(o.occupancyTokens).toBe(72_000);
      expect(o.pressure).toBeUndefined();
      expect(o.effectiveWindowSource).toBe("unavailable");
    }
  });

  it("a quota-only usage.updated produces NO context observation (accounting is not occupancy)", async () => {
    const script: FakeScript = {
      ok: true,
      events: [
        {
          type: "usage.updated",
          summary: "quota 80%",
          payload: { quota: [{ window: "5h", usedPercent: 80 }] },
        },
        { type: "message", summary: "done", payload: { text: "done" } },
      ],
    };
    // No `[FAKE:CONTEXT:…]` marker ⇒ the adapter exposes no sample.
    const runner = new SessionRunner(deps(PROVIDER_REPORTED, script));
    await runner.run(request("plain run, no context marker"));
    expect(rows("context.observed")).toHaveLength(0);
  });

  it("an unavailable sample records nothing — never a fabricated number", async () => {
    const runner = new SessionRunner(deps(PROVIDER_REPORTED));
    await runner.run(request("[FAKE:CONTEXT:unavailable]"));
    expect(rows("context.observed")).toHaveLength(0);
  });

  it("does not observe when the manifest declares occupancy unavailable (Codex-shaped)", async () => {
    const codexShaped = baseManifest({
      occupancy: "unavailable",
      effectiveWindow: "unavailable",
      compact: "none",
      autoManagement: "provider",
      observesAutoCompaction: false,
    });
    const runner = new SessionRunner(deps(codexShaped));
    await runner.run(request("[FAKE:CONTEXT:0.5]"));
    expect(rows("context.observed")).toHaveLength(0);
  });

  it("forwards a scripted compact_boundary and re-observes after it — issuing no compaction command", async () => {
    const runner = new SessionRunner(deps(PROVIDER_REPORTED));
    await runner.run(request("[FAKE:CONTEXT:0.8] [FAKE:COMPACT]"));

    // The provider boundary is forwarded, not dropped, and is not our action.
    const compaction = rows("context.compaction.observed");
    expect(compaction).toHaveLength(1);
    expect(compaction[0]).toMatchObject({ trigger: "auto", requestedByPlane: false });

    // A fresh observation is recorded AFTER the boundary (re-observation), and it
    // reflects the post-compaction relief (below the 0.8 the marker started at).
    const compactionSeq = seqOf("context.compaction.observed")[0]!;
    const observedSeqs = seqOf("context.observed");
    expect(observedSeqs.some((s) => s > compactionSeq)).toBe(true);
    const observed = rows("context.observed") as unknown as ContextObservation[];
    expect(observed.at(-1)!.pressure).toBeLessThan(0.8);
    expect(observed.at(-1)!.pressure).toBeCloseTo(0.4, 2);

    // K9 issues no compaction command: no guard.decision touches compaction.
    const guards = rows("guard.decision");
    expect(guards.every((g) => g.directive !== "compact" && !String(g.reason ?? "").includes("compact"))).toBe(true);
  });
});
