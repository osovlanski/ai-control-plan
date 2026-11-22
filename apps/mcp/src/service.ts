import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema, isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { resourceUrl, type McpConfig } from "./config.js";
import { loadContract, SCOPES, type Contract, type Scope } from "./contract.js";
import { BodyTooLarge, readBody, sendJson } from "./http-util.js";
import { AuthServer } from "./oauth/server.js";
import { OidcClient } from "./oauth/oidc.js";
import { OAuthStore, safeEqual } from "./oauth/store.js";
import { PlaneClient, apiVersionAtLeast } from "./plane.js";
import { RateLimiter } from "./ratelimit.js";
import { readPlaneSecret, readPrivateFile } from "./secrets.js";
import { Tools } from "./tools.js";

/**
 * apps/mcp (C2, docs/adr/mcp-connector.md): one loopback HTTP listener serving Streamable HTTP
 * `/mcp` as an OAuth-protected resource, the co-hosted authorization server, and the metadata
 * documents. An optional second loopback listener accepts a static dev bearer for local clients.
 */
export interface ServiceDeps {
  now?: () => number;
  /** Injectable CIMD fetcher (tests). */
  fetchClientMetadata?: (url: string) => Promise<unknown>;
  log?: (event: Record<string, unknown>) => void;
  /** Overrides the environment lookup of the dev bearer (tests). */
  devBearerToken?: string;
}

export interface RunningService {
  url: string;
  devUrl?: string;
  store: OAuthStore;
  close(): Promise<void>;
}

const SESSION_IDLE_MS = 30 * 60_000;
const MAX_SESSIONS = 64;
const MCP_CREDENTIAL_CAPABILITIES = new Set(["tasks.read", "tasks.create", "tasks.start"]);

/** Every log line goes through here: path only (no query), no headers, no bodies (T1). */
export const stderrLog = (event: Record<string, unknown>) => process.stderr.write(`${JSON.stringify({ t: new Date().toISOString(), ...event })}\n`);

interface Session { transport: StreamableHTTPServerTransport; grantId: string; lastSeen: number }

export async function checkPlane(config: McpConfig, plane: PlaneClient): Promise<{ webOrigin: string }> {
  const meta = await plane.meta();
  if (meta.status !== 200) throw new Error(`plane refused the MCP credential on /api/meta (${meta.status})`);
  if (!apiVersionAtLeast(meta.body.apiVersion)) throw new Error(`plane API ${String(meta.body.apiVersion)} is older than 2.14`);
  const ws = await plane.workspace();
  if (ws.status !== 200) throw new Error(`plane refused GET /api/workspace (${ws.status})`);
  const allowlist = (ws.body.repoAllowlist ?? []) as string[];
  const mcp = (ws.body.mcp ?? {}) as { repos?: string[]; webOrigin?: string | null };
  // Every result carries the Web link, so a plane without a Web origin is a configuration error.
  if (typeof mcp.webOrigin !== "string" || !mcp.webOrigin.startsWith("https://")) throw new Error("plane config has no mcp.webOrigin; every tool result needs the Web link");
  for (const [alias, path] of Object.entries(config.repos)) {
    // Exact, never by prefix (T4).
    if (!allowlist.includes(path)) throw new Error(`repos.${alias} is not exactly an entry of the plane's repoAllowlist`);
    if (!(mcp.repos ?? []).includes(alias)) throw new Error(`repos.${alias} is not an alias in the plane's mcp.repos`);
  }
  return { webOrigin: mcp.webOrigin.replace(/\/$/, "") };
}

function jsonRpcToolNames(body: unknown): string[] {
  const msgs = Array.isArray(body) ? body : [body];
  return msgs.flatMap((m) => {
    const msg = m as { method?: unknown; params?: { name?: unknown } };
    return msg && msg.method === "tools/call" ? [typeof msg.params?.name === "string" ? msg.params.name : ""] : [];
  });
}

export async function startService(config: McpConfig, deps: ServiceDeps = {}): Promise<RunningService> {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? stderrLog;
  const contract: Contract = loadContract();
  const credential = () => readPlaneSecret(config.plane.credentialFile, new Date(now()));
  const initial = credential();
  const extra = initial.capabilities.filter((c) => !MCP_CREDENTIAL_CAPABILITIES.has(c));
  // D-C: refuse to run with anything wider than tasks.read, tasks.create, tasks.start.
  if (extra.length > 0) throw new Error(`plane credential holds more than the MCP set (${extra.join(", ")}); mint one with \`rotate --name mcp\``);
  const plane = new PlaneClient(config.plane.url, () => credential().secret);
  const { webOrigin } = await checkPlane(config, plane);

  const limiter = new RateLimiter(now);
  const tools = new Tools({ config, contract, plane, limiter, webOrigin });
  const store = new OAuthStore(config.stateDb, now);
  const resource = resourceUrl(config);
  const oidcSecret = () => readPrivateFile(config.oidc.clientSecretFile).trim();
  oidcSecret(); // fail at boot, not at first login
  const auth = new AuthServer({
    publicUrl: config.publicUrl, resource, owner: config.owner, store, limiter, log,
    oidc: new OidcClient({ issuer: config.oidc.issuer, clientId: config.oidc.clientId, clientSecret: oidcSecret, redirectUri: `${config.publicUrl}/oauth/callback` }),
    limits: { perAddress: config.rateLimits.oauthPerMinutePerAddress, perInstance: config.rateLimits.oauthPerMinutePerInstance },
    clientAddress: (req) => {
      const cf = req.headers["cf-connecting-ip"];
      return config.trustCloudflareClientIp && typeof cf === "string" ? cf : req.socket.remoteAddress ?? "unknown";
    },
    ...(deps.fetchClientMetadata ? { fetchClientMetadata: deps.fetchClientMetadata } : {}),
  });

  const sessions = new Map<string, Session>();
  const sweep = setInterval(() => {
    for (const [id, s] of sessions) if (now() - s.lastSeen > SESSION_IDLE_MS) { sessions.delete(id); void s.transport.close(); }
  }, 60_000);
  sweep.unref();

  const newMcpServer = (grantId: string) => {
    const server = new Server({ name: "agent-os", version: "0.1.0" }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, () => ({
      tools: contract.tools.map((t) => ({ name: t.name, title: t.title, description: t.description, annotations: t.annotations, inputSchema: t.inputSchema, outputSchema: t.outputSchema })),
    }) as never);
    server.setRequestHandler(CallToolRequestSchema, async (req) => tools.call(req.params.name, req.params.arguments, { grantId }) as never);
    return server;
  };

  const challenge = (error?: string) =>
    `Bearer resource_metadata="${config.publicUrl}/.well-known/oauth-protected-resource/mcp", scope="${SCOPES.join(" ")}"${error ? `, error="${error}"` : ""}`;

  /** Streamable HTTP `/mcp` for an authenticated grant (OAuth or dev bearer). */
  const serveMcp = async (req: IncomingMessage, res: ServerResponse, grant: { id: string; scopes: Scope[] }) => {
    let body: unknown;
    if (req.method === "POST") {
      try { body = JSON.parse(await readBody(req)); } catch (e) {
        return sendJson(res, e instanceof BodyTooLarge ? 413 : 400, { jsonrpc: "2.0", error: { code: -32700, message: "Parse error" }, id: null });
      }
      const missing = jsonRpcToolNames(body).map((n) => contract.scopeOf[n as keyof Contract["scopeOf"]]).filter((s) => s && !grant.scopes.includes(s));
      if (missing.length > 0) {
        res.setHeader("www-authenticate", `Bearer error="insufficient_scope", scope="${[...new Set(missing)].join(" ")}", resource_metadata="${config.publicUrl}/.well-known/oauth-protected-resource/mcp"`);
        return sendJson(res, 403, { error: "insufficient_scope" });
      }
    }
    const sid = req.headers["mcp-session-id"];
    if (typeof sid === "string") {
      const s = sessions.get(sid);
      // A session id alone authorizes nothing: it must belong to the presenting grant.
      if (!s || s.grantId !== grant.id) return sendJson(res, 404, { jsonrpc: "2.0", error: { code: -32001, message: "Session not found" }, id: null });
      s.lastSeen = now();
      await s.transport.handleRequest(req, res, body);
      if (req.method === "DELETE") sessions.delete(sid);
      return;
    }
    if (req.method !== "POST" || !isInitializeRequest(body)) {
      return sendJson(res, 400, { jsonrpc: "2.0", error: { code: -32000, message: "Bad Request: no session; send initialize first" }, id: null });
    }
    if (sessions.size >= MAX_SESSIONS) {
      const oldest = [...sessions.entries()].sort((a, b) => a[1].lastSeen - b[1].lastSeen)[0];
      if (oldest) { sessions.delete(oldest[0]); void oldest[1].transport.close(); }
    }
    const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomBytes(24).toString("base64url"),
      onsessioninitialized: (id) => { sessions.set(id, { transport, grantId: grant.id, lastSeen: now() }); },
    });
    transport.onclose = () => { if (transport.sessionId) sessions.delete(transport.sessionId); };
    await newMcpServer(grant.id).connect(transport);
    await transport.handleRequest(req, res, body);
  };

  const publicHost = new URL(config.publicUrl).host;

  const handler = (mode: "public" | "dev", devHost?: () => string) => async (req: IncomingMessage, res: ServerResponse) => {
    const started = now();
    const url = new URL(req.url ?? "/", "http://placeholder");
    res.on("finish", () => log({ event: "http", listener: mode, method: req.method, path: url.pathname, status: res.statusCode, ms: now() - started }));
    try {
      // DNS rebinding: the Host must be the canonical one (T8).
      const expectedHost = mode === "public" ? publicHost : devHost!();
      if (req.headers.host !== expectedHost && !(mode === "dev" && req.headers.host === expectedHost.replace("127.0.0.1", "localhost"))) {
        return sendJson(res, 421, { error: "misdirected_request" });
      }
      if (mode === "public" && (await auth.handle(req, res, url))) return;
      if (url.pathname !== "/mcp") return sendJson(res, 404, { error: "not_found" });
      // No browser calls /mcp, so any present Origin is refused (allowlist empty).
      if (req.headers.origin !== undefined) return sendJson(res, 403, { error: "origin_not_allowed" });
      const bearer = /^Bearer\s+([A-Za-z0-9._~+/=-]+)$/.exec(req.headers.authorization ?? "")?.[1];
      if (mode === "dev") {
        const expected = deps.devBearerToken ?? process.env[config.devBearer!.tokenEnv] ?? "";
        if (!bearer || !expected || !safeEqual(bearer, expected)) return sendJson(res, 401, { error: "invalid_token" }, { "www-authenticate": 'Bearer realm="aos-mcp-dev"' });
        return await serveMcp(req, res, { id: "dev-bearer", scopes: [...SCOPES] });
      }
      if (!bearer) return sendJson(res, 401, { error: "unauthorized" }, { "www-authenticate": challenge() });
      const g = store.verifyAccess(bearer);
      // Audience: only tokens issued for this resource (RFC 8707).
      if (!g || g.resource !== resource) return sendJson(res, 401, { error: "invalid_token" }, { "www-authenticate": challenge("invalid_token") });
      return await serveMcp(req, res, { id: g.id, scopes: g.scopes.split(" ") as Scope[] });
    } catch (err) {
      log({ event: "error", path: url.pathname, message: err instanceof Error ? err.name : "unknown" });
      if (!res.headersSent) sendJson(res, 500, { error: "internal" });
      else res.end();
    }
  };

  const listen = (server: HttpServer, port: number) => new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve((server.address() as AddressInfo).port));
  });

  const main = createServer(handler("public"));
  const mainPort = await listen(main, config.listen.port);
  let dev: HttpServer | undefined;
  let devPort: number | undefined;
  if (config.devBearer) {
    dev = createServer(handler("dev", () => `127.0.0.1:${devPort}`));
    devPort = await listen(dev, config.devBearer.port);
  }
  log({ event: "listening", port: mainPort, ...(devPort ? { devPort } : {}) });

  return {
    url: `http://127.0.0.1:${mainPort}`,
    ...(devPort ? { devUrl: `http://127.0.0.1:${devPort}` } : {}),
    store,
    async close() {
      clearInterval(sweep);
      for (const s of sessions.values()) await s.transport.close();
      sessions.clear();
      main.closeAllConnections();
      dev?.closeAllConnections();
      await new Promise<void>((r) => main.close(() => r()));
      if (dev) await new Promise<void>((r) => dev!.close(() => r()));
      store.close();
    },
  };
}
