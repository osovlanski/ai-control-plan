import { promises as dns, type LookupAddress } from "node:dns";
import type { IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP, type LookupFunction } from "node:net";

/**
 * Client ID Metadata Document fetch (security review 2026-11-24, L1). `cimdUrl` in server.ts already
 * refuses IP literals and local-looking names, but a public name can still resolve to loopback,
 * RFC 1918 or the metadata address. So this fetch:
 *
 * - resolves the name once, refuses it when any answer is not a public unicast address, and then
 *   connects only to that vetted address (the socket's `lookup` is pinned), so a second DNS answer
 *   cannot rebind the connection; TLS still checks the certificate against the name;
 * - accepts only a 200 with no redirect, reads at most `maxBytes` (Content-Length is checked first,
 *   then the stream is counted and cut), and
 * - bounds the whole exchange, DNS included, by one deadline.
 */
export const CIMD_MAX_BYTES = 16_384;
export const CIMD_TIMEOUT_MS = 5_000;
export const CIMD_CACHE_TTL_MS = 5 * 60_000;
const CIMD_CACHE_MAX = 256;

export class CimdFetchError extends Error {
  constructor(readonly reason: "scheme" | "dns" | "address" | "status" | "too_large" | "timeout" | "json" | "network", message: string) {
    super(message);
    this.name = "CimdFetchError";
  }
}

// Special-purpose IPv4 ranges (IANA registry) that a public client metadata host never uses.
const BLOCKED_V4: Array<[string, number]> = [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12],
  ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15],
  ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
];
// IPv6 is allow-listed to global unicast (2000::/3), minus the parts of it that are not a plain host:
// IETF assignments incl. Teredo, documentation, and 6to4 (which embeds an arbitrary IPv4 address).
// Everything outside 2000::/3 is refused, which covers ::, ::1, IPv4-mapped/compatible, NAT64
// (64:ff9b::/96 can embed a private IPv4), ULA fc00::/7, link-local fe80::/10 and multicast.
const BLOCKED_V6: Array<[string, number]> = [["2001::", 23], ["2001:db8::", 32], ["2002::", 16], ["3fff::", 20]];

const blockedV4 = new BlockList();
for (const [net, prefix] of BLOCKED_V4) blockedV4.addSubnet(net, prefix, "ipv4");
const blockedV6 = new BlockList();
for (const [net, prefix] of BLOCKED_V6) blockedV6.addSubnet(net, prefix, "ipv6");
const globalV6 = new BlockList();
globalV6.addSubnet("2000::", 3, "ipv6");

/** True only for a public unicast IPv4 or IPv6 address. Anything unparsable is not public. */
export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !blockedV4.check(address, "ipv4");
  if (family === 6) return globalV6.check(address, "ipv6") && !blockedV6.check(address, "ipv6");
  return false;
}

export interface CimdFetchOptions {
  /** Name resolution (tests inject one). Default: the system resolver, every answer. */
  resolve?: (host: string) => Promise<LookupAddress[]>;
  /** Which resolved addresses may be contacted. Default `isPublicAddress`; tests widen it to reach a loopback fixture. */
  addressAllowed?: (address: string) => boolean;
  /** Tests only: the fixture's port and CA. Production always uses 443 and the system roots. */
  port?: number;
  ca?: string | Buffer;
  timeoutMs?: number;
  maxBytes?: number;
}

const systemResolve = (host: string) => dns.lookup(host, { all: true, verbatim: true });

export async function fetchClientMetadataDocument(url: string, o: CimdFetchOptions = {}): Promise<unknown> {
  const u = new URL(url);
  if (u.protocol !== "https:") throw new CimdFetchError("scheme", "client metadata must be fetched over https");
  const host = u.hostname;
  const maxBytes = o.maxBytes ?? CIMD_MAX_BYTES;
  const allowed = o.addressAllowed ?? isPublicAddress;
  const deadline = Date.now() + (o.timeoutMs ?? CIMD_TIMEOUT_MS);

  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new CimdFetchError("timeout", "client metadata fetch timed out")), Math.max(0, deadline - Date.now()));
  });
  try {
    let answers: LookupAddress[];
    try { answers = await Promise.race([(o.resolve ?? systemResolve)(host), timeout]); } catch (e) {
      if (e instanceof CimdFetchError) throw e;
      throw new CimdFetchError("dns", "client metadata host did not resolve");
    }
    if (answers.length === 0) throw new CimdFetchError("dns", "client metadata host did not resolve");
    // Refuse when any answer is private, so a name cannot mix a public and a private address.
    if (answers.some((a) => !allowed(a.address))) throw new CimdFetchError("address", "client metadata host resolves to a non-public address");
    const pinned = answers[0]!;
    return await Promise.race([get(u, pinned, o, maxBytes, deadline), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

function get(u: URL, pinned: LookupAddress, o: CimdFetchOptions, maxBytes: number, deadline: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (err: Error | null, value?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(cut);
      if (err) { req.destroy(); reject(err); } else resolve(value);
    };
    // The socket connects to the vetted address only, whatever the resolver would answer now.
    const lookup: LookupFunction = (_host, options, cb) => {
      if ((options as { all?: boolean }).all) (cb as unknown as (e: null, a: LookupAddress[]) => void)(null, [pinned]);
      else cb(null, pinned.address, pinned.family);
    };
    const req = httpsRequest({
      host: u.hostname, servername: isIP(u.hostname) ? undefined : u.hostname, port: o.port ?? 443,
      path: `${u.pathname}${u.search}`, method: "GET", agent: false, lookup,
      headers: { accept: "application/json", host: u.host, "user-agent": "agent-os-mcp" },
      ...(o.ca ? { ca: o.ca } : {}),
    }, (res: IncomingMessage) => {
      // No redirects (a 3xx is refused like any other non-200).
      if (res.statusCode !== 200) { res.resume(); return done(new CimdFetchError("status", `client metadata fetch failed (${res.statusCode})`)); }
      const declared = Number(res.headers["content-length"]);
      if (Number.isFinite(declared) && declared > maxBytes) return done(new CimdFetchError("too_large", "client metadata document too large"));
      const chunks: Buffer[] = [];
      let size = 0;
      res.on("data", (c: Buffer) => {
        size += c.length;
        if (size > maxBytes) return done(new CimdFetchError("too_large", "client metadata document too large"));
        chunks.push(c);
      });
      res.on("end", () => {
        try { done(null, JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown); } catch { done(new CimdFetchError("json", "client metadata document is not JSON")); }
      });
      res.on("error", () => done(new CimdFetchError("network", "client metadata fetch failed")));
      res.on("close", () => { if (!res.complete) done(new CimdFetchError("network", "client metadata fetch was cut off")); });
    });
    const cut = setTimeout(() => done(new CimdFetchError("timeout", "client metadata fetch timed out")), Math.max(0, deadline - Date.now()));
    req.on("error", () => done(new CimdFetchError("network", "client metadata fetch failed")));
    req.end();
  });
}

/**
 * A short positive cache in front of a CIMD fetcher, so a known client's authorize does not refetch
 * its document every time. Failures are not cached; a changed document is seen after the TTL.
 */
export function cachedClientMetadata(
  fetchDoc: (url: string) => Promise<unknown>,
  opts: { ttlMs?: number; now?: () => number } = {},
): (url: string) => Promise<unknown> {
  const ttl = opts.ttlMs ?? CIMD_CACHE_TTL_MS;
  const now = opts.now ?? Date.now;
  const cache = new Map<string, { at: number; doc: unknown }>();
  return async (url) => {
    const hit = cache.get(url);
    if (hit && now() - hit.at < ttl) return hit.doc;
    const doc = await fetchDoc(url);
    cache.delete(url);
    cache.set(url, { at: now(), doc });
    if (cache.size > CIMD_CACHE_MAX) cache.delete(cache.keys().next().value!);
    return doc;
  };
}
