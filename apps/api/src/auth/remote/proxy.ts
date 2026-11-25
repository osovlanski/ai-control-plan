import type { IncomingMessage } from "node:http";
import { isIP } from "node:net";
import type { RemoteAuthConfig } from "./config.js";

/**
 * The trusted-proxy contract of the remote listener (Tailscale Serve, D-A/D-B). Tailscale Serve
 * terminates TLS for the tailnet name and proxies with Go's ReverseProxy `Rewrite`, which drops
 * every client `Forwarded`/`X-Forwarded-*` field and then sets exactly one `X-Forwarded-Host`,
 * `X-Forwarded-Proto: https` and `X-Forwarded-For`; it clears client `Tailscale-User-*` fields and
 * sets `Tailscale-User-Login` only for a user-owned tailnet node (never Funnel, never tagged).
 *
 * So a request is accepted only when ALL hold, checked before cookies, login, data or streams:
 *   - the socket peer is a configured loopback peer (the proxy on this box);
 *   - exactly one Host and one X-Forwarded-Host, both the canonical authority;
 *   - exactly one X-Forwarded-Proto, `https`;
 *   - exactly one X-Forwarded-For holding a single IP, no zone id (the limiter's client address,
 *     in its canonical spelling);
 *   - no `Forwarded` and no `Tailscale-Funnel-Request` field;
 *   - exactly one Tailscale-User-Login equal to the configured owner login.
 * The login header is a second factor on the network path, never the identity: a process on the
 * box that can reach loopback could forge it, which is why the OIDC session is still required.
 */
export type ProxyVerdict = { ok: true; clientAddress: string } | { ok: false; reason: string };

function values(req: IncomingMessage, name: string): string[] {
  const out: string[] = [];
  const raw = req.rawHeaders;
  for (let i = 0; i + 1 < raw.length; i += 2) if (raw[i]!.toLowerCase() === name) out.push(raw[i + 1]!);
  return out;
}

/**
 * One spelling per address, so the login limiter cannot be split by writing the same IPv6 address
 * two ways (Codex review 4). IPv4 and IPv4-mapped IPv6 become dotted IPv4; other IPv6 becomes the
 * WHATWG canonical (RFC 5952) form. A zone id, or anything not an IP, yields undefined.
 */
export function canonicalIp(raw: string): string | undefined {
  const text = raw.trim();
  const family = isIP(text);
  if (family === 4) return text;
  if (family !== 6 || text.includes("%")) return undefined;
  let host: string;
  try { host = new URL(`http://[${text}]/`).hostname.slice(1, -1); } catch { return undefined; }
  const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(host);
  if (mapped) {
    const hi = parseInt(mapped[1]!, 16); const lo = parseInt(mapped[2]!, 16);
    return `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
  }
  return host;
}

export const normalizePeer = (addr: string | undefined) => (addr?.startsWith("::ffff:") ? addr.slice(7) : addr) ?? "";

export function checkProxyContract(req: IncomingMessage, cfg: RemoteAuthConfig): ProxyVerdict {
  const peer = normalizePeer(req.socket.remoteAddress);
  if (!cfg.transport.peers.includes(peer)) return { ok: false, reason: "untrusted_peer" };
  const authority = new URL(cfg.canonicalOrigin).host;
  const host = values(req, "host");
  if (host.length !== 1 || host[0]!.toLowerCase() !== authority) return { ok: false, reason: "authority" };
  const fwdHost = values(req, "x-forwarded-host");
  if (fwdHost.length !== 1 || fwdHost[0]!.toLowerCase() !== authority) return { ok: false, reason: "forwarded_host" };
  const proto = values(req, "x-forwarded-proto");
  if (proto.length !== 1 || proto[0] !== "https") return { ok: false, reason: "forwarded_proto" };
  const fwdFor = values(req, "x-forwarded-for");
  const clientAddress = fwdFor.length === 1 ? canonicalIp(fwdFor[0]!) : undefined;
  if (!clientAddress) return { ok: false, reason: "forwarded_for" };
  if (values(req, "forwarded").length) return { ok: false, reason: "forwarded" };
  if (values(req, "tailscale-funnel-request").length) return { ok: false, reason: "funnel" };
  const login = values(req, "tailscale-user-login");
  if (login.length !== 1 || login[0] !== cfg.transport.tailscaleUserLogin) return { ok: false, reason: "tailscale_login" };
  return { ok: true, clientAddress };
}
