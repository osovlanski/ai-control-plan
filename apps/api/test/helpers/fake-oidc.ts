import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { exportJWK, generateKeyPair, SignJWT, type JWK } from "jose";

/**
 * A loopback fake OIDC issuer for remote-auth tests (same shape as apps/mcp's test issuer).
 * `/authorize` signs in instantly as `loginAs` and redirects back with a one-use code; `/token`
 * checks client secret, redirect URI and PKCE before signing an ID token. No real IdP is touched.
 */
export const FAKE_CLIENT_ID = "FAKE-web-client-not-real";
export const FAKE_CLIENT_SECRET = "FAKE-web-client-secret-not-real";
export const OWNER_SUB = "FAKE-owner-sub-not-real";

export interface FakeIssuer {
  issuer: string;
  loginAs: { sub: string; iss?: string; aud?: string; email?: string; nonce?: string; signWithOtherKey?: boolean };
  /** Number of token exchanges served (a replayed callback must never reach one). */
  exchanges: number;
  close(): Promise<void>;
}

export async function startFakeIssuer(): Promise<FakeIssuer> {
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const other = await generateKeyPair("RS256");
  const jwk: JWK = { ...(await exportJWK(publicKey)), kid: "fake-1", alg: "RS256", use: "sig" };
  const codes = new Map<string, { nonce: string; challenge: string; redirectUri: string; login: FakeIssuer["loginAs"] }>();
  let n = 0;
  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", state.issuer);
    if (url.pathname === "/.well-known/openid-configuration") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ issuer: state.issuer, authorization_endpoint: `${state.issuer}/authorize`, token_endpoint: `${state.issuer}/token`, jwks_uri: `${state.issuer}/jwks` }));
    }
    if (url.pathname === "/jwks") { res.writeHead(200, { "content-type": "application/json" }); return res.end(JSON.stringify({ keys: [jwk] })); }
    if (url.pathname === "/authorize") {
      const q = url.searchParams;
      if (q.get("client_id") !== FAKE_CLIENT_ID || q.get("scope") !== "openid" || q.get("code_challenge_method") !== "S256" || q.get("response_type") !== "code") { res.writeHead(400); return res.end("bad authorize"); }
      const code = `FAKE-google-code-${++n}-not-real`;
      codes.set(code, { nonce: q.get("nonce")!, challenge: q.get("code_challenge")!, redirectUri: q.get("redirect_uri")!, login: { ...state.loginAs } });
      const back = new URL(q.get("redirect_uri")!);
      back.searchParams.set("code", code);
      back.searchParams.set("state", q.get("state")!);
      res.writeHead(302, { location: back.toString() });
      return res.end();
    }
    if (url.pathname === "/token" && req.method === "POST") {
      state.exchanges += 1;
      let raw = ""; for await (const c of req) raw += c;
      const f = new URLSearchParams(raw);
      const entry = codes.get(f.get("code") ?? "");
      codes.delete(f.get("code") ?? "");
      const verifierOk = entry && createHash("sha256").update(f.get("code_verifier") ?? "").digest("base64url") === entry.challenge;
      if (!entry || !verifierOk || f.get("client_secret") !== FAKE_CLIENT_SECRET || f.get("redirect_uri") !== entry.redirectUri) { res.writeHead(400); return res.end('{"error":"invalid_grant"}'); }
      const l = entry.login;
      const idToken = await new SignJWT({ nonce: l.nonce ?? entry.nonce, ...(l.email ? { email: l.email, email_verified: true } : {}) })
        .setProtectedHeader({ alg: "RS256", kid: "fake-1" }).setIssuer(l.iss ?? state.issuer).setSubject(l.sub)
        .setAudience(l.aud ?? FAKE_CLIENT_ID).setIssuedAt().setExpirationTime("5m").sign(l.signWithOtherKey ? other.privateKey : privateKey);
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ id_token: idToken, access_token: "FAKE-google-access-not-real", token_type: "Bearer" }));
    }
    res.writeHead(404); res.end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const state: FakeIssuer = {
    issuer: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    loginAs: { sub: OWNER_SUB },
    exchanges: 0,
    close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }),
  };
  return state;
}
