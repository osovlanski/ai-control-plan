import { digestString } from "./fingerprint.js";

export type NormalizedRemoteIdentity =
  | { kind: "normalized"; value: string; fingerprint: string }
  | { kind: "unsupported" };

function normalizeParts(hostname: string, port: string, pathname: string): NormalizedRemoteIdentity {
  let path: string;
  try {
    path = decodeURIComponent(pathname);
  } catch {
    return { kind: "unsupported" };
  }
  const host = hostname.toLowerCase();
  const cleanPort = port === "22" || port === "443" || port === "" ? "" : `:${port}`;
  path = path.replace(/^\/+|\/+$/g, "").replace(/\.git$/i, "");
  if (!host || !path || path.includes("\0")) return { kind: "unsupported" };
  const value = `${host}${cleanPort}/${path}`;
  return { kind: "normalized", value, fingerprint: digestString(value) };
}

/**
 * Credential-safe correlation identity for supported Git remotes. The raw
 * remote is never included in errors or returned values. This digest is a
 * local correlation key, not a privacy or cryptographic boundary.
 */
export function normalizeRemoteIdentity(raw: string): NormalizedRemoteIdentity {
  if (/^[A-Za-z]:[\\/]/.test(raw)) return { kind: "unsupported" };
  const scp = /^(?:[^@/:]+@)?(\[[^\]]+\]|[^/:]+):(.+)$/.exec(raw);
  if (scp && !raw.includes("://")) {
    return normalizeParts(scp[1]!.replace(/^\[|\]$/g, ""), "", scp[2]!);
  }
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== "https:" && parsed.protocol !== "ssh:") return { kind: "unsupported" };
    return normalizeParts(parsed.hostname, parsed.port, parsed.pathname);
  } catch {
    return { kind: "unsupported" };
  }
}
