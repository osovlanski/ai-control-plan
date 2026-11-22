/**
 * B2 remote-auth rig, entirely on loopback: a real plane (both listeners), the shared fake OIDC
 * issuer, and a TLS proxy that behaves like Tailscale Serve (terminates TLS for the canonical
 * tailnet name, drops client forwarding/identity fields, sets one X-Forwarded-Host/-Proto/-For and
 * Tailscale-User-Login). Test-only certificate, generated per rig with openssl; nothing listens
 * beyond 127.0.0.1 and no provider, account or credential is involved. Used by
 * test/remote-auth.test.ts and apps/web/e2e/remote-auth.spec.ts.
 */
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer, request as httpRequest, type IncomingHttpHeaders, type Server } from "node:http";
import { createServer as createHttpsServer, request as httpsRequest } from "node:https";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse, stringify } from "yaml";
import { startFakeIssuer, type FakeIssuer } from "@agent-plane/oidc/testing";
import { loadConfig, type ResolvedConfig } from "../../src/config.js";
import { openDb, type Db } from "../../src/db/index.js";
import { buildServer, type BuiltServer } from "../../src/server.js";
import { credentialPath, readCredential } from "../../src/auth/credential-file.js";

export const CANONICAL_HOST = "plane.fake-tailnet.ts.net";
export const TAILSCALE_LOGIN = "FAKE-owner@tailnet-not-real";

export async function freePort(): Promise<number> {
  const s = createHttpServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", () => r()));
  const port = (s.address() as AddressInfo).port;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}

export interface ProxyOptions {
  /** What the proxy sends as Tailscale-User-Login. Default: the owner's login. null = omitted (Funnel / tagged node). */
  login?: string | null;
  /** Extra header lines the proxy adds after its own (contract-violation fixtures). */
  inject?: Record<string, string>;
}

export interface RemoteRig {
  home: string; config: ResolvedConfig; db: Db; built: BuiltServer; issuer: FakeIssuer;
  localPort: number; remotePort: number; proxyPort: number; canonicalOrigin: string; cert: string;
  clock: { now: Date };
  proxyOptions: ProxyOptions;
  bearer(): Record<string, string>;
  close(): Promise<void>;
}

export interface RigOptions {
  grants?: string[];
  session?: { absoluteTtlSeconds?: number; idleTtlSeconds?: number };
  limits?: Record<string, number>;
  /** Start the remote listener (default true). */
  listen?: boolean;
  /** Reuse a home/DB (restart case). */
  home?: string;
}

export const ALL_REMOTE_GRANTS = ["tasks.read", "events.read", "events.stream", "routing.read", "sessions.read", "verification.read", "approvals.read", "schedules.read", "models.read", "context.read", "decisions.read", "commands.write"];

export async function startRemoteRig(opts: RigOptions = {}): Promise<RemoteRig> {
  const home = opts.home ?? mkdtempSync(join(tmpdir(), "acp-remote-"));
  // One injected clock for the plane and the issuer, so token times agree when a test moves time.
  const clock = { now: new Date() };
  const issuer = await startFakeIssuer({ now: () => clock.now });
  const [localPort, remotePort, proxyPort] = [await freePort(), await freePort(), await freePort()];
  const canonicalOrigin = `https://${CANONICAL_HOST}:${proxyPort}`;
  const first = loadConfig({ AGENT_PLANE_HOME: home });
  const secretFile = join(first.dir, "oidc-client-secret");
  writeFileSync(secretFile, `${issuer.clientSecret}\n`, { mode: 0o600 });
  chmodSync(secretFile, 0o600);
  const configPath = join(first.dir, "config.yaml");
  const doc = (parse(readFileSync(configPath, "utf8")) ?? {}) as Record<string, unknown>;
  doc.assistants = { "fake-claude": { provider: "fake" } };
  doc.api = {
    port: localPort,
    remote: {
      port: remotePort, canonicalOrigin,
      transport: { kind: "trusted-proxy", peers: ["127.0.0.1"], tailscaleUserLogin: TAILSCALE_LOGIN },
      identity: { issuer: issuer.issuer, clientId: issuer.clientId, clientSecretFile: secretFile, owner: { issuer: issuer.issuer, subject: issuer.loginAs.sub } },
      grants: opts.grants ?? ALL_REMOTE_GRANTS,
      ...(opts.session ? { session: opts.session } : {}),
      ...(opts.limits ? { limits: opts.limits } : {}),
    },
  };
  writeFileSync(configPath, stringify(doc), "utf8");
  const config = loadConfig({ AGENT_PLANE_HOME: home });
  const db = openDb(config.dbPath);
  const built = buildServer({ config, db, now: () => clock.now });
  built.registry.init();
  await built.app.listen({ host: "127.0.0.1", port: localPort });
  if (opts.listen !== false) await built.app.listenRemote!();

  const certDir = mkdtempSync(join(tmpdir(), "acp-remote-cert-"));
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", join(certDir, "key.pem"), "-out", join(certDir, "cert.pem"),
    "-days", "1", "-subj", `/CN=${CANONICAL_HOST}`, "-addext", `subjectAltName=DNS:${CANONICAL_HOST}`], { stdio: "ignore" });
  const cert = readFileSync(join(certDir, "cert.pem"), "utf8");
  const key = readFileSync(join(certDir, "key.pem"), "utf8");
  rmSync(certDir, { recursive: true, force: true });
  const proxyOptions: ProxyOptions = {};
  const authority = `${CANONICAL_HOST}:${proxyPort}`;
  const proxy = createHttpsServer({ key, cert }, (req, res) => {
    const headers: IncomingHttpHeaders = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (/^(forwarded|x-forwarded-.*|tailscale-.*|connection|keep-alive|host)$/i.test(k)) continue;
      headers[k] = v;
    }
    headers.host = authority;
    headers["x-forwarded-host"] = authority;
    headers["x-forwarded-proto"] = "https";
    headers["x-forwarded-for"] = (req.socket.remoteAddress ?? "").replace(/^::ffff:/, "");
    const login = proxyOptions.login === undefined ? TAILSCALE_LOGIN : proxyOptions.login;
    if (login !== null) headers["tailscale-user-login"] = login;
    Object.assign(headers, proxyOptions.inject ?? {});
    const up = httpRequest({ host: "127.0.0.1", port: remotePort, method: req.method, path: req.url, headers }, (ur) => {
      res.writeHead(ur.statusCode ?? 502, ur.headers);
      ur.pipe(res);
      res.on("close", () => ur.destroy());
    });
    up.on("error", () => { if (!res.headersSent) res.writeHead(502); res.end(); });
    req.pipe(up);
  });
  await new Promise<void>((r) => proxy.listen(proxyPort, "127.0.0.1", () => r()));

  return {
    home, config, db, built, issuer, localPort, remotePort, proxyPort, canonicalOrigin, cert, clock, proxyOptions,
    bearer: () => ({ authorization: `Bearer ${readCredential(credentialPath(config.dir)).secrets.at(-1)!.secret}` }),
    close: async () => {
      proxy.closeAllConnections();
      await new Promise<void>((r) => proxy.close(() => r()));
      await built.app.close();
      db.close();
      await issuer.close();
      if (!opts.home) rmSync(home, { recursive: true, force: true });
    },
  };
}

export interface Answer { status: number; headers: IncomingHttpHeaders; body: string }

/** One request through the TLS proxy (the Tailscale Serve path), like a browser on the tailnet. */
export function viaProxy(rig: RemoteRig, method: string, path: string, headers: Record<string, string> = {}, body?: string): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const req = httpsRequest({ host: "127.0.0.1", port: rig.proxyPort, servername: CANONICAL_HOST, ca: rig.cert, method, path, headers: { host: `${CANONICAL_HOST}:${rig.proxyPort}`, ...headers } }, (res) => {
      let data = ""; res.setEncoding("utf8"); res.on("data", (c: string) => { data += c; }); res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: data }));
    });
    req.on("error", reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

/** One raw request straight to a listener port with exactly these header lines (no proxy). */
export function rawRequest(port: number, method: string, path: string, headerLines: Array<[string, string]>, body?: string): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: "127.0.0.1", port, method, path, setHost: false, headers: headerLines.flat() as unknown as Record<string, string> }, (res) => {
      let data = ""; res.setEncoding("utf8"); res.on("data", (c: string) => { data += c; }); res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: data }));
    });
    req.on("error", reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

export const cookieOf = (setCookie: string | string[] | undefined, name: string): string | undefined => {
  for (const line of Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : []) {
    const first = line.split(";")[0]!;
    if (first.startsWith(`${name}=`) && first.length > name.length + 1) return first;
  }
  return undefined;
};

/** Same-origin browser headers for a read on the remote origin. */
export const sameOrigin = (cookie: string) => ({ cookie, "sec-fetch-site": "same-origin" });

/**
 * The OIDC round trip without a browser: login → fake issuer → callback, as the owner (or whoever
 * `rig.issuer.loginAs` says). Returns the callback answer and, when one was set, the session cookie.
 */
export async function oidcLogin(rig: RemoteRig, extraCookie?: string): Promise<{ start: Answer; callback?: Answer; session?: string; loginCookie?: string; callbackPath?: string }> {
  const start = await viaProxy(rig, "GET", "/api/auth/login", { "sec-fetch-site": "same-origin", ...(extraCookie ? { cookie: extraCookie } : {}) });
  const loginCookie = cookieOf(start.headers["set-cookie"], "__Host-acp_login");
  if (start.status !== 303 || !loginCookie) return { start };
  const authorize = await fetch(start.headers.location!, { redirect: "manual" });
  const back = new URL(authorize.headers.get("location")!);
  const callbackPath = `${back.pathname}${back.search}`;
  const callback = await viaProxy(rig, "GET", callbackPath, { cookie: loginCookie, "sec-fetch-site": "cross-site" });
  return { start, callback, session: cookieOf(callback.headers["set-cookie"], "__Host-acp_remote_session"), loginCookie, callbackPath };
}

export async function ownerSession(rig: RemoteRig): Promise<{ cookie: string; csrf: string }> {
  const { session } = await oidcLogin(rig);
  if (!session) throw new Error("owner login failed");
  const s = await viaProxy(rig, "GET", "/api/auth/session", sameOrigin(session));
  return { cookie: session, csrf: (JSON.parse(s.body) as { csrfToken: string }).csrfToken };
}

/** Headers for an unsafe same-origin command from the owner's browser. */
export const command = (rig: RemoteRig, s: { cookie: string; csrf: string }) => ({
  cookie: s.cookie, origin: rig.canonicalOrigin, "sec-fetch-site": "same-origin", "x-csrf-token": s.csrf, "content-type": "application/json",
});

export type { Server };
