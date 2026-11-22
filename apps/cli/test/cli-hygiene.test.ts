/**
 * p1-3 slice 1 hygiene, findings F1, F2, F3 and F7 of docs/cli/aos-parity.md, plus `aos status`.
 * F1 runs the real `bin` in a child process and pipes its stdout into a JSON parser, the way
 * `aos … --json | jq` is used.
 */
import { exec } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { USAGE as MAIN_USAGE } from "../src/main.js";
import { USAGE as RUNTIMES_USAGE } from "../src/runtimes.js";
import { STATUS_ROUTES, USAGE as STATUS_USAGE } from "../src/status.js";
import { USAGE as TASK_USAGE } from "../src/task.js";
import { aos, bearer, bootPlane, type Plane } from "./helpers.js";

const run = promisify(exec);
const BIN = join(dirname(fileURLToPath(import.meta.url)), "../bin/aos.mjs");

let plane: Plane | undefined;
afterEach(async () => { await plane?.close(); plane = undefined; });

describe("F1: the bin prints only the command's output", () => {
  it("bin/aos.mjs … --json pipes into a JSON parser", async () => {
    plane = await bootPlane();
    const id = plane.built.tasks.create({ goal: "Document the parser module" }).taskId;
    const env = { ...process.env, AGENT_PLANE_HOME: plane.home, AOS_API_URL: plane.origin };
    const parse = `node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const v=JSON.parse(s);process.stdout.write(JSON.stringify(Array.isArray(v)?v.map(t=>t.id):Object.keys(v)))})'`;
    const tasks = await run(`node ${JSON.stringify(BIN)} task ls --json | ${parse}`, { env });
    expect(JSON.parse(tasks.stdout)).toEqual([id]);
    const status = await run(`node ${JSON.stringify(BIN)} status --json | ${parse}`, { env });
    expect(JSON.parse(status.stdout)).toContain("/api/health");
  }, 30_000);

  it("the bin returns the command's exit code", async () => {
    const home = mkdtempSync(join(tmpdir(), "aos-bin-"));
    try {
      await expect(run(`node ${JSON.stringify(BIN)} nope`, { env: { ...process.env, AGENT_PLANE_HOME: home } })).rejects.toMatchObject({ code: 2 });
    } finally { rmSync(home, { recursive: true, force: true }); }
  }, 30_000);
});

describe("F2: a missing credential", () => {
  it("names the path and how to get one, and exits 1", async () => {
    const home = mkdtempSync(join(tmpdir(), "aos-nocred-"));
    try {
      const r = await aos({ home, origin: "http://127.0.0.1:9" }, ["ls"], { env: { AGENT_PLANE_HOME: home } });
      expect(r.code).toBe(1);
      expect(r.err).toContain(`No workspace credential found at ${join(home, "personal", "api-credential.json")}`);
      expect(r.err).toContain("pnpm dev");
      expect(r.err).toContain("--credential <path> or set AOS_CREDENTIAL_FILE");
      expect(r.err).not.toMatch(/ENOENT|lstat/);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
});

describe("F3: provider aliases", () => {
  it("accepts a harness name and lists ids with harness names on a miss", async () => {
    plane = await bootPlane();
    const byId = await aos(plane, ["catalog", "anthropic", "--json"]);
    const byHarness = await aos(plane, ["catalog", "claude-code", "--json"]);
    expect(byHarness.code, byHarness.err).toBe(0);
    expect(JSON.parse(byHarness.out)).toEqual(JSON.parse(byId.out));
    const miss = await aos(plane, ["catalog", "claude"]);
    expect(miss.code).toBe(1);
    expect(miss.err).toContain("claude is not in this build's runtime catalogue");
    expect(miss.err).toContain("anthropic (harness claude-code)");
  });
});

describe("F7: --help states the exit codes", () => {
  it("every group's usage and the top-level usage name them", () => {
    for (const usage of [MAIN_USAGE, RUNTIMES_USAGE, TASK_USAGE, STATUS_USAGE]) expect(usage).toMatch(/Exit codes[^\n]*0 [a-z]+, 1 /);
    expect(MAIN_USAGE).toContain("2 usage");
  });
});

describe("aos status against a real plane", () => {
  it("reads only its routes, --json carries the served reads, and a healthy plane exits 0", async () => {
    plane = await bootPlane();
    plane.built.scheduler.startTimer(); // as apps/api/src/index.ts does; the test boot leaves it off
    const seen = new Set<string>();
    const fetchImpl: typeof fetch = (input, init) => { seen.add(`${init?.method ?? "GET"} ${new URL(String(input)).pathname}`); return fetch(input, init); };
    const r = await aos(plane, ["--json"], { group: "status", fetchImpl });
    expect(r.code, r.err).toBe(0);
    for (const route of seen) expect(STATUS_ROUTES).toContain(route);
    const body = JSON.parse(r.out) as Record<string, unknown>;
    const auth = { authorization: `Bearer ${bearer(plane)}` };
    const health = (await plane.built.app.inject({ method: "GET", url: "/api/health", headers: auth })).json() as Record<string, unknown>;
    expect(body["/api/health"]).toMatchObject({ status: health.status, workspace: health.workspace, migrations: health.migrations });
    expect(body["/api/meta"]).toEqual((await plane.built.app.inject({ method: "GET", url: "/api/meta", headers: auth })).json());
    expect(body.degraded).toEqual([]);
    const text = await aos(plane, [], { group: "status" });
    expect(text.out).toMatch(/^Plane ok · workspace personal · API /);
    expect(text.out).toContain("Assistants: fake-a, fake-b");
    expect((await aos(plane, ["extra"], { group: "status" })).code).toBe(2);
    // A boot that never arms the scheduler is degraded, and says so.
    plane.built.scheduler.stop();
    const unarmed = await aos(plane, [], { group: "status" });
    expect(unarmed.code).toBe(1);
    expect(unarmed.out).toContain("- the scheduler is enabled but not armed");
  });

  it("exits 1 and says why when the plane reports itself unhealthy", async () => {
    plane = await bootPlane();
    const sick: typeof fetch = async (input, init) => {
      const res = await fetch(input, init);
      if (new URL(String(input)).pathname !== "/api/health") return res;
      return new Response(JSON.stringify({ ...(await res.json() as object), status: "degraded" }), { status: 200 });
    };
    const r = await aos(plane, [], { group: "status", fetchImpl: sick });
    expect(r.code).toBe(1);
    expect(r.out).toContain("Plane DEGRADED");
    expect(r.out).toContain("- health is degraded");
  });
});
