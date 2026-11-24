/**
 * B2 remote auth: the stage 2 acceptance cases that apply to the one-origin topology
 * (docs/adr/remote-auth-design.md, "Stage 2 acceptance cases" + "B2 amendments"), on real loopback
 * sockets: the plane's two listeners, a Tailscale-Serve-like TLS proxy and the fake OIDC issuer.
 */
import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request as httpsRequest } from "node:https";
import { afterEach, describe, expect, it } from "vitest";
import { mintBootstrapToken } from "../src/auth/bootstrap-token.js";
import { credentialPath, readCredential } from "../src/auth/credential-file.js";
import { canonicalIp, checkProxyContract } from "../src/auth/remote/proxy.js";
import { privateFileProblem, resolveRemoteAuth } from "../src/auth/remote/config.js";
import {
  ALL_REMOTE_GRANTS, CANONICAL_HOST, TAILSCALE_LOGIN, command, cookieOf, oidcLogin, ownerSession, rawRequest, sameOrigin,
  startRemoteRig, viaProxy, type RemoteRig,
} from "./helpers/remote-rig.js";

let rig: RemoteRig | undefined;
afterEach(async () => { await rig?.close(); rig = undefined; });
const json = (body: string) => JSON.parse(body) as Record<string, unknown>;
const taskCount = (r: RemoteRig) => (r.db.prepare("SELECT COUNT(*) AS n FROM tasks").get() as { n: number }).n;
const liveSessions = (r: RemoteRig) => (r.db.prepare("SELECT COUNT(*) AS n FROM remote_sessions WHERE revoked_at IS NULL").get() as { n: number }).n;

/** Opens an SSE stream through the proxy and collects what arrives until the server closes it. */
function openStream(r: RemoteRig, path: string, headers: Record<string, string>) {
  const chunks: string[] = [];
  let status = 0; let closed = false;
  const opened = new Promise<number>((resolve, reject) => {
    const req = httpsRequest({ host: "127.0.0.1", port: r.proxyPort, servername: CANONICAL_HOST, ca: r.cert, method: "GET", path, headers: { host: `${CANONICAL_HOST}:${r.proxyPort}`, accept: "text/event-stream", ...headers } }, (res) => {
      status = res.statusCode ?? 0; res.setEncoding("utf8");
      res.on("data", (c: string) => chunks.push(c)); res.on("end", () => { closed = true; }); res.on("close", () => { closed = true; });
      resolve(status);
    });
    req.on("error", reject); req.end();
  });
  return { opened, chunks, get closed() { return closed; }, get status() { return status; } };
}
const until = async (cond: () => boolean, ms = 5000) => { const end = Date.now() + ms; while (!cond()) { if (Date.now() > end) throw new Error("timed out"); await new Promise((r) => setTimeout(r, 25)); } };

describe("OIDC owner login and transaction", () => {
  it("only the exact (iss, sub) owner gets a fresh Strict host cookie; the callback lands on the fixed origin", async () => {
    rig = await startRemoteRig();
    const { start, callback, session } = await oidcLogin(rig);
    expect(start.status).toBe(303);
    expect(start.headers["cache-control"]).toBe("no-store");
    expect(String(start.headers["set-cookie"])).toMatch(/^__Host-acp_login=[^;]+; HttpOnly; Secure; SameSite=Lax; Path=\/; Max-Age=300/);
    const authorize = new URL(start.headers.location!);
    expect(authorize.origin).toBe(rig.issuer.issuer);
    expect(authorize.searchParams.get("redirect_uri")).toBe(`${rig.canonicalOrigin}/api/auth/callback`);
    expect(authorize.searchParams.get("code_challenge_method")).toBe("S256");
    expect(callback!.status).toBe(303);
    expect(callback!.headers.location).toBe(`${rig.canonicalOrigin}/`);
    const lines = callback!.headers["set-cookie"] as string[];
    expect(lines.find((l) => l.startsWith("__Host-acp_remote_session="))).toMatch(/; HttpOnly; Secure; SameSite=Strict; Path=\/; Max-Age=43200$/);
    expect(lines.join("\n")).not.toMatch(/Domain=/i);
    expect(lines.find((l) => l.startsWith("__Host-acp_login="))).toContain("Max-Age=0");
    const me = await viaProxy(rig, "GET", "/api/auth/session", sameOrigin(session!));
    expect(me.status).toBe(200);
    expect(me.headers["cache-control"]).toBe("no-store");
    expect(json(me.body)).toMatchObject({ mode: "remote", grants: ALL_REMOTE_GRANTS });
    expect(typeof json(me.body).csrfToken).toBe("string");
    // Only a hash of the handle is stored.
    const stored = JSON.stringify(rig.db.prepare("SELECT * FROM remote_sessions").all());
    expect(stored).not.toContain(session!.split("=")[1]);
  });

  it("refuses a non-owner (same email), wrong issuer, audience, signature, nonce, expired token; none mints a session", async () => {
    rig = await startRemoteRig({ limits: { loginPerMinutePerAddress: 100, loginPerMinuteInstance: 100 } });
    const owner = rig.issuer.loginAs.sub;
    const cases = [
      { sub: "FAKE-other-sub-not-real", email: "FAKE-owner@example-not-real" },
      { sub: owner, iss: "https://accounts.example-not-real" },
      { sub: owner, aud: "FAKE-other-client-not-real" },
      { sub: owner, aud: [rig.issuer.clientId, "FAKE-other-client-not-real"] },
      { sub: owner, forgeSignature: true },
      { sub: owner, nonce: "FAKE-nonce-not-real" },
      { sub: owner, expiresIn: -120 },
    ];
    for (const login of cases) {
      rig.issuer.loginAs = login;
      const { callback, session } = await oidcLogin(rig);
      expect(callback!.status, JSON.stringify(login)).toBe(403);
      expect(session).toBeUndefined();
    }
    expect(rig.db.prepare("SELECT COUNT(*) AS n FROM remote_sessions").get()).toEqual({ n: 0 });
  });

  it("a callback without the browser's transaction cookie, with another state, or replayed mints nothing", async () => {
    rig = await startRemoteRig();
    // Missing cookie.
    const start = await viaProxy(rig, "GET", "/api/auth/login", { "sec-fetch-site": "same-origin" });
    const loginCookie = cookieOf(start.headers["set-cookie"], "__Host-acp_login")!;
    const back = new URL((await fetch(start.headers.location!, { redirect: "manual" })).headers.get("location")!);
    expect((await viaProxy(rig, "GET", `${back.pathname}${back.search}`, {})).status).toBe(400);
    // Another browser's cookie (state mismatch) for the same callback.
    const other = await viaProxy(rig, "GET", "/api/auth/login", { "sec-fetch-site": "same-origin" });
    expect((await viaProxy(rig, "GET", `${back.pathname}${back.search}`, { cookie: cookieOf(other.headers["set-cookie"], "__Host-acp_login")! })).status).toBe(400);
    // Right cookie + state: works once, then replay fails.
    const good = await oidcLogin(rig);
    expect(good.callback!.status).toBe(303);
    const replay = await viaProxy(rig, "GET", good.callbackPath!, { cookie: good.loginCookie! });
    expect(replay.status).toBe(400);
    expect(cookieOf(replay.headers["set-cookie"], "__Host-acp_remote_session")).toBeUndefined();
    void loginCookie;
    // An external return target is ignored: the destination is fixed.
    const ext = await viaProxy(rig, "GET", "/api/auth/login?next=https://evil.example-not-real/&return_to=//evil", { "sec-fetch-site": "same-origin" });
    expect(new URL(ext.headers.location!).searchParams.get("redirect_uri")).toBe(`${rig.canonicalOrigin}/api/auth/callback`);
    expect(rig.db.prepare("SELECT COUNT(*) AS n FROM remote_sessions").get()).toEqual({ n: 1 });
  });

  it("re-login from the app rotates the handle and revokes the old session", async () => {
    rig = await startRemoteRig();
    const a = await ownerSession(rig);
    const second = await oidcLogin(rig, a.cookie);
    expect(second.session).toBeDefined();
    expect((await viaProxy(rig, "GET", "/api/tasks", sameOrigin(a.cookie))).status).toBe(401);
    expect((await viaProxy(rig, "GET", "/api/tasks", sameOrigin(second.session!))).status).toBe(200);
  });

  it("an unreachable issuer denies login and never falls back; the remote listener refuses to start without it", async () => {
    rig = await startRemoteRig();
    await rig.issuer.close();
    const fresh = await startRemoteRig({ listen: false });
    await fresh.issuer.close();
    await expect(fresh.built.app.listenRemote!()).rejects.toThrow();
    await fresh.close();
  });
});

describe("hostile origin and CSRF", () => {
  it("rejects attacker, null, sibling, wrong scheme or port origins and spoofed Fetch Metadata before any effect", async () => {
    rig = await startRemoteRig();
    const s = await ownerSession(rig);
    const hostile = ["https://evil.example-not-real", "null", `https://other.fake-tailnet.ts.net:${rig.proxyPort}`, `http://${CANONICAL_HOST}:${rig.proxyPort}`, `https://${CANONICAL_HOST}:1`, `https://${CANONICAL_HOST}`];
    const before = taskCount(rig);
    for (const origin of hostile) {
      const headers = { ...command(rig, s), origin, "sec-fetch-site": "same-origin" };
      const write = await viaProxy(rig, "POST", "/api/tasks", headers, JSON.stringify({ goal: "evil" }));
      expect(write.status, origin).toBe(403);
      expect(write.headers["access-control-allow-origin"]).toBeUndefined();
      expect((await viaProxy(rig, "GET", "/api/tasks", { cookie: s.cookie, origin, "sec-fetch-site": "same-origin" })).status, origin).toBe(403);
      expect((await viaProxy(rig, "GET", "/api/auth/session", { cookie: s.cookie, origin, "sec-fetch-site": "same-origin" })).status, origin).toBe(403);
    }
    // No Origin: reads need same-origin metadata; `none`, cross-site or absent fail closed; writes always need Origin.
    for (const site of ["none", "cross-site", "same-site", undefined]) {
      expect((await viaProxy(rig, "GET", "/api/tasks", { cookie: s.cookie, ...(site ? { "sec-fetch-site": site } : {}) })).status, String(site)).toBe(403);
    }
    const { origin: _o, ...noOrigin } = command(rig, s);
    expect((await viaProxy(rig, "POST", "/api/tasks", noOrigin, JSON.stringify({ goal: "x" }))).status).toBe(403);
    // Valid origin, wrong or missing or other-session CSRF.
    const other = await ownerSession(rig);
    for (const csrf of [undefined, "FAKE-csrf-not-real", other.csrf]) {
      const h: Record<string, string> = { ...command(rig, s) };
      if (csrf === undefined) delete h["x-csrf-token"]; else h["x-csrf-token"] = csrf;
      expect((await viaProxy(rig, "POST", "/api/tasks", h, JSON.stringify({ goal: "x" }))).status).toBe(403);
    }
    expect(taskCount(rig)).toBe(before);
    // Valid origin + token: executes exactly once.
    const ok = await viaProxy(rig, "POST", "/api/tasks", command(rig, s), JSON.stringify({ goal: "remote create" }));
    expect(ok.status).toBe(201);
    expect(taskCount(rig)).toBe(before + 1);
  });

  it("hostile SSE opens get 403 before stream headers", async () => {
    rig = await startRemoteRig();
    const s = await ownerSession(rig);
    const id = json((await viaProxy(rig, "POST", "/api/tasks", command(rig, s), JSON.stringify({ goal: "sse" }))).body).taskId as string;
    const bad = openStream(rig, `/api/tasks/${id}/events/stream`, { cookie: s.cookie, origin: "https://evil.example-not-real", "sec-fetch-site": "same-origin" });
    expect(await bad.opened).toBe(403);
    const good = openStream(rig, `/api/tasks/${id}/events/stream`, sameOrigin(s.cookie));
    expect(await good.opened).toBe(200);
    await until(() => good.chunks.join("").includes("data:"));
  });
});

describe("expiry, revocation and logout", () => {
  it("idle and absolute deadlines end sessions; reads, polling and streams never extend idle; operator activity does", async () => {
    rig = await startRemoteRig({ session: { absoluteTtlSeconds: 600, idleTtlSeconds: 60 } });
    const s = await ownerSession(rig);
    const t0 = rig.clock.now.getTime();
    const at = (ms: number) => { rig!.clock.now = new Date(t0 + ms); };
    at(50_000);
    expect((await viaProxy(rig, "GET", "/api/tasks", sameOrigin(s.cookie))).status).toBe(200); // polling
    at(61_000);
    expect((await viaProxy(rig, "GET", "/api/tasks", sameOrigin(s.cookie))).status).toBe(401); // idle from login, not from the poll
    const b = await ownerSession(rig);
    const t1 = rig.clock.now.getTime();
    rig.clock.now = new Date(t1 + 50_000);
    expect((await viaProxy(rig, "POST", "/api/auth/activity", command(rig, b), "{}")).status).toBe(200);
    rig.clock.now = new Date(t1 + 100_000);
    expect((await viaProxy(rig, "GET", "/api/tasks", sameOrigin(b.cookie))).status).toBe(200); // activity moved idle
    // Absolute deadline holds however active the owner is.
    for (let ms = 90_000; ms < 600_000; ms += 40_000) {
      rig.clock.now = new Date(t1 + ms);
      expect((await viaProxy(rig, "POST", "/api/auth/activity", command(rig, b), "{}")).status).toBe(200);
    }
    rig.clock.now = new Date(t1 + 600_000);
    expect((await viaProxy(rig, "GET", "/api/tasks", sameOrigin(b.cookie))).status).toBe(401);
  });

  it("an open stream closes at the deadline and on logout; nothing is sent after", async () => {
    rig = await startRemoteRig({ session: { absoluteTtlSeconds: 600, idleTtlSeconds: 60 } });
    const s = await ownerSession(rig);
    const id = json((await viaProxy(rig, "POST", "/api/tasks", command(rig, s), JSON.stringify({ goal: "deadline" }))).body).taskId as string;
    const st = openStream(rig, `/api/tasks/${id}/events/stream`, sameOrigin(s.cookie));
    expect(await st.opened).toBe(200);
    await until(() => st.chunks.length > 0);
    rig.clock.now = new Date(rig.clock.now.getTime() + 61_000);
    await until(() => st.closed, 4000);
    const s2 = await ownerSession(rig);
    const st2 = openStream(rig, `/api/tasks/${id}/events/stream`, sameOrigin(s2.cookie));
    expect(await st2.opened).toBe(200);
    await until(() => st2.chunks.length > 0);
    // Logout with a bad CSRF is 403 and changes nothing.
    expect((await viaProxy(rig, "POST", "/api/auth/logout", { ...command(rig, s2), "x-csrf-token": "FAKE-csrf-not-real" }, "{}")).status).toBe(403);
    expect(st2.closed).toBe(false);
    const out = await viaProxy(rig, "POST", "/api/auth/logout", command(rig, s2), "{}");
    expect(out.status).toBe(204);
    expect(String(out.headers["set-cookie"])).toMatch(/^__Host-acp_remote_session=; HttpOnly; Secure; SameSite=Strict; Path=\/; Max-Age=0/);
    await until(() => st2.closed, 2000);
    const seen = st2.chunks.join("").length;
    // A frame published after logout never reaches the closed stream.
    rig.built.bus.publish(id, { type: "notice", message: "after logout" } as never);
    await new Promise((r) => setTimeout(r, 100));
    expect(st2.chunks.join("").length).toBe(seen);
    for (const [m, p] of [["GET", "/api/tasks"], ["GET", `/api/tasks/${id}/events/stream`]] as const) expect((await viaProxy(rig, m, p, sameOrigin(s2.cookie))).status).toBe(401);
    expect((await viaProxy(rig, "POST", "/api/tasks", command(rig, s2), JSON.stringify({ goal: "x" }))).status).toBe(401);
  });

  it("operator revoke-all (local listener, local credential) ends every remote session and stream at once", async () => {
    rig = await startRemoteRig();
    const s = await ownerSession(rig);
    const id = json((await viaProxy(rig, "POST", "/api/tasks", command(rig, s), JSON.stringify({ goal: "revoke" }))).body).taskId as string;
    const st = openStream(rig, `/api/tasks/${id}/events/stream`, sameOrigin(s.cookie));
    expect(await st.opened).toBe(200);
    // Not reachable on the remote listener, even with a remote session + CSRF.
    expect((await viaProxy(rig, "POST", "/api/auth/remote/revoke-all", command(rig, s))).status).toBe(404);
    const res = await fetch(`http://127.0.0.1:${rig.localPort}/api/auth/remote/revoke-all`, { method: "POST", headers: rig.bearer() });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ revoked: 1 });
    await until(() => st.closed, 2000);
    expect((await viaProxy(rig, "GET", "/api/tasks", sameOrigin(s.cookie))).status).toBe(401);
  });

  it("a restart revokes every prior remote session", async () => {
    rig = await startRemoteRig();
    const s = await ownerSession(rig);
    const home = rig.home;
    const keep = rig;
    // Restart on the same home + DB.
    await keep.built.app.close(); keep.db.close(); await keep.issuer.close();
    rig = await startRemoteRig({ home });
    expect(liveSessions(rig)).toBe(0);
    expect((rig.db.prepare("SELECT revoked_reason FROM remote_sessions").all() as Array<{ revoked_reason: string }>).map((r) => r.revoked_reason)).toEqual(["restart"]);
    expect((await viaProxy(rig, "GET", "/api/tasks", sameOrigin(s.cookie))).status).toBe(401);
  });
});

describe("command-level denial", () => {
  it("a session granted reads + tasks.create may create and nothing else; commands.write alone is never inferred", async () => {
    rig = await startRemoteRig({ grants: ["tasks.read", "tasks.create"] });
    const s = await ownerSession(rig);
    // The gate lets a tasks.create grant through; the kernel's own narrow-credential rules (C1) still apply after it:
    // without an mcp.repos alias the create is refused as invalid input (400), never as an auth failure.
    const narrow = await viaProxy(rig, "POST", "/api/tasks", command(rig, s), JSON.stringify({ goal: "create only", idempotencyKey: "FAKE-key-0001-not-real" }));
    expect(narrow.status, narrow.body).toBe(400);
    expect(json(narrow.body).reason).toBe("invalid_input");
    const local = await fetch(`http://127.0.0.1:${rig.localPort}/api/tasks`, { method: "POST", headers: { ...rig.bearer(), "content-type": "application/json" }, body: JSON.stringify({ goal: "made locally" }) });
    const id = ((await local.json()) as { taskId: string }).taskId;
    const before = JSON.stringify(rig.db.prepare("SELECT id, state FROM tasks").all());
    const denied: Array<[string, string, unknown]> = [
      ["POST", `/api/tasks/${id}/start`, {}], ["POST", `/api/tasks/${id}/cancel`, {}], ["POST", `/api/tasks/${id}/run-now`, { generation: 0 }],
      ["POST", `/api/tasks/${id}/approvals/x/respond`, { decision: "approve" }], ["POST", "/api/schedules", {}], ["POST", "/api/models/refresh", {}],
      ["POST", "/api/assistants/fake-claude/sync", {}], ["POST", "/api/autopilot/start", {}],
    ];
    for (const [m, p, b] of denied) {
      const r = await viaProxy(rig, m, p, command(rig, s), JSON.stringify(b));
      expect([403, 404], `${m} ${p} -> ${r.status} ${r.body}`).toContain(r.status);
      if (r.status === 404) expect(r.body).not.toContain("required"); // a path that does not exist on this plane
    }
    for (const [m, p] of [["POST", `/api/tasks/${id}/start`], ["POST", `/api/tasks/${id}/cancel`], ["POST", "/api/models/refresh"]] as const) {
      expect((await viaProxy(rig, m, p, command(rig, s), "{}")).status).toBe(403);
    }
    expect((await viaProxy(rig, "GET", `/api/tasks/${id}/events`, sameOrigin(s.cookie))).status).toBe(403); // events.read not granted
    expect(JSON.stringify(rig.db.prepare("SELECT id, state FROM tasks").all())).toBe(before);
  });

  it("config refuses grants that are never remote (autopilot.operate, usage.write) and an empty list", () => {
    for (const grants of [["autopilot.operate"], ["usage.write"], [], ["tasks.read", "tasks.read"], ["*"]]) {
      const problems: string[] = [];
      resolveRemoteAuth({ port: 2, canonicalOrigin: "https://a.example", transport: { kind: "trusted-proxy", peers: ["127.0.0.1"], tailscaleUserLogin: "a@b" }, identity: { issuer: "https://i.example", clientId: "c", clientSecretFile: "/nonexistent", owner: { issuer: "https://i.example", subject: "s" } }, grants }, { localPort: 1, configDir: "/tmp", workspace: "personal", fileWorkspace: undefined }, problems);
      expect(problems.some((p) => p.startsWith("api.remote.grants")), JSON.stringify(grants)).toBe(true);
    }
  });
});

describe("workspace escape", () => {
  it("a W1 cookie is unknown on W2; W2 resources stay invisible", async () => {
    rig = await startRemoteRig();
    const w2 = await startRemoteRig();
    try {
      const s1 = await ownerSession(rig);
      const s2 = await ownerSession(w2);
      const w2Task = json((await viaProxy(w2, "POST", "/api/tasks", command(w2, s2), JSON.stringify({ goal: "w2 only" }))).body).taskId as string;
      // W1's cookie presented to W2's origin (same owner, same IdP): unknown there.
      expect((await viaProxy(w2, "GET", "/api/tasks", sameOrigin(s1.cookie))).status).toBe(401);
      expect((await viaProxy(w2, "POST", "/api/tasks", { ...command(w2, s2), cookie: s1.cookie }, JSON.stringify({ goal: "x" }))).status).toBe(401);
      // W2's task id through W1: not found, no payload.
      const r = await viaProxy(rig, "GET", `/api/tasks/${w2Task}`, sameOrigin(s1.cookie));
      expect(r.status).toBe(404);
      expect(r.body).not.toContain("w2 only");
    } finally { await w2.close(); }
  });

  it("a config whose YAML workspace label contradicts the selected directory is refused", () => {
    const problems: string[] = [];
    resolveRemoteAuth({}, { localPort: 1, configDir: "/tmp", workspace: "personal", fileWorkspace: "work" }, problems);
    expect(problems.join("\n")).toContain("contradicts the selected workspace");
  });
});

describe("canonical proxy contract", () => {
  const good = (r: RemoteRig, cookie?: string): Array<[string, string]> => [
    ["Host", `${CANONICAL_HOST}:${r.proxyPort}`], ["X-Forwarded-Host", `${CANONICAL_HOST}:${r.proxyPort}`], ["X-Forwarded-Proto", "https"],
    ["X-Forwarded-For", "100.64.0.7"], ["Tailscale-User-Login", TAILSCALE_LOGIN], ["Sec-Fetch-Site", "same-origin"], ...(cookie ? [["Cookie", cookie]] as Array<[string, string]> : []),
  ];
  it("accepts exactly the Tailscale Serve header set and rejects every forged or ambiguous variant before auth", async () => {
    rig = await startRemoteRig();
    const s = await ownerSession(rig);
    expect((await rawRequest(rig.remotePort, "GET", "/api/tasks", good(rig, s.cookie))).status).toBe(200);
    const variants: Array<[string, (h: Array<[string, string]>) => Array<[string, string]>]> = [
      ["forged host", (h) => h.map(([k, v]) => (k === "Host" ? [k, "evil.example-not-real"] : [k, v]))],
      ["forged forwarded host", (h) => h.map(([k, v]) => (k === "X-Forwarded-Host" ? [k, "evil.example-not-real"] : [k, v]))],
      ["http proto", (h) => h.map(([k, v]) => (k === "X-Forwarded-Proto" ? [k, "http"] : [k, v]))],
      ["no proto", (h) => h.filter(([k]) => k !== "X-Forwarded-Proto")],
      ["two protos", (h) => [...h, ["X-Forwarded-Proto", "https"]]],
      ["ip chain", (h) => h.map(([k, v]) => (k === "X-Forwarded-For" ? [k, "1.2.3.4, 100.64.0.7"] : [k, v]))],
      ["two ip headers", (h) => [...h, ["X-Forwarded-For", "1.2.3.4"]]],
      ["not an ip", (h) => h.map(([k, v]) => (k === "X-Forwarded-For" ? [k, "evil"] : [k, v]))],
      ["Forwarded field", (h) => [...h, ["Forwarded", "for=1.2.3.4;proto=https"]]],
      ["funnel", (h) => [...h, ["Tailscale-Funnel-Request", "?1"]]],
      ["other tailnet user", (h) => h.map(([k, v]) => (k === "Tailscale-User-Login" ? [k, "FAKE-intruder@tailnet-not-real"] : [k, v]))],
      ["no tailnet user (tagged node / local process)", (h) => h.filter(([k]) => k !== "Tailscale-User-Login")],
      ["two tailnet users", (h) => [...h, ["Tailscale-User-Login", TAILSCALE_LOGIN]]],
      ["direct origin, no proxy fields", () => [["Host", `127.0.0.1:${rig!.remotePort}`], ["Cookie", s.cookie], ["Sec-Fetch-Site", "same-origin"]]],
    ];
    for (const [name, mutate] of variants) {
      const r = await rawRequest(rig.remotePort, "GET", "/api/tasks", mutate(good(rig, s.cookie)));
      expect(r.status, name).toBe(403);
      expect(r.body, name).not.toContain("tasks");
      expect(r.headers["set-cookie"], name).toBeUndefined();
    }
    // The SPA shell and the login route are behind the same contract.
    expect((await rawRequest(rig.remotePort, "GET", "/api/auth/login", good(rig).filter(([k]) => k !== "Tailscale-User-Login"))).status).toBe(403);
    expect((await rawRequest(rig.remotePort, "GET", "/", good(rig).filter(([k]) => k !== "X-Forwarded-Proto"))).status).toBe(403);
    // Through the real TLS proxy with a login the box would not send:
    rig.proxyOptions.login = null;
    expect((await viaProxy(rig, "GET", "/api/tasks", sameOrigin(s.cookie))).status).toBe(403);
  });

  it("an untrusted socket peer is refused", () => {
    const cfg = { canonicalOrigin: "https://a.example", transport: { kind: "trusted-proxy", peers: ["::1"], tailscaleUserLogin: "a@b" } } as never;
    const fake = { socket: { remoteAddress: "::ffff:127.0.0.1" }, rawHeaders: ["Host", "a.example", "X-Forwarded-Host", "a.example", "X-Forwarded-Proto", "https", "X-Forwarded-For", "100.64.0.1", "Tailscale-User-Login", "a@b"] } as never;
    expect(checkProxyContract(fake, cfg)).toEqual({ ok: false, reason: "untrusted_peer" });
    const trusted = { ...(fake as object), socket: { remoteAddress: "::1" } } as never;
    expect(checkProxyContract(trusted, cfg)).toEqual({ ok: true, clientAddress: "100.64.0.1" });
  });

  it("keys the login limiter on one spelling per forwarded address (Codex review 4)", () => {
    const cfg = { canonicalOrigin: "https://a.example", transport: { kind: "trusted-proxy", peers: ["::1"], tailscaleUserLogin: "a@b" } } as never;
    const via = (fwd: string) => checkProxyContract({ socket: { remoteAddress: "::1" }, rawHeaders: ["Host", "a.example", "X-Forwarded-Host", "a.example", "X-Forwarded-Proto", "https", "X-Forwarded-For", fwd, "Tailscale-User-Login", "a@b"] } as never, cfg);
    const spellings = ["fd7a:115c:a1e0::1", "FD7A:115C:A1E0:0:0:0:0:1", "fd7a:115c:a1e0:0000:0000:0000:0000:0001", " fd7a:115c:a1e0::0:1 "];
    expect(new Set(spellings.map((x) => JSON.stringify(via(x))))).toEqual(new Set([JSON.stringify({ ok: true, clientAddress: "fd7a:115c:a1e0::1" })]));
    expect(via("::ffff:100.64.0.1")).toEqual({ ok: true, clientAddress: "100.64.0.1" });
    expect(via("::FFFF:6440:1")).toEqual({ ok: true, clientAddress: "100.64.0.1" });
    expect(via("fe80::1%eth0")).toEqual({ ok: false, reason: "forwarded_for" });
    expect(canonicalIp("not-an-ip")).toBeUndefined();
    expect(canonicalIp("100.64.0.1")).toBe("100.64.0.1");
  });
});

describe("local and remote coexistence (D-B)", () => {
  it("the remote listener never accepts the local bearer, local cookie or bootstrap; the local listener never accepts a remote session", async () => {
    rig = await startRemoteRig();
    const s = await ownerSession(rig);
    // Local bearer on the remote listener: 401, even with a valid same-origin context.
    expect((await viaProxy(rig, "GET", "/api/tasks", { ...rig.bearer(), "sec-fetch-site": "same-origin" })).status).toBe(401);
    expect((await viaProxy(rig, "GET", "/api/tasks", { ...rig.bearer(), ...sameOrigin(s.cookie) })).status).toBe(401);
    // Bootstrap is not a route on the remote listener.
    const cred = readCredential(credentialPath(rig.config.dir)).secrets.at(-1)!;
    const token = mintBootstrapToken(cred, { aud: `http://127.0.0.1:${rig.localPort}`, lo: rig.canonicalOrigin, cap: cred.capabilities, exp: Math.floor(rig.clock.now.getTime() / 1000) + 10 });
    const boot = await viaProxy(rig, "POST", "/api/auth/bootstrap", { origin: rig.canonicalOrigin, "content-type": "application/x-www-form-urlencoded" }, new URLSearchParams({ token }).toString());
    expect(boot.status).toBe(404);
    expect(cookieOf(boot.headers["set-cookie"], "__Host-acp_session")).toBeUndefined();
    // A local cookie next to the remote one is a conflicting credential.
    expect((await viaProxy(rig, "GET", "/api/tasks", sameOrigin(`${s.cookie}; __Host-acp_session=FAKE-local-not-real`))).status).toBe(401);
    // Two remote cookies are ambiguous.
    expect((await viaProxy(rig, "GET", "/api/tasks", sameOrigin(`${s.cookie}; ${s.cookie}`))).status).toBe(401);
    // The local listener: remote cookie is not a credential; remote routes do not exist; bearer works unchanged.
    const local = `http://127.0.0.1:${rig.localPort}`;
    expect((await fetch(`${local}/api/tasks`, { headers: { cookie: s.cookie, "sec-fetch-site": "same-origin" } })).status).toBe(401);
    for (const p of ["/api/auth/login", "/api/auth/callback"]) expect((await fetch(`${local}${p}`, { headers: rig.bearer(), redirect: "manual" })).status, p).toBe(404);
    for (const p of ["/api/auth/activity", "/api/auth/logout"]) expect((await fetch(`${local}${p}`, { method: "POST", headers: rig.bearer() })).status, p).toBe(404);
    // The session probe exists on both sides: locally it says "local" and carries no token.
    const localSession = await fetch(`${local}/api/auth/session`, { headers: rig.bearer() });
    expect(localSession.status).toBe(200);
    expect(await localSession.json()).toEqual({ mode: "local" });
    expect((await fetch(`${local}/api/tasks`, { headers: rig.bearer() })).status).toBe(200);
    // Local bootstrap still mints a local cookie on the local listener.
    const tk = mintBootstrapToken(cred, { aud: local, lo: "http://127.0.0.1:9999", cap: cred.capabilities, exp: Math.floor(rig.clock.now.getTime() / 1000) + 10 });
    const lb = await fetch(`${local}/api/auth/bootstrap`, { method: "POST", redirect: "manual", headers: { origin: "http://127.0.0.1:9999", "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ token: tk }).toString() });
    expect(lb.status).toBe(303);
    expect(lb.headers.get("set-cookie")).toMatch(/^__Host-acp_session=/);
  });

  it("refuses incomplete or permissive remote configuration before listen", () => {
    const base = { port: 2, canonicalOrigin: "https://a.example", transport: { kind: "trusted-proxy", peers: ["127.0.0.1"], tailscaleUserLogin: "a@b" }, identity: { issuer: "https://i.example", clientId: "c", clientSecretFile: "/nonexistent", owner: { issuer: "https://i.example", subject: "s" } }, grants: ["tasks.read"] };
    const bad: Array<[string, Record<string, unknown>]> = [
      ["http origin", { ...base, canonicalOrigin: "http://a.example" }],
      ["origin with path", { ...base, canonicalOrigin: "https://a.example/app" }],
      ["unknown key", { ...base, allowNonLoopback: true }],
      ["permissive peers", { ...base, transport: { ...base.transport, peers: ["0.0.0.0/0"] } }],
      ["no peers", { ...base, transport: { ...base.transport, peers: [] } }],
      ["direct-tls", { ...base, transport: { ...base.transport, kind: "direct-tls" } }],
      ["no tailscale login", { ...base, transport: { kind: "trusted-proxy", peers: ["127.0.0.1"] } }],
      ["owner issuer mismatch", { ...base, identity: { ...base.identity, owner: { issuer: "https://other.example", subject: "s" } } }],
      ["no subject", { ...base, identity: { ...base.identity, owner: { issuer: "https://i.example" } } }],
      ["http issuer", { ...base, identity: { ...base.identity, issuer: "http://i.example", owner: { issuer: "http://i.example", subject: "s" } } }],
      ["same port as local", { ...base, port: 1 }],
      ["idle > absolute", { ...base, session: { absoluteTtlSeconds: 10, idleTtlSeconds: 20 } }],
      ["zero limit", { ...base, limits: { readsPerMinutePerSession: 0 } }],
      ["missing secret file", base],
    ];
    for (const [name, raw] of bad) {
      const problems: string[] = [];
      expect(resolveRemoteAuth(raw, { localPort: 1, configDir: "/tmp", workspace: "personal", fileWorkspace: undefined }, problems), name).toBeUndefined();
      expect(problems.length, name).toBeGreaterThan(0);
    }
  });
});

describe("C1: encoded and non-canonical request targets on the remote listener", () => {
  const variants = (p: string) => [`/%61pi${p}`, `/ap%69${p}`, `/%61%70%69${p}`];
  it("no session: every encoded variant answers like /api/ (never 200) and no command takes effect", async () => {
    rig = await startRemoteRig();
    const local = `http://127.0.0.1:${rig.localPort}`;
    const id = ((await (await fetch(`${local}/api/tasks`, { method: "POST", headers: { ...rig.bearer(), "content-type": "application/json" }, body: JSON.stringify({ goal: "keep me" }) })).json()) as { taskId: string }).taskId;
    const before = JSON.stringify(rig.db.prepare("SELECT id, state FROM tasks").all());
    for (const headers of [{}, { "sec-fetch-site": "same-origin" }, { origin: rig.canonicalOrigin, "sec-fetch-site": "same-origin" }] as Array<Record<string, string>>) {
      const control = await viaProxy(rig, "GET", "/api/tasks", headers);
      expect([401, 403]).toContain(control.status);
      for (const p of [...variants("/tasks"), ...variants("/workspace"), "//api/tasks", "/API/tasks", "/%2561pi/tasks", "/x/../api/tasks"]) {
        const r = await viaProxy(rig, "GET", p, headers);
        expect([401, 403], `${p} ${JSON.stringify(headers)} -> ${r.status} ${r.body}`).toContain(r.status);
      }
      // The review's write: a no-cors cancel from any page the owner has open.
      for (const p of variants(`/tasks/${id}/cancel`)) {
        const r = await viaProxy(rig, "POST", p, { ...headers, "content-type": "application/json" }, "{}");
        expect([401, 403], `${p} -> ${r.status} ${r.body}`).toContain(r.status);
      }
      for (const p of variants("/tasks")) {
        const r = await viaProxy(rig, "POST", p, { ...headers, "content-type": "application/json" }, JSON.stringify({ goal: "x", idempotencyKey: "FAKE-key-0002-not-real" }));
        expect([401, 403], `${p} -> ${r.status} ${r.body}`).toContain(r.status);
      }
    }
    expect(JSON.stringify(rig.db.prepare("SELECT id, state FROM tasks").all())).toBe(before);
  });

  it("with an owner session: encoded reads and writes go through the same Origin, CSRF and grant checks", async () => {
    rig = await startRemoteRig();
    const s = await ownerSession(rig);
    for (const p of variants("/tasks")) expect((await viaProxy(rig, "GET", p, sameOrigin(s.cookie))).status, p).toBe(200);
    const local = `http://127.0.0.1:${rig.localPort}`;
    const id = ((await (await fetch(`${local}/api/tasks`, { method: "POST", headers: { ...rig.bearer(), "content-type": "application/json" }, body: JSON.stringify({ goal: "keep me" }) })).json()) as { taskId: string }).taskId;
    // Cookie without the CSRF token, or from a hostile Origin: refused, nothing changes.
    const noCsrf = { cookie: s.cookie, origin: rig.canonicalOrigin, "sec-fetch-site": "same-origin", "content-type": "application/json" };
    for (const p of variants(`/tasks/${id}/cancel`)) {
      const r = await viaProxy(rig, "POST", p, noCsrf, "{}");
      expect(r.status, p).toBe(403); expect(json(r.body).error).toBe("csrf");
      expect((await viaProxy(rig, "POST", p, { ...command(rig, s), origin: "https://evil.example" }, "{}")).status, p).toBe(403);
    }
    expect((rig.db.prepare("SELECT state FROM tasks WHERE id = ?").get(id) as { state: string }).state).not.toBe("CANCELLED");
    // The full browser command (Origin + CSRF + grant) still works through an encoded path: the gate ran.
    const ok = await viaProxy(rig, "POST", `/%61pi/tasks/${id}/cancel`, command(rig, s), "{}");
    expect(ok.status, ok.body).toBe(200);
    expect((rig.db.prepare("SELECT state FROM tasks WHERE id = ?").get(id) as { state: string }).state).toBe("CANCELLED");
  });

  it("the local-only revoke-all is 404 on the remote listener under any encoding, and sessions survive", async () => {
    rig = await startRemoteRig();
    const s = await ownerSession(rig);
    const live = liveSessions(rig);
    for (const p of ["/api/auth/remote/revoke-all", ...variants("/auth/remote/revoke-all"), "/api/auth/remote/%72evoke-all", "/api/auth/%72emote/revoke-all"]) {
      for (const headers of [{}, command(rig, s)]) {
        const r = await viaProxy(rig, "POST", p, headers, "{}");
        expect(r.status, `${p} -> ${r.status} ${r.body}`).toBe(404);
        expect(r.body).not.toContain("revoked");
      }
    }
    expect(liveSessions(rig)).toBe(live);
    expect((await viaProxy(rig, "GET", "/api/tasks", sameOrigin(s.cookie))).status).toBe(200);
    // And the remote-only session routes stay 404 on the local listener under encoding.
    for (const p of ["/%61pi/auth/login", "/%61pi/auth/callback"]) expect((await fetch(`http://127.0.0.1:${rig.localPort}${p}`, { headers: rig.bearer(), redirect: "manual" })).status, p).toBe(404);
    for (const p of ["/%61pi/auth/activity", "/%61pi/auth/logout"]) expect((await fetch(`http://127.0.0.1:${rig.localPort}${p}`, { method: "POST", headers: rig.bearer() })).status, p).toBe(404);
  });

  it("an absolute-form target straight to the remote port is refused before the proxy contract or auth", async () => {
    rig = await startRemoteRig();
    const headers: Array<[string, string]> = [["host", `${CANONICAL_HOST}:${rig.proxyPort}`], ["x-forwarded-host", `${CANONICAL_HOST}:${rig.proxyPort}`], ["x-forwarded-proto", "https"], ["x-forwarded-for", "127.0.0.1"], ["tailscale-user-login", TAILSCALE_LOGIN]];
    for (const target of [`http://${CANONICAL_HOST}/api/tasks`, `https://${CANONICAL_HOST}:${rig.proxyPort}/api/tasks`, "http://127.0.0.1/%61pi/tasks"]) {
      const r = await rawRequest(rig.remotePort, "GET", target, headers);
      expect(r.status, `${target} -> ${r.body}`).toBe(400);
    }
  });
});

describe("L3: the OIDC client secret file", () => {
  it("is refused as a symlink or a group-readable file, at config time and again at login", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acp-secret-"));
    try {
      const real = join(dir, "real"); writeFileSync(real, "FAKE-secret-not-real\n", { mode: 0o600 }); chmodSync(real, 0o600);
      const link = join(dir, "link"); symlinkSync(real, link);
      expect(privateFileProblem(real)).toBeUndefined();
      expect(privateFileProblem(link)).toMatch(/symlink/);
      expect(privateFileProblem(join(dir, "absent"))).toMatch(/does not exist/);
      chmodSync(real, 0o640); expect(privateFileProblem(real)).toMatch(/chmod 600/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
    rig = await startRemoteRig();
    const secretFile = rig.config.api.remote!.identity.clientSecretFile;
    chmodSync(secretFile, 0o644);
    const { callback, session } = await oidcLogin(rig);
    expect(session).toBeUndefined();
    expect(callback?.status ?? 0).toBeGreaterThanOrEqual(400);
    expect(callback?.body ?? "").not.toContain("FAKE");
    chmodSync(secretFile, 0o600);
    expect((await oidcLogin(rig)).session).toBeDefined();
  });
});

describe("limits and secrecy", () => {
  it("login is budgeted per address and the budget survives a restart; commands and reads answer 429 with Retry-After", async () => {
    rig = await startRemoteRig({ limits: { loginPerMinutePerAddress: 3, commandsPerMinutePerPrincipal: 2, readsPerMinutePerSession: 4 } });
    const s = await ownerSession(rig); // login + callback: 2 attempts
    for (let i = 0; i < 1; i += 1) expect((await viaProxy(rig, "GET", "/api/auth/login", { "sec-fetch-site": "same-origin" })).status).toBe(303); // 2, 3
    const limited = await viaProxy(rig, "GET", "/api/auth/login", { "sec-fetch-site": "same-origin" });
    expect(limited.status).toBe(429);
    expect(Number(limited.headers["retry-after"])).toBeGreaterThan(0);
    const before = taskCount(rig);
    expect((await viaProxy(rig, "POST", "/api/tasks", command(rig, s), JSON.stringify({ goal: "1" }))).status).toBe(201);
    expect((await viaProxy(rig, "POST", "/api/tasks", command(rig, s), JSON.stringify({ goal: "2" }))).status).toBe(201);
    const third = await viaProxy(rig, "POST", "/api/tasks", command(rig, s), JSON.stringify({ goal: "3" }));
    expect(third.status).toBe(429);
    expect(taskCount(rig)).toBe(before + 2);
    let reads = 0; for (let i = 0; i < 6; i += 1) if ((await viaProxy(rig, "GET", "/api/tasks", sameOrigin(s.cookie))).status === 429) reads += 1;
    expect(reads).toBeGreaterThan(0);
    // Restart in the same minute: the login budget is still spent.
    const home = rig.home; const clock = rig.clock.now;
    await rig.built.app.close(); rig.db.close(); await rig.issuer.close();
    rig = await startRemoteRig({ home, limits: { loginPerMinutePerAddress: 3 } });
    rig.clock.now = clock;
    expect((await viaProxy(rig, "GET", "/api/auth/login", { "sec-fetch-site": "same-origin" })).status).toBe(429);
  });

  it("logs carry no cookie, code, state, CSRF, client secret or login URL", async () => {
    const lines: string[] = [];
    const orig = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => { lines.push(String(chunk)); return (orig as (...a: unknown[]) => boolean)(chunk, ...rest); }) as typeof process.stdout.write;
    try {
      rig = await startRemoteRig();
      const { start, callbackPath, session, loginCookie } = await oidcLogin(rig);
      const me = json((await viaProxy(rig, "GET", "/api/auth/session", sameOrigin(session!))).body);
      await viaProxy(rig, "POST", "/api/tasks", command(rig, { cookie: session!, csrf: me.csrfToken as string }), JSON.stringify({ goal: "log check" }));
      const all = lines.join("");
      const code = new URL(`https://x${callbackPath}`).searchParams.get("code")!;
      const state = new URL(`https://x${callbackPath}`).searchParams.get("state")!;
      for (const secret of [session!.split("=")[1]!, loginCookie!.split("=")[1]!, code, state, me.csrfToken as string, rig.issuer.clientSecret, start.headers.location!]) {
        expect(all).not.toContain(secret);
      }
      expect(all).toContain("remote_auth");
    } finally { process.stdout.write = orig; }
  });
});

// Keep the raw http import used (type-only helpers above use it indirectly).
void httpRequest;
