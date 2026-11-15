/**
 * P0-10 (docs/agentic-os-auto-copilot-plan.md): the minimum morning report. Every figure is
 * re-derived here from the raw tables (or the budget route, for tokens), so "the numbers reproduce
 * from the DB" is what the test checks, not what the report says about itself.
 */
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AGENT_USER_DEFAULTS } from "../src/config.js";
import type { MorningReport } from "../src/modules/autopilot-report.js";
import { bootRig, type Rig } from "./helpers/composer-cockpit.js";

const T0 = Date.parse("2030-01-01T23:00:00.000Z");
const MIN = 60_000;
const CAP = 1_000;
let rig: Rig | undefined;
let instant = T0;
const now = () => new Date(instant);
const at = (ms: number) => new Date(ms).toISOString();

afterEach(async () => {
  await rig?.close();
  rig = undefined;
  instant = T0;
});

async function boot(): Promise<Rig> {
  rig = await bootRig({
    now,
    requireRevision: true,
    budget: { maxTokens: CAP },
    assistants: { "fake-claude": { provider: "fake", options: { agentUser: true } } },
    configure: (config) => {
      const tree = join(config.dir, "..", "aos");
      mkdirSync(join(tree, "worktrees"), { recursive: true });
      mkdirSync(join(tree, "profiles"), { recursive: true });
      chmodSync(join(tree, "profiles"), 0o2750);
      config.execution.agentUser = { ...AGENT_USER_DEFAULTS, profilesRoot: join(tree, "profiles"), worktreesRoot: join(tree, "worktrees") };
      config.scheduler = { ...config.scheduler!, resources: { "oci-heavy": 1 } };
    },
    autopilotHostGate: () => ({ ok: true }),
  });
  return rig;
}

const ap = () => rig!.built.autopilot;
const head = () => execFileSync("git", ["-C", rig!.repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
async function settle(taskId: string) {
  const moved = new Promise<string>((resolve) => {
    const off = rig!.built.bus.subscribe(taskId, (p) => {
      if (p.kind === "state" && ["COMPLETED", "FAILED", "CANCELLED", "WAITING_INPUT"].includes(p.state!.state)) { off(); resolve(p.state!.state); }
    });
  });
  await rig!.built.scheduler.tick();
  return moved;
}
const report = async (query = "") => {
  const res = await rig!.built.app.inject({ method: "GET", url: `/api/autopilot/report${query}`, headers: rig!.auth() });
  return { status: res.statusCode, get body() { return res.json() as MorningReport; }, raw: res.body };
};

describe("autopilot morning report (P0-10)", () => {
  it("reports nothing to do on a fresh plane, and says the heartbeat is not tracked", async () => {
    await boot();
    const { status, body } = await report();
    expect(status).toBe(200);
    expect(body).toMatchObject({
      window: null, outcomes: {}, attempts: [], runtime: { windowMs: 0 }, unresolvedEffects: [], attestation: null,
      autopilot: { status: "stopped", stopReason: "never-started" },
      heartbeat: { tracked: false, gaps: null },
      tokens: { used: 0, overshoot: 0, attemptsOverCap: 0, available: true },
    });
    expect((await report("?windowId=nope")).status).toBe(404);
    expect((await rig!.built.app.inject({ method: "GET", url: "/api/autopilot/report" })).statusCode).toBe(401);
  });

  it("reproduces outcomes, runtime, tokens and overshoot, charges, stop reason, open effects and attestation age from the DB", async () => {
    await boot();
    const window = ap().addWindow({ opensAt: at(instant - MIN), closesAt: at(instant + 8 * 60 * MIN), maxItems: 3 }, "op_test");
    ap().attest({ extraUsageOff: true, autoReloadOff: true }, "op_test");
    ap().start("op_test");

    const reserved = ap().reserve({ itemId: "item-a", reservationId: "res-a", reservationSha: head() });
    const attempt = ap().admit(reserved.id, { goal: "Ship the feature", repoPath: rig!.repo });
    expect(await settle(attempt.taskId!)).toBe("COMPLETED");
    const runId = (rig!.db.prepare("SELECT id FROM runs WHERE task_id = ?").get(attempt.taskId) as { id: string }).id;
    // A late cumulative record well past the advisory cap: the report must show the overshoot.
    expect((await rig!.postUsage({ eventId: "FAKE-evt-morning", runId, accounting: "cumulative", tokensIn: 2_400, tokensOut: 100 })).status).toBe(201);

    // An unresolved create beside it (a lost response): the report must surface it for itay.
    const ts = at(instant);
    rig!.db.prepare(
      `INSERT INTO autopilot_publications(id, attempt_id, repo, base, head, repo_path, remote, reservation_sha, verified_sha, title, body, state, reason, created_at, updated_at)
       VALUES('pub-a', ?, 'o/r', 'main', 'os/item-a', ?, 'origin', ?, ?, 't', 'aos-publication: pub-a', 'publish_uncertain', 'create response lost', ?, ?)`,
    ).run(attempt.id, rig!.repo, head(), head(), ts, ts);
    rig!.db.prepare("INSERT INTO autopilot_publication_mutations(publication_id, kind, issued_at, outcome, detail) VALUES('pub-a', 'create_pr', ?, 'unknown', 'socket hang up')").run(ts);
    rig!.db.prepare("INSERT INTO autopilot_publication_mutations(publication_id, kind, issued_at, outcome, settled_at) VALUES('pub-a', 'push', ?, 'ok', ?)").run(ts, ts);

    instant += 9 * 60 * MIN; // the morning after: the window has closed
    ap().stop("drain");

    const { status, body } = await report();
    expect(status).toBe(200);

    // Re-derive everything from the tables.
    const runtime = (rig!.db.prepare(
      "SELECT SUM(r.ms) AS ms FROM autopilot_runtime r JOIN autopilot_sessions s ON s.session_id = r.session_id WHERE s.window_id = ?",
    ).get(window.id) as { ms: number }).ms;
    const charged = (rig!.db.prepare("SELECT COUNT(*) AS n FROM autopilot_window_charges WHERE window_id = ?").get(window.id) as { n: number }).n;
    const budget = (await rig!.built.app.inject({ method: "GET", url: `/api/tasks/${attempt.taskId}/composition/budget`, headers: rig!.auth() })).json() as { consumed: { tokens: number } };
    const state = ap().attempt(attempt.id)!;

    expect(runtime).toBeGreaterThanOrEqual(0);
    expect(budget.consumed.tokens).toBe(2_500);
    expect(body.window).toEqual({ id: window.id, opensAt: window.opensAt, closesAt: window.closesAt, maxItems: 3, charged, closed: true });
    expect(charged).toBe(1);
    expect(body.outcomes).toEqual({ [state.state]: 1 });
    expect(body.attempts).toEqual([expect.objectContaining({
      attemptId: attempt.id, itemId: "item-a", attemptNo: 1, taskId: attempt.taskId, state: state.state,
      windowRuntimeMs: runtime, attemptRuntimeMs: state.runtimeUsedMs, runtimeBudgetMs: state.runtimeBudgetMs, sessions: 1,
      tokens: { used: 2_500, cap: CAP, overshoot: 1_500, sessions: 1, provisional: true },
      publication: { id: "pub-a", state: "publish_uncertain", prNumber: null, prUrl: null },
    })]);
    expect(body.runtime.windowMs).toBe(runtime);
    expect(body.tokens).toEqual({ used: 2_500, overshoot: 1_500, attemptsOverCap: 1, available: true });
    expect(body.autopilot).toMatchObject({ status: "draining", stopReason: "drain" });
    expect(body.unresolvedEffects).toEqual([
      { kind: "publication_waiting", attemptId: attempt.id, publicationId: "pub-a", detail: "create response lost" },
      expect.objectContaining({ kind: "mutation_unknown", attemptId: attempt.id, publicationId: "pub-a", detail: "create_pr: socket hang up" }),
    ]);
    // Attested at T0, read nine hours later; the default max age keeps it current.
    expect(body.attestation).toMatchObject({ attestedAt: at(T0), ageHours: 9, current: true, extraUsageOff: true, autoReloadOff: true });

    // The same window by id; and the text form names each figure.
    expect((await report(`?windowId=${window.id}`)).body).toEqual(body);
    const text = (await report("?format=text")).raw;
    expect(text).toContain(`Window ${window.id}`);
    expect(text).toContain("charged 1/3");
    expect(text).toContain("OVER by 1500");
    expect(text).toContain("stop reason: drain");
    expect(text).toContain("Unresolved remote effects: 2");
    expect(text).toContain("Heartbeat gaps: not tracked");
    expect(text).toContain("9h old");
  });

  it("an attempt from an earlier window stays out of tonight's outcomes, but its open effects do not", async () => {
    await boot();
    const first = ap().addWindow({ opensAt: at(instant - MIN), closesAt: at(instant + 60 * MIN), maxItems: 1 }, "op_test");
    ap().attest({ extraUsageOff: true, autoReloadOff: true }, "op_test");
    ap().start("op_test");
    const reserved = ap().reserve({ itemId: "item-old", reservationId: "res-old", reservationSha: head() });
    const attempt = ap().admit(reserved.id, { goal: "Ship the feature", repoPath: rig!.repo });
    expect(await settle(attempt.taskId!)).toBe("COMPLETED");
    rig!.db.prepare("INSERT INTO acceptance_runs(id, attempt_id, run_no, source_ref, state, unknown_effects_json, started_at) VALUES('acc-1', ?, 1, 'origin/main', 'crashed', '[\"pnpm db:seed\"]', ?)")
      .run(attempt.id, at(instant));

    instant += 24 * 60 * MIN;
    const second = ap().addWindow({ opensAt: at(instant - MIN), closesAt: at(instant + 60 * MIN), maxItems: 2 }, "op_test");
    const { body } = await report();
    expect(body.window).toMatchObject({ id: second.id, charged: 0, closed: false });
    expect(body.attempts).toEqual([]);
    expect(body.unresolvedEffects).toEqual([{ kind: "acceptance_unknown_effects", attemptId: attempt.id, acceptanceRunId: "acc-1", detail: "[\"pnpm db:seed\"]" }]);
    expect((await report(`?windowId=${first.id}`)).body.attempts.map((a) => a.attemptId)).toEqual([attempt.id]);
    expect(body.attestation).toMatchObject({ ageHours: 24 });
  });
});
