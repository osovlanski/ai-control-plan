import { statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { COMMAND_CAPABILITIES, OBSERVABILITY_CAPABILITIES, TASK_COMMAND_CAPABILITIES } from "@agent-plane/core";

/**
 * `api.remote` (docs/adr/remote-auth-design.md, "Explicit configuration contract", as amended for
 * B2): the second loopback listener that Tailscale Serve proxies to. Absent means no remote
 * listener and no remote routes: the local listener, bootstrap and bearer CLI are unchanged
 * either way (D-B). Every key is validated strictly; an unknown key anywhere in the block is an
 * error, so a typo can never silently weaken it.
 */
export interface RemoteLimits {
  loginPerMinutePerAddress: number;
  loginPerMinuteInstance: number;
  pendingLogins: number;
  commandsPerMinutePerPrincipal: number;
  commandsPerMinuteInstance: number;
  startsPerMinute: number;
  readsPerMinutePerSession: number;
  streamOpensPerMinutePerSession: number;
  activeStreamsPerSession: number;
  activeStreamsInstance: number;
}

export interface RemoteAuthConfig {
  /** Loopback port of the remote listener. Always bound on 127.0.0.1, never the local api.port. */
  port: number;
  /** The one browser + API origin (one-origin topology): normalized https, no path. Never derived from Host. */
  canonicalOrigin: string;
  /** The only transport this slice implements: a TLS-terminating proxy on loopback (Tailscale Serve). */
  transport: { kind: "trusted-proxy"; peers: string[]; tailscaleUserLogin: string };
  /** D-A: Google OIDC (any pinned issuer), exact (iss, sub) owner. */
  identity: { issuer: string; clientId: string; clientSecretFile: string; owner: { issuer: string; subject: string } };
  /** Capabilities a remote session holds. Explicit, no implicit `*`; autopilot.operate and usage.write are never grantable. */
  grants: string[];
  session: { absoluteTtlSeconds: number; idleTtlSeconds: number };
  limits: RemoteLimits;
}

/** The callback is fixed; the redirect URI is always `${canonicalOrigin}${REMOTE_CALLBACK_PATH}`. */
export const REMOTE_CALLBACK_PATH = "/api/auth/callback";

export const REMOTE_GRANTABLE: readonly string[] = [...OBSERVABILITY_CAPABILITIES, ...COMMAND_CAPABILITIES, ...TASK_COMMAND_CAPABILITIES];

export const DEFAULT_REMOTE_SESSION = { absoluteTtlSeconds: 43_200, idleTtlSeconds: 1_800 } as const;
export const DEFAULT_REMOTE_LIMITS: RemoteLimits = {
  loginPerMinutePerAddress: 10, loginPerMinuteInstance: 30, pendingLogins: 100,
  commandsPerMinutePerPrincipal: 30, commandsPerMinuteInstance: 60, startsPerMinute: 5,
  readsPerMinutePerSession: 120, streamOpensPerMinutePerSession: 10, activeStreamsPerSession: 3, activeStreamsInstance: 10,
};

const LOOPBACK_PEERS = new Set(["127.0.0.1", "::1"]);
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Returns the parsed block, or undefined when `api.remote` is absent. Problems are appended, never thrown. */
export function resolveRemoteAuth(raw: unknown, ctx: { localPort: number; configDir: string; workspace: string; fileWorkspace: unknown }, problems: string[]): RemoteAuthConfig | undefined {
  if (raw === undefined) return undefined;
  const p = (msg: string) => { problems.push(`api.remote${msg}`); };
  if (!isRecord(raw)) { p(" must be a mapping"); return undefined; }
  const before = problems.length;
  const keys = (v: Record<string, unknown>, at: string, known: string[]) => {
    const unknown = Object.keys(v).filter((k) => !known.includes(k));
    if (unknown.length) p(`${at} has unknown key(s): ${unknown.join(", ")}`);
  };
  keys(raw, "", ["port", "canonicalOrigin", "transport", "identity", "grants", "session", "limits"]);

  // The workspace identity a remote session is bound to is the boot-selected directory; a YAML label
  // that disagrees with it is refused rather than trusted.
  if (ctx.fileWorkspace !== undefined && ctx.fileWorkspace !== ctx.workspace) {
    p(`: workspace label ${JSON.stringify(ctx.fileWorkspace)} contradicts the selected workspace ${JSON.stringify(ctx.workspace)}`);
  }

  const port = raw.port;
  if (!Number.isInteger(port) || (port as number) < 1 || (port as number) > 65535) p(".port must be 1-65535");
  else if (port === ctx.localPort) p(".port must differ from api.port: the remote listener never shares the local one");

  let canonicalOrigin = "";
  if (typeof raw.canonicalOrigin !== "string") p(".canonicalOrigin must be an https origin");
  else {
    try {
      const u = new URL(raw.canonicalOrigin);
      if (u.protocol !== "https:") p(".canonicalOrigin must be https");
      else if (u.username || u.password || u.search || u.hash || (u.pathname !== "/" && u.pathname !== "")) p(".canonicalOrigin must be an origin with no path, query, fragment or credentials");
      else if (raw.canonicalOrigin.replace(/\/$/, "") !== u.origin) p(`.canonicalOrigin must be normalized (${u.origin})`);
      else canonicalOrigin = u.origin;
    } catch { p(".canonicalOrigin must be a URL"); }
  }

  let transport: RemoteAuthConfig["transport"] = { kind: "trusted-proxy", peers: [], tailscaleUserLogin: "" };
  if (!isRecord(raw.transport)) p(".transport must be { kind, peers, tailscaleUserLogin }");
  else {
    const t = raw.transport;
    keys(t, ".transport", ["kind", "peers", "tailscaleUserLogin"]);
    if (t.kind !== "trusted-proxy") p(`.transport.kind must be trusted-proxy (direct-tls is not implemented), got ${JSON.stringify(t.kind)}`);
    const peers = Array.isArray(t.peers) ? t.peers : [];
    if (!Array.isArray(t.peers) || peers.length === 0) p(".transport.peers must list at least one loopback address");
    for (const peer of peers) if (typeof peer !== "string" || !LOOPBACK_PEERS.has(peer)) p(`.transport.peers entry ${JSON.stringify(peer)} must be 127.0.0.1 or ::1: the remote listener binds loopback only`);
    const login = t.tailscaleUserLogin;
    if (typeof login !== "string" || !/^[\x21-\x7e]{1,256}$/.test(login)) p(".transport.tailscaleUserLogin must be the owner's Tailscale login (printable ASCII, no spaces)");
    transport = { kind: "trusted-proxy", peers: peers.filter((x): x is string => typeof x === "string"), tailscaleUserLogin: typeof login === "string" ? login : "" };
  }

  let identity: RemoteAuthConfig["identity"] = { issuer: "", clientId: "", clientSecretFile: "", owner: { issuer: "", subject: "" } };
  if (!isRecord(raw.identity)) p(".identity must be { issuer, clientId, clientSecretFile, owner }");
  else {
    const i = raw.identity;
    keys(i, ".identity", ["issuer", "clientId", "clientSecretFile", "owner"]);
    const issuer = issuerUrl(i.issuer, p);
    if (typeof i.clientId !== "string" || !i.clientId) p(".identity.clientId is required");
    let secretFile = "";
    if (typeof i.clientSecretFile !== "string" || !i.clientSecretFile) p(".identity.clientSecretFile must be a file path");
    else {
      secretFile = isAbsolute(i.clientSecretFile) ? i.clientSecretFile : resolve(ctx.configDir, i.clientSecretFile);
      try {
        const s = statSync(secretFile);
        if (!s.isFile()) p(".identity.clientSecretFile must be a regular file");
        else if ((s.mode & 0o077) !== 0) p(`.identity.clientSecretFile must not be readable by group or others; run: chmod 600 ${secretFile}`);
        else if (s.uid !== process.getuid?.()) p(".identity.clientSecretFile must be owned by the plane's user");
      } catch { p(".identity.clientSecretFile does not exist"); }
    }
    const owner = isRecord(i.owner) ? i.owner : undefined;
    if (!owner) p(".identity.owner must be { issuer, subject }");
    else {
      keys(owner, ".identity.owner", ["issuer", "subject"]);
      if (owner.issuer !== issuer) p(".identity.owner.issuer must equal identity.issuer: the pin is checked against the issuer that signed the token");
      if (typeof owner.subject !== "string" || !owner.subject) p(".identity.owner.subject is required (the exact OIDC subject, never an email)");
    }
    identity = {
      issuer, clientId: typeof i.clientId === "string" ? i.clientId : "", clientSecretFile: secretFile,
      owner: { issuer, subject: typeof owner?.subject === "string" ? owner.subject : "" },
    };
  }

  let grants: string[] = [];
  if (!Array.isArray(raw.grants) || raw.grants.length === 0) p(".grants must list at least one capability (no implicit *)");
  else {
    for (const g of raw.grants) if (typeof g !== "string" || !REMOTE_GRANTABLE.includes(g)) p(`.grants entry ${JSON.stringify(g)} is not grantable remotely (allowed: ${REMOTE_GRANTABLE.join(", ")})`);
    if (new Set(raw.grants).size !== raw.grants.length) p(".grants has duplicates");
    grants = raw.grants.filter((g): g is string => typeof g === "string");
  }

  const session: { absoluteTtlSeconds: number; idleTtlSeconds: number } = { ...DEFAULT_REMOTE_SESSION };
  if (raw.session !== undefined) {
    if (!isRecord(raw.session)) p(".session must be { absoluteTtlSeconds, idleTtlSeconds }");
    else {
      keys(raw.session, ".session", ["absoluteTtlSeconds", "idleTtlSeconds"]);
      for (const k of ["absoluteTtlSeconds", "idleTtlSeconds"] as const) {
        const v = raw.session[k];
        if (v === undefined) continue;
        if (!Number.isInteger(v) || (v as number) < 1 || (v as number) > 7 * 86_400) p(`.session.${k} must be an integer from 1 to 604800`);
        else session[k] = v as number;
      }
      if (session.idleTtlSeconds > session.absoluteTtlSeconds) p(".session.idleTtlSeconds must not exceed absoluteTtlSeconds");
    }
  }

  const limits: RemoteLimits = { ...DEFAULT_REMOTE_LIMITS };
  if (raw.limits !== undefined) {
    if (!isRecord(raw.limits)) p(".limits must be a mapping");
    else {
      keys(raw.limits, ".limits", Object.keys(DEFAULT_REMOTE_LIMITS));
      for (const k of Object.keys(DEFAULT_REMOTE_LIMITS) as (keyof RemoteLimits)[]) {
        const v = raw.limits[k];
        if (v === undefined) continue;
        if (!Number.isInteger(v) || (v as number) < 1 || (v as number) > 100_000) p(`.limits.${k} must be an integer from 1 to 100000 (zero or unbounded is refused)`);
        else limits[k] = v as number;
      }
    }
  }

  if (problems.length > before) return undefined;
  return { port: port as number, canonicalOrigin, transport, identity, grants, session, limits };
}

function issuerUrl(value: unknown, p: (m: string) => void): string {
  if (typeof value !== "string") { p(".identity.issuer must be a URL"); return ""; }
  try {
    const u = new URL(value);
    const loopback = u.hostname === "127.0.0.1" || u.hostname === "localhost" || u.hostname === "[::1]";
    // http is accepted only for a loopback test issuer (the fake OIDC issuer); a real IdP is https.
    if (u.protocol !== "https:" && !(u.protocol === "http:" && loopback)) p(".identity.issuer must be https");
    if (u.search || u.hash || u.username || u.password) p(".identity.issuer must have no query, fragment or credentials");
    return value.replace(/\/$/, "");
  } catch { p(".identity.issuer must be a URL"); return ""; }
}
