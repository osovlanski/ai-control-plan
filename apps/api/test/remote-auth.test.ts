import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig, resolveRemote, type ResolvedConfig } from "../src/config.js";
import { openDb, type Db } from "../src/db/index.js";
import { buildServer, type BuiltServer } from "../src/server.js";
import { startRemoteListener } from "../src/auth/remote-listener.js";
import { credentialPath, readCredential } from "../src/auth/credential-file.js";
import { FAKE_CLIENT_ID, FAKE_CLIENT_SECRET, OWNER_SUB, startFakeIssuer, type FakeIssuer } from "./helpers/fake-oidc.js";

/**
 * B2 remote auth on real loopback sockets. The test client plays Tailscale Serve: it connects from
 * 127.0.0.1 and sets the headers Serve sets (Host/X-Forwarded-Host = canonical host,
 * X-Forwarded-Proto https, one X-Forwarded-For, Tailscale-User-Login). The TLS proxy + real browser
 * half of the ADR acceptance cases is the drive script, not this suite.
 */
const CANONICAL = "https://plane.fake-tailnet-not-real.ts.net";
const HOST = new URL(CANONICAL).host;
const TAILNET_LOGIN = "FAKE-owner-not-real@example.com";

async function freePort(): Promise<number> {
  return new Promise((resolve) => { const s = createServer(); s.listen(0, "127.0.0.1", () => { const p = (s.address() as AddressInfo).port; s.close(() => resolve(p)); }); });
}

interface Res { status: number; headers: Record<string, string | string[] | undefined>; body: string }
/** Raw HTTP so the test controls every header, duplicates included. */
function send(port: number, method: string, path: string, headers: [string, string][], body?: string): Promise<Res> {
  return new Promise((resolve, reject) => {
    const flat = headers.flat();
    if (body !== undefined) flat.push("content-length", String(Buffer.byteLength(body)));
    const r = request({ host: "127.0.0.1", port, method, path, headers: flat, setHost: false }, (res) => {
      let b = ""; res.setEncoding("utf8"); res.on("data", (c) => { b += c; }); res.on("end", () => resolve({ status: res.statusCode!, headers: res.headers, body: b }));
    });
    r.on("error", reject); if (body !== undefined) r.write(body); r.end();
  });
}
const proxied = (extra: [string, string][] = [], drop: string[] = []): [string, string][] =>
  ([["host", HOST], ["x-forwarded-host", HOST], ["x-forwarded-proto", "https"], ["x-forwarded-for", "100.64.0.7"], ["tailscale-user-login", TAILNET_LOGIN]] as [string, string][])
    .filter(([k]) => !drop.includes(k)).concat(extra);
const cookieOf = (h: Res["headers"], name: string) => ([h["set-cookie"]].flat().filter(Boolean) as string[]).find((c) => c.startsWith(`${name}=`))?.split(";")[0];

let home: string, config: ResolvedConfig, db: Db, built: BuiltServer, issuer: FakeIssuer, remotePort: number, localPort: number;
let clock = new Date("2026-11-22T12:00:00.000Z");
let grants = ["tasks.read", "events.read", "events.stream", "routing.read", "sessions.read", "verification.read", "approvals.read", "schedules.read", "models.read", "context.read", "decisions.read", "registry.read", "commands.write"];

function writeConfig(extra = ""): void {
  const dir = join(home, "personal");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const secret = join(home, "web-client-secret");
  writeFileSync(secret, FAKE_CLIENT_SECRET); chmodSync(secret, 0o600);
  writeFileSync(join(dir, "config.yaml"), `workspace: personal
assistants:
  fake: { provider: fake }
api:
  host: 127.0.0.1
  port: 4186
  remote:
    listen: { host: 127.0.0.1, port: ${remotePort} }
    canonicalOrigin: ${CANONICAL}
    transport: { kind: trusted-proxy, peers: ["127.0.0.1"], tailscaleLogin: "${TAILNET_LOGIN}" }
    identity:
      issuer: ${issuer.issuer}
      clientId: ${FAKE_CLIENT_ID}
      clientSecretFile: ${secret}
      subject: ${OWNER_SUB}
      grants: [${grants.join(", ")}]
    session: { absoluteTtlSeconds: 7200, idleTtlSeconds: 600 }
${extra}`);
}

async function boot(): Promise<void> {
  config = loadConfig({ AGENT_PLANE_HOME: home });
  db ??= openDb(config.dbPath);
  built = buildServer({ config, db, now: () => clock });
  built.registry.init();
  await built.app.listen({ host: "127.0.0.1", port: 0 });
  localPort = (built.app.server.address() as AddressInfo).port;
  await startRemoteListener(built.app, built.remoteAuth!);
}

/** The whole browser login: /login → fake IdP → /callback. Returns the session cookie and the callback response. */
async function login(): Promise<{ cookie: string | undefined; callback: Res; loginCookie: string }> {
  const start = await send(remotePort, "GET", "/api/auth/login", proxied([["sec-fetch-mode", "navigate"], ["sec-fetch-site", "none"]]));
  expect(start.status).toBe(302);
  const loginCookie = cookieOf(start.headers, "__Host-acp_login")!;
  const authorize = await fetch(String(start.headers.location), { redirect: "manual" });
  const back = new URL(authorize.headers.get("location")!);
  expect(back.origin).toBe(CANONICAL);
  const callback = await send(remotePort, "GET", `${back.pathname}${back.search}`, proxied([["cookie", loginCookie], ["sec-fetch-site", "cross-site"], ["sec-fetch-mode", "navigate"]]));
  return { cookie: cookieOf(callback.headers, "__Host-acp_remote_session"), callback, loginCookie };
}
async function session(cookie: string): Promise<{ csrfToken: string; grants: string[]; idleExpiresAt: string }> {
  const r = await send(remotePort, "GET", "/api/auth/session", proxied([["cookie", cookie], ["sec-fetch-site", "same-origin"]]));
  expect(r.status).toBe(200);
  return JSON.parse(r.body) as { csrfToken: string; grants: string[]; idleExpiresAt: string };
}
const post = (cookie: string, path: string, body: unknown, headers: [string, string][]) =>
  send(remotePort, "POST", path, proxied([["cookie", cookie], ["content-type", "application/json"], ...headers]), JSON.stringify(body));
const taskCount = () => (db.prepare("SELECT COUNT(*) AS n FROM tasks").get() as { n: number }).n;

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), "acp-remote-"));
  issuer = await startFakeIssuer();
  remotePort = await freePort();
  writeConfig();
  await boot();
});
afterEach(async () => {
  await built.app.close(); db.close(); (db as Db | undefined) = undefined as never; await issuer.close();
  rmSync(home, { recursive: true, force: true });
  clock = new Date("2026-11-22T12:00:00.000Z");
  grants = ["tasks.read", "events.read", "events.stream", "routing.read", "sessions.read", "verification.read", "approvals.read", "schedules.read", "models.read", "context.read", "decisions.read", "registry.read", "commands.write"];
});

describe("B2 remote listener: transport contract", () => {
  it("refuses every request that did not come through the pinned proxy contract, static files included", async () => {
    for (const [name, headers] of [
      ["no proxy headers", [["host", HOST]]],
      ["no tailnet identity", proxied([], ["tailscale-user-login"])],
      ["wrong tailnet identity", proxied([["tailscale-user-login", "someone-else@example.com"]], ["tailscale-user-login"])],
      ["two tailnet identities", proxied([["tailscale-user-login", TAILNET_LOGIN]])],
      ["forged host", proxied([["host", "evil.example"]], ["host"])],
      ["forged forwarded host", proxied([["x-forwarded-host", "evil.example"]], ["x-forwarded-host"])],
      ["http effective proto", proxied([["x-forwarded-proto", "http"]], ["x-forwarded-proto"])],
      ["two forwarded-for", proxied([["x-forwarded-for", "1.2.3.4"]])],
      ["comma chain", proxied([["x-forwarded-for", "1.2.3.4, 100.64.0.7"]], ["x-forwarded-for"])],
      ["Forwarded header", proxied([["forwarded", "for=1.2.3.4;proto=https"]])],
    ] as [string, [string, string][]][]) {
      for (const path of ["/", "/api/auth/login", "/api/meta"]) {
        const r = await send(remotePort, "GET", path, headers);
        expect([name, path, r.status]).toEqual([name, path, 403]);
        expect(r.headers["set-cookie"]).toBeUndefined();
      }
    }
  });

  it("does not trust a peer outside the configured loopback list", async () => {
    await built.app.close(); db.close(); (db as Db | undefined) = undefined as never;
    writeConfig();
    const yaml = join(home, "personal", "config.yaml");
    const { readFileSync } = await import("node:fs");
    writeFileSync(yaml, readFileSync(yaml, "utf8").replace('peers: ["127.0.0.1"]', 'peers: ["::1"]'));
    await boot();
    expect((await send(remotePort, "GET", "/api/auth/login", proxied())).status).toBe(403);
  });
});

describe("B2 remote listener: local credentials never work remotely", () => {
  it("refuses bearer, local cookie and bootstrap, and hides the operator revoke route", async () => {
    const bearer = readCredential(credentialPath(config.dir)).secrets.at(-1)!.secret;
    expect((await send(remotePort, "GET", "/api/tasks", proxied([["authorization", `Bearer ${bearer}`], ["sec-fetch-site", "same-origin"]]))).status).toBe(401);
    expect((await send(remotePort, "GET", "/api/tasks", proxied([["cookie", "__Host-acp_session=FAKE-local-not-real"], ["sec-fetch-site", "same-origin"]]))).status).toBe(401);
    expect((await send(remotePort, "POST", "/api/auth/bootstrap", proxied([["origin", CANONICAL], ["content-type", "application/x-www-form-urlencoded"]]), "token=FAKE-boot-not-real")).status).toBe(404);
    const { cookie } = await login();
    const { csrfToken } = await session(cookie!);
    // A valid remote session plus a bearer is a conflicting credential: refused.
    expect((await send(remotePort, "GET", "/api/tasks", proxied([["cookie", cookie!], ["authorization", `Bearer ${bearer}`], ["sec-fetch-site", "same-origin"]]))).status).toBe(401);
    expect((await post(cookie!, "/api/auth/remote-sessions/revoke", {}, [["origin", CANONICAL], ["x-csrf-token", csrfToken]])).status).toBe(404);
  });

  it("leaves the local listener on its own rules: remote routes 404, remote cookie ignored, proxied requests misdirected", async () => {
    const bearer = readCredential(credentialPath(config.dir)).secrets.at(-1)!.secret;
    const auth: [string, string] = ["authorization", `Bearer ${bearer}`];
    expect((await send(localPort, "GET", "/api/tasks", [["host", "127.0.0.1"], auth])).status).toBe(200);
    for (const path of ["/api/auth/login", "/api/auth/callback", "/api/auth/session"]) expect((await send(localPort, "GET", path, [["host", "127.0.0.1"], auth])).status).toBe(404);
    const { cookie } = await login();
    expect((await send(localPort, "GET", "/api/tasks", [["host", "127.0.0.1"], ["cookie", cookie!], ["sec-fetch-site", "same-origin"]])).status).toBe(401);
    expect((await send(localPort, "GET", "/api/tasks", [["host", "127.0.0.1"], auth, ["tailscale-user-login", TAILNET_LOGIN]])).status).toBe(421);
    expect((await send(localPort, "GET", "/api/tasks", [["host", "127.0.0.1"], auth, ["x-forwarded-proto", "https"]])).status).toBe(421);
  });
});

describe("B2 remote login: Google OIDC exact (iss, sub) pin", () => {
  it("mints a strict host-only session cookie for the owner and returns to the canonical origin only", async () => {
    const start = await send(remotePort, "GET", "/api/auth/login?return=https://evil.example/", proxied());
    expect(start.headers["set-cookie"]).toEqual([expect.stringMatching(/^__Host-acp_login=[^;]+; HttpOnly; Secure; SameSite=Lax; Path=\/; Max-Age=300$/)]);
    expect(start.headers["cache-control"]).toBe("no-store");
    const authz = new URL(String(start.headers.location));
    expect(authz.searchParams.get("redirect_uri")).toBe(`${CANONICAL}/api/auth/callback`);
    expect(authz.searchParams.get("scope")).toBe("openid");
    expect(authz.searchParams.get("code_challenge_method")).toBe("S256");
    const { cookie, callback } = await login();
    expect(callback.status).toBe(303);
    expect(callback.headers.location).toBe(`${CANONICAL}/`);
    const set = [callback.headers["set-cookie"]].flat() as string[];
    expect(set.find((c) => c.startsWith("__Host-acp_remote_session="))).toMatch(/; HttpOnly; Secure; SameSite=Strict; Path=\/; Max-Age=7200$/);
    expect(set.join("\n")).not.toContain("Domain");
    expect(set.find((c) => c.startsWith("__Host-acp_login="))).toMatch(/Max-Age=0$/);
    const s = await session(cookie!);
    expect(s.grants).toEqual(grants);
    expect(s.csrfToken.length).toBeGreaterThan(20);
    // Only a hash of the handle is stored.
    const rows = JSON.stringify(db.prepare("SELECT * FROM remote_sessions").all());
    expect(rows).not.toContain(cookie!.split("=")[1]);
  });

  it("refuses a non-owner with the owner's email, a wrong issuer, audience, signature or nonce", async () => {
    for (const loginAs of [
      { sub: "FAKE-other-sub-not-real", email: "owner@example.com" },
      { sub: OWNER_SUB, iss: "https://accounts.FAKE-not-real.example" },
      { sub: OWNER_SUB, aud: "FAKE-other-client-not-real" },
      { sub: OWNER_SUB, signWithOtherKey: true },
      { sub: OWNER_SUB, nonce: "FAKE-wrong-nonce-not-real" },
    ]) {
      issuer.loginAs = loginAs;
      const { cookie, callback } = await login();
      expect([loginAs, callback.status]).toEqual([loginAs, 403]);
      expect(cookie).toBeUndefined();
    }
    expect((db.prepare("SELECT COUNT(*) AS n FROM remote_sessions").get() as { n: number }).n).toBe(0);
  });

  it("consumes a transaction once, binds it to the browser cookie and never replays", async () => {
    const start = await send(remotePort, "GET", "/api/auth/login", proxied());
    const loginCookie = cookieOf(start.headers, "__Host-acp_login")!;
    const back = new URL((await fetch(String(start.headers.location), { redirect: "manual" })).headers.get("location")!);
    const path = `${back.pathname}${back.search}`;
    // Another browser (no or wrong login cookie) cannot complete it.
    expect((await send(remotePort, "GET", path, proxied())).status).toBe(400);
    expect((await send(remotePort, "GET", path, proxied([["cookie", "__Host-acp_login=FAKE-other-browser-not-real"]]))).status).toBe(400);
    const ok = await send(remotePort, "GET", path, proxied([["cookie", loginCookie]]));
    expect(ok.status).toBe(303);
    const exchanges = issuer.exchanges;
    const replay = await send(remotePort, "GET", path, proxied([["cookie", loginCookie]]));
    expect(replay.status).toBe(400);
    expect(cookieOf(replay.headers, "__Host-acp_remote_session")).toBeUndefined();
    expect(issuer.exchanges).toBe(exchanges);
  });

  it("expires a transaction after five minutes", async () => {
    const start = await send(remotePort, "GET", "/api/auth/login", proxied());
    const loginCookie = cookieOf(start.headers, "__Host-acp_login")!;
    const back = new URL((await fetch(String(start.headers.location), { redirect: "manual" })).headers.get("location")!);
    clock = new Date(clock.getTime() + 5 * 60_000 + 1);
    expect((await send(remotePort, "GET", `${back.pathname}${back.search}`, proxied([["cookie", loginCookie]]))).status).toBe(400);
  });

  it("rate limits login per client address with Retry-After", async () => {
    let last: Res | undefined;
    for (let i = 0; i < 11; i++) last = await send(remotePort, "GET", "/api/auth/login", proxied());
    expect(last!.status).toBe(429);
    expect(Number(last!.headers["retry-after"])).toBeGreaterThan(0);
    expect((await send(remotePort, "GET", "/api/auth/login", proxied([["x-forwarded-for", "100.64.0.8"]], ["x-forwarded-for"]))).status).toBe(302);
  });
});

describe("B2 remote session: origin, CSRF and grants", () => {
  it("runs a write exactly once with exact Origin plus the session's CSRF token, and refuses every other shape", async () => {
    const { cookie } = await login();
    const { csrfToken } = await session(cookie!);
    const other = await login();
    const otherCsrf = (await session(other.cookie!)).csrfToken;
    const before = taskCount();
    for (const headers of [
      [],
      [["origin", "https://evil.example"], ["x-csrf-token", csrfToken]],
      [["origin", "null"], ["x-csrf-token", csrfToken]],
      [["origin", "http://plane.fake-tailnet-not-real.ts.net"], ["x-csrf-token", csrfToken]],
      [["origin", `${CANONICAL}:8443`], ["x-csrf-token", csrfToken]],
      [["origin", "https://evil.plane.fake-tailnet-not-real.ts.net"], ["x-csrf-token", csrfToken]],
      [["origin", "https://evil.example"], ["sec-fetch-site", "same-origin"], ["x-csrf-token", csrfToken]],
      [["origin", CANONICAL]],
      [["origin", CANONICAL], ["x-csrf-token", "FAKE-wrong-not-real"]],
      [["origin", CANONICAL], ["x-csrf-token", otherCsrf]],
      [["origin", CANONICAL], ["origin", CANONICAL], ["x-csrf-token", csrfToken]],
    ] as [string, string][][]) {
      const r = await post(cookie!, "/api/tasks", { goal: "remote write" }, headers);
      expect([headers, r.status]).toEqual([headers, 403]);
    }
    expect(taskCount()).toBe(before);
    const ok = await post(cookie!, "/api/tasks", { goal: "remote write" }, [["origin", CANONICAL], ["x-csrf-token", csrfToken]]);
    expect(ok.status).toBe(201);
    expect(taskCount()).toBe(before + 1);
  });

  it("serves reads only to same-origin browser requests, never to navigation or cross-site", async () => {
    const { cookie } = await login();
    const c: [string, string] = ["cookie", cookie!];
    expect((await send(remotePort, "GET", "/api/tasks", proxied([c, ["sec-fetch-site", "same-origin"]]))).status).toBe(200);
    expect((await send(remotePort, "GET", "/api/tasks", proxied([c, ["origin", CANONICAL]]))).status).toBe(200);
    expect((await send(remotePort, "GET", "/api/tasks", proxied([c]))).status).toBe(403);
    expect((await send(remotePort, "GET", "/api/tasks", proxied([c, ["sec-fetch-site", "cross-site"]]))).status).toBe(403);
    expect((await send(remotePort, "GET", "/api/tasks", proxied([c, ["sec-fetch-site", "none"]]))).status).toBe(403);
    expect((await send(remotePort, "GET", "/api/tasks", proxied([c, ["sec-fetch-site", "same-origin"], ["sec-fetch-mode", "navigate"]]))).status).toBe(403);
    expect((await send(remotePort, "GET", "/api/tasks", proxied([c, ["origin", "https://evil.example"], ["sec-fetch-site", "same-origin"]]))).status).toBe(403);
    expect((await send(remotePort, "GET", "/api/tasks", proxied([["sec-fetch-site", "same-origin"]]))).status).toBe(401);
    const unauth = await send(remotePort, "GET", "/api/auth/session", proxied([["sec-fetch-site", "same-origin"]]));
    expect(unauth.status).toBe(401);
    expect(JSON.parse(unauth.body)).toEqual({ error: "unauthenticated", login: "/api/auth/login" });
  });

  it("enforces the configured grants: a read-only owner cannot write, and autopilot.operate is never grantable", async () => {
    await built.app.close(); db.close(); (db as Db | undefined) = undefined as never;
    grants = ["tasks.read", "events.stream"];
    writeConfig();
    await boot();
    const { cookie } = await login();
    const { csrfToken } = await session(cookie!);
    expect((await post(cookie!, "/api/tasks", { goal: "x" }, [["origin", CANONICAL], ["x-csrf-token", csrfToken]])).status).toBe(403);
    expect((await post(cookie!, "/api/autopilot/start", {}, [["origin", CANONICAL], ["x-csrf-token", csrfToken]])).status).toBe(403);
    expect(() => resolveRemote({ ...validRemote(), identity: { ...validRemote().identity, grants: ["tasks.read", "autopilot.operate"] } }, 4186, "t")).toThrow(/may not hold: autopilot.operate/);
  });
});

describe("B2 remote session: expiry, logout, revocation and restart", () => {
  it("expires on idle unless the operator writes; reads and polling never extend it; absolute is a hard cap", async () => {
    const { cookie } = await login();
    const { csrfToken } = await session(cookie!);
    const read = () => send(remotePort, "GET", "/api/tasks", proxied([["cookie", cookie!], ["sec-fetch-site", "same-origin"]]));
    for (let i = 0; i < 5; i++) { clock = new Date(clock.getTime() + 110_000); expect((await read()).status).toBe(200); }
    clock = new Date(clock.getTime() + 60_000); // 610 s idle with reads only
    expect((await read()).status).toBe(401);

    const fresh = await login();
    const fcsrf = (await session(fresh.cookie!)).csrfToken;
    const start = clock.getTime();
    for (let i = 0; i < 12; i++) {
      clock = new Date(clock.getTime() + 590_000);
      expect((await post(fresh.cookie!, "/api/auth/activity", {}, [["origin", CANONICAL], ["x-csrf-token", fcsrf]])).status).toBe(200);
    }
    expect(clock.getTime() - start).toBeLessThan(7200_000);
    clock = new Date(start + 7200_000);
    expect((await post(fresh.cookie!, "/api/auth/activity", {}, [["origin", CANONICAL], ["x-csrf-token", fcsrf]])).status).toBe(401);
    expect(csrfToken).not.toBe(fcsrf);
  });

  it("logout needs Origin and CSRF, revokes server-side, expires the cookie and closes the session's streams", async () => {
    const { cookie } = await login();
    const { csrfToken } = await session(cookie!);
    const made = await post(cookie!, "/api/tasks", { goal: "stream me" }, [["origin", CANONICAL], ["x-csrf-token", csrfToken]]);
    const taskId = (JSON.parse(made.body) as { taskId: string }).taskId;
    const stream = await openStream(cookie!, taskId);
    expect(stream.status).toBe(200);
    expect(built.remoteAuth!.activeStreams()).toBe(1);
    expect((await post(cookie!, "/api/auth/logout", {}, [["origin", CANONICAL]])).status).toBe(403);
    const out = await post(cookie!, "/api/auth/logout", {}, [["origin", CANONICAL], ["x-csrf-token", csrfToken]]);
    expect(out.status).toBe(200);
    expect(cookieOf(out.headers, "__Host-acp_remote_session")).toBe("__Host-acp_remote_session=");
    expect([out.headers["set-cookie"]].flat().join()).toMatch(/Max-Age=0/);
    await stream.closed;
    expect(built.remoteAuth!.activeStreams()).toBe(0);
    expect((await send(remotePort, "GET", "/api/tasks", proxied([["cookie", cookie!], ["sec-fetch-site", "same-origin"]]))).status).toBe(401);
  });

  it("caps active streams per session and closes a stream when the session expires", async () => {
    const { cookie } = await login();
    const { csrfToken } = await session(cookie!);
    const taskId = (JSON.parse((await post(cookie!, "/api/tasks", { goal: "s" }, [["origin", CANONICAL], ["x-csrf-token", csrfToken]])).body) as { taskId: string }).taskId;
    const open = [await openStream(cookie!, taskId), await openStream(cookie!, taskId), await openStream(cookie!, taskId)];
    expect(open.map((s) => s.status)).toEqual([200, 200, 200]);
    expect((await openStream(cookie!, taskId)).status).toBe(429);
    clock = new Date(clock.getTime() + 601_000);
    built.remoteAuth!.sweepStreams();
    await Promise.all(open.map((s) => s.closed));
    expect(built.remoteAuth!.activeStreams()).toBe(0);
  });

  it("revoke-all from the local bearer CLI and a restart both end remote sessions", async () => {
    const bearer = readCredential(credentialPath(config.dir)).secrets.at(-1)!.secret;
    const a = await login();
    const r = await send(localPort, "POST", "/api/auth/remote-sessions/revoke", [["host", "127.0.0.1"], ["authorization", `Bearer ${bearer}`], ["content-type", "application/json"]], "{}");
    expect(r.status).toBe(200);
    expect(JSON.parse(r.body)).toEqual({ revoked: 1 });
    expect((await send(remotePort, "GET", "/api/tasks", proxied([["cookie", a.cookie!], ["sec-fetch-site", "same-origin"]]))).status).toBe(401);
    const b = await login();
    await built.app.close();
    await boot();
    expect((await send(remotePort, "GET", "/api/tasks", proxied([["cookie", b.cookie!], ["sec-fetch-site", "same-origin"]]))).status).toBe(401);
  });
});

function openStream(cookie: string, taskId: string): Promise<{ status: number; closed: Promise<void> }> {
  return new Promise((resolve, reject) => {
    const r = request({ host: "127.0.0.1", port: remotePort, path: `/api/tasks/${taskId}/events/stream`, headers: proxied([["cookie", cookie], ["sec-fetch-site", "same-origin"], ["accept", "text/event-stream"]]).flat(), setHost: false }, (res) => {
      const closed = new Promise<void>((done) => { res.on("close", () => done()); res.on("error", () => done()); });
      res.resume();
      resolve({ status: res.statusCode!, closed });
    });
    r.on("error", reject); r.end();
  });
}

function validRemote() {
  const secret = join(home, "web-client-secret");
  return {
    listen: { host: "127.0.0.1", port: 4999 }, canonicalOrigin: CANONICAL,
    transport: { kind: "trusted-proxy", peers: ["127.0.0.1"], tailscaleLogin: TAILNET_LOGIN },
    identity: { issuer: "https://accounts.google.com", clientId: FAKE_CLIENT_ID, clientSecretFile: secret, subject: OWNER_SUB, grants: ["tasks.read"] },
  };
}

describe("B2 remote configuration", () => {
  it("is all-or-nothing: incomplete, unknown, http, non-loopback or unsafe settings fail before listen", () => {
    expect(resolveRemote(undefined, 4186, "t")).toBeUndefined();
    expect(resolveRemote(validRemote(), 4186, "t")?.session).toEqual({ absoluteTtlSeconds: 43200, idleTtlSeconds: 1800 });
    const v = validRemote();
    const bad: [string, unknown, RegExp][] = [
      ["unknown key", { ...v, allowAnything: true }, /unknown key/],
      ["unknown nested key", { ...v, identity: { ...v.identity, email: "x" } }, /identity has unknown key/],
      ["http origin", { ...v, canonicalOrigin: "http://plane.example" }, /must be https/],
      ["origin with path", { ...v, canonicalOrigin: `${CANONICAL}/app` }, /no path/],
      ["non-loopback listener", { ...v, listen: { host: "0.0.0.0", port: 4999 } }, /127.0.0.1 or ::1/],
      ["same port as local", { ...v, listen: { host: "127.0.0.1", port: 4186 } }, /must differ from api.port/],
      ["public peer", { ...v, transport: { ...v.transport, peers: ["100.64.0.1"] } }, /loopback address/],
      ["empty peers", { ...v, transport: { ...v.transport, peers: [] } }, /loopback address/],
      ["direct tls", { ...v, transport: { ...v.transport, kind: "direct-tls" } }, /trusted-proxy/],
      ["no tailnet login", { ...v, transport: { kind: "trusted-proxy", peers: ["127.0.0.1"] } }, /tailscaleLogin/],
      ["no subject", { ...v, identity: { ...v.identity, subject: undefined } }, /subject/],
      ["empty grants", { ...v, identity: { ...v.identity, grants: [] } }, /at least one grant/],
      ["usage.write", { ...v, identity: { ...v.identity, grants: ["usage.write"] } }, /may not hold/],
      ["http issuer", { ...v, identity: { ...v.identity, issuer: "http://accounts.google.com" } }, /must be https/],
      ["issuer slash", { ...v, identity: { ...v.identity, issuer: "https://accounts.google.com/" } }, /exact issuer/],
      ["relative secret", { ...v, identity: { ...v.identity, clientSecretFile: "secret" } }, /absolute path/],
      ["missing secret", { ...v, identity: { ...v.identity, clientSecretFile: join(home, "nope") } }, /does not exist/],
      ["idle over absolute", { ...v, session: { absoluteTtlSeconds: 600, idleTtlSeconds: 900 } }, /must not exceed/],
      ["zero limit", { ...v, limits: { commandsPerMinute: 0 } }, /commandsPerMinute/],
    ];
    for (const [name, raw, msg] of bad) expect(() => resolveRemote(raw, 4186, "t"), name).toThrow(msg);
    chmodSync(join(home, "web-client-secret"), 0o644);
    expect(() => resolveRemote(v, 4186, "t")).toThrow(/mode 0600/);
    chmodSync(join(home, "web-client-secret"), 0o600);
  });

  it("keeps the non-loopback refusal for the local listener even with remote configured", async () => {
    const yaml = join(home, "personal", "config.yaml");
    const { readFileSync } = await import("node:fs");
    writeFileSync(yaml, readFileSync(yaml, "utf8").replace("  host: 127.0.0.1\n  port: 4186", "  host: 0.0.0.0\n  port: 4186"));
    expect(() => loadConfig({ AGENT_PLANE_HOME: home })).toThrow(/api.host must be a loopback address/);
  });
});
