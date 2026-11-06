import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import type { SessionDetail, SessionVerification, TaskContext, TaskDetail, VerificationCheckView } from "../api.js";
import { DetailTabs, TAB_REGION, type FilesData, type VerifyData } from "./DetailTabs.js";
import type { TabRead } from "./reads.js";
import { TABS, contextView, filesView, lastRunId, verifyView } from "./tabs.js";

const check = (o: Partial<VerificationCheckView> = {}): VerificationCheckView => ({ name: "typecheck", passed: true, required: true, summary: "ok", ...o });
const session = (o: Partial<SessionDetail> = {}): SessionDetail => ({
  sessionId: "r1", taskId: "AG-1", endedAt: "2026-11-06T07:00:00.000Z", result: null, checkpoints: [], approvals: [], audit: [], ...o,
}) as unknown as SessionDetail;
const withChecks = (checks: VerificationCheckView[], passed = checks.every(c => c.passed)) =>
  session({ result: { outcome: "completed", terminalState: "COMPLETED", verification: { passed, checks } } });
const revision = (n: number, reason: SessionVerification["revisions"][number]["reason"]) =>
  ({ id: `v${n}`, sessionId: "r1", executionRequestId: "e", revision: n, supersedesRevisionId: null, planFingerprint: "f", plan: null, reason, createdAt: "" });
const plan = (...revisions: SessionVerification["revisions"]): SessionVerification => ({ sessionId: "r1", revisions, runs: [] });

describe("tab keys", () => {
  it("are 1 to 4 in the order log, verify, files, ctx", () => {
    expect(TABS.map(t => `${t.key}:${t.id}`)).toEqual(["1:log", "2:verify", "3:files", "4:ctx"]);
    expect(Object.keys(TAB_REGION)).toEqual(TABS.map(t => t.id));
  });
  it("reads the verify session from the task's newest run", () => {
    expect(lastRunId(undefined)).toBeNull();
    expect(lastRunId({ runs: [] })).toBeNull();
    expect(lastRunId({ runs: [{ id: "r1" }, { id: "r2" }] } as TaskDetail)).toBe("r2");
  });
});

describe("verify tab", () => {
  it("lists each check with its status, required flag and summary, and the plan revision reason", () => {
    const v = verifyView(withChecks([
      check(),
      check({ name: "lint", passed: false, status: "blocked", summary: "eslint not found. Install it with: pnpm add -D eslint" }),
      check({ name: "e2e", passed: false, status: "skipped", required: false, summary: "no browser" }),
    ]), plan(revision(1, "initial"), revision(2, "post_change")));
    expect(v.checks.map(c => [c.name, c.label, c.required])).toEqual([["typecheck", "passed", true], ["lint", "blocked", true], ["e2e", "skipped", false]]);
    // A blocked check's install hint is shown verbatim, not reworded.
    expect(v.checks[1]!.summary).toBe("eslint not found. Install it with: pnpm add -D eslint");
    expect(v.plan).toBe("plan revision 2 of 2: post_change");
    expect(v.verdict).toBe("blocked (1 skipped)");
  });
  it("keeps the passed/failed reading for a legacy check with no status", () => {
    const v = verifyView(withChecks([check({ passed: false, summary: "2 failed" })]), null);
    expect(v.checks[0]!.label).toBe("failed");
    expect(v.verdict).toBe("failed");
    expect(v.plan).toBeNull();
  });
  it("says why there is nothing to list instead of an empty pane", () => {
    expect(verifyView(undefined, null).note).toMatch(/legacy path/);
    expect(verifyView(session(), plan(revision(1, "initial"))).note).toMatch(/not ended/);
    expect(verifyView(session({ result: { outcome: "completed", terminalState: "COMPLETED" } }), null).note).toMatch(/recorded no verification/);
    expect(verifyView(withChecks([]), null).note).toMatch(/no checks/);
  });
});

describe("files tab", () => {
  const detail = { branch: "task/AG-1", envelope: { artifacts: { changedFiles: ["src/a.ts", "README.md"], testResults: [] } } } as unknown as TaskDetail;
  it("joins each checkpoint to the session's diffStat by id and leaves it null without a session", () => {
    const points = [{ id: "c1", reason: "manual", at: "2026-11-06T07:00:00.000Z", gitRef: "abc123" }, { id: "c2", reason: "quota", at: "2026-11-06T07:05:00.000Z", gitRef: null }];
    const withStat = session({ checkpoints: [{ id: "c1", reason: "manual", gitRef: "abc123", diffStat: "1 file changed", at: "" }] });
    const f = filesView(detail, points, withStat);
    expect(f.branch).toBe("task/AG-1");
    expect(f.files).toEqual(["src/a.ts", "README.md"]);
    expect(f.checkpoints.map(c => [c.id, c.gitRef, c.diffStat])).toEqual([["c1", "abc123", "1 file changed"], ["c2", null, null]]);
    expect(filesView(detail, points, undefined).checkpoints.every(c => c.diffStat === null)).toBe(true);
  });
  it("is empty, not invented, for a task with no branch or files", () => {
    expect(filesView(undefined, [], undefined)).toEqual({ branch: null, files: [], checkpoints: [] });
  });
});

describe("ctx tab", () => {
  const known = (o: Partial<TaskContext> = {}, obs: Partial<NonNullable<TaskContext["observation"]>> = {}): TaskContext => ({
    status: "known",
    observation: { sequence: 3, observedAt: "2026-11-06T07:00:00.000Z", occupancyTokens: 82_000, occupancySource: "provider-reported", effectiveWindowTokens: 180_000,
      effectiveWindowSource: "catalog", pressure: 0.456, freshness: "live", breakdown: [{ category: "system", tokens: 4_000 }, { category: "messages", tokens: 78_000 }], ...obs },
    autoCompaction: { observed: true, count: 2 },
    continuation: { number: 1, limit: 3, reason: "context_critical" },
    ...o,
  });
  const value = (v: ReturnType<typeof contextView>, label: string) => v.rows.find(r => r.label === label)?.value;
  it("shows occupancy, window, source, freshness, breakdown, auto-compaction and continuation", () => {
    const v = contextView(known());
    expect(value(v, "occupancy")).toBe("82k / 180k tokens");
    expect(value(v, "pressure")).toBe("46%");
    expect(value(v, "source")).toBe("provider-reported");
    expect(value(v, "window")).toBe("catalog");
    expect(value(v, "freshness")).toBe("live");
    expect(value(v, "auto-compaction")).toBe("observed ×2");
    expect(value(v, "continuation")).toBe("1 of 3");
    expect(v.breakdown).toEqual([{ category: "system", tokens: "4k" }, { category: "messages", tokens: "78k" }]);
  });
  it("dims a stale pressure and never invents one", () => {
    const stale = contextView(known({}, { freshness: "stale" }));
    expect(stale.rows.find(r => r.label === "pressure")).toMatchObject({ value: "46%", dim: true });
    const none = contextView(known({ autoCompaction: undefined, continuation: undefined }, { pressure: undefined }));
    expect(none.rows.find(r => r.label === "pressure")).toMatchObject({ value: "—", dim: true });
    expect(value(none, "auto-compaction")).toBe("not observed");
    expect(value(none, "continuation")).toBe("none");
  });
  it("names why there is no observation", () => {
    expect(contextView(null).note).toBe("context read unavailable");
    expect(contextView({ status: "unavailable", reason: "legacy execution path" }).note).toBe("occupancy unavailable: legacy execution path");
    expect(contextView({ status: "unavailable" }).rows).toEqual([]);
  });
});

describe("DetailTabs", () => {
  const ok = <T,>(value: T): TabRead<T> => ({ status: "ok", value });
  const render = (tab: (typeof TABS)[number]["id"], o: { verify?: TabRead<VerifyData>; files?: TabRead<FilesData>; hasRun?: boolean | null; pid?: string | null } = {}) =>
    renderToStaticMarkup(createElement(DetailTabs, {
      tab, onTab: () => {}, pid: o.pid === undefined ? "AG-1" : o.pid, detail: undefined, hasRun: o.hasRun === undefined ? true : o.hasRun, context: undefined,
      verify: o.verify ?? { status: "idle" }, files: o.files ?? { status: "idle" }, before: createElement("i", { id: "before" }), log: createElement("ol", { id: "log" }),
    }));
  it("marks exactly the chosen tab selected and shows the key beside each label", () => {
    const html = render("files");
    expect(html.match(/aria-selected="true"/g)).toHaveLength(1);
    expect(html).toMatch(/id="sv-tab-files"[^>]*aria-selected="true"/);
    for (const t of TABS) expect(html).toContain(`<kbd>${t.key}</kbd> ${t.label}`);
  });
  it("shows the log only on the log tab, and the shared header on every tab", () => {
    for (const t of TABS) {
      const html = render(t.id, { verify: ok({ session: undefined, verification: null }), files: ok({ checkpoints: [], session: undefined }) });
      expect(html.includes('id="log"')).toBe(t.id === "log");
      expect(html).toContain('id="before"');
    }
  });
  it("says it is reading, and says there is no run, rather than render an empty pane", () => {
    expect(render("verify", { verify: { status: "loading" } })).toContain("reading verification…");
    expect(render("verify", { hasRun: false })).toContain("no run yet");
    expect(render("files", { files: { status: "error", message: "boom" } })).toContain("checkpoints read failed: boom");
    expect(render("log", { pid: null })).toContain("no task selected");
  });
  it("renders a blocked check's hint verbatim", () => {
    const blocked = withChecks([check({ name: "lint", passed: false, status: "blocked", summary: "eslint not found. Install it with: pnpm add -D eslint" })]);
    const html = render("verify", { verify: ok({ session: blocked, verification: plan(revision(1, "recovery")) }) });
    expect(html).toContain("eslint not found. Install it with: pnpm add -D eslint");
    expect(html).toContain("plan revision 1 of 1: recovery");
    expect(html).toContain('data-status="blocked"');
  });
});
