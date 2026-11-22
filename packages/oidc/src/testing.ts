import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { exportJWK, generateKeyPair, SignJWT, type JWK } from "jose";

/**
 * A loopback fake OIDC issuer for tests and drives (no provider login, no network beyond
 * 127.0.0.1). `/authorize` signs the "user" in instantly as `loginAs` and redirects back with a
 * single-use code; `/token` checks client secret, redirect URI and PKCE before issuing an ID token.
 * Every value it mints is a FAKE-*-not-real string.
 */
export interface FakeLogin {
  sub: string;
  /** Overrides the token's issuer (wrong-issuer case). */
  iss?: string;
  email?: string;
  /** Overrides the audience (wrong-audience case). */
  aud?: string | string[];
  azp?: string;
  /** Replaces the nonce the relying party sent (nonce mismatch case). */
  nonce?: string;
  /** Signs with a key that is not in the published key set (bad signature case). */
  forgeSignature?: boolean;
  /** Seconds from now the token expires; negative means already expired. Default 300. */
  expiresIn?: number;
}

export interface FakeIssuer {
  issuer: string;
  clientId: string;
  clientSecret: string;
  /** Who the next login signs in as. */
  loginAs: FakeLogin;
  /** Count of successful code exchanges. */
  exchanges: number;
  close(): Promise<void>;
}

export async function startFakeIssuer(opts: { clientId?: string; clientSecret?: string; sub?: string; now?: () => Date } = {}): Promise<FakeIssuer> {
  const clientId = opts.clientId ?? "FAKE-oidc-client-not-real";
  const clientSecret = opts.clientSecret ?? "FAKE-oidc-secret-not-real";
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const forger = await generateKeyPair("RS256");
  const jwk: JWK = { ...(await exportJWK(publicKey)), kid: "fake-1", alg: "RS256", use: "sig" };
  const codes = new Map<string, { nonce: string; challenge: string; redirectUri: string; login: FakeLogin }>();
  let n = 0;
  const server: Server = createServer();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const issuer = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const state: FakeIssuer = { issuer, clientId, clientSecret, loginAs: { sub: opts.sub ?? "FAKE-owner-sub-not-real" }, exchanges: 0, close: async () => {} };
  server.on("request", (req, res) => void (async () => {
    const url = new URL(req.url ?? "/", issuer);
    if (url.pathname === "/.well-known/openid-configuration") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`, jwks_uri: `${issuer}/jwks` }));
    }
    if (url.pathname === "/jwks") { res.writeHead(200, { "content-type": "application/json" }); return res.end(JSON.stringify({ keys: [jwk] })); }
    if (url.pathname === "/authorize") {
      const q = url.searchParams;
      if (q.get("client_id") !== clientId || q.get("scope") !== "openid" || q.get("code_challenge_method") !== "S256" || q.get("response_type") !== "code") {
        res.writeHead(400); return res.end("bad authorize");
      }
      const code = `FAKE-oidc-code-${++n}-not-real`;
      codes.set(code, { nonce: q.get("nonce")!, challenge: q.get("code_challenge")!, redirectUri: q.get("redirect_uri")!, login: { ...state.loginAs } });
      const back = new URL(q.get("redirect_uri")!);
      back.searchParams.set("code", code);
      back.searchParams.set("state", q.get("state")!);
      res.writeHead(302, { location: back.toString() });
      return res.end();
    }
    if (url.pathname === "/token" && req.method === "POST") {
      let raw = ""; for await (const c of req) raw += String(c);
      const f = new URLSearchParams(raw);
      const entry = codes.get(f.get("code") ?? "");
      codes.delete(f.get("code") ?? "");
      const verifierOk = entry && createHash("sha256").update(f.get("code_verifier") ?? "").digest("base64url") === entry.challenge;
      if (!entry || !verifierOk || f.get("client_id") !== clientId || f.get("client_secret") !== clientSecret || f.get("redirect_uri") !== entry.redirectUri) {
        res.writeHead(400, { "content-type": "application/json" }); return res.end('{"error":"invalid_grant"}');
      }
      const l = entry.login;
      const nowS = Math.floor((opts.now?.() ?? new Date()).getTime() / 1000);
      const idToken = await new SignJWT({ nonce: l.nonce ?? entry.nonce, ...(l.email ? { email: l.email, email_verified: true } : {}), ...(l.azp ? { azp: l.azp } : {}) })
        .setProtectedHeader({ alg: "RS256", kid: "fake-1" }).setIssuer(l.iss ?? issuer).setSubject(l.sub)
        .setAudience(l.aud ?? clientId).setIssuedAt(nowS).setExpirationTime(nowS + (l.expiresIn ?? 300))
        .sign(l.forgeSignature ? forger.privateKey : privateKey);
      state.exchanges += 1;
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ id_token: idToken, access_token: "FAKE-oidc-access-not-real", token_type: "Bearer" }));
    }
    res.writeHead(404); res.end();
  })());
  state.close = () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); });
  return state;
}
