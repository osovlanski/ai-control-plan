/**
 * p1-3 slice 1: `aos task ls|show|events [--follow]|verdict` against a real plane (routes, router,
 * database, FakeAdapter). Each command reaches only its COMMAND_ROUTES; --json is the served body
 * (or the served reads under named keys); `--follow` streams a task from approval to done.
 */
import { afterEach, describe, expect, it } from "vitest";
import type { TaskEvent } from "../../web/src/api.js";
import { COMMAND_ROUTES, verdictText, type TaskVerdict } from "../src/task.js";
import { aos, bearer, bootPlane, type Plane } from "./helpers.js";

let plane: Plane | undefined;
afterEach(async () => { await plane?.close(); plane = undefined; });

const task = (argv: string[], opts: { fetchImpl?: typeof fetch } = {}) => aos(plane!, argv, { ...opts, group: "task" });
const auth = () => ({ authorization: `Bearer ${bearer(plane!)}` });

async function start(id: string, assistantId = "fake-a") {
  const res = await plane!.built.app.inject({ method: "POST", url: `/api/tasks/${id}/start`, headers: auth(), payload: { assistantId } });
  expect(res.statusCode, res.body).toBe(200);
}

/** A fetch that records `METHOD path` with task and run ids replaced by `:id`. */
function recorder(ids: string[]) {
  const seen = new Set<string>();
  const fetchImpl: typeof fetch = (input, init) => {
    let path = new URL(String(input)).pathname;
    for (const id of ids) path = path.replace(`/${id}`, "/:id");
    seen.add(`${init?.method ?? "GET"} ${path}`);
    return fetch(input, init);
  };
  return { seen, fetchImpl };
}

function awaitEvent(id: string, type: string): Promise<void> {
  return new Promise((resolve) => {
    const off = plane!.built.bus.subscribe(id, (p) => { if (p.event?.type === type) { off(); resolve(); } });
  });
}

describe("aos task reads against a real plane", () => {
  it("ls lists tasks as served; --attention and --state filter the served list, never re-derive it", async () => {
    plane = await bootPlane();
    const quiet = plane.built.tasks.create({ goal: "Document the parser module" }).taskId;
    const waiting = plane.built.tasks.create({ goal: "Add a typed helper to the parser [FAKE:APPROVAL]" }).taskId;
    const requested = awaitEvent(waiting, "approval.requested");
    await start(waiting);
    await requested;

    const { seen, fetchImpl } = recorder([]);
    const asJson = await task(["ls", "--json"], { fetchImpl });
    expect(asJson.code, asJson.err).toBe(0);
    expect([...seen]).toEqual([...COMMAND_ROUTES.ls!]);
    const served = (await plane.built.app.inject({ method: "GET", url: "/api/tasks", headers: auth() })).json() as Array<{ id: string; state: string; stage?: { value: string } }>;
    expect(JSON.parse(asJson.out)).toEqual(served);

    const text = await task(["ls"]);
    expect(text.out).toMatch(/^ID\s+STATE\s+STAGE\s+UPDATED\s+GOAL/);
    expect(text.out).toContain(quiet);
    const attention = await task(["ls", "--attention", "--json"]);
    expect(JSON.parse(attention.out)).toEqual(served.filter((t) => t.stage?.value === "needs-you"));
    const created = await task(["ls", "--state", "created", "--json"]);
    expect((JSON.parse(created.out) as Array<{ id: string }>).map((t) => t.id)).toEqual([quiet]);
    const working = await task(["ls", "--stage", "working", "--json"]);
    expect((JSON.parse(working.out) as Array<{ id: string }>).map((t) => t.id)).toEqual(served.filter((t) => t.stage?.value === "working").map((t) => t.id));

    // A needs-you row as the plane would serve it (a Harness session awaiting approval).
    const row = { ...served[0]!, id: "AG-needs", stage: { value: "needs-you", rule: "awaiting-approval" } };
    const canned: typeof fetch = async () => new Response(JSON.stringify([row, served[1]]), { status: 200 });
    const picked = await task(["ls", "--attention"], { fetchImpl: canned });
    expect(picked.out).toContain("AG-needs");
    expect(picked.out.split("\n")).toHaveLength(2);
  });

  it("show prints the detail, stage and the embedded provenance block, and --json adds them to the served detail", async () => {
    plane = await bootPlane();
    const id = plane.built.tasks.create({ goal: "Ship the feature [FAKE:LIMIT]" }).taskId;
    await start(id);
    await plane.built.orchestrator.waitForSettled(id);

    const { seen, fetchImpl } = recorder([id]);
    const asJson = await task(["show", id, "--json"], { fetchImpl });
    expect(asJson.code, asJson.err).toBe(0);
    expect([...seen].sort()).toEqual([...COMMAND_ROUTES.show!].sort());
    const body = JSON.parse(asJson.out) as Record<string, unknown> & { provenance: unknown; stage: unknown };
    const detail = (await plane.built.app.inject({ method: "GET", url: `/api/tasks/${id}`, headers: auth() })).json() as Record<string, unknown>;
    const provenance = (await plane.built.app.inject({ method: "GET", url: `/api/tasks/${id}/provenance`, headers: auth() })).json();
    const { provenance: p, stage, ...rest } = body;
    expect(rest).toEqual(detail);
    expect(p).toEqual(provenance);
    expect(stage).toMatchObject({ value: "done", rule: "terminal" });

    const text = await task(["show", id]);
    expect(text.code, text.err).toBe(0);
    expect(text.out).toContain(`Task ${id}`);
    expect(text.out).toContain("goal: Ship the feature [FAKE:LIMIT]");
    expect(text.out).toContain("stage done (terminal)");
    expect(text.out).toContain("Runs (2):");
    expect(text.out).toContain("Provenance:");
    expect(text.out).toContain(`  Task ${id} · mode single · owner operator`);
    expect(text.out).toContain("[via handoff_record]");
  });

  it("events prints the served rows; --follow streams an approval to done and exits 0", async () => {
    plane = await bootPlane();
    const id = plane.built.tasks.create({ goal: "Add a typed helper to the parser [FAKE:APPROVAL]" }).taskId;
    const requested = awaitEvent(id, "approval.requested");
    await start(id);
    await requested;

    const { seen, fetchImpl } = recorder([id]);
    const following = task(["events", id, "--follow", "--json"], { fetchImpl });
    // Answer once the follower has subscribed, the way the web's Approve button does.
    for (let i = 0; i < 100 && !seen.has("GET /api/tasks/:id/events"); i++) await new Promise((r) => setTimeout(r, 10));
    const rows = (await plane.built.app.inject({ method: "GET", url: `/api/tasks/${id}/events`, headers: auth() })).json() as TaskEvent[];
    const ask = rows.find((e) => e.type === "approval.requested")!;
    const requestId = (ask.payload as { requestId: string }).requestId;
    const answered = await plane.built.app.inject({ method: "POST", url: `/api/tasks/${id}/input`, headers: auth(), payload: { kind: "approval", requestId, approved: true } });
    expect(answered.statusCode, answered.body).toBeLessThan(300);

    const r = await following;
    expect(r.code, r.err).toBe(0);
    expect([...seen].sort()).toEqual([...COMMAND_ROUTES["events --follow"]!].sort());
    const lines = r.out.split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(lines.some((l) => l.type === "approval.requested")).toBe(true);
    const last = lines.at(-1) as { kind: string; state: { state: string; stage: { value: string } } };
    expect(last).toMatchObject({ kind: "state", state: { state: "COMPLETED", stage: { value: "done" } } });
    // No live event repeats a backlog row.
    const keys = lines.map((l) => (l.kind === "event" ? `${(l.event as { runId: string; seq: number }).runId}:${(l.event as { seq: number }).seq}` : l.run_id ? `${l.run_id as string}:${l.seq as number}` : null)).filter(Boolean);
    expect(new Set(keys).size).toBe(keys.length);

    const once = await task(["events", id, "--json"]);
    expect(JSON.parse(once.out)).toEqual((await plane.built.app.inject({ method: "GET", url: `/api/tasks/${id}/events`, headers: auth() })).json());
    const text = await task(["events", id]);
    expect(text.out).toMatch(/approval\.requested/);
    // A done task: backlog, then the plane's connect-time state frame ends it.
    const again = await task(["events", id, "--follow"]);
    expect(again.code, again.err).toBe(0);
    expect(again.out.split("\n").at(-1)).toBe("-- state COMPLETED · stage done (terminal)");
  });

  it("verdict reads the last run's verification where the web does, with the web's label", async () => {
    plane = await bootPlane();
    const id = plane.built.tasks.create({ goal: "Document the parser module" }).taskId;
    const before = await task(["verdict", id, "--json"]);
    expect(before.code, before.err).toBe(0);
    expect(JSON.parse(before.out)).toMatchObject({ taskId: id, run: null, verdict: null });
    await start(id);
    await plane.built.orchestrator.waitForSettled(id);

    const runId = (plane.db.prepare("SELECT id FROM runs WHERE task_id = ?").get(id) as { id: string }).id;
    const { seen, fetchImpl } = recorder([id, runId]);
    const r = await task(["verdict", id, "--json"], { fetchImpl });
    expect(r.code, r.err).toBe(0);
    const v = JSON.parse(r.out) as TaskVerdict;
    expect(v).toMatchObject({ taskId: id, state: "COMPLETED", stage: { value: "done" }, run: { id: runId, assistantId: "fake-a" } });
    for (const route of seen) expect(COMMAND_ROUTES.verdict).toContain(route);
    // Exactly one of the two verification sources is read for one run.
    expect(seen.has("GET /api/sessions/:id")).toBe(true);
    expect(seen.has("GET /api/tasks/:id/events")).toBe(v.source === "event");
    if (v.verification) expect(v.verdict?.label).toBe(v.verification.passed ? "passed" : v.verdict?.label);
    const text = await task(["verdict", id]);
    expect(text.code, text.err).toBe(0);
    expect(text.out).toContain(`Task ${id} · state COMPLETED · stage done (terminal)`);
    expect(text.out).toContain(`Run ${runId} (fake-a)`);
  });

  it("an unknown task exits 1 with a plain message; usage errors exit 2", async () => {
    plane = await bootPlane();
    for (const cmd of ["show", "events", "verdict"]) {
      const r = await task([cmd, "nope"]);
      expect(r.code, cmd).toBe(1);
      expect(r.err).toMatch(new RegExp(`aos task ${cmd}: no task nope`));
    }
    expect((await task(["events", "nope", "--follow"])).err).toMatch(/no task nope/);
    expect((await task(["ls", "extra"])).code).toBe(2);
    expect((await task(["show"])).code).toBe(2);
    expect((await task(["show", "x", "--follow"])).code).toBe(2);
    expect((await task(["show", "x", "--attention"])).code).toBe(2);
    const help = await task(["--help"]);
    for (const route of Object.values(COMMAND_ROUTES).flat()) expect(help.out).toContain(route.replace("GET ", ""));
    expect(help.out).toContain("Exit codes: 0 ok");
  });
});

describe("verdictText", () => {
  const base: TaskVerdict = { taskId: "t-1", state: "COMPLETED", stage: { value: "done", rule: "terminal" }, run: { id: "run-1", assistantId: "fake-a", state: "COMPLETED", endedAt: "2026-11-21T10:00:00.000Z" }, source: "session", outcome: "completed", verification: null, verdict: null };

  it("says blocked when only blocked required checks fail, and counts skipped", () => {
    const text = verdictText({
      ...base,
      verification: { passed: false, checks: [
        { name: "pnpm test", required: true, passed: false, summary: "pnpm is not installed: run corepack enable", status: "blocked" },
        { name: "lint", required: false, passed: false, summary: "read-only workspace", status: "skipped" },
      ] },
      verdict: { label: "blocked", skipped: 1, blocked: 1 },
    });
    expect(text).toContain("Verification: BLOCKED (1 skipped)");
    expect(text).toMatch(/blocked\s+pnpm test\s+required\s+pnpm is not installed/);
    expect(text).toMatch(/skipped\s+lint\s+not required/);
  });

  it("names a run with no verification and a run that has not ended", () => {
    expect(verdictText(base)).toContain("No verification recorded for this run.");
    expect(verdictText({ ...base, run: { ...base.run!, endedAt: null } })).toContain("has not ended, so there is no verdict yet");
  });
});
