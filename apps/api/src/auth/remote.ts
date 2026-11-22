import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, Server } from "node:http";
import { isIP } from "node:net";
import { lstatSync, readFileSync } from "node:fs";
import type { FastifyBaseLogger, FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { capabilityGranted, registerSecret } from "@agent-plane/core";
import { OidcClient, isPinnedOwner } from "@agent-plane/core/oidc";
import type { RemoteAuthConfig } from "../config.js";
import type { Db } from "../db/index.js";
import type { AuthenticatedCredential } from "./index.js";

/**
 * B2 remote mode (docs/adr/remote-auth-design.md, amendments D-A/D-B).
 *
 * One process, two loopback listeners. The local listener keeps bootstrap, bearer and local cookies
 * exactly as they were. The remote listener (the Tailscale Serve target, see `remote-listener.ts`)
 * accepts only what this class admits:
 *
 * 1. Transport: the socket peer is a configured loopback proxy address, and the request carries
 *    exactly one of each header Tailscale Serve sets (Host and X-Forwarded-Host equal to the
 *    canonical host, X-Forwarded-Proto https, one X-Forwarded-For IP) plus the configured
 *    Tailscale-User-Login. No `Forwarded`. This runs on every remote request, static files too.
 * 2. Identity: a `__Host-acp_remote_session` cookie minted only by the Google OIDC callback after
 *    the exact (iss, sub) pin. Bearer credentials, the local cookie and bootstrap are refused here.
 * 3. Origin: an Origin must equal the canonical origin; a write must carry it and a session-bound
 *    X-CSRF-Token; a read without Origin must say `Sec-Fetch-Site: same-origin`. API routes are not
 *    navigable except login and callback.
 * 4. Grants: the configured owner grants, checked by the route's existing `config.auth.require`.
 *
 * Sessions live in the workspace DB (migration 055) as hashes only. Boot revokes every open session.
 */

export const REMOTE_SESSION_COOKIE = "__Host-acp_remote_session";
export const REMOTE_LOGIN_COOKIE = "__Host-acp_login";
const LOCAL_SESSION_COOKIE = "__Host-acp_session";
const LOGIN_TTL_MS = 5 * 60_000;

/** Paths the remote listener never serves, whatever the session holds. */
const REMOTE_REFUSED = new Set(["/api/auth/bootstrap", "/api/auth/remote-sessions/revoke"]);
/** The only API routes a browser may navigate to, and the only ones without a session. */
export const REMOTE_PUBLIC_ROUTES = new Set(["/api/auth/login", "/api/auth/callback"]);
/** Session-only routes (no capability beyond a live session; writes still need Origin + CSRF). */
export const REMOTE_SESSION_ROUTES = new Set(["/api/auth/session", "/api/auth/logout", "/api/auth/activity"]);

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const sha256 = (v: string) => createHash("sha256").update(v).digest("hex");
const token = (bytes: number) => randomBytes(bytes).toString("base64url");

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Every value of a header as sent, counted from rawHeaders (Node joins or drops duplicates otherwise). */
function headerValues(raw: IncomingMessage, name: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < raw.rawHeaders.length; i += 2) if (raw.rawHeaders[i]!.toLowerCase() === name) out.push(raw.rawHeaders[i + 1]!);
  return out;
}

/** Cookie values by name, keeping duplicates so a second copy can be refused. */
function cookieValues(header: string | undefined, name: string): string[] {
  if (!header) return [];
  return header.split(";").map((p) => p.trim()).filter((p) => p.startsWith(`${name}=`)).map((p) => p.slice(name.length + 1));
}

function readSecretFile(path: string): string {
  const s = lstatSync(path);
  if (!s.isFile() || s.isSymbolicLink() || s.uid !== process.getuid?.() || (s.mode & 0o077) !== 0) throw new Error("unsafe client secret file");
  return readFileSync(path, "utf8").trim();
}

interface SessionRow {
  handle_hash: string; issuer: string; subject: string; workspace: string; grants_json: string;
  issued_at: number; last_active_at: number; absolute_expires_at: number; revoked_at: number | null;
}

export interface RemoteSession { handleHash: string; grants: string[]; absoluteExpiresAt: number; idleExpiresAt: number; csrf: string }

/** Fixed one-minute windows; the clock is the plane's injected clock. */
class WindowLimiter {
  private readonly buckets = new Map<string, { start: number; count: number }>();
  constructor(private readonly now: () => number) {}
  /** Counts one attempt. Returns the seconds to wait when `limit` is already used up in this window. */
  take(key: string, limit: number): number | null {
    const t = this.now(); const b = this.buckets.get(key);
    if (!b || t - b.start >= 60_000) { this.buckets.set(key, { start: t, count: 1 }); this.prune(t); return null; }
    b.count += 1;
    return b.count > limit ? Math.max(1, Math.ceil((b.start + 60_000 - t) / 1000)) : null;
  }
  private prune(t: number): void { if (this.buckets.size > 10_000) for (const [k, b] of this.buckets) if (t - b.start >= 60_000) this.buckets.delete(k); }
}

export interface RemoteAuthDeps { config: RemoteAuthConfig; workspace: string; db: Db; now: () => Date; log: FastifyBaseLogger; oidc?: OidcClient }

export class RemoteAuth {
  readonly config: RemoteAuthConfig;
  private readonly remoteRequests = new WeakSet<IncomingMessage>();
  private readonly csrfKey = randomBytes(32);
  private readonly limiter: WindowLimiter;
  private readonly streams = new Map<string, Set<FastifyReply>>();
  private readonly oidc: OidcClient;
  private readonly canonicalHost: string;
  private readonly peers: Set<string>;
  private listener?: Server;

  constructor(private readonly deps: RemoteAuthDeps) {
    this.config = deps.config;
    this.limiter = new WindowLimiter(() => deps.now().getTime());
    this.canonicalHost = new URL(deps.config.canonicalOrigin).host;
    this.peers = new Set(deps.config.transport.peers);
    this.oidc = deps.oidc ?? new OidcClient({
      issuer: deps.config.identity.issuer, clientId: deps.config.identity.clientId,
      clientSecret: () => readSecretFile(deps.config.identity.clientSecretFile),
      redirectUri: `${deps.config.canonicalOrigin}/api/auth/callback`,
    });
  }

  attachListener(server: Server): void { this.listener = server; }

  /** Called by the remote listener only: marks a request as having arrived on the remote port. */
  markRemote(raw: IncomingMessage): void { this.remoteRequests.add(raw); }
  isRemote(raw: IncomingMessage): boolean { return this.remoteRequests.has(raw); }

  /** Restart policy: every open remote session ends at boot, and stale logins are dropped. */
  revokeOnBoot(): number {
    const t = this.deps.now().getTime();
    this.deps.db.prepare("DELETE FROM remote_login_transactions WHERE expires_at <= ? OR consumed_at IS NOT NULL").run(t);
    return this.revokeAll("restart");
  }

  revokeAll(reason: string): number {
    const n = this.deps.db.prepare("UPDATE remote_sessions SET revoked_at = ?, revoke_reason = ? WHERE revoked_at IS NULL").run(this.deps.now().getTime(), reason).changes;
    for (const set of this.streams.values()) for (const reply of set) reply.raw.destroy();
    this.streams.clear();
    return n;
  }

  /** Discovery warm-up; a failure is logged and the next login retries. */
  async warmUp(): Promise<void> {
    try { await this.oidc.discover(); } catch (e) { this.deps.log.warn({ event: "remote.oidc", outcome: "discovery_failed", reason: (e as Error).message }, "remote login unavailable until the identity provider answers"); }
  }

  private csrfFor(handle: string): string { return createHmac("sha256", this.csrfKey).update(handle).digest("base64url"); }

  private loadSession(handle: string): RemoteSession | null {
    const row = this.deps.db.prepare("SELECT * FROM remote_sessions WHERE handle_hash = ?").get(sha256(handle)) as SessionRow | undefined;
    if (!row || row.revoked_at !== null) return null;
    const t = this.deps.now().getTime();
    const idleExpiresAt = Math.min(row.last_active_at + this.config.session.idleTtlSeconds * 1000, row.absolute_expires_at);
    if (t >= row.absolute_expires_at || t >= idleExpiresAt) return null;
    // The pin and the workspace are rechecked on every request: a config change plus restart revokes
    // anyway, but a row from another owner or workspace never authenticates.
    if (row.workspace !== this.deps.workspace || row.issuer !== this.config.identity.issuer || row.subject !== this.config.identity.subject) return null;
    const grants = (JSON.parse(row.grants_json) as string[]).filter((g) => this.config.identity.grants.includes(g));
    return { handleHash: row.handle_hash, grants, absoluteExpiresAt: row.absolute_expires_at, idleExpiresAt, csrf: this.csrfFor(handle) };
  }

  private touch(handleHash: string): void {
    this.deps.db.prepare("UPDATE remote_sessions SET last_active_at = ? WHERE handle_hash = ? AND revoked_at IS NULL").run(this.deps.now().getTime(), handleHash);
  }

  private revoke(handleHash: string, reason: string): void {
    this.deps.db.prepare("UPDATE remote_sessions SET revoked_at = ?, revoke_reason = ? WHERE handle_hash = ? AND revoked_at IS NULL").run(this.deps.now().getTime(), reason, handleHash);
    for (const reply of this.streams.get(handleHash) ?? []) reply.raw.destroy();
    this.streams.delete(handleHash);
  }

  /** Closes every tracked stream whose session is no longer valid (expiry, revocation). Runs on a timer. */
  sweepStreams(): void {
    for (const [hash, set] of this.streams) {
      const row = this.deps.db.prepare("SELECT revoked_at, last_active_at, absolute_expires_at FROM remote_sessions WHERE handle_hash = ?").get(hash) as Pick<SessionRow, "revoked_at" | "last_active_at" | "absolute_expires_at"> | undefined;
      const t = this.deps.now().getTime();
      const live = row && row.revoked_at === null && t < row.absolute_expires_at && t < row.last_active_at + this.config.session.idleTtlSeconds * 1000;
      if (!live) { for (const reply of set) reply.raw.destroy(); this.streams.delete(hash); }
    }
  }

  activeStreams(): number { let n = 0; for (const s of this.streams.values()) n += s.size; return n; }

  /** Transport contract for the trusted proxy. Returns the verified client address or a reason code. */
  private transport(req: FastifyRequest): { client: string } | { reason: string } {
    const peer = (req.raw.socket.remoteAddress ?? "").replace(/^::ffff:/, "");
    if (!this.peers.has(peer)) return { reason: "peer" };
    const one = (name: string) => { const v = headerValues(req.raw, name); return v.length === 1 ? v[0]! : null; };
    if (headerValues(req.raw, "forwarded").length > 0) return { reason: "forwarded" };
    if (one("host") !== this.canonicalHost || one("x-forwarded-host") !== this.canonicalHost) return { reason: "authority" };
    if (one("x-forwarded-proto") !== "https") return { reason: "proto" };
    const client = one("x-forwarded-for");
    if (!client || isIP(client) === 0) return { reason: "client" };
    const login = one("tailscale-user-login");
    if (login === null || !safeEqual(login, this.config.transport.tailscaleLogin)) return { reason: "tailnet_identity" };
    return { client };
  }

  private refuse(reply: FastifyReply, code: number, error: string, extra: Record<string, unknown> = {}): FastifyReply {
    return reply.code(code).header("cache-control", "no-store").send({ error, ...extra });
  }

  /** The onRequest hook for the remote listener. Every check fails closed. */
  async onRequest(req: FastifyRequest, reply: FastifyReply): Promise<FastifyReply | void> {
    const tr = this.transport(req);
    if ("reason" in tr) { this.deps.log.warn({ event: "remote.transport", outcome: "refused", reason: tr.reason }, "remote request refused"); return this.refuse(reply, 403, "forbidden"); }
    (req as RemoteRequest).remoteClient = tr.client;
    const path = req.url.split("?")[0]!;
    if (!path.startsWith("/api/")) return;
    if (REMOTE_REFUSED.has(path)) return this.refuse(reply, 404, "not found");
    const route = req.routeOptions.url;
    const rule = req.routeOptions.config?.auth;
    if (rule === null) return this.refuse(reply, 404, "not found");

    if (route !== undefined && REMOTE_PUBLIC_ROUTES.has(route)) {
      const wait = this.limiter.take(`login:${tr.client}`, this.config.limits.loginPerMinutePerAddress) ?? this.limiter.take("login:*", this.config.limits.loginPerMinutePerInstance);
      if (wait !== null) return this.refuse(reply.header("retry-after", String(wait)), 429, "rate limited");
      return;
    }

    const unsafe = !SAFE_METHODS.has(req.method);
    const origin = headerValues(req.raw, "origin");
    if (origin.length > 1 || (origin.length === 1 && origin[0] !== this.config.canonicalOrigin)) return this.refuse(reply, 403, "cross-origin");
    if (unsafe && origin.length === 0) return this.refuse(reply, 403, "cross-origin");
    if (!unsafe && origin.length === 0 && req.headers["sec-fetch-site"] !== "same-origin") return this.refuse(reply, 403, "cross-origin");
    if (req.headers["sec-fetch-mode"] === "navigate") return this.refuse(reply, 403, "cross-origin");

    // Local credentials never work here: no bearer, no local cookie, exactly one remote cookie.
    const cookie = req.headers.cookie;
    const handles = cookieValues(cookie, REMOTE_SESSION_COOKIE);
    const session = req.headers.authorization === undefined && cookieValues(cookie, LOCAL_SESSION_COOKIE).length === 0 && handles.length === 1 ? this.loadSession(handles[0]!) : null;
    if (!session) return this.refuse(reply, 401, "unauthenticated", { login: "/api/auth/login" });
    if (unsafe) {
      const csrf = headerValues(req.raw, "x-csrf-token");
      if (csrf.length !== 1 || !safeEqual(csrf[0]!, session.csrf)) return this.refuse(reply, 403, "csrf");
    }

    const wait = unsafe
      ? this.limiter.take(`cmd:${session.handleHash}`, this.config.limits.commandsPerMinute) ?? this.limiter.take("cmd:*", this.config.limits.commandsPerMinutePerInstance)
      : this.limiter.take(`read:${session.handleHash}`, this.config.limits.readsPerMinute);
    if (wait !== null) return this.refuse(reply.header("retry-after", String(wait)), 429, "rate limited");

    if (rule !== undefined && "require" in rule && !capabilityGranted(session.grants, rule.require)) return this.refuse(reply, 403, `${rule.require} required`);

    const cred: AuthenticatedCredential = { kind: "remote", capabilities: session.grants, kid: `remote:${session.handleHash.slice(0, 12)}` };
    req.cred = cred;
    (req as RemoteRequest).remoteSession = session;
    // Only an explicit write is operator activity; reads, polling and streams never extend idle time.
    if (unsafe) this.touch(session.handleHash);

    if (route?.endsWith("/events/stream")) {
      const mine = this.streams.get(session.handleHash) ?? new Set<FastifyReply>();
      if (mine.size >= this.config.limits.streamsPerSession || this.activeStreams() >= this.config.limits.streamsPerInstance) return this.refuse(reply, 429, "too many streams");
      mine.add(reply); this.streams.set(session.handleHash, mine);
      reply.raw.once("close", () => { mine.delete(reply); if (mine.size === 0 && this.streams.get(session.handleHash) === mine) this.streams.delete(session.handleHash); });
    }
  }

  private noStore(reply: FastifyReply): FastifyReply { return reply.header("cache-control", "no-store").header("referrer-policy", "no-referrer"); }

  private page(reply: FastifyReply, code: number, title: string, body: string): FastifyReply {
    return this.noStore(reply).code(code).type("text/html; charset=utf-8")
      .header("content-security-policy", "default-src 'none'; style-src 'unsafe-inline'")
      .send(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${title}</title><body style="font-family:system-ui;max-width:32rem;margin:3rem auto;padding:0 1rem"><h1>${title}</h1>${body}<p><a href="/api/auth/login">Sign in again</a></p></body>`);
  }

  private cookie(name: string, value: string, maxAgeSeconds: number, sameSite: "Strict" | "Lax"): string {
    return `${name}=${value}; HttpOnly; Secure; SameSite=${sameSite}; Path=/; Max-Age=${maxAgeSeconds}`;
  }

  registerRoutes(app: FastifyInstance): void {
    const remoteOnly = (req: FastifyRequest, reply: FastifyReply) => (this.isRemote(req.raw) ? null : reply.code(404).send({ error: "not found" }));

    app.get("/api/auth/login", { config: { auth: { remote: "public" } } }, async (req, reply) => {
      if (remoteOnly(req, reply)) return reply;
      const t = this.deps.now().getTime();
      this.deps.db.prepare("DELETE FROM remote_login_transactions WHERE expires_at <= ? OR consumed_at IS NOT NULL").run(t);
      const pending = (this.deps.db.prepare("SELECT COUNT(*) AS n FROM remote_login_transactions").get() as { n: number }).n;
      if (pending >= this.config.limits.maxPendingLogins) return this.page(reply.header("retry-after", "60"), 429, "Too many sign-ins", "<p>Wait a minute and try again.</p>");
      const browser = token(32), state = token(32), nonce = token(32), verifier = token(48);
      let location: string;
      try { location = await this.oidc.authorizationUrl({ state, nonce, codeVerifier: verifier }); }
      catch { this.deps.log.warn({ event: "remote.login", outcome: "idp_unavailable" }, "remote login refused"); return this.page(reply, 503, "Sign-in unavailable", "<p>The identity provider did not answer. Nothing was granted.</p>"); }
      this.deps.db.prepare("INSERT INTO remote_login_transactions (state, browser_hash, nonce, code_verifier, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)").run(state, sha256(browser), nonce, verifier, t, t + LOGIN_TTL_MS);
      this.deps.log.info({ event: "remote.login", outcome: "started" }, "remote login started");
      return this.noStore(reply).code(302).header("location", location).header("set-cookie", this.cookie(REMOTE_LOGIN_COOKIE, browser, LOGIN_TTL_MS / 1000, "Lax")).send();
    });

    app.get<{ Querystring: Record<string, string | undefined> }>("/api/auth/callback", { config: { auth: { remote: "public" } } }, async (req, reply) => {
      if (remoteOnly(req, reply)) return reply;
      const clearLogin = this.cookie(REMOTE_LOGIN_COOKIE, "", 0, "Lax");
      const fail = (code: number, outcome: string, title: string, body: string) => {
        this.deps.log.warn({ event: "remote.login", outcome }, "remote login refused");
        return this.page(reply.header("set-cookie", clearLogin), code, title, body);
      };
      const q = req.query ?? {};
      const state = typeof q.state === "string" ? q.state : "";
      const browsers = cookieValues(req.headers.cookie, REMOTE_LOGIN_COOKIE);
      const tx = state ? this.deps.db.prepare("SELECT * FROM remote_login_transactions WHERE state = ?").get(state) as { state: string; browser_hash: string; nonce: string; code_verifier: string } | undefined : undefined;
      if (!tx || browsers.length !== 1 || !safeEqual(sha256(browsers[0]!), tx.browser_hash)) return fail(400, "no_transaction", "Sign-in expired", "<p>This sign-in is not valid in this browser any more.</p>");
      const t = this.deps.now().getTime();
      // Single use: the row is consumed atomically before the IdP is asked, so a replayed callback never reaches the exchange.
      const consumed = this.deps.db.prepare("UPDATE remote_login_transactions SET consumed_at = ? WHERE state = ? AND consumed_at IS NULL AND expires_at > ?").run(t, state, t).changes;
      this.deps.db.prepare("DELETE FROM remote_login_transactions WHERE state = ?").run(state);
      if (consumed !== 1) return fail(400, "replayed_or_expired", "Sign-in expired", "<p>This sign-in was already used or is too old.</p>");
      if (q.error !== undefined || typeof q.code !== "string" || !q.code) return fail(403, "idp_error", "Sign-in cancelled", "<p>Nothing was granted.</p>");
      registerSecret(q.code);
      let claims: { iss?: unknown; sub?: unknown };
      try { claims = await this.oidc.verifyCallback({ code: q.code, codeVerifier: tx.code_verifier, nonce: tx.nonce }); }
      catch { return fail(403, "token_invalid", "Sign-in failed", "<p>The identity provider's answer could not be verified. Nothing was granted.</p>"); }
      if (!isPinnedOwner(claims, { issuer: this.config.identity.issuer, subject: this.config.identity.subject })) return fail(403, "not_owner", "Not allowed", "<p>This account is not the owner of this Agentic OS. Nothing was granted.</p>");

      // Re-login rotates: the session this browser held, if any, ends now.
      for (const old of cookieValues(req.headers.cookie, REMOTE_SESSION_COOKIE)) this.revoke(sha256(old), "relogin");
      const handle = token(32);
      registerSecret(handle); registerSecret(this.csrfFor(handle));
      const now = this.deps.now().getTime();
      const absolute = now + this.config.session.absoluteTtlSeconds * 1000;
      this.deps.db.prepare("INSERT INTO remote_sessions (handle_hash, issuer, subject, workspace, grants_json, issued_at, last_active_at, absolute_expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
        .run(sha256(handle), this.config.identity.issuer, this.config.identity.subject, this.deps.workspace, JSON.stringify(this.config.identity.grants), now, now, absolute);
      this.deps.log.info({ event: "remote.login", outcome: "owner" }, "remote session issued");
      return this.noStore(reply).code(303).header("location", `${this.config.canonicalOrigin}/`)
        .header("set-cookie", [this.cookie(REMOTE_SESSION_COOKIE, handle, this.config.session.absoluteTtlSeconds, "Strict"), clearLogin]).send();
    });

    app.get("/api/auth/session", { config: { auth: { remote: "session" } } }, async (req, reply) => {
      if (remoteOnly(req, reply)) return reply;
      const s = (req as RemoteRequest).remoteSession!;
      return this.noStore(reply).send({ mode: "remote", principal: "owner", grants: s.grants, csrfToken: s.csrf, expiresAt: new Date(s.absoluteExpiresAt).toISOString(), idleExpiresAt: new Date(s.idleExpiresAt).toISOString() });
    });

    app.post("/api/auth/activity", { config: { auth: { remote: "session" } } }, async (req, reply) => {
      if (remoteOnly(req, reply)) return reply;
      const s = (req as RemoteRequest).remoteSession!;
      const idle = Math.min(this.deps.now().getTime() + this.config.session.idleTtlSeconds * 1000, s.absoluteExpiresAt);
      return this.noStore(reply).send({ idleExpiresAt: new Date(idle).toISOString() });
    });

    app.post("/api/auth/logout", { config: { auth: { remote: "session" } } }, async (req, reply) => {
      if (remoteOnly(req, reply)) return reply;
      this.revoke((req as RemoteRequest).remoteSession!.handleHash, "logout");
      this.deps.log.info({ event: "remote.logout", outcome: "revoked" }, "remote session revoked");
      return this.noStore(reply).header("set-cookie", this.cookie(REMOTE_SESSION_COOKIE, "", 0, "Strict")).send({ ok: true });
    });

    // Operator recovery on the box: the local bearer CLI ends every remote session. Refused on the remote listener.
    app.post("/api/auth/remote-sessions/revoke", { config: { auth: { require: "commands.write" } } }, async (req, reply) => {
      if (this.isRemote(req.raw)) return reply.code(404).send({ error: "not found" });
      const revoked = this.revokeAll("operator");
      this.deps.log.info({ event: "remote.revoke_all", outcome: "revoked", count: revoked }, "remote sessions revoked");
      return reply.header("cache-control", "no-store").send({ revoked });
    });

    const sweep = setInterval(() => this.sweepStreams(), 5_000); sweep.unref();
    app.addHook("onClose", async () => {
      clearInterval(sweep);
      const server = this.listener; this.listener = undefined;
      if (server) await new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); });
    });
  }
}

interface RemoteRequest extends FastifyRequest { remoteClient?: string; remoteSession?: RemoteSession }
