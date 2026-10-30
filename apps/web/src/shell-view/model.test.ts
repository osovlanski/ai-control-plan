import { describe, expect, it } from "vitest";
import type { Assistant, CompositionBudget, TaskDetail, TaskEvent } from "../api.js";
import type { Mission } from "../board/execution.js";
import {
  assistantStatus, formatAge, isTypingTarget, logLines, modelCell, processState, quotaBar, quotaPercent, sortRows, toRow, tokensCell,
  type ProcessDetail,
} from "./model.js";
import { readView, writeView, VIEW_KEY } from "./viewMode.js";

const NOW = Date.parse("2026-10-29T12:00:00.000Z");
const task = (o: Partial<Mission> = {}): Mission => ({
  id: "AG-1", goal: "fix it", state: "RUNNING", phase: null, profile: "auto", repoPath: null,
  createdAt: "2026-10-29T11:57:00.000Z", updatedAt: "2026-10-29T11:59:00.000Z", ...o,
});
type Run = TaskDetail["runs"][number];
const run = (o: Partial<Run> = {}): Run => ({ id: "r1", assistant_id: "claude", state: "RUNNING", usage: null, started_at: "", ended_at: null, ...o });
const detail = (runs: Run[]): TaskDetail => ({ id: "AG-1", goal: "", state: "RUNNING", activity_phase: null, profile: "auto", repo_path: null, branch: null,
  envelope: { goal: "", constraints: [], status: { state: "RUNNING" }, completed: [], remaining: [], decisions: [], artifacts: { changedFiles: [], testResults: [] } },
  runs, active: true });
const budget = (o: Partial<CompositionBudget> = {}): CompositionBudget => ({
  taskId: "AG-1", provisional: true, caps: { max_tokens: 10_000 },
  consumed: { tokens: 4100, costUsd: 0, costMethod: "none", unknownCostSessions: 0, sessions: 1, recordCount: 1 },
  remaining: {}, exhausted: [], latestRevision: null,
  runs: [{ runId: "r1", assistantId: "claude", compositionRevisionId: null, model: null, accounting: "cumulative",
    tokens: 4100, source: "in_run", inRunTokens: 4100, recordTokens: 0, recordCount: 0, regressed: [], cost: { method: "unknown" } }],
  overruns: [], ...o,
} as CompositionBudget);

describe("process state", () => {
  it("maps the plane's attention states to NEEDS-YOU and keeps the rest", () => {
    expect(processState(task({ state: "WAITING_INPUT" }))).toBe("NEEDS-YOU");
    expect(processState(task({ state: "LIMIT_PAUSED" }))).toBe("NEEDS-YOU");
    expect(processState(task({ execution: { awaitingApproval: true, assistants: [], verified: true } }))).toBe("NEEDS-YOU");
    expect(processState(task())).toBe("RUNNING");
    expect(processState(task({ execution: { awaitingApproval: false, assistants: [], verified: false } }))).toBe("UNKNOWN");
    expect(processState(task({ state: "WAITING_RESOURCE" }))).toBe("WAITING");
    expect(processState(task({ state: "CREATED", wait: { state: "active", generation: 1, kind: "time", reason: "", notBefore: "" } }))).toBe("WAITING");
    expect(processState(task({ state: "HANDING_OFF" }))).toBe("HANDING-OFF");
  });
  it("pins NEEDS-YOU above any column sort", () => {
    const rows = [task({ id: "A", goal: "a" }), task({ id: "B", goal: "b", state: "WAITING_INPUT" }), task({ id: "C", goal: "c", state: "COMPLETED" })]
      .map(t => toRow(t, undefined, NOW));
    expect(sortRows(rows, { key: null, dir: 1 }).map(r => r.pid)).toEqual(["B", "A", "C"]);
    expect(sortRows(rows, { key: "goal", dir: -1 }).map(r => r.pid)).toEqual(["B", "C", "A"]);
    expect(sortRows(rows, { key: "pid", dir: 1 }).map(r => r.pid)).toEqual(["B", "A", "C"]);
  });
});

describe("row cells never invent a value", () => {
  it("shows the resolved model, or unknown when the provider reported none", () => {
    expect(modelCell(undefined)).toBe("…");
    expect(modelCell({ detail: detail([]), budget: "off" })).toBe("—");
    expect(modelCell({ detail: detail([run()]), budget: "off" })).toBe("unknown");
    const identity = { requestedSelector: "opus", resolvedModelId: "claude-opus-5-5", resolvedSource: "provider", servingProvider: null };
    expect(modelCell({ detail: detail([run({ modelIdentity: identity })]), budget: "off" })).toBe("claude-opus-5-5");
  });
  it("shows tokens used / cap from the budget read, unknown without accounting", () => {
    const p = (b: ProcessDetail["budget"]): ProcessDetail => ({ detail: detail([run()]), budget: b });
    expect(tokensCell(p(budget()))).toBe("4.1k/10k");
    expect(tokensCell(p(budget({ caps: {} })))).toBe("4.1k");
    expect(tokensCell(p("off"))).toBe("unknown");
    expect(tokensCell(p("unavailable"))).toBe("unknown");
    expect(tokensCell(p(budget({ runs: [{ ...budget().runs[0]!, accounting: "none" }] })))).toBe("unknown");
    expect(tokensCell({ detail: detail([]), budget: budget() })).toBe("—");
  });
  it("formats age", () => {
    expect(formatAge("2026-10-29T11:59:30.000Z", NOW)).toBe("30s");
    expect(formatAge("2026-10-29T11:48:00.000Z", NOW)).toBe("12m");
    expect(formatAge("2026-10-29T10:00:00.000Z", NOW)).toBe("2h");
  });
});

describe("top panel", () => {
  const assistant = (limits?: Array<{ window: string; usedPercent: number }>, enabled = true): Assistant => ({
    id: "claude", provider: "claude", enabled, manifestUpdatedAt: null,
    manifest: { core: { models: [], canResume: true, canMcp: true, supportsMidRunInput: true, reportsUsage: true, reportsLimits: true,
      execution: { shell: true, filesystem: true, web: "no" }, auth: { state: "ok" }, ...(limits ? { limits } : {}) }, providerDetail: {} },
  });
  it("reads the highest reported quota window and says unknown when none is reported", () => {
    expect(quotaPercent(assistant([{ window: "5h", usedPercent: 62 }, { window: "7d", usedPercent: 20 }]))).toBe(62);
    expect(quotaPercent(assistant())).toBeNull();
    expect(quotaBar(62)).toBe("▮▮▯▯");
    expect(quotaBar(100)).toBe("▮▮▮▮");
    expect(quotaBar(null)).toBe("▯▯▯▯");
  });
  it("names off and cooling assistants", () => {
    expect(assistantStatus(assistant(undefined, false), [], NOW)).toBe("off");
    expect(assistantStatus(assistant(), [{ assistantId: "claude", until: "2026-10-29T13:00:00.000Z" }], NOW)).toBe("cooling");
    expect(assistantStatus(assistant(), [{ assistantId: "claude", until: "2026-10-29T11:00:00.000Z" }], NOW)).toBe("ready");
  });
});

describe("event log and keys", () => {
  it("orders events oldest first, like tail -f", () => {
    const e = (seq: number, ts: string, type: string): TaskEvent => ({ run_id: "r1", seq, ts, type, phase: null, summary: type, payload: null } as TaskEvent);
    const lines = logLines([e(2, "2026-10-29T12:00:02.000Z", "b"), e(1, "2026-10-29T12:00:01.000Z", "a")]);
    expect(lines.map(l => l.type)).toEqual(["a", "b"]);
    expect(lines[0]!.time).toMatch(/^\d\d:\d\d:\d\d$/);
  });
  it("treats text fields as typing targets", () => {
    expect(isTypingTarget(null)).toBe(false);
    expect(isTypingTarget({} as EventTarget)).toBe(false);
    for (const tagName of ["INPUT", "TEXTAREA", "SELECT"]) expect(isTypingTarget({ tagName } as unknown as EventTarget)).toBe(true);
    expect(isTypingTarget({ tagName: "DIV", isContentEditable: true } as unknown as EventTarget)).toBe(true);
    expect(isTypingTarget({ tagName: "BUTTON", isContentEditable: false } as unknown as EventTarget)).toBe(false);
  });
});

describe("view preference", () => {
  it("defaults to orbit and survives a throwing or absent storage", () => {
    const store = new Map<string, string>();
    const s = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) };
    expect(readView(s)).toBe("orbit");
    writeView("shell", s);
    expect(store.get(VIEW_KEY)).toBe("shell");
    expect(readView(s)).toBe("shell");
    const broken = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } };
    expect(readView(broken)).toBe("orbit");
    expect(() => writeView("shell", broken)).not.toThrow();
    expect(readView(undefined)).toBe("orbit");
  });
});
