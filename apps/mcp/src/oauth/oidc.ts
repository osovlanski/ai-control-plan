import { createHash } from "node:crypto";
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";

/**
 * The MCP service as an OIDC relying party of the owner's identity provider (D-A: Google).
 * Only `openid` is requested; the ID token is verified (signature, iss, aud, exp, nonce) and the
 * Google tokens are discarded. Authorization is the exact (iss, sub) pin, checked by the caller.
 */
interface Discovery { issuer: string; authorization_endpoint: string; token_endpoint: string; jwks_uri: string }

export class OidcClient {
  private discovery?: Discovery;
  private jwks?: ReturnType<typeof createRemoteJWKSet>;

  constructor(private readonly opts: { issuer: string; clientId: string; clientSecret: () => string; redirectUri: string }) {}

  private async discover(): Promise<Discovery> {
    if (this.discovery) return this.discovery;
    const res = await fetch(`${this.opts.issuer}/.well-known/openid-configuration`, { signal: AbortSignal.timeout(10_000), redirect: "error" });
    if (!res.ok) throw new Error(`OIDC discovery failed (${res.status})`);
    const doc = (await res.json()) as Discovery;
    if (doc.issuer !== this.opts.issuer) throw new Error("OIDC discovery issuer mismatch");
    this.discovery = doc;
    this.jwks = createRemoteJWKSet(new URL(doc.jwks_uri));
    return doc;
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
    });
    if (payload.nonce !== p.nonce) throw new Error("OIDC nonce mismatch");
    if (typeof payload.sub !== "string" || !payload.sub) throw new Error("OIDC token has no subject");
    return payload;
  }
}

export const s256 = (verifier: string) => createHash("sha256").update(verifier).digest("base64url");
