import { createHash } from "node:crypto";
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";

/**
 * One OIDC relying party of the owner's identity provider (D-A: Google), shared by the Web remote
 * login (apps/api/src/auth/remote) and the MCP OAuth server (apps/mcp/src/oauth). Only `openid` is
 * requested; the ID token is verified (signature, iss, aud, azp, exp, nonce) and every provider
 * token is discarded. Authorization is the exact (iss, sub) pin, checked with `ownerPinMatches`.
 *
 * Nothing here accepts a caller-chosen issuer, discovery URL or redirect URI: all three come from
 * the service's own validated configuration.
 */
interface Discovery { issuer: string; authorization_endpoint: string; token_endpoint: string; jwks_uri: string }

export interface OidcClientOptions {
  issuer: string;
  clientId: string;
  clientSecret: () => string;
  redirectUri: string;
  /** Clock for ID token time checks. Defaults to the wall clock. */
  now?: () => Date;
}

/** The exact owner identity (D-A). Email, domain or display name never authorize. */
export interface OwnerPin { issuer: string; subject: string }

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

export class OidcClient {
  private discovery?: Discovery;
  private jwks?: ReturnType<typeof createRemoteJWKSet>;

  constructor(private readonly opts: OidcClientOptions) {}

  /** Endpoints must be https; plain http is accepted only when the issuer itself is a loopback test issuer. */
  private endpoint(value: unknown, field: string): string {
    if (typeof value !== "string") throw new Error(`OIDC discovery has no ${field}`);
    const url = new URL(value);
    const issuer = new URL(this.opts.issuer);
    const loopbackTest = issuer.protocol === "http:" && LOOPBACK_HOSTS.has(issuer.hostname);
    if (url.protocol !== "https:" && !(loopbackTest && url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname))) {
      throw new Error(`OIDC discovery ${field} must be https`);
    }
    return url.toString();
  }

  private async discover(): Promise<Discovery> {
    if (this.discovery) return this.discovery;
    const res = await fetch(`${this.opts.issuer}/.well-known/openid-configuration`, { signal: AbortSignal.timeout(10_000), redirect: "error" });
    if (!res.ok) throw new Error(`OIDC discovery failed (${res.status})`);
    const doc = (await res.json()) as Partial<Discovery>;
    if (doc.issuer !== this.opts.issuer) throw new Error("OIDC discovery issuer mismatch");
    const checked: Discovery = {
      issuer: doc.issuer,
      authorization_endpoint: this.endpoint(doc.authorization_endpoint, "authorization_endpoint"),
      token_endpoint: this.endpoint(doc.token_endpoint, "token_endpoint"),
      jwks_uri: this.endpoint(doc.jwks_uri, "jwks_uri"),
    };
    this.discovery = checked;
    this.jwks = createRemoteJWKSet(new URL(checked.jwks_uri));
    return checked;
  }

  /**
   * Readiness before a service listens: discovery answers for the pinned issuer and its key set
   * is reachable. Throws with a reason; the caller refuses to start rather than fall back.
   */
  async ready(): Promise<void> {
    const d = await this.discover();
    const res = await fetch(d.jwks_uri, { signal: AbortSignal.timeout(10_000), redirect: "error" });
    if (!res.ok) throw new Error(`OIDC key set unavailable (${res.status})`);
    const body = (await res.json()) as { keys?: unknown };
    if (!Array.isArray(body.keys) || body.keys.length === 0) throw new Error("OIDC key set is empty");
  }

  async authorizationUrl(p: { state: string; nonce: string; codeVerifier: string }): Promise<string> {
    const d = await this.discover();
    const url = new URL(d.authorization_endpoint);
    url.search = new URLSearchParams({
      response_type: "code", client_id: this.opts.clientId, redirect_uri: this.opts.redirectUri, scope: "openid",
      state: p.state, nonce: p.nonce, code_challenge: s256(p.codeVerifier), code_challenge_method: "S256", prompt: "select_account",
    }).toString();
    return url.toString();
  }

  /** Exchanges the code and returns the verified ID token claims. Throws on any failure. */
  async verifyCallback(p: { code: string; codeVerifier: string; nonce: string }): Promise<JWTPayload> {
    const d = await this.discover();
    const res = await fetch(d.token_endpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code", code: p.code, redirect_uri: this.opts.redirectUri,
        client_id: this.opts.clientId, client_secret: this.opts.clientSecret(), code_verifier: p.codeVerifier,
      }),
      signal: AbortSignal.timeout(10_000),
      redirect: "error",
    });
    if (!res.ok) throw new Error(`OIDC token exchange failed (${res.status})`);
    const body = (await res.json()) as { id_token?: unknown };
    if (typeof body.id_token !== "string") throw new Error("OIDC token response has no id_token");
    const { payload } = await jwtVerify(body.id_token, this.jwks!, {
      issuer: this.opts.issuer, audience: this.opts.clientId, algorithms: ["RS256", "ES256"], clockTolerance: 30,
      ...(this.opts.now ? { currentDate: this.opts.now() } : {}),
    });
    // OIDC Core 3.1.3.7: with several audiences the authorized party must be this client, and a present azp always must.
    if ((Array.isArray(payload.aud) && payload.aud.length > 1 && payload.azp !== this.opts.clientId)
      || (payload.azp !== undefined && payload.azp !== this.opts.clientId)) throw new Error("OIDC authorized party mismatch");
    if (payload.nonce !== p.nonce) throw new Error("OIDC nonce mismatch");
    if (typeof payload.sub !== "string" || !payload.sub) throw new Error("OIDC token has no subject");
    return payload;
  }
}

/** D-A: exact (iss, sub). The only check that authorizes an identity; never email, domain or name. */
export function ownerPinMatches(claims: { iss?: unknown; sub?: unknown }, pin: OwnerPin): boolean {
  return typeof claims.iss === "string" && typeof claims.sub === "string" && claims.iss === pin.issuer && claims.sub === pin.subject;
}

export const s256 = (verifier: string) => createHash("sha256").update(verifier).digest("base64url");
