/**
 * Test harness for apps/mcp: a fake OIDC issuer, a real plane (routes, router, DB, FakeAdapter) on
 * loopback, the MCP service in-process, and a scripted owner browser for the OAuth leg.
 * Every secret here is minted by the code under test or is FAKE-*-not-real.
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportJWK, generateKeyPair, SignJWT, type JWK } from "jose";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { rotateNamedCredential, namedCredentialPath } from "../../api/src/auth/credential-file.js";
import { loadConfig as loadPlaneConfig } from "../../api/src/config.js";
import { openDb, type Db } from "../../api/src/db/index.js";
import { buildServer, type BuiltServer } from "../../api/src/server.js";
import { parseConfig, type McpConfig } from "../src/config.js";
import { startService, type RunningService, type ServiceDeps } from "../src/service.js";

export const WEB_ORIGIN = "https://aos.example-tailnet.ts.net";
export const OWNER_SUB = "FAKE-owner-sub-not-real";
export const OIDC_CLIENT_ID = "FAKE-oidc-client-not-real";
export const OIDC_CLIENT_SECRET = "FAKE-oidc-secret-not-real";
export const DEV_BEARER = "FAKE-dev-bearer-not-real";
const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid" };

export function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => { const p = (s.address() as AddressInfo).port; s.close(() => resolve(p)); });
  });
}

/** `n` distinct free ports: every probe stays bound until all are, so two can't come back equal. */
export async function freePorts(n: number): Promise<number[]> {
  const servers = Array.from({ length: n }, () => createServer());
  await Promise.all(servers.map((s) => new Promise<void>((r) => s.listen(0, "127.0.0.1", () => r()))));
  const ports = servers.map((s) => (s.address() as AddressInfo).port);
  await Promise.all(servers.map((s) => new Promise<void>((r) => s.close(() => r()))));
  return ports;
}

export function gitRepo(path: string) {
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, "README.md"), "x\n");
  for (const args of [["init", "-q"], ["add", "."], ["commit", "-q", "-m", "init"]]) execFileSync("git", ["-C", path, ...args], { env: GIT_ENV });
}

// ---- fake OIDC issuer ----

export interface FakeIssuer {
  issuer: string;
  /** Who the next login signs in as. */
  loginAs: { iss?: string; sub: string; email?: string };
  close(): Promise<void>;
}

export async function startFakeIssuer(): Promise<FakeIssuer> {
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const jwk: JWK = { ...(await exportJWK(publicKey)), kid: "fake-1", alg: "RS256", use: "sig" };
  const codes = new Map<string, { nonce: string; challenge: string; redirectUri: string; sub: string; iss?: string; email?: string }>();
  let n = 0;
  const port = await freePort();
  const issuer = `http://127.0.0.1:${port}`;
  const state: FakeIssuer = { issuer, loginAs: { sub: OWNER_SUB }, close: async () => {} };
  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", issuer);
    if (url.pathname === "/.well-known/openid-configuration") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`, jwks_uri: `${issuer}/jwks` }));
    }
    if (url.pathname === "/jwks") { res.writeHead(200, { "content-type": "application/json" }); return res.end(JSON.stringify({ keys: [jwk] })); }
    if (url.pathname === "/authorize") {
      // The "user" signs in instantly as `loginAs` and is sent back with a code.
      const q = url.searchParams;
      if (q.get("client_id") !== OIDC_CLIENT_ID || q.get("scope") !== "openid" || q.get("code_challenge_method") !== "S256") { res.writeHead(400); return res.end("bad authorize"); }
      const code = `FAKE-google-code-${++n}-not-real`;
      codes.set(code, { nonce: q.get("nonce")!, challenge: q.get("code_challenge")!, redirectUri: q.get("redirect_uri")!, ...state.loginAs });
      const back = new URL(q.get("redirect_uri")!);
      back.searchParams.set("code", code);
      back.searchParams.set("state", q.get("state")!);
      res.writeHead(302, { location: back.toString() });
      return res.end();
    }
    if (url.pathname === "/token" && req.method === "POST") {
      let raw = ""; for await (const c of req) raw += c;
      const f = new URLSearchParams(raw);
      const entry = codes.get(f.get("code") ?? "");
      codes.delete(f.get("code") ?? "");
      const verifierOk = entry && createHash("sha256").update(f.get("code_verifier") ?? "").digest("base64url") === entry.challenge;
      if (!entry || !verifierOk || f.get("client_secret") !== OIDC_CLIENT_SECRET || f.get("redirect_uri") !== entry.redirectUri) { res.writeHead(400); return res.end('{"error":"invalid_grant"}'); }
      const idToken = await new SignJWT({ nonce: entry.nonce, ...(entry.email ? { email: entry.email, email_verified: true } : {}) })
        .setProtectedHeader({ alg: "RS256", kid: "fake-1" }).setIssuer(entry.iss ?? issuer).setSubject(entry.sub)
        .setAudience(OIDC_CLIENT_ID).setIssuedAt().setExpirationTime("5m").sign(privateKey);
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ id_token: idToken, access_token: "FAKE-google-access-not-real", token_type: "Bearer" }));
    }
    res.writeHead(404); res.end();
  });
  await new Promise<void>((r) => server.listen(port, "127.0.0.1", () => r()));
  state.close = () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); });
  return state;
}

// ---- plane + service ----

export interface Rig {
  root: string; repo: string; hidden: string;
  plane: BuiltServer; planeDb: Db; planeUrl: string;
  issuer: FakeIssuer; config: McpConfig; service: RunningService;
  logs: Array<Record<string, unknown>>;
  close(): Promise<void>;
}

export async function bootRig(opts: { deps?: ServiceDeps; mcp?: Partial<Record<string, unknown>>; planeWebOrigin?: string | null; credentialCapabilities?: string[] } = {}): Promise<Rig> {
  const root = mkdtempSync(join(tmpdir(), "aos-mcp-"));
  const repo = join(root, "repo");
  const hidden = join(root, "hidden");
  gitRepo(repo); gitRepo(hidden);
  const home = join(root, "plane");
  mkdirSync(join(home, "personal"), { recursive: true });
  const config = loadPlaneConfig({ AGENT_PLANE_HOME: home });
  config.assistants = { "fake-claude": { provider: "fake" } };
  config.repoAllowlist = [repo, hidden];
  config.policy.approvalMode = "auto-approve";
  config.execution.harnessModes.single = true;
  // `hidden` is allowlisted for the plane but not exposed to MCP.
  config.mcp = { repos: { dogfood: repo }, ...(opts.planeWebOrigin === null ? {} : { webOrigin: opts.planeWebOrigin ?? WEB_ORIGIN }) };
  const planeDb = openDb(config.dbPath);
  const plane = buildServer({ config, db: planeDb });
  plane.registry.init();
  await plane.registry.syncAll();
  await plane.app.listen({ host: "127.0.0.1", port: 0 });
  const planeUrl = `http://127.0.0.1:${(plane.app.server.address() as AddressInfo).port}`;
  rotateNamedCredential(config.dir, "mcp", 0, opts.credentialCapabilities);

  const issuer = await startFakeIssuer();
  const secretFile = join(root, "oidc-secret");
  writeFileSync(secretFile, OIDC_CLIENT_SECRET, { mode: 0o600 });
  const [port, devPort] = await freePorts(2) as [number, number];
  const mcpConfig = parseConfig({
    listen: { host: "127.0.0.1", port },
    publicUrl: `http://127.0.0.1:${port}`,
    plane: { url: planeUrl, credentialFile: namedCredentialPath(config.dir, "mcp") },
    repos: { dogfood: repo },
    owner: { issuer: issuer.issuer, subject: OWNER_SUB },
    oidc: { issuer: issuer.issuer, clientId: OIDC_CLIENT_ID, clientSecretFile: secretFile },
    stateDb: join(root, "mcp-oauth.db"),
    devBearer: { port: devPort, tokenEnv: "AOS_MCP_DEV_BEARER" },
    ...opts.mcp,
    // Tests run many logins a minute; the limit tests set their own values.
    rateLimits: { oauthPerMinutePerAddress: 1000, oauthPerMinutePerInstance: 1000, ...(opts.mcp?.rateLimits as Record<string, number> | undefined) },
  });
  const logs: Array<Record<string, unknown>> = [];
  const service = await startService(mcpConfig, { log: (e) => logs.push(e), devBearerToken: DEV_BEARER, ...opts.deps });
  return {
    root, repo, hidden, plane, planeDb, planeUrl, issuer, config: mcpConfig, service, logs,
    async close() {
      await service.close();
      await issuer.close();
      await plane.orchestrator.shutdown();
      await plane.app.close();
      planeDb.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

// ---- OAuth client side (what Claude / Codex do), with a scripted owner browser ----

export const pkce = () => {
  const verifier = `FAKE-verifier-${"x".repeat(40)}-not-real`;
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
};

export const LOOPBACK_REDIRECT = "http://127.0.0.1:53682/callback";

export async function registerClient(base: string, body: Record<string, unknown> = {}) {
  const res = await fetch(`${base}/oauth/register`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: "Test client", redirect_uris: [LOOPBACK_REDIRECT], token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], ...body }),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

export interface BrowserResult { status: number; location?: string; html?: string; code?: string; error?: string; iss?: string; state?: string }

/** Runs authorize → fake Google → callback → (consent) and returns where the browser ended. */
export async function ownerBrowser(rig: Pick<Rig, "config">, params: Record<string, string>, opts: { consent?: "approve" | "deny"; origin?: string } = {}): Promise<BrowserResult> {
  const base = rig.config.publicUrl;
  const authorize = new URL(`${base}/oauth/authorize`);
  authorize.search = new URLSearchParams(params).toString();
  let res = await fetch(authorize, { redirect: "manual" });
  if (res.status !== 302) return { status: res.status, html: await res.text() };
  const loc = res.headers.get("location")!;
  if (loc.startsWith(LOOPBACK_REDIRECT) || loc.startsWith("https://claude.ai/")) return parseBack(res.status, loc);
  const cookie = (res.headers.get("set-cookie") ?? "").split(";")[0]!;
  res = await fetch(loc, { redirect: "manual" }); // fake Google
  const callback = res.headers.get("location")!;
  res = await fetch(callback, { redirect: "manual", headers: { cookie } });
  if (res.status === 302) return parseBack(302, res.headers.get("location")!);
  const html = await res.text();
  if (res.status !== 200 || !opts.consent) return { status: res.status, html };
  const pending = /name="pending" value="([^"]+)"/.exec(html)![1]!;
  const csrf = /name="csrf" value="([^"]+)"/.exec(html)![1]!;
  res = await fetch(`${base}/oauth/consent`, {
    method: "POST", redirect: "manual",
    headers: { cookie, "content-type": "application/x-www-form-urlencoded", origin: opts.origin ?? new URL(base).origin },
    body: new URLSearchParams({ pending, csrf, decision: opts.consent }).toString(),
  });
  if (res.status !== 303 && res.status !== 302) return { status: res.status, html: await res.text() };
  return parseBack(res.status, res.headers.get("location")!);
}

function parseBack(status: number, location: string): BrowserResult {
  const u = new URL(location);
  return {
    status, location,
    ...(u.searchParams.get("code") ? { code: u.searchParams.get("code")! } : {}),
    ...(u.searchParams.get("error") ? { error: u.searchParams.get("error")! } : {}),
    ...(u.searchParams.get("iss") ? { iss: u.searchParams.get("iss")! } : {}),
    ...(u.searchParams.get("state") ? { state: u.searchParams.get("state")! } : {}),
  };
}

export async function tokenRequest(base: string, form: Record<string, string>, headers: Record<string, string> = {}) {
  const res = await fetch(`${base}/oauth/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", ...headers }, body: new URLSearchParams(form).toString() });
  return { status: res.status, body: (await res.json()) as Record<string, string> };
}

/** The whole owner flow: register, authorize + consent, exchange. Returns the tokens. */
export async function ownerTokens(rig: Pick<Rig, "config">, scope = "aos.tasks.read aos.tasks.create aos.tasks.start") {
  const base = rig.config.publicUrl;
  const client = await registerClient(base);
  const clientId = client.body.client_id as string;
  const { verifier, challenge } = pkce();
  const resource = `${base}/mcp`;
  const back = await ownerBrowser(rig, {
    response_type: "code", client_id: clientId, redirect_uri: LOOPBACK_REDIRECT, code_challenge: challenge,
    code_challenge_method: "S256", state: "FAKE-state-not-real", scope, resource,
  }, { consent: "approve" });
  if (!back.code) throw new Error(`no code: ${JSON.stringify(back)}`);
  const t = await tokenRequest(base, { grant_type: "authorization_code", code: back.code, redirect_uri: LOOPBACK_REDIRECT, client_id: clientId, code_verifier: verifier, resource });
  if (t.status !== 200) throw new Error(`token ${t.status} ${JSON.stringify(t.body)}`);
  return { clientId, access: t.body.access_token!, refresh: t.body.refresh_token!, verifier, resource };
}

export async function mcpClient(url: string, bearer: string) {
  const client = new Client({ name: "aos-mcp-test", version: "0.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { authorization: `Bearer ${bearer}` } } });
  await client.connect(transport);
  return { client, transport, close: () => client.close() };
}
