import { realpathSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { CONTROL_PLANE_API_VERSION, capabilityGranted, registerSecret } from "@agent-plane/core";
import { OidcClient, ownerPinMatches } from "@agent-plane/oidc";
import type { Db } from "../../db/index.js";
import { REMOTE_CALLBACK_PATH, readPrivateFile, type RemoteAuthConfig } from "./config.js";
import { checkProxyContract } from "./proxy.js";
import { isApiRequest } from "../request-target.js";
import { principalOf, RemoteSessionStore, sha256, type RemoteSessionRow } from "./store.js";

/**
 * B2: authenticated remote mode for the one-origin private Web link (docs/adr/remote-auth-design.md
 * stage 2 + "B2 amendments"). One process, two loopback listeners (D-B): the local listener keeps
 * bootstrap, the bearer CLI and local cookies exactly as before; this module owns the second,
 * remote-only listener (the Tailscale Serve target), which accepts only remote sessions minted by
 * an OIDC login that matched the exact (iss, sub) owner pin (D-A). Nothing on the remote listener
 * accepts a local bearer, a local cookie or a bootstrap token, and nothing on the local listener
 * mints or accepts a remote session.
 */

export const REMOTE_SESSION_COOKIE = "__Host-acp_remote_session";
export const REMOTE_LOGIN_COOKIE = "__Host-acp_login";
const LOCAL_SESSION_COOKIE = "__Host-acp_session";
/** Route rule for the session routes themselves: any authenticated caller, no capability. */
export const REMOTE_SESSION_RULE = "auth.session";
const LOGIN_TTL_MS = 5 * 60_000;
const MINUTE = 60_000;

const remoteRequests = new WeakSet<IncomingMessage>();
const clientAddresses = new WeakMap<IncomingMessage, string>();
/** True only for a request that arrived on the remote listener. Set before Fastify routes it. */
export const isRemoteRequest = (raw: IncomingMessage) => remoteRequests.has(raw);

declare module "fastify" {
  interface FastifyInstance { listenRemote?: () => Promise<{ port: number }> }
  interface FastifyRequest { remoteSession?: RemoteSessionRow }
}

/** Boot-selected workspace directory identity. Never the YAML label. */
export const workspaceIdOf = (dir: string) => sha256(realpathSync(dir)).slice(0, 32);

function cookieValues(req: FastifyRequest, name: string): string[] {
  const header = req.headers.cookie;
  if (!header) return [];
  return header.split(";").map((x) => x.trim()).filter((x) => x.startsWith(`${name}=`)).map((x) => x.slice(name.length + 1));
}

class Windows {
  private readonly hits = new Map<string, { start: number; count: number }>();
  constructor(private readonly now: () => Date) {}
  /** Fixed one-minute windows. Counts rejected attempts too. */
  hit(key: string, limit: number): { ok: true } | { ok: false; retryAfter: number } {
    const now = this.now().getTime(); const start = now - (now % MINUTE);
    const cur = this.hits.get(key);
    const entry = cur && cur.start === start ? cur : { start, count: 0 };
    entry.count += 1; this.hits.set(key, entry);
    if (this.hits.size > 10_000) for (const [k, v] of this.hits) if (v.start < start) this.hits.delete(k);
    return entry.count > limit ? { ok: false, retryAfter: Math.max(1, Math.ceil((start + MINUTE - now) / 1000)) } : { ok: true };
  }
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export interface RemoteAuth {
  /** The whole remote onRequest decision. Returns the reply when it answered, undefined to continue. */
  onRequest(req: FastifyRequest, reply: FastifyReply): Promise<FastifyReply | undefined>;
  /** `GET /api/auth/session` on the remote listener (the route itself is shared, see auth/index.ts). */
  describe(req: FastifyRequest, reply: FastifyReply): FastifyReply;
}

export function registerRemoteAuth(app: FastifyInstance, deps: { config: { dir: string; api: { remote?: RemoteAuthConfig } }; db: Db; now: () => Date }): RemoteAuth | undefined {
  const cfg = deps.config.api.remote;
  if (!cfg) return undefined;
  const { db, now } = deps;
  const workspaceId = workspaceIdOf(deps.config.dir);
  const owner = cfg.identity.owner;
  const principal = principalOf(owner.issuer, owner.subject);
  const kid = `r_${principal.slice(0, 12)}`;
  const store = new RemoteSessionStore(db, { workspaceId, principal, idleMs: cfg.session.idleTtlSeconds * 1000, absoluteMs: cfg.session.absoluteTtlSeconds * 1000, now });
  const revokedAtBoot = store.revokeOnBoot();
  const clientSecret = () => { const v = readPrivateFile(cfg.identity.clientSecretFile).trim(); registerSecret(v); return v; };
  const oidc = new OidcClient({ issuer: cfg.identity.issuer, clientId: cfg.identity.clientId, clientSecret, redirectUri: `${cfg.canonicalOrigin}${REMOTE_CALLBACK_PATH}`, now });
  const windows = new Windows(now);
  /** CSRF tokens in protected memory for delivery by GET /api/auth/session; the DB holds only their hash. */
  const csrfTokens = new Map<string, string>();
  const streams = new Map<string, Set<ServerResponse>>();
  let streamTotal = 0;
  const audit = (action: string, outcome: string, extra: Record<string, unknown> = {}) =>
    app.log.info({ event: "remote_auth", action, outcome, principal: principal.slice(0, 12), ...extra }, "remote auth");
  app.log.info({ event: "remote_auth", action: "boot", revokedAtBoot }, "remote auth: previous remote sessions revoked");

  const closeStreams = (sessionId?: string) => {
    for (const [id, set] of streams) {
      if (sessionId && id !== sessionId) continue;
      for (const res of set) res.end();
    }
  };
  // Streams close at the earlier idle/absolute deadline and immediately on revocation (below).
  const sweep = setInterval(() => { for (const id of streams.keys()) if (!store.byId(id).ok) closeStreams(id); }, 1000);
  sweep.unref();
  let server: Server | undefined;
  app.addHook("onClose", async () => {
    clearInterval(sweep);
    if (server) { const s = server; server = undefined; s.closeAllConnections(); await new Promise<void>((r) => s.close(() => r())); }
  });

  app.decorate("listenRemote", async () => {
    // Readiness before listen (ADR "Explicit configuration contract"): the pinned issuer answers and its key set is reachable.
    await oidc.ready();
    const s = createServer((req, res) => { remoteRequests.add(req); app.routing(req, res); });
    await new Promise<void>((resolve, reject) => { s.once("error", reject); s.listen(cfg.port, "127.0.0.1", () => { s.off("error", reject); resolve(); }); });
    server = s;
    const port = (s.address() as { port: number }).port;
    app.log.info({ event: "remote_auth", action: "listen", port }, "remote listener ready (loopback; Tailscale Serve target)");
    return { port };
  });

  // Hardening headers on every remote answer. SSE writes its own head and is unaffected.
  app.addHook("onSend", async (req, reply) => {
    if (!isRemoteRequest(req.raw)) return;
    reply.header("x-frame-options", "DENY").header("referrer-policy", "no-referrer").header("x-content-type-options", "nosniff");
    if (isApiRequest(req) && !reply.hasHeader("cache-control")) reply.header("cache-control", "no-store");
  });

  const unauthenticated = (reply: FastifyReply) => reply.code(401).header("X-Control-Plane-Api-Version", CONTROL_PLANE_API_VERSION)
    .send({ error: "unauthenticated", mode: "remote", login: "/api/auth/login" });
  const tooMany = (reply: FastifyReply, retryAfter: number) => reply.code(429).header("retry-after", String(retryAfter)).send({ error: "rate limited" });
  const page = (reply: FastifyReply, status: number, title: string, body: string) => reply.code(status)
    .header("content-type", "text/html; charset=utf-8").header("cache-control", "no-store").header("referrer-policy", "no-referrer")
    .header("content-security-policy", "default-src 'none'; style-src 'unsafe-inline'")
    .header("set-cookie", `${REMOTE_LOGIN_COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`)
    .send(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escapeHtml(title)}</title><body style="font-family:system-ui;max-width:32rem;margin:3rem auto;padding:0 1rem"><h1>${escapeHtml(title)}</h1>${body}<p><a href="/">Back to Agentic OS</a></p></body>`);

  /** Persistent login budget (survives restart). Store failure fails closed. */
  const loginBudget = (req: FastifyRequest, reply: FastifyReply): FastifyReply | undefined => {
    try {
      const addr = clientAddresses.get(req.raw) ?? "unknown";
      const a = store.countAttempt(`login:addr:${sha256(addr)}`, MINUTE);
      const i = store.countAttempt("login:instance", MINUTE);
      if (a.count > cfg.limits.loginPerMinutePerAddress || i.count > cfg.limits.loginPerMinuteInstance) {
        audit("login", "rate_limited");
        return tooMany(reply, Math.max(a.retryAfterSeconds, i.retryAfterSeconds));
      }
      return undefined;
    } catch {
      audit("login", "limiter_unavailable");
      return reply.code(503).send({ error: "sign-in unavailable" });
    }
  };

  // ---- public login routes (remote listener only) ----

  app.get("/api/auth/login", { config: { auth: null, listener: "remote" }, logLevel: "silent" }, async (req, reply) => {
    const limited = loginBudget(req, reply); if (limited) return limited;
    store.pruneLogins();
    if (store.pendingLogins() >= cfg.limits.pendingLogins) { audit("login", "pending_cap"); return tooMany(reply, 60); }
    // Re-login rotates: a same-origin click still carries the Strict session cookie, whose session the callback revokes.
    const held = cookieValues(req, REMOTE_SESSION_COOKIE);
    const current = held.length === 1 ? store.byHandle(held[0]!) : undefined;
    const t = store.beginLogin(LOGIN_TTL_MS, current?.ok ? current.row.id : null);
    for (const v of [t.state, t.browserSecret, t.nonce, t.verifier]) registerSecret(v);
    let location: string;
    try { location = await oidc.authorizationUrl({ state: t.state, nonce: t.nonce, codeVerifier: t.verifier }); }
    catch { store.consumeLogin(t.state, t.browserSecret); audit("login", "idp_unavailable"); return page(reply, 503, "Sign-in unavailable", "<p>The identity provider could not be reached. Nothing else signs you in; try again later.</p>"); }
    audit("login", "started");
    return reply.code(303).header("location", location).header("cache-control", "no-store").header("referrer-policy", "no-referrer")
      .header("set-cookie", `${REMOTE_LOGIN_COOKIE}=${t.state}.${t.browserSecret}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${LOGIN_TTL_MS / 1000}`).send();
  });

  app.get<{ Querystring: Record<string, unknown> }>(REMOTE_CALLBACK_PATH, { config: { auth: null, listener: "remote" }, logLevel: "silent" }, async (req, reply) => {
    const limited = loginBudget(req, reply); if (limited) return limited;
    const q = req.query ?? {};
    const str = (k: string) => (typeof q[k] === "string" ? q[k] : undefined);
    const state = str("state"); const code = str("code");
    if (code) registerSecret(code);
    const cookies = cookieValues(req, REMOTE_LOGIN_COOKIE);
    const [cookieState, browserSecret] = cookies.length === 1 ? cookies[0]!.split(".") : [];
    if (!state || !cookieState || !browserSecret || cookieState !== state) { audit("callback", "no_transaction"); return page(reply, 400, "Sign-in expired", "<p>This sign-in is not valid in this browser. Start again.</p>"); }
    const tx = store.consumeLogin(state, browserSecret);
    if (!tx) { audit("callback", "transaction_invalid"); return page(reply, 400, "Sign-in expired", "<p>This sign-in is not valid in this browser. Start again.</p>"); }
    if (q.error !== undefined || !code) { audit("callback", "idp_denied"); return page(reply, 403, "Sign-in cancelled", "<p>Nothing was granted.</p>"); }
    let claims: { iss?: unknown; sub?: unknown };
    try { claims = await oidc.verifyCallback({ code, codeVerifier: tx.code_verifier, nonce: tx.nonce }); }
    catch { audit("callback", "token_invalid"); return page(reply, 403, "Sign-in failed", "<p>The identity provider's answer could not be verified. Nothing was granted.</p>"); }
    // D-A: exact (iss, sub). Email, domain or name never authorize.
    if (!ownerPinMatches(claims, owner)) { audit("callback", "not_owner"); return page(reply, 403, "Not allowed", "<p>This account is not the owner of this Agentic OS. Nothing was granted.</p>"); }
    if (tx.replaces_session_id && store.revoke(tx.replaces_session_id, "relogin")) { csrfTokens.delete(tx.replaces_session_id); closeStreams(tx.replaces_session_id); }
    const s = store.mint();
    registerSecret(s.handle); registerSecret(s.csrf);
    csrfTokens.set(s.id, s.csrf);
    audit("callback", "owner", { session: s.id });
    return reply.code(303).header("location", `${cfg.canonicalOrigin}/`).header("cache-control", "no-store").header("referrer-policy", "no-referrer")
      .header("set-cookie", [
        `${REMOTE_SESSION_COOKIE}=${s.handle}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${cfg.session.absoluteTtlSeconds}`,
        `${REMOTE_LOGIN_COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`,
      ]).send();
  });

  // ---- session routes (remote listener, any live remote session) ----

  const sessionRule = { config: { auth: { require: REMOTE_SESSION_RULE }, listener: "remote" as const } };
  const describe = (row: RemoteSessionRow, idleExpiresAt: number) => ({
    mode: "remote", principal: row.principal.slice(0, 12), grants: cfg.grants, csrfToken: csrfTokens.get(row.id) ?? null,
    expiresAt: new Date(row.absolute_expires_at).toISOString(), idleExpiresAt: new Date(idleExpiresAt).toISOString(), idleTtlSeconds: cfg.session.idleTtlSeconds,
  });
  const describeSession = (req: FastifyRequest, reply: FastifyReply) => {
    const c = store.byId(req.remoteSession!.id);
    if (!c.ok) return unauthenticated(reply);
    return reply.header("cache-control", "no-store").send(describe(c.row, c.idleExpiresAt));
  };
  // An explicit operator interaction: the onRequest gate already checked Origin + CSRF and moved idle time.
  app.post("/api/auth/activity", sessionRule, async (req, reply) => {
    const c = store.byId(req.remoteSession!.id);
    if (!c.ok) return unauthenticated(reply);
    return reply.send({ idleExpiresAt: new Date(c.idleExpiresAt).toISOString() });
  });
  app.post("/api/auth/logout", sessionRule, async (req, reply) => {
    const id = req.remoteSession!.id;
    store.revoke(id, "logout"); csrfTokens.delete(id); closeStreams(id);
    audit("logout", "ok", { session: id });
    return reply.code(204).header("set-cookie", `${REMOTE_SESSION_COOKIE}=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0`).send();
  });

  // ---- operator recovery (local listener only, local credential with commands.write) ----

  app.post("/api/auth/remote/revoke-all", { config: { auth: { require: "commands.write" }, listener: "local" as const } }, async (_req, reply) => {
    const revoked = store.revokeAll(); csrfTokens.clear(); closeStreams();
    audit("revoke_all", "ok", { revoked });
    return reply.send({ revoked });
  });

  // ---- the gate ----

  const onRequest = async (req: FastifyRequest, reply: FastifyReply): Promise<FastifyReply | undefined> => {
    const contract = checkProxyContract(req.raw, cfg);
    if (!contract.ok) {
      app.log.warn({ event: "remote_auth", action: "proxy", outcome: "rejected", reason: contract.reason }, "remote request outside the proxy contract");
      return reply.code(403).header("cache-control", "no-store").send({ error: "forbidden" });
    }
    clientAddresses.set(req.raw, contract.clientAddress);
    // C1: the matched route decides (find-my-way decodes `/%61pi/…` to `/api/…`); unmatched targets
    // that could read as /api/ are gated too, before the 404.
    if (!isApiRequest(req)) return undefined; // the SPA shell and its assets carry no data
    const path = req.routeOptions.url ?? req.url.split("?")[0]!;
    const routeCfg = req.routeOptions.config as { auth?: null | { require: string }; listener?: "local" | "remote" } | undefined;
    if (routeCfg?.listener === "local" || (routeCfg?.auth === null && routeCfg.listener !== "remote")) return reply.code(404).send({ error: "not found" });
    if (routeCfg?.auth === null) return undefined; // login + callback: their own transaction checks and budget

    // Origin before anything else: a hostile Origin is never overridden by Fetch Metadata.
    const origin = req.headers.origin;
    const unsafe = !SAFE_METHODS.has(req.method);
    if (origin !== undefined ? origin !== cfg.canonicalOrigin : (unsafe || req.headers["sec-fetch-site"] !== "same-origin")) {
      return reply.code(403).send({ error: "cross-origin" });
    }
    // Only the remote session cookie authenticates here: never a bearer, never a local cookie.
    if (req.headers.authorization !== undefined || cookieValues(req, LOCAL_SESSION_COOKIE).length) return unauthenticated(reply);
    const handles = cookieValues(req, REMOTE_SESSION_COOKIE);
    if (handles.length !== 1) return unauthenticated(reply);
    const check = store.byHandle(handles[0]!);
    if (!check.ok) return unauthenticated(reply);
    const row = check.row;
    const rule = routeCfg?.auth;
    if (rule === undefined) return undefined; // unknown /api path: the 404 handler answers an authenticated caller
    if (rule.require !== REMOTE_SESSION_RULE && !capabilityGranted(cfg.grants, rule.require)) return reply.code(403).send({ error: `${rule.require} required` });
    if (unsafe) {
      const token = req.headers["x-csrf-token"];
      if (typeof token !== "string" || !store.csrfMatches(row, token)) return reply.code(403).send({ error: "csrf" });
      if (rule.require !== REMOTE_SESSION_RULE) for (const [key, limit] of [[`cmd:p:${row.principal}`, cfg.limits.commandsPerMinutePerPrincipal], ["cmd:instance", cfg.limits.commandsPerMinuteInstance]] as const) {
        const r = windows.hit(key, limit); if (!r.ok) return tooMany(reply, r.retryAfter);
      }
      if (rule.require === "tasks.start" || /\/(start|run-now|parallel)$/.test(path)) {
        const r = windows.hit(`start:p:${row.principal}`, cfg.limits.startsPerMinute); if (!r.ok) return tooMany(reply, r.retryAfter);
      }
      store.touch(row.id);
    } else {
      const r = windows.hit(`read:s:${row.id}`, cfg.limits.readsPerMinutePerSession); if (!r.ok) return tooMany(reply, r.retryAfter);
    }
    if (rule.require === "events.stream") {
      const r = windows.hit(`stream:s:${row.id}`, cfg.limits.streamOpensPerMinutePerSession); if (!r.ok) return tooMany(reply, r.retryAfter);
      const set = streams.get(row.id) ?? new Set<ServerResponse>();
      if (set.size >= cfg.limits.activeStreamsPerSession || streamTotal >= cfg.limits.activeStreamsInstance) return tooMany(reply, 5);
      set.add(reply.raw); streams.set(row.id, set); streamTotal += 1;
      reply.raw.once("close", () => { set.delete(reply.raw); streamTotal -= 1; if (!set.size) streams.delete(row.id); });
    }
    req.remoteSession = row;
    req.cred = { kind: "remote", capabilities: [...cfg.grants], kid };
    return undefined;
  };
  return { onRequest, describe: describeSession };
}
