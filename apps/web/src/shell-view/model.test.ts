import { describe, expect, it } from "vitest";
import type { Assistant, CompositionBudget, SessionDetail, TaskContext, TaskDetail, TaskEvent, VerificationCheckView } from "../api.js";
import type { Mission } from "../board/execution.js";
import {
  approvalTools, assistantStatus, causeCell, checksCell, costCell, ctxCell, formatAge, isTypingTarget, logLines, modelCell, phaseCell,
  processState, stageCell, contextPressure, quotaFill, quotaPercent, restartOfferedIn, sortRows, toRow, tokensCell, COLUMNS,
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
  it("shows the provider-reported phase verbatim, — when none", () => {
    expect(phaseCell(task({ phase: "editing" }))).toBe("editing");
    expect(phaseCell(task())).toBe("—");
  });
  it("shows cost from costMethod: $x measured, ~$x estimated, unknown otherwise; never computed", () => {
    const p = (b: ProcessDetail["budget"]): ProcessDetail => ({ detail: detail([run()]), budget: b });
    const consumed = (costMethod: CompositionBudget["consumed"]["costMethod"], costUsd: number) => budget({ consumed: { ...budget().consumed, costMethod, costUsd } });
    expect(costCell(undefined)).toBe("…");
    expect(costCell({ detail: detail([]), budget: budget() })).toBe("—");
    expect(costCell(p(consumed("measured", 0.1149)))).toBe("$0.11");
    expect(costCell(p(consumed("estimated", 0.021803)))).toBe("~$0.02");
    expect(costCell(p(consumed("estimated", 0.0045)))).toBe("~$0.0045");
    expect(costCell(p(consumed("unknown", 0.5)))).toBe("unknown");
    expect(costCell(p(consumed("none", 0)))).toBe("unknown");
    expect(costCell(p("off"))).toBe("unknown");
    expect(costCell(p("unavailable"))).toBe("unknown");
    const noAccounting = budget({ consumed: { ...budget().consumed, costMethod: "measured", costUsd: 1 }, runs: [{ ...budget().runs[0]!, accounting: "none" }] });
    expect(costCell(p(noAccounting))).toBe("unknown");
  });
  it("shows context pressure only for a known observation, flags stale, — otherwise", () => {
    const obs = (o: Partial<NonNullable<TaskContext["observation"]>> = {}): TaskContext => ({ status: "known", observation: {
      sequence: 1, observedAt: "", occupancySource: "provider-reported", effectiveWindowSource: "catalog", pressure: 0.31, freshness: "live", ...o } });
    const p = (context: ProcessDetail["context"]): ProcessDetail => ({ detail: detail([run()]), budget: "off", context });
    expect(ctxCell(p(obs()))).toEqual({ text: "31%", stale: false });
    expect(ctxCell(p(obs({ freshness: "stale" })))).toEqual({ text: "31%", stale: true });
    expect(ctxCell(p(obs({ pressure: undefined })))).toEqual({ text: "—", stale: false });
    expect(ctxCell(p({ status: "unavailable", reason: "legacy execution path" }))).toEqual({ text: "—", stale: false });
    expect(ctxCell(p("unavailable")).text).toBe("—");
    expect(ctxCell(p(undefined)).text).toBe("—");
  });
  it("counts the last run's checks by status, skipped not counted, — while running", () => {
    const check = (o: Partial<VerificationCheckView>): VerificationCheckView => ({ name: "c", passed: false, required: true, summary: "", ...o });
    const session = (checks: VerificationCheckView[] | undefined) => ({
      result: { outcome: "completed", terminalState: "ENDED_OK", ...(checks ? { verification: { passed: false, checks } } : {}) },
    }) as unknown as SessionDetail;
    const ended = (s: ProcessDetail["session"]): ProcessDetail => ({ detail: detail([run({ ended_at: "2026-10-29T11:59:00.000Z" })]), budget: "off", session: s });
    const all = [check({ passed: true, status: "passed" }), check({ passed: true }), check({ passed: true, status: "passed" }),
      check({ status: "failed" }), check({ status: "blocked" }), check({ status: "skipped" })];
    expect(checksCell(ended(session(all)))).toEqual({ text: "3✓ 1✗ 1⊘", title: "3 passed, 1 failed, 1 blocked, 1 skipped" });
    expect(checksCell(ended(session([check({ passed: false })]))).text).toBe("1✗");
    expect(checksCell(ended(session([check({ status: "skipped" })]))).text).toBe("—");
    expect(checksCell(ended(session(undefined))).text).toBe("—");
    expect(checksCell(ended("unavailable")).text).toBe("unknown");
    expect(checksCell({ detail: detail([run()]), budget: "off", session: session(all) }).text).toBe("—");
    expect(checksCell({ detail: detail([]), budget: "off" }).text).toBe("—");
  });
  it("names a NEEDS-YOU row's cause from the reads, and leaves other rows' goals alone", () => {
    const blocked = { result: { outcome: "completed", terminalState: "ENDED_OK", verification: { passed: false, checks: [{ name: "t", passed: false, required: true, summary: "", status: "blocked" }] } } } as unknown as SessionDetail;
    const endedRun = detail([run({ ended_at: "2026-10-29T11:59:00.000Z" })]);
    const waiting = task({ state: "WAITING_INPUT" });
    const awaiting = task({ execution: { awaitingApproval: true, assistants: [], verified: true } });
    const attention = (approvals: Array<{ requestId: string; tool: string | null }>, restartOffered = false): ProcessDetail =>
      ({ detail: detail([run()]), budget: "off", attention: { approvals, restartOffered } });
    expect(causeCell(awaiting, attention([{ requestId: "a1", tool: "Bash" }]))).toBe("approve: Bash");
    expect(causeCell(awaiting, attention([{ requestId: "a1", tool: null }, { requestId: "a2", tool: "Write" }]))).toBe("approve: unknown tool (+1)");
    expect(causeCell(task({ state: "LIMIT_PAUSED" }), undefined)).toBe("limit paused");
    expect(causeCell(waiting, { ...attention([], true), detail: endedRun, session: blocked })).toBe("restart offered");
    expect(causeCell(waiting, { ...attention([]), detail: endedRun, session: blocked })).toBe("verify: blocked");
    expect(causeCell(waiting, attention([]))).toBeNull();
    expect(causeCell(waiting, { ...attention([]), attention: "unavailable" })).toBeNull();
    expect(causeCell(task(), attention([{ requestId: "a1", tool: "Bash" }]))).toBeNull();
    const row = toRow(awaiting, attention([{ requestId: "a1", tool: "Bash" }]), NOW);
    expect([row.cause, row.goal]).toEqual(["approve: Bash", "fix it"]);
  });
  it("reads restart offers and approval tools the same way the rest of the web does", () => {
    const s = (o: Partial<SessionDetail>) => ({ taskId: "AG-1", endedAt: null, audit: [], ...o }) as unknown as SessionDetail;
    const offer = { seq: 1, ts: "", type: "recovery.decision", summary: "", payload: { action: "resume_offered" } };
    expect(restartOfferedIn("AG-1", "WAITING_INPUT", [s({ audit: [offer] })])).toBe(true);
    expect(restartOfferedIn("AG-1", "RUNNING", [s({ audit: [offer] })])).toBe(false);
    expect(restartOfferedIn("AG-1", "WAITING_INPUT", [s({ audit: [offer], endedAt: "x" })])).toBe(false);
    expect(restartOfferedIn("AG-1", "WAITING_INPUT", [s({ audit: [{ ...offer, payload: { action: "orphan" } }] })])).toBe(false);
    const e = (payload: Record<string, unknown> | null, type = "approval.requested") => ({ run_id: "r1", seq: 1, ts: "", type, phase: null, summary: "", payload, assistant_id: "a" }) as TaskEvent;
    const tools = approvalTools([e({ requestId: "a1", tool: "Bash" }), e({ requestId: "a2" }), e({ requestId: "a3", tool: "X" }, "message"), e(null)]);
    expect([...tools]).toEqual([["a1", "Bash"], ["a2", null]]);
  });
  it("lists the part B columns in order, and keeps PID, STATE, TOKENS and GOAL at phone width", () => {
    expect(COLUMNS.map(c => c[1])).toEqual(["PID", "STATE", "STAGE", "PHASE", "ASSIST", "MODEL", "TOKENS", "COST", "CTX", "CHECKS", "AGE", "GOAL"]);
    expect(COLUMNS.filter(c => !c[2]).map(c => c[1])).toEqual(["PID", "STATE", "TOKENS", "GOAL"]);
  });
  it("shows the plane's stage as sent, the rule as its title, and — where the plane sent none", () => {
    expect(stageCell(task({ stage: { value: "needs-you", rule: "awaiting-approval" } }))).toEqual({ text: "needs-you", rule: "awaiting-approval" });
    // A value a newer plane adds is shown, not dropped or mapped.
    expect(stageCell(task({ stage: { value: "reviewing", rule: "review-round" } })).text).toBe("reviewing");
    // An older plane sends no stage. The cell does not derive one from the state.
    expect(stageCell(task({ state: "COMPLETED" }))).toEqual({ text: "—", rule: "" });
    expect(stageCell(task({ stage: { value: "", rule: "x" } })).text).toBe("—");
    const row = toRow(task({ stage: { value: "working", rule: "live-run" } }), undefined, NOW);
    expect([row.stage, row.stageRule]).toEqual(["working", "live-run"]);
    expect(toRow(task(), undefined, NOW).stage).toBe("—");
  });
  it("sorts by the stage text", () => {
    const rows = [["A", "working"], ["B", "done"], ["C", "queued"]].map(([id, value]) => toRow(task({ id, stage: { value: value!, rule: "r" } }), undefined, NOW));
    expect(sortRows(rows, { key: "stage", dir: 1 }).map(r => r.pid)).toEqual(["B", "C", "A"]);
  });
  it("reads context pressure one way for the CTX column and the ctx tab", () => {
    const ctx = (o: Partial<NonNullable<TaskContext["observation"]>>): TaskContext => ({ status: "known", observation: { sequence: 1, observedAt: "", occupancySource: "provider-reported", effectiveWindowSource: "provider-reported", freshness: "live", ...o } });
    expect(contextPressure(ctx({ pressure: 0.314 }))).toEqual({ text: "31%", stale: false });
    expect(contextPressure(ctx({ pressure: 0.5, freshness: "stale" }))).toEqual({ text: "50%", stale: true });
    expect(contextPressure(ctx({}))).toEqual({ text: "—", stale: false });
    expect(contextPressure("unavailable").text).toBe("—");
    expect(contextPressure(undefined).text).toBe("—");
    expect(contextPressure({ status: "unavailable", reason: "legacy execution path" }).text).toBe("—");
  });
  it("sorts cost and ctx numerically, unknown last", () => {
    const rows = ["$0.11", "~$0.02", "unknown"].map((cost, i) => ({ ...toRow(task({ id: `T${i}` }), undefined, NOW), cost, ctx: ["5%", "40%", "—"][i]! }));
    expect(sortRows(rows, { key: "cost", dir: -1 }).map(r => r.cost)).toEqual(["$0.11", "~$0.02", "unknown"]);
    expect(sortRows(rows, { key: "ctx", dir: -1 }).map(r => r.ctx)).toEqual(["40%", "5%", "—"]);
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
    expect(quotaFill(62.4)).toBe(62);
    expect(quotaFill(140)).toBe(100);
    expect(quotaFill(-3)).toBe(0);
    expect(quotaFill(Number.NaN)).toBe(0);
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
