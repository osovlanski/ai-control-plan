/**
 * L1 (security review 2026-11-24): the CIMD fetch resolves once, refuses non-public addresses,
 * connects only to the vetted address, caps the body and bounds the time. The fixture is a real TLS
 * server on loopback with a test-only certificate for a fake public name; nothing leaves the box.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:https";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CimdFetchError, cachedClientMetadata, fetchClientMetadataDocument, isPublicAddress, type CimdFetchOptions } from "../src/oauth/cimd-fetch.js";

const HOST = "client.example.org";
const DOC = { client_id: `https://${HOST}/oauth/metadata.json`, client_name: "Fixture", redirect_uris: ["https://claude.ai/api/mcp/auth_callback"] };

let dir: string;
let server: Server;
let port: number;
let ca: Buffer;
let hits = 0;
let handler: (req: IncomingMessage, res: ServerResponse) => void = () => {};

function cert(name: string, prefix: string) {
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", join(dir, `${prefix}key.pem`), "-out", join(dir, `${prefix}cert.pem`),
    "-days", "1", "-subj", `/CN=${name}`, "-addext", `subjectAltName=DNS:${name}`], { stdio: "ignore" });
  return { key: readFileSync(join(dir, `${prefix}key.pem`)), cert: readFileSync(join(dir, `${prefix}cert.pem`)) };
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "aos-cimd-"));
  const pair = cert(HOST, "");
  ca = pair.cert;
  server = createServer(pair, (req, res) => { hits++; handler(req, res); });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  port = (server.address() as AddressInfo).port;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
  rmSync(dir, { recursive: true, force: true });
});

/** Options that reach the loopback fixture: the name resolves to 127.0.0.1 and only that address is allowed. */
const fixture = (over: Partial<CimdFetchOptions> = {}): CimdFetchOptions => ({
  resolve: async () => [{ address: "127.0.0.1", family: 4 }], addressAllowed: (a) => a === "127.0.0.1", port, ca, ...over,
});
const reason = async (p: Promise<unknown>) => { try { await p; return "resolved"; } catch (e) { return e instanceof CimdFetchError ? e.reason : `other:${String(e)}`; } };

describe("isPublicAddress", () => {
  it("refuses loopback, private, link-local, CGNAT, metadata, mapped, NAT64, 6to4, ULA and multicast", () => {
    for (const a of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0",
      "224.0.0.1", "255.255.255.255", "198.18.0.1", "192.0.2.1", "::1", "::", "fe80::1", "fc00::1", "fd12:3456::1", "::ffff:127.0.0.1",
      "::ffff:7f00:1", "::ffff:8.8.8.8", "64:ff9b::a00:1", "2002:a00:1::1", "2001:db8::1", "2001::1", "ff02::1", "not-an-ip", ""]) {
      expect(isPublicAddress(a), a).toBe(false);
    }
  });
  it("accepts public unicast IPv4 and IPv6", () => {
    for (const a of ["8.8.8.8", "1.1.1.1", "160.79.104.10", "172.32.0.1", "2606:4700:4700::1111", "2a00:1450:4001::200e"]) expect(isPublicAddress(a), a).toBe(true);
  });
});

describe("fetchClientMetadataDocument", () => {
  it("fetches the document over TLS from the pinned address, resolving once", async () => {
    handler = (_req, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(DOC)); };
    let resolved = 0;
    // client.example.org has no real record pointing here, so reaching the fixture proves the socket used the pinned answer.
    const doc = await fetchClientMetadataDocument(DOC.client_id, fixture({ resolve: async () => { resolved++; return [{ address: "127.0.0.1", family: 4 }]; } }));
    expect(doc).toEqual(DOC);
    expect(resolved).toBe(1);
  });

  it("refuses a name that resolves to a private address, and a mixed answer, before connecting", async () => {
    const before = hits;
    expect(await reason(fetchClientMetadataDocument(DOC.client_id, { resolve: async () => [{ address: "127.0.0.1", family: 4 }], port, ca }))).toBe("address");
    expect(await reason(fetchClientMetadataDocument(DOC.client_id, { resolve: async () => [{ address: "169.254.169.254", family: 4 }], port, ca }))).toBe("address");
    expect(await reason(fetchClientMetadataDocument(DOC.client_id, fixture({ resolve: async () => [{ address: "127.0.0.1", family: 4 }, { address: "10.0.0.1", family: 4 }] })))).toBe("address");
    expect(await reason(fetchClientMetadataDocument(DOC.client_id, { resolve: async () => [{ address: "fd00::1", family: 6 }], port, ca }))).toBe("address");
    expect(await reason(fetchClientMetadataDocument(DOC.client_id, fixture({ resolve: async () => [] })))).toBe("dns");
    expect(await reason(fetchClientMetadataDocument(DOC.client_id, fixture({ resolve: async () => { throw new Error("ENOTFOUND"); } })))).toBe("dns");
    expect(await reason(fetchClientMetadataDocument(`http://${HOST}/m.json`, fixture()))).toBe("scheme");
    expect(hits).toBe(before);
  });

  it("caps the body: a declared or a streamed body over 16 KiB is refused", async () => {
    const big = JSON.stringify({ ...DOC, pad: "x".repeat(20_000) });
    handler = (_req, res) => { res.writeHead(200, { "content-type": "application/json", "content-length": Buffer.byteLength(big) }); res.end(big); };
    expect(await reason(fetchClientMetadataDocument(DOC.client_id, fixture()))).toBe("too_large");
    // Chunked, no Content-Length, and the server would keep sending: the read is cut at the cap.
    handler = (_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      const t = setInterval(() => { if (!res.write("x".repeat(4096))) return; }, 1);
      res.on("close", () => clearInterval(t));
    };
    expect(await reason(fetchClientMetadataDocument(DOC.client_id, fixture()))).toBe("too_large");
  });

  it("bounds the time: no answer, a drip-fed body and a slow resolver all time out", async () => {
    handler = () => { /* never answers */ };
    let started = Date.now();
    expect(await reason(fetchClientMetadataDocument(DOC.client_id, fixture({ timeoutMs: 300 })))).toBe("timeout");
    expect(Date.now() - started).toBeLessThan(2000);
    handler = (_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      const t = setInterval(() => res.write(" "), 50);
      res.on("close", () => clearInterval(t));
    };
    started = Date.now();
    expect(await reason(fetchClientMetadataDocument(DOC.client_id, fixture({ timeoutMs: 400 })))).toBe("timeout");
    expect(Date.now() - started).toBeLessThan(2000);
    expect(await reason(fetchClientMetadataDocument(DOC.client_id, fixture({ timeoutMs: 200, resolve: () => new Promise(() => {}) })))).toBe("timeout");
  });

  it("refuses redirects and other non-200 answers, non-JSON, and a certificate for another name", async () => {
    handler = (_req, res) => { res.writeHead(302, { location: "https://169.254.169.254/latest/meta-data/" }); res.end(); };
    expect(await reason(fetchClientMetadataDocument(DOC.client_id, fixture()))).toBe("status");
    handler = (_req, res) => { res.writeHead(404); res.end(); };
    expect(await reason(fetchClientMetadataDocument(DOC.client_id, fixture()))).toBe("status");
    handler = (_req, res) => { res.writeHead(200); res.end("<html>"); };
    expect(await reason(fetchClientMetadataDocument(DOC.client_id, fixture()))).toBe("json");
    handler = (_req, res) => { res.writeHead(200); res.end(JSON.stringify(DOC)); };
    // Same pinned address, but the URL names a host the certificate does not cover.
    expect(await reason(fetchClientMetadataDocument("https://other.example.org/oauth/metadata.json", fixture()))).toBe("network");
  });
});

describe("cachedClientMetadata", () => {
  it("serves a document from cache within the TTL, refetches after it, and never caches a failure", async () => {
    let t = 0;
    let calls = 0;
    let fail = true;
    const cached = cachedClientMetadata(async () => { calls++; if (fail) throw new Error("down"); return DOC; }, { ttlMs: 1000, now: () => t });
    await expect(cached("u")).rejects.toThrow("down");
    fail = false;
    expect(await cached("u")).toEqual(DOC);
    expect(await cached("u")).toEqual(DOC);
    expect(calls).toBe(2);
    t = 1000;
    await cached("u");
    expect(calls).toBe(3);
  });
});
