import { afterEach, describe, expect, it } from "vitest";
import { OidcClient, ownerPinMatches, s256 } from "../src/index.js";
import { startFakeIssuer, type FakeIssuer } from "../src/testing.js";

let issuer: FakeIssuer | undefined;
afterEach(async () => { await issuer?.close(); issuer = undefined; });

const client = (i: FakeIssuer, redirectUri = "https://app.example-not-real/cb") =>
  new OidcClient({ issuer: i.issuer, clientId: i.clientId, clientSecret: () => i.clientSecret, redirectUri });

/** Runs the authorize step against the fake issuer and returns the code it redirects back with. */
async function authorize(c: OidcClient, nonce: string, verifier: string): Promise<string> {
  const url = await c.authorizationUrl({ state: "FAKE-state-not-real", nonce, codeVerifier: verifier });
  const res = await fetch(url, { redirect: "manual" });
  return new URL(res.headers.get("location")!).searchParams.get("code")!;
}

describe("ownerPinMatches (D-A)", () => {
  const pin = { issuer: "https://accounts.google.com", subject: "1234" };
  it("matches only the exact (iss, sub) pair", () => {
    expect(ownerPinMatches({ iss: pin.issuer, sub: pin.subject }, pin)).toBe(true);
    for (const claims of [{ iss: pin.issuer, sub: "12345" }, { iss: "https://accounts.google.com/", sub: "1234" }, { sub: "1234" }, { iss: pin.issuer }, { iss: pin.issuer, sub: 1234 }, {}]) {
      expect(ownerPinMatches(claims, pin), JSON.stringify(claims)).toBe(false);
    }
  });
});

describe("OidcClient", () => {
  it("sends PKCE S256 and the openid scope, and verifies the owner's ID token", async () => {
    issuer = await startFakeIssuer();
    const c = client(issuer);
    await c.ready();
    const url = new URL(await c.authorizationUrl({ state: "s", nonce: "n", codeVerifier: "v".repeat(43) }));
    expect(url.searchParams.get("scope")).toBe("openid");
    expect(url.searchParams.get("code_challenge")).toBe(s256("v".repeat(43)));
    const code = await authorize(c, "FAKE-nonce-not-real", "w".repeat(43));
    const claims = await c.verifyCallback({ code, codeVerifier: "w".repeat(43), nonce: "FAKE-nonce-not-real" });
    expect(claims.sub).toBe(issuer.loginAs.sub);
  });

  it("rejects a wrong verifier, nonce, audience, authorized party or signature", async () => {
    issuer = await startFakeIssuer();
    const c = client(issuer);
    const v = "x".repeat(43);
    await expect(c.verifyCallback({ code: await authorize(c, "n1", v), codeVerifier: "y".repeat(43), nonce: "n1" })).rejects.toThrow();
    await expect(c.verifyCallback({ code: await authorize(c, "n2", v), codeVerifier: v, nonce: "other" })).rejects.toThrow(/nonce/);
    for (const login of [{ aud: "FAKE-other-not-real" }, { aud: [issuer.clientId, "FAKE-other-not-real"] }, { azp: "FAKE-other-not-real" }, { forgeSignature: true }]) {
      issuer.loginAs = { sub: "FAKE-owner-sub-not-real", ...login };
      await expect(c.verifyCallback({ code: await authorize(c, "n3", v), codeVerifier: v, nonce: "n3" }), JSON.stringify(login)).rejects.toThrow();
    }
  });

  it("refuses discovery for another issuer", async () => {
    issuer = await startFakeIssuer();
    const c = new OidcClient({ issuer: `${issuer.issuer}/other`, clientId: issuer.clientId, clientSecret: () => issuer!.clientSecret, redirectUri: "https://a.example-not-real/cb" });
    await expect(c.ready()).rejects.toThrow();
  });
});
