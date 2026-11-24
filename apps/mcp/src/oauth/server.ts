import type { IncomingMessage, ServerResponse } from "node:http";
import { isIP } from "node:net";
import { SCOPES, type Scope } from "../contract.js";
import { cookies, escapeHtml, readBody, redirect, sendHtml, sendJson } from "../http-util.js";
import type { RateLimiter } from "../ratelimit.js";
import { hash, safeEqual, token, type ClientRow, type OAuthStore } from "./store.js";
import { ownerPinMatches, s256, type OidcClient } from "./oidc.js";

/**
 * OAuth 2.1 authorization server for MCP clients (docs/adr/mcp-connector.md, "Access model"):
 * authorization code + PKCE S256 only, RFC 8414 metadata, RFC 9207 `iss`, RFC 8707 `resource`
 * bound to the grant, DCR (RFC 7591) and Client ID Metadata Documents, owner login through the
 * service's own OIDC client with an exact (iss, sub) pin, and one consent per client.
 */
export interface AuthServerOptions {
  publicUrl: string;
  resource: string;
  owner: { issuer: string; subject: string };
  store: OAuthStore;
  oidc: OidcClient;
  limiter: RateLimiter;
  limits: { perAddress: number; perInstance: number };
  clientAddress: (req: IncomingMessage) => string;
  /** Fetches a Client ID Metadata Document; injectable for tests. */
  fetchClientMetadata?: (url: string) => Promise<unknown>;
  log: (event: Record<string, unknown>) => void;
}

const BROWSER_COOKIE = "aos_mcp_browser";
const CLAUDE_CALLBACK = "https://claude.ai/api/mcp/auth_callback";
const PKCE_CHALLENGE = /^[A-Za-z0-9_-]{43,128}$/;
const PKCE_VERIFIER = /^[A-Za-z0-9._~-]{43,128}$/;

/** The fixed redirect allowlist: Claude's hosted callback, and RFC 8252 loopback redirects for CLIs (both IP literals, and localhost as before). */
export function redirectAllowed(uri: string): boolean {
  if (uri === CLAUDE_CALLBACK) return true;
  let u: URL;
  try { u = new URL(uri); } catch { return false; }
  if (u.protocol !== "http:" || u.username || u.password || u.hash) return false;
  return u.hostname === "127.0.0.1" || u.hostname === "[::1]" || u.hostname === "localhost";
}

export function authorizationServerMetadata(publicUrl: string) {
  return {
    issuer: publicUrl,
    authorization_endpoint: `${publicUrl}/oauth/authorize`,
    token_endpoint: `${publicUrl}/oauth/token`,
    registration_endpoint: `${publicUrl}/oauth/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none", "client_secret_basic", "client_secret_post"],
    scopes_supported: [...SCOPES],
    authorization_response_iss_parameter_supported: true,
    client_id_metadata_document_supported: true,
  };
}

export function protectedResourceMetadata(publicUrl: string, resource: string) {
  return {
    resource,
    authorization_servers: [publicUrl],
    scopes_supported: [...SCOPES],
    bearer_methods_supported: ["header"],
    resource_name: "Agent OS",
  };
}

function parseScopes(raw: string | null): Scope[] | null {
  if (raw === null || raw.trim() === "") return [...SCOPES];
  const asked = raw.trim().split(/\s+/);
  if (asked.some((s) => !(SCOPES as readonly string[]).includes(s))) return null;
  return SCOPES.filter((s) => asked.includes(s));
}

/** CIMD client ids are https URLs with a path; IP literals and local names are refused (SSRF). */
function cimdUrl(clientId: string): URL | null {
  let u: URL;
  try { u = new URL(clientId); } catch { return null; }
  if (u.protocol !== "https:" || u.username || u.password || u.hash || u.pathname === "/" || u.port) return null;
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host) || host === "localhost" || /\.(local|internal|localhost|lan|home|arpa)$/i.test(host) || !host.includes(".")) return null;
  return u;
}

async function defaultFetchClientMetadata(url: string): Promise<unknown> {
  const res = await fetch(url, { signal: AbortSignal.timeout(5000), redirect: "error", headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`client metadata fetch failed (${res.status})`);
  const text = await res.text();
  if (text.length > 16_384) throw new Error("client metadata document too large");
  return JSON.parse(text) as unknown;
}

export class AuthServer {
  constructor(private readonly o: AuthServerOptions) {}

  private get secure() { return this.o.publicUrl.startsWith("https://"); }

  /** Handles /oauth/* and the metadata documents. Returns false when the path is not its own. */
  async handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
    const p = url.pathname;
    if (req.method === "GET" && (p === "/.well-known/oauth-authorization-server" || p === "/.well-known/openid-configuration")) {
      sendJson(res, 200, authorizationServerMetadata(this.o.publicUrl), { "cache-control": "max-age=300" });
      return true;
    }
    if (req.method === "GET" && (p === "/.well-known/oauth-protected-resource" || p === "/.well-known/oauth-protected-resource/mcp")) {
      sendJson(res, 200, protectedResourceMetadata(this.o.publicUrl, this.o.resource), { "cache-control": "max-age=300" });
      return true;
    }
    if (!p.startsWith("/oauth/")) return false;
    const addr = this.o.clientAddress(req);
    const allowed = this.o.limiter.hit(
      { key: `oauth:addr:${addr}`, limit: this.o.limits.perAddress, windowMs: 60_000 },
      { key: "oauth:instance", limit: this.o.limits.perInstance, windowMs: 60_000 },
    );
    if (!allowed.ok) {
      sendJson(res, 429, { error: "rate_limited" }, { "retry-after": String(allowed.retryAfterSeconds) });
      return true;
    }
    this.o.store.pruneClients();
    if (req.method === "GET" && p === "/oauth/authorize") await this.authorize(req, res, url);
    else if (req.method === "GET" && p === "/oauth/callback") await this.callback(req, res, url);
    else if (req.method === "POST" && p === "/oauth/consent") await this.consent(req, res);
    else if (req.method === "POST" && p === "/oauth/token") await this.tokenEndpoint(req, res);
    else if (req.method === "POST" && p === "/oauth/register") await this.register(req, res);
    else sendJson(res, 404, { error: "not_found" });
    return true;
  }

  // ---- registration ----

  private async register(req: IncomingMessage, res: ServerResponse) {
    let body: Record<string, unknown>;
    try { body = JSON.parse(await readBody(req, 16_384)) as Record<string, unknown>; } catch { return sendJson(res, 400, { error: "invalid_client_metadata", error_description: "body must be JSON" }); }
    const uris = body.redirect_uris;
    if (!Array.isArray(uris) || uris.length === 0 || uris.length > 10 || uris.some((u) => typeof u !== "string" || !redirectAllowed(u))) {
      return sendJson(res, 400, { error: "invalid_redirect_uri", error_description: "redirect_uris must be Claude's callback or loopback http URIs" });
    }
    const method = body.token_endpoint_auth_method ?? "client_secret_basic";
    if (!["none", "client_secret_basic", "client_secret_post"].includes(method as string)) {
      return sendJson(res, 400, { error: "invalid_client_metadata", error_description: "unsupported token_endpoint_auth_method" });
    }
    const grants = (body.grant_types ?? ["authorization_code"]) as unknown;
    const responses = (body.response_types ?? ["code"]) as unknown;
    if (!Array.isArray(grants) || grants.some((g) => g !== "authorization_code" && g !== "refresh_token") ||
        !Array.isArray(responses) || responses.some((r) => r !== "code")) {
      return sendJson(res, 400, { error: "invalid_client_metadata", error_description: "only authorization_code (+ refresh_token) and response_type code" });
    }
    const name = typeof body.client_name === "string" && body.client_name.trim() ? body.client_name.trim().slice(0, 100) : "Unnamed client";
    const clientId = `c_${token(16)}`;
    const secret = method === "none" ? undefined : token();
    this.o.store.addClient({ client_id: clientId, kind: "dcr", client_name: name, redirect_uris: JSON.stringify(uris), auth_method: method as string, secret_hash: secret ? hash(secret) : null });
    this.o.log({ event: "oauth.register", client: clientId, method });
    sendJson(res, 201, {
      client_id: clientId, ...(secret ? { client_secret: secret, client_secret_expires_at: 0 } : {}),
      client_id_issued_at: Math.floor(Date.now() / 1000), client_name: name, redirect_uris: uris,
      token_endpoint_auth_method: method, grant_types: grants, response_types: responses,
    });
  }

  /** A registered (DCR) client, or a CIMD client whose document is fetched and checked now. */
  private async resolveClient(clientId: string): Promise<ClientRow | null> {
    const known = this.o.store.client(clientId);
    if (known && known.kind === "dcr") return known;
    const u = cimdUrl(clientId);
    if (!u) return null;
    let doc: unknown;
    try { doc = await (this.o.fetchClientMetadata ?? defaultFetchClientMetadata)(u.toString()); } catch { return null; }
    if (!doc || typeof doc !== "object") return null;
    const d = doc as Record<string, unknown>;
    if (d.client_id !== clientId) return null;
    const uris = d.redirect_uris;
    if (!Array.isArray(uris) || uris.length === 0 || uris.some((x) => typeof x !== "string" || !redirectAllowed(x))) return null;
    if (d.token_endpoint_auth_method !== undefined && d.token_endpoint_auth_method !== "none") return null;
    const name = typeof d.client_name === "string" && d.client_name.trim() ? d.client_name.trim().slice(0, 100) : u.hostname;
    this.o.store.addClient({ client_id: clientId, kind: "cimd", client_name: name, redirect_uris: JSON.stringify(uris), auth_method: "none", secret_hash: null });
    return this.o.store.client(clientId)!;
  }

  // ---- authorize (browser) ----

  private errorRedirect(res: ServerResponse, redirectUri: string, error: string, state: string | null) {
    const u = new URL(redirectUri);
    u.searchParams.set("error", error);
    if (state !== null) u.searchParams.set("state", state);
    u.searchParams.set("iss", this.o.publicUrl);
    redirect(res, u.toString());
  }

  private async authorize(_req: IncomingMessage, res: ServerResponse, url: URL) {
    const q = url.searchParams;
    const clientId = q.get("client_id") ?? "";
    const redirectUri = q.get("redirect_uri") ?? "";
    const client = clientId ? await this.resolveClient(clientId) : null;
    // Before the redirect URI is trusted, errors are shown here and never sent anywhere.
    if (!client) return sendHtml(res, 400, "Unknown client", "<p>This client is not registered.</p>");
    const registered = JSON.parse(client.redirect_uris) as string[];
    if (!redirectAllowed(redirectUri) || !registered.includes(redirectUri)) {
      return sendHtml(res, 400, "Redirect not allowed", "<p>The redirect address is not registered for this client.</p>");
    }
    const state = q.get("state");
    if (q.get("response_type") !== "code") return this.errorRedirect(res, redirectUri, "unsupported_response_type", state);
    const challenge = q.get("code_challenge") ?? "";
    if (q.get("code_challenge_method") !== "S256" || !PKCE_CHALLENGE.test(challenge)) return this.errorRedirect(res, redirectUri, "invalid_request", state);
    if (q.get("resource") !== this.o.resource) return this.errorRedirect(res, redirectUri, "invalid_target", state);
    const scopes = parseScopes(q.get("scope"));
    if (!scopes || scopes.length === 0) return this.errorRedirect(res, redirectUri, "invalid_scope", state);

    const pendingId = token(24);
    const browser = token(24);
    const nonce = token(24);
    const verifier = token(48);
    this.o.store.addPending({
      id: pendingId, browser_hash: hash(browser), client_id: client.client_id, redirect_uri: redirectUri, state,
      scopes: scopes.join(" "), resource: this.o.resource, code_challenge: challenge, oidc_nonce: nonce, oidc_verifier: verifier,
    });
    let location: string;
    try { location = await this.o.oidc.authorizationUrl({ state: pendingId, nonce, codeVerifier: verifier }); }
    catch { return sendHtml(res, 502, "Sign-in unavailable", "<p>The identity provider could not be reached. Try again.</p>"); }
    redirect(res, location, 302, { "set-cookie": this.cookie(`${pendingId}.${browser}`, 600) });
  }

  private cookie(value: string, maxAge: number) {
    return `${BROWSER_COOKIE}=${value}; Path=/oauth; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${this.secure ? "; Secure" : ""}`;
  }

  /** The pending authorization this browser started, or undefined (cookie binding defeats login CSRF). */
  private browserPending(req: IncomingMessage, pendingId: string) {
    const raw = cookies(req)[BROWSER_COOKIE] ?? "";
    const [id, secret] = raw.split(".");
    if (!id || !secret || id !== pendingId) return undefined;
    const row = this.o.store.pending(pendingId);
    if (!row || !safeEqual(row.browser_hash, hash(secret))) return undefined;
    return row;
  }

  private async callback(req: IncomingMessage, res: ServerResponse, url: URL) {
    const pendingId = url.searchParams.get("state") ?? "";
    const pending = this.browserPending(req, pendingId);
    if (!pending) return sendHtml(res, 400, "Sign-in expired", "<p>This sign-in is not valid in this browser any more. Start again from your app.</p>");
    if (url.searchParams.get("error")) {
      this.o.store.dropPending(pending.id);
      return this.errorRedirect(res, pending.redirect_uri, "access_denied", pending.state);
    }
    let claims: { iss?: unknown; sub?: unknown };
    try {
      claims = await this.o.oidc.verifyCallback({ code: url.searchParams.get("code") ?? "", codeVerifier: pending.oidc_verifier, nonce: pending.oidc_nonce });
    } catch {
      this.o.store.dropPending(pending.id);
      this.o.log({ event: "oauth.login", outcome: "token_invalid" });
      return sendHtml(res, 403, "Sign-in failed", "<p>The identity provider's answer could not be verified.</p>");
    }
    // D-A: exact (iss, sub). Email, domain or name never authorize.
    if (!ownerPinMatches(claims, this.o.owner)) {
      this.o.store.dropPending(pending.id);
      this.o.log({ event: "oauth.login", outcome: "not_owner" });
      return sendHtml(res, 403, "Not allowed", "<p>This account is not the owner of this Agent OS. Nothing was granted.</p>");
    }
    this.o.log({ event: "oauth.login", outcome: "owner", client: pending.client_id });
    const scopes = pending.scopes.split(" ") as Scope[];
    const client = this.o.store.client(pending.client_id)!;
    // M1 (security review 2026-11-24): remembered consent is honoured only for a DCR client, whose
    // client_id was minted for one registration. A CIMD client_id is a public URL that every user of
    // that client app shares, so someone else's authorize URL would otherwise be granted silently.
    if (client.kind === "dcr" && this.o.store.consented(pending.client_id, scopes)) return this.finish(res, pending.id);
    const csrf = token(24);
    this.o.store.markOwner(pending.id, csrf);
    const redirectHost = new URL(pending.redirect_uri).host;
    // The CIMD name comes from the fetched document, so the page also shows the host that published it.
    const publisher = client.kind === "cimd" ? `<p>Client published by <code>${escapeHtml(new URL(client.client_id).host)}</code>. Only allow this if you started this sign-in yourself, just now.</p>` : "";
    sendHtml(res, 200, "Allow access to Agent OS?", `
<p><strong>${escapeHtml(client.client_name)}</strong> wants to use your Agent OS.</p>${publisher}
<p>It will return to <code>${escapeHtml(redirectHost)}</code>.</p>
<p>It asks to:</p><ul>${scopes.map((s) => `<li>${escapeHtml(SCOPE_TEXT[s])}</li>`).join("")}</ul>
<p>It cannot approve tool use, answer input, cancel tasks or change settings.</p>
<form method="post" action="/oauth/consent">
<input type="hidden" name="pending" value="${escapeHtml(pending.id)}"><input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
<button name="decision" value="approve" type="submit">Allow</button><button name="decision" value="deny" type="submit">Deny</button>
</form>`);
  }

  private async consent(req: IncomingMessage, res: ServerResponse) {
    // CSRF: an exact Origin plus the per-pending token and the browser cookie.
    if (req.headers.origin !== new URL(this.o.publicUrl).origin) return sendHtml(res, 403, "Not allowed", "<p>Consent must come from this page.</p>");
    let form: URLSearchParams;
    try { form = new URLSearchParams(await readBody(req, 4096)); } catch { return sendHtml(res, 400, "Bad request", "<p>Bad form.</p>"); }
    const pending = this.browserPending(req, form.get("pending") ?? "");
    if (!pending || !pending.owner_ok || !pending.csrf || !safeEqual(pending.csrf, form.get("csrf") ?? "")) {
      return sendHtml(res, 403, "Not allowed", "<p>This consent is not valid any more. Start again from your app.</p>");
    }
    if (form.get("decision") !== "approve") {
      this.o.store.dropPending(pending.id);
      this.o.log({ event: "oauth.consent", outcome: "denied", client: pending.client_id });
      return this.errorRedirect(res, pending.redirect_uri, "access_denied", pending.state);
    }
    this.o.store.recordConsent(pending.client_id, pending.scopes.split(" ") as Scope[]);
    this.o.log({ event: "oauth.consent", outcome: "approved", client: pending.client_id });
    this.finish(res, pending.id, 303);
  }

  private finish(res: ServerResponse, pendingId: string, status = 302) {
    const p = this.o.store.pending(pendingId)!;
    this.o.store.dropPending(p.id);
    const code = this.o.store.issueCode({ clientId: p.client_id, redirectUri: p.redirect_uri, scopes: p.scopes, resource: p.resource, codeChallenge: p.code_challenge });
    const u = new URL(p.redirect_uri);
    u.searchParams.set("code", code);
    if (p.state !== null) u.searchParams.set("state", p.state);
    u.searchParams.set("iss", this.o.publicUrl);
    redirect(res, u.toString(), status, { "set-cookie": this.cookie("", 0) });
  }

  // ---- token ----

  private authenticateClient(req: IncomingMessage, form: URLSearchParams): ClientRow | null {
    let id = form.get("client_id");
    let secret = form.get("client_secret");
    const basic = /^Basic\s+(.+)$/i.exec(req.headers.authorization ?? "");
    let method = secret !== null ? "client_secret_post" : "none";
    if (basic) {
      const decoded = Buffer.from(basic[1]!, "base64").toString("utf8");
      const i = decoded.indexOf(":");
      if (i < 0) return null;
      const bid = decodeURIComponent(decoded.slice(0, i));
      if (id !== null && id !== bid) return null;
      id = bid; secret = decodeURIComponent(decoded.slice(i + 1)); method = "client_secret_basic";
    }
    if (!id) return null;
    const client = this.o.store.client(id);
    if (!client || client.auth_method !== method) return null;
    if (method !== "none" && (!client.secret_hash || !secret || !safeEqual(client.secret_hash, hash(secret)))) return null;
    return client;
  }

  private async tokenEndpoint(req: IncomingMessage, res: ServerResponse) {
    let form: URLSearchParams;
    try { form = new URLSearchParams(await readBody(req, 16_384)); } catch { return sendJson(res, 400, { error: "invalid_request" }); }
    const client = this.authenticateClient(req, form);
    if (!client) return sendJson(res, 401, { error: "invalid_client" }, { "www-authenticate": 'Basic realm="aos-mcp"' });
    const grantType = form.get("grant_type");
    if (grantType === "authorization_code") {
      const code = form.get("code") ?? "";
      const verifier = form.get("code_verifier") ?? "";
      const redeemed = this.o.store.redeemCode(code);
      if (redeemed.kind !== "ok") { this.o.log({ event: "oauth.token", outcome: "code_invalid" }); return sendJson(res, 400, { error: "invalid_grant" }); }
      const r = redeemed.row;
      if (r.client_id !== client.client_id || r.redirect_uri !== form.get("redirect_uri") || !PKCE_VERIFIER.test(verifier) || s256(verifier) !== r.code_challenge) {
        return sendJson(res, 400, { error: "invalid_grant" });
      }
      // RFC 8707: the grant is bound to this MCP resource; a token request for another target is refused.
      if (form.get("resource") !== this.o.resource || r.resource !== this.o.resource) return sendJson(res, 400, { error: "invalid_target" });
      const grantId = this.o.store.createGrant(client.client_id, r.scopes, r.resource);
      this.o.store.bindCodeGrant(code, grantId);
      this.o.store.touchClient(client.client_id);
      const t = this.o.store.issueTokens(grantId);
      this.o.log({ event: "oauth.token", outcome: "issued", grant: grantId });
      return sendJson(res, 200, { access_token: t.access, token_type: "Bearer", expires_in: t.expiresIn, refresh_token: t.refresh, scope: r.scopes });
    }
    if (grantType === "refresh_token") {
      const resource = form.get("resource");
      if (resource !== null && resource !== this.o.resource) return sendJson(res, 400, { error: "invalid_target" });
      const rotated = this.o.store.rotateRefresh(form.get("refresh_token") ?? "", client.client_id);
      if (rotated.kind === "reused") {
        this.o.log({ event: "oauth.refresh", outcome: "reused_revoked" });
        return sendJson(res, 400, { error: "invalid_grant", error_description: "refresh token reused; the grant is revoked" });
      }
      if (rotated.kind !== "ok") return sendJson(res, 400, { error: "invalid_grant" });
      const g = this.o.store.grant(rotated.grantId)!;
      const t = this.o.store.issueTokens(g.id);
      this.o.log({ event: "oauth.refresh", outcome: "rotated", grant: g.id });
      return sendJson(res, 200, { access_token: t.access, token_type: "Bearer", expires_in: t.expiresIn, refresh_token: t.refresh, scope: g.scopes });
    }
    sendJson(res, 400, { error: "unsupported_grant_type" });
  }
}

const SCOPE_TEXT: Record<Scope, string> = {
  "aos.tasks.read": "See tasks in the exposed repositories and their status",
  "aos.tasks.create": "Create tasks in the exposed repositories (without starting them)",
  "aos.tasks.start": "Start tasks it created or you name",
};
