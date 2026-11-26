/** Autopilot state v1 (docs/contracts/autopilot-state-v1.md): the projection copies, renames and redacts. */
import { describe, expect, it } from "vitest";
import { AUTOPILOT_STATE_PATH, AUTOPILOT_STATE_URL, projectAutopilotState, redactAutopilotText, REDACTED, type AutopilotStateSources } from "../src/index.js";

const T = "2030-01-01T23:00:00.000Z";
const base = (): AutopilotStateSources => ({
  status: { status: "stopped", updatedAt: T, window: null, nextWindowOpensAt: null, attempt: null, billingAttestation: null, settings: [] },
  windows: [], attempts: [],
  dispatcher: { problems: [], inFlight: [], selection: [] },
  restore: { pending: false, reconciling: false },
  openExternals: 0,
});

describe("redactAutopilotText", () => {
  it("replaces secrets, URLs and filesystem paths, and keeps config keys, refs and the plane's API routes", () => {
    expect(redactAutopilotText("auth failed: Bearer FAKE-token-not-real")).toBe(`auth failed: ${REDACTED}`);
    expect(redactAutopilotText("token=FAKE-secret-not-real")).not.toContain("FAKE-secret-not-real");
    expect(redactAutopilotText("git failed in /var/lib/aos/worktrees/apa_1 (exit 1)")).toBe(`git failed in ${AUTOPILOT_STATE_PATH} (exit 1)`);
    expect(redactAutopilotText("read ~/.agent-plane/personal/github-token")).toBe(`read ${AUTOPILOT_STATE_PATH}`);
    expect(redactAutopilotText("/home/u/repo is not clean")).toBe(`${AUTOPILOT_STATE_PATH} is not clean`);
    expect(redactAutopilotText("GET https://api.github.com/repos/o/r/git/refs failed")).toBe(`GET ${AUTOPILOT_STATE_URL} failed`);
    expect(redactAutopilotText("autopilot.repos.plane.path is not in repoAllowlist")).toBe("autopilot.repos.plane.path is not in repoAllowlist");
    expect(redactAutopilotText("behind origin/main by 3")).toBe("behind origin/main by 3");
    expect(redactAutopilotText("Run POST /api/autopilot/restore/reconcile")).toBe("Run POST /api/autopilot/restore/reconcile");
  });
});

describe("projectAutopilotState", () => {
  it("a stopped, empty plane is all nulls and empty lists, never missing keys", () => {
    const s = projectAutopilotState(base(), T);
    expect(s).toEqual({
      schemaVersion: "1.0", observedAt: T, status: "stopped", stopReason: null, startedBy: null, updatedAt: T,
      window: null, nextWindowOpensAt: null, windows: [], billingAttestation: null, settingProblems: [],
      currentAttempt: null, recentAttempts: [],
      dispatcher: { problems: [], inFlight: [], selection: [], lastTick: null },
      restore: { pending: false, reconciling: false, restoreId: null, detectedAt: null, reconciledAt: null, reconcileError: null, reportComplete: null, reportReadCurrent: null, startBlockedBy: null },
      openExternals: 0,
    });
  });

  it("drops fields outside the contract, marks final attempts, caps recent attempts at 20 and redacts every free-text field", () => {
    const src = base();
    const attempt = (n: number, state: string) => ({
      id: `apa_${n}`, itemId: `item-${n}`, attemptNo: 1, state, reason: "failed in /var/lib/aos/worktrees/x with Bearer FAKE-token-not-real",
      repo: "plane", taskId: `task_${n}`, runtimeBudgetMs: 10, runtimeUsedMs: 1, createdAt: T, updatedAt: T,
      reservationId: "refs/heads/aos/reservation/x", reservationSha: "a".repeat(40), worktreePath: "/var/lib/aos/worktrees/x",
    });
    src.attempts = Array.from({ length: 25 }, (_, i) => attempt(i, i === 0 ? "running" : "failed"));
    src.status.attempt = src.attempts[0]!;
    src.status.stopReason = "github-auth: GET https://api.github.com failed";
    src.status.settings = [{ setting: "execution.agentUser", detail: "profiles under /var/lib/aos/profiles" }];
    src.status.window = { id: "apw_1", opensAt: T, closesAt: T, maxItems: 3, charged: 1, exhaustedByRestore: "apr_1" };
    src.dispatcher = { problems: ["clone /var/lib/aos/repos/x missing"], inFlight: ["accept:apa_0"], selection: [{ itemId: "a", status: "blocked", reason: "see ~/notes" }],
      lastTick: { at: T, result: { action: "drove", attemptId: "apa_0", state: "accepting", detail: "checkout /tmp/x" } } };
    src.restore = { pending: true, reconciling: false, restoreId: "apr_1", detectedAt: T, reconcileError: "token=FAKE-secret-not-real", startBlockedBy: { setting: "restore.reconcile", detail: "Run POST /api/autopilot/restore/reconcile" } };
    const s = projectAutopilotState(src, T);
    const wire = JSON.stringify(s);
    for (const leak of ["FAKE-token-not-real", "FAKE-secret-not-real", "/var/lib/aos", "api.github.com", "~/notes", "/tmp/x", "reservation", "aaaaaaaa"]) expect([leak, wire.includes(leak)]).toEqual([leak, false]);
    expect(s.recentAttempts).toHaveLength(20);
    expect(s.currentAttempt).toMatchObject({ id: "apa_0", final: false });
    expect(s.recentAttempts[1]).toMatchObject({ state: "failed", final: true, deadlineAt: null, finalAt: null });
    expect(Object.keys(s.currentAttempt!)).not.toContain("worktreePath");
    expect(s.window).toMatchObject({ exhaustedByRestore: true });
    expect(s.dispatcher.lastTick).toEqual({ at: T, action: "drove", itemId: null, attemptId: "apa_0", detail: `accepting: checkout ${AUTOPILOT_STATE_PATH}` });
    expect(s.restore.startBlockedBy).toEqual({ setting: "restore.reconcile", detail: "Run POST /api/autopilot/restore/reconcile" });
  });
});
