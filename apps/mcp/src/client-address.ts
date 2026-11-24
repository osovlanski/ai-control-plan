import type { IncomingMessage } from "node:http";
import { isIP } from "node:net";

/**
 * The key the OAuth endpoints rate-limit on (security review 2026-11-24, L2).
 *
 * The service binds loopback and cloudflared connects from loopback, so behind the tunnel every
 * peer is 127.0.0.1 and a per-address limit becomes one bucket for the whole internet. With
 * `trustCloudflareClientIp` on, the key is Cloudflare's `CF-Connecting-IP` instead. Cloudflare
 * overwrites that header on every proxied request, so a tunneled client cannot choose it; that only
 * holds while the tunnel is the sole ingress, which is why the flag is off by default.
 *
 * - The header must be exactly one IP address. Anything else (absent, a list, junk) falls back to
 *   the socket peer, which is what a request that did not come through Cloudflare looks like.
 * - IPv6 keys on the /64, because one subscriber is usually handed a whole /64 and could otherwise
 *   rotate through addresses to escape the limit. IPv4-mapped IPv6 keys as the IPv4 address.
 */
export function oauthClientKey(req: IncomingMessage, trustCloudflareClientIp: boolean): string {
  const peer = req.socket.remoteAddress ?? "unknown";
  if (trustCloudflareClientIp) {
    const cf = req.headers["cf-connecting-ip"];
    if (typeof cf === "string" && isIP(cf.trim()) !== 0) return `cf:${addressKey(cf.trim())}`;
  }
  return addressKey(peer);
}

/** IPv4 as is; IPv4-mapped IPv6 as its IPv4; other IPv6 as its /64 prefix; anything else unchanged. */
export function addressKey(address: string): string {
  const family = isIP(address);
  if (family === 4) return address;
  if (family !== 6) return address;
  const groups = expandV6(address.split("%")[0]!);
  if (groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff) {
    return `${groups[6]! >> 8}.${groups[6]! & 0xff}.${groups[7]! >> 8}.${groups[7]! & 0xff}`;
  }
  return `${groups.slice(0, 4).map((g) => g.toString(16)).join(":")}::/64`;
}

function expandV6(address: string): number[] {
  let text = address.toLowerCase();
  // A dotted IPv4 tail (::ffff:1.2.3.4) becomes two groups.
  const dotted = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(text);
  if (dotted) {
    const [a, b, c, d] = dotted.slice(1).map(Number) as [number, number, number, number];
    text = `${text.slice(0, dotted.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head, tail] = text.includes("::") ? text.split("::") as [string, string] : [text, undefined];
  const left = head ? head.split(":") : [];
  const right = tail === undefined ? [] : tail ? tail.split(":") : [];
  const fill = tail === undefined ? [] : new Array<string>(8 - left.length - right.length).fill("0");
  return [...left, ...fill, ...right].map((g) => parseInt(g, 16));
}
