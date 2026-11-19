/**
 * `aos runtimes` against a real plane on loopback: real routes, auth, router and database.
 * Agent Runtime Registry PR 6 (design §C PR 6, §E).
 */
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { credentialPath, readCredential, rotateCredential } from "../../api/src/auth/credential-file.js";
import { loadConfig, readApiEndpoint } from "../../api/src/config.js";
import {
  validateAssistantLifecycle, validateConformanceResult, validateOperatorStateChange, validateRuntimeCatalog,
} from "../../api/src/agent-runtime-contract.js";
import { configSnippet } from "../../web/src/shell/runtime-registry.js";
import { assertLoopbackOrigin, PlaneError, selectSecret } from "../src/client.js";
import { aos, bootPlane, type Plane } from "./helpers.js";

let plane: Plane | undefined;
afterEach(async () => { await plane?.close(); plane = undefined; });

/** Every file under the workspace dir with its size and mtime, minus the database the plane itself writes. */
function snapshot(dir: string): Record<string, string> {
  const files: Record<string, string> = {};
  for (const name of readdirSync(dir)) {
    if (name.startsWith("agent-plane.db")) continue;
    const s = statSync(join(dir, name));
    files[name] = `${s.size}:${s.mtimeMs}:${s.isFile() ? readFileSync(join(dir, name), "utf8") : "dir"}`;
  }
  return files;
}

async function routeFailures(p: Plane, id: string): Promise<string[]> {
  const headers = { authorization: `Bearer ${readCredential(credentialPath(join(p.home, "personal"))).secrets[0]!.secret}` };
  const created = await p.built.app.inject({ method: "POST", url: "/api/tasks", headers, payload: { goal: "do it" } });
  const routed = await p.built.app.inject({ method: "POST", url: `/api/tasks/${(created.json() as { taskId: string }).taskId}/route`, headers });
  return (routed.json() as { candidates: Array<{ assistantId: string; filterFailures: string[] }> }).candidates.find((c) => c.assistantId === id)!.filterFailures;
}

describe("aos runtimes against a running plane", () => {
  it("ls prints each configured assistant's served lifecycle; --json is the route body, contract-valid", async () => {
    plane = await bootPlane();
    const text = await aos(plane, ["ls"]);
    expect(text).toMatchObject({ code: 0, err: "" });
    expect(text.out.split("\n")[0]).toMatch(/^ID\s+PROVIDER\s+READY\s+INSTALLED\s+AUTH\s+CONFORMANCE\s+OPERATOR$/);
    expect(text.out).toMatch(/fake-a\s+fake\s+yes\s+not probed yet\s+ok\s+not-run\s+none/);
    expect(text.out).toMatch(/fake-b\s+fake\s+yes/);

    const asJson = await aos(plane, ["ls", "--json"]);
    expect(asJson.code).toBe(0);
    const body = JSON.parse(asJson.out) as Array<{ id: string; lifecycle: unknown }>;
    const served = await plane.built.app.inject({ method: "GET", url: "/api/assistants", headers: { authorization: `Bearer ${readCredential(credentialPath(join(plane.home, "personal"))).secrets[0]!.secret}` } });
    expect(body).toEqual(served.json());
    for (const a of body) expect(validateAssistantLifecycle(a.lifecycle).ok).toBe(true);
  });

  it("disable → the router's reason → enable, through the same routes the web UI uses", async () => {
    plane = await bootPlane();
    const off = await aos(plane, ["disable", "fake-a"]);
    expect(off).toMatchObject({ code: 0, out: "fake-a is disabled for future routing. Sessions already running are not stopped." });
    expect(await routeFailures(plane, "fake-a")).toContain("disabled by operator");

    const show = await aos(plane, ["show", "fake-a"]);
    expect(show.code).toBe(0);
    expect(show.out).toContain("  Ready: no\n    - disabled by operator");
    expect(show.out).toContain("Enablement: config enabled · disabled by operator");
    expect(show.out).toContain("The router still decides each task against");
    expect(show.out).toContain("This build lists no official install or sign-in link for it.");

    const again = await aos(plane, ["disable", "fake-a", "--json"]);
    const change = JSON.parse(again.out) as { changed: boolean };
    expect(validateOperatorStateChange(change).ok).toBe(true);
    expect(change.changed).toBe(false);

    expect((await aos(plane, ["enable", "fake-a"])).out).toBe("fake-a: operator override cleared.");
    expect(await routeFailures(plane, "fake-a")).not.toContain("disabled by operator");
    expect((await aos(plane, ["show", "fake-a", "--json"])).out).toContain('"ready": true');
  });

  it("enable never overrides a config-disabled assistant", async () => {
    plane = await bootPlane("assistants:\n  fake-a:\n    provider: fake\n    enabled: false\n");
    const r = await aos(plane, ["enable", "fake-a"]);
    expect(r).toMatchObject({ code: 0, out: "fake-a: had no operator override. Workspace config still disables it." });
    expect((await aos(plane, ["show", "fake-a"])).out).toContain("    - disabled in workspace config");
  });

  it("test prints the plane's conformance result and records it; the exit code follows its status", async () => {
    plane = await bootPlane();
    const json = await aos(plane, ["test", "fake-a", "--json"]);
    const result = JSON.parse(json.out) as { status: string; recorded: boolean };
    expect(validateConformanceResult(result).ok).toBe(true);
    expect(json.code).toBe(result.status === "pass" ? 0 : 1);
    const text = await aos(plane, ["test", "fake-a"]);
    expect(text.out).toMatch(new RegExp(`^fake-a: test ${result.status}`));
    expect(text.out).toContain("Conformance now:");
  });

  it("catalog is the served catalogue; --snippet is the web UI's snippet text and loads as config", async () => {
    plane = await bootPlane();
    const json = await aos(plane, ["catalog", "--json"]);
    const cat = JSON.parse(json.out) as { runtimes: Array<{ provider: string }> };
    expect(validateRuntimeCatalog(cat).ok).toBe(true);
    const text = await aos(plane, ["catalog"]);
    for (const r of cat.runtimes) expect(text.out).toMatch(new RegExp(`^${r.provider}\\s`, "m"));
    expect(text.out).toContain("being listed grants nothing");

    const snippet = await aos(plane, ["catalog", "fake", "--snippet"]);
    expect(snippet).toMatchObject({ code: 0, out: configSnippet("fake", ["fake-a", "fake-b"]) });
    expect(snippet.out).toBe("assistants:\n  fake:\n    provider: fake\n    enabled: true");
    const scratch = mkdtempSync(join(tmpdir(), "agent-plane-aos-snippet-"));
    try {
      mkdirSync(join(scratch, "personal"));
      writeFileSync(join(scratch, "personal", "config.yaml"), `${snippet.out}\n`);
      expect(loadConfig({ AGENT_PLANE_HOME: scratch }).assistants["fake"]).toEqual({ provider: "fake", enabled: true });
    } finally { rmSync(scratch, { recursive: true, force: true }); }

    const one = await aos(plane, ["catalog", "anthropic"]);
    expect(one.code).toBe(0);
    expect(one.out).toContain("anthropic · ");
    expect((await aos(plane, ["catalog", "nope"])).err).toContain("nope is not in this build's runtime catalogue");
  });

  it("sync and changes reach their routes", async () => {
    plane = await bootPlane();
    const sync = await aos(plane, ["sync", "fake-a"]);
    expect(sync).toMatchObject({ code: 0 });
    expect(sync.out).toContain("fake-a: capability sync done · manifest auth ok");
    const changes = await aos(plane, ["changes", "--json"]);
    expect(changes.code).toBe(0);
    expect(Array.isArray(JSON.parse(changes.out))).toBe(true);
  });

  it("an unknown assistant is the plane's 404 text, exit 1, nothing written", async () => {
    plane = await bootPlane();
    for (const cmd of ["disable", "enable", "test", "sync"]) {
      const r = await aos(plane, [cmd, "ghost"]);
      expect(r.code).toBe(1);
      expect(r.err).toMatch(/HTTP (404|400)/);
    }
    expect((await aos(plane, ["show", "ghost"])).err).toBe("aos runtimes show: Unknown assistant: ghost");
    const count = plane.db.prepare("SELECT COUNT(*) AS n FROM runtime_conformance").get() as { n: number };
    expect(count.n).toBe(0);
  });

  it("writes no config or credential, and a read-only credential cannot disable", async () => {
    plane = await bootPlane();
    const dir = join(plane.home, "personal");
    const before = snapshot(dir);
    for (const argv of [["ls"], ["show", "fake-a"], ["catalog"], ["catalog", "fake", "--snippet"], ["changes"], ["test", "fake-a"], ["disable", "fake-a"], ["enable", "fake-a"], ["sync", "fake-a"]]) {
      await aos(plane, argv);
    }
    expect(snapshot(dir)).toEqual(before);

    rotateCredential(credentialPath(dir), 0, ["tasks.read"], new Date(Date.now() - 1000));
    const refused = await aos(plane, ["disable", "fake-a"]);
    expect(refused.code).toBe(1);
    expect(refused.err).toContain("holds commands.write");
    expect((await aos(plane, ["ls"])).code).toBe(0);
  });

  it("a bearer the plane does not know is its 401, shown as served", async () => {
    plane = await bootPlane();
    const dir = join(plane.home, "personal");
    const r = await aos(plane, ["disable", "fake-a"], { fetchImpl: (url, init) => fetch(url, { ...init, headers: { authorization: "Bearer FAKE-aos-cli-not-real" } }) });
    expect(r).toMatchObject({ code: 1, err: "aos runtimes disable: POST /api/assistants/fake-a/disable: HTTP 401: unauthenticated" });
    expect(readCredential(credentialPath(dir)).secrets).toHaveLength(1);
  });
});

describe("aos runtimes without a plane", () => {
  it("refuses a non-loopback origin before reading any credential", async () => {
    for (const origin of ["http://10.0.0.5:4176", "https://127.0.0.1:4176", "http://example.com", "http://127.0.0.1:4176/api"]) {
      expect(() => assertLoopbackOrigin(origin)).toThrow(PlaneError);
    }
    for (const origin of ["http://127.0.0.1:4176", "http://localhost:1", "http://[::1]:4176"]) expect(assertLoopbackOrigin(origin).port).not.toBe("");
    const r = await aos({ home: "/nonexistent-aos-home", origin: "http://10.0.0.5:4176" }, ["ls"]);
    expect(r).toMatchObject({ code: 1 });
    expect(r.err).toContain("only talks to a plane on loopback");
  });

  it("resolves the endpoint read-only: no workspace dir, config or credential is created", async () => {
    const home = "/tmp/agent-plane-aos-cli-absent-home";
    expect(readApiEndpoint({ AGENT_PLANE_HOME: home })).toMatchObject({ host: "127.0.0.1", port: 4176 });
    expect(readApiEndpoint({ AGENT_PLANE_HOME: home, AGENT_PLANE_WORKSPACE: "work" })).toMatchObject({ port: 4186 });
    const r = await aos({ home, origin: "" }, ["ls"], { env: { AGENT_PLANE_HOME: home } });
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/ENOENT|api-credential\.json/);
    expect(() => statSync(home)).toThrow();
  });

  it("reads api.host and api.port from the workspace config without loading it", async () => {
    plane = await bootPlane(`api:\n  port: 4999\n${"assistants:\n  fake-a:\n    provider: fake\n"}`);
    expect(readApiEndpoint({ AGENT_PLANE_HOME: plane.home })).toMatchObject({ host: "127.0.0.1", port: 4999 });
    expect(loadConfig({ AGENT_PLANE_HOME: plane.home }).api.port).toBe(4999);
  });

  it("selects the newest active secret that holds the capability", () => {
    const s = (kid: string, capabilities: string[], notAfter: string | null = null) => ({ kid, secret: `FAKE-${kid}-not-real`, capabilities, createdAt: "2026-01-01T00:00:00Z", notAfter });
    const now = new Date("2026-06-01T00:00:00Z");
    expect(selectSecret([s("a", ["tasks.read", "commands.write"]), s("b", ["tasks.read"])], "commands.write", now)?.kid).toBe("a");
    expect(selectSecret([s("a", ["tasks.read"]), s("b", ["tasks.read"])], "tasks.read", now)?.kid).toBe("b");
    expect(selectSecret([s("a", ["commands.write"], "2026-05-01T00:00:00Z")], "commands.write", now)).toBeUndefined();
  });

  it("usage errors exit 2 and name the problem", async () => {
    const p = { home: "/nonexistent-aos-home", origin: "http://127.0.0.1:1" };
    expect((await aos(p, [])).code).toBe(2);
    expect(await aos(p, ["frobnicate"])).toMatchObject({ code: 2, err: expect.stringContaining("Unknown command: frobnicate") });
    expect(await aos(p, ["disable"])).toMatchObject({ code: 2, err: expect.stringContaining("needs an assistant id") });
    expect(await aos(p, ["ls", "x"])).toMatchObject({ code: 2, err: expect.stringContaining("takes no argument") });
    expect(await aos(p, ["catalog", "--snippet"])).toMatchObject({ code: 2, err: expect.stringContaining("--snippet goes with") });
    expect(await aos(p, ["ls", "--bogus"])).toMatchObject({ code: 2 });
    expect(await aos(p, ["--help"])).toMatchObject({ code: 0, out: expect.stringContaining("usage: aos runtimes") });
  });
});
