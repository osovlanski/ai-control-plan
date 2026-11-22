import { readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { parse as parseYaml } from "yaml";

/**
 * MCP service configuration (docs/adr/mcp-connector.md, C2). Everything that is still an owner
 * question (the public hostname, the exposed repos, the owner's Google subject) is required
 * configuration with no default, so nothing here assumes an answer.
 */
export interface RateLimits {
  readsPerMinute: number;
  createsPerHour: number;
  startsPerHour: number;
  /** Multiplier for the per-instance limit over the per-grant one. */
  instanceFactor: number;
  oauthPerMinutePerAddress: number;
  oauthPerMinutePerInstance: number;
}

export interface McpConfig {
  listen: { host: "127.0.0.1"; port: number };
  /** Canonical public origin of this service, e.g. https://<mcp host>. The MCP resource is `${publicUrl}/mcp`. */
  publicUrl: string;
  plane: { url: string; credentialFile: string };
  /** Exposed-repo map: alias → absolute path. Each path must be exactly in the plane's repoAllowlist and the alias in its mcp.repos. */
  repos: Record<string, string>;
  /** D-A: the only identity that may authorize a client. Exact (iss, sub); email never authorizes. */
  owner: { issuer: string; subject: string };
  /** This service's own OIDC client at the owner's identity provider (separate from the Web login's). */
  oidc: { issuer: string; clientId: string; clientSecretFile: string };
  /** SQLite file for OAuth state. Never the plane database. */
  stateDb: string;
  /** Optional loopback-only listener that accepts one static bearer (tests and local dev; never on the tunnel). */
  devBearer?: { port: number; tokenEnv: string };
  /** Use Cloudflare's CF-Connecting-IP as the client address for OAuth rate limits. Off unless the tunnel is the only ingress. */
  trustCloudflareClientIp: boolean;
  rateLimits: RateLimits;
}

export const DEFAULT_RATE_LIMITS: RateLimits = {
  readsPerMinute: 60, createsPerHour: 10, startsPerHour: 10, instanceFactor: 3,
  oauthPerMinutePerAddress: 10, oauthPerMinutePerInstance: 30,
};

export const REPO_ALIAS = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const fail = (path: string, msg: string): never => { throw new Error(`${path}: ${msg}`); };

function originOf(value: unknown, field: string, path: string, allowLoopbackHttp: boolean): string {
  if (typeof value !== "string") return fail(path, `${field} must be a URL string`);
  let url: URL;
  try { url = new URL(value); } catch { return fail(path, `${field} must be a URL`); }
  const loopback = LOOPBACK_HOSTS.has(url.hostname);
  if (url.protocol !== "https:" && !(allowLoopbackHttp && url.protocol === "http:" && loopback)) {
    fail(path, `${field} must be https (http is accepted only on a loopback host)`);
  }
  if (url.username || url.password || url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) {
    fail(path, `${field} must be an origin with no path, query, fragment or credentials`);
  }
  return url.origin;
}

function port(value: unknown, field: string, path: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 65535) return fail(path, `${field} must be a port number`);
  return value;
}

export function parseConfig(raw: unknown, path = "mcp config", base = process.cwd()): McpConfig {
  if (!isRecord(raw)) return fail(path, "must be a mapping");
  const known = ["listen", "publicUrl", "plane", "repos", "owner", "oidc", "stateDb", "devBearer", "trustCloudflareClientIp", "rateLimits"];
  const unknown = Object.keys(raw).filter((k) => !known.includes(k));
  if (unknown.length) fail(path, `unknown key(s): ${unknown.join(", ")}`);

  const listen = isRecord(raw.listen) ? raw.listen : fail(path, "listen must be { host, port }");
  // The service binds loopback only, like the plane; the tunnel is the only way in (ADR D-C).
  if (listen.host !== "127.0.0.1") fail(path, "listen.host must be 127.0.0.1: the MCP service refuses any other bind");

  const plane = isRecord(raw.plane) ? raw.plane : fail(path, "plane must be { url, credentialFile }");
  const planeUrl = originOf(plane.url, "plane.url", path, true);
  if (!LOOPBACK_HOSTS.has(new URL(planeUrl).hostname)) fail(path, "plane.url must be a loopback origin");

  const file = (value: unknown, field: string) => {
    if (typeof value !== "string" || !value) return fail(path, `${field} must be a file path`);
    return isAbsolute(value) ? value : resolve(base, value);
  };

  if (!isRecord(raw.repos) || Object.keys(raw.repos).length === 0) fail(path, "repos must map at least one alias to an absolute path");
  const repos: Record<string, string> = {};
  for (const [alias, p] of Object.entries(raw.repos as Record<string, unknown>)) {
    if (!REPO_ALIAS.test(alias)) fail(path, `repos alias ${JSON.stringify(alias)} must match ${REPO_ALIAS.source}`);
    if (typeof p !== "string" || !isAbsolute(p) || resolve(p) !== p) fail(path, `repos.${alias} must be an absolute, normalized path`);
    repos[alias] = p as string;
  }
  if (new Set(Object.values(repos)).size !== Object.keys(repos).length) fail(path, "repos may not map two aliases to one path");

  const owner = isRecord(raw.owner) ? raw.owner : fail(path, "owner must be { issuer, subject }");
  const ownerIssuer = typeof owner.issuer === "string" && owner.issuer ? owner.issuer : fail(path, "owner.issuer is required");
  const subject = typeof owner.subject === "string" && owner.subject ? owner.subject : fail(path, "owner.subject is required");

  const oidc = isRecord(raw.oidc) ? raw.oidc : fail(path, "oidc must be { issuer, clientId, clientSecretFile }");
  const oidcIssuer = originOrUrl(oidc.issuer, "oidc.issuer", path);
  if (oidcIssuer !== ownerIssuer) fail(path, "oidc.issuer must equal owner.issuer: the pin is checked against the issuer that signed the token");
  const clientId = typeof oidc.clientId === "string" && oidc.clientId ? oidc.clientId : fail(path, "oidc.clientId is required");

  let devBearer: McpConfig["devBearer"];
  if (raw.devBearer !== undefined) {
    const d = isRecord(raw.devBearer) ? raw.devBearer : fail(path, "devBearer must be { port, tokenEnv }");
    const tokenEnv = typeof d.tokenEnv === "string" && /^[A-Z][A-Z0-9_]*$/.test(d.tokenEnv) ? d.tokenEnv : fail(path, "devBearer.tokenEnv must name an environment variable");
    devBearer = { port: port(d.port, "devBearer.port", path), tokenEnv };
  }

  const limits = { ...DEFAULT_RATE_LIMITS };
  if (raw.rateLimits !== undefined) {
    if (!isRecord(raw.rateLimits)) fail(path, "rateLimits must be a mapping");
    for (const [k, v] of Object.entries(raw.rateLimits as Record<string, unknown>)) {
      if (!(k in limits)) fail(path, `rateLimits.${k} is not a known limit`);
      if (typeof v !== "number" || !(v > 0)) fail(path, `rateLimits.${k} must be a positive number`);
      (limits as Record<string, number>)[k] = v as number;
    }
  }

  return {
    listen: { host: "127.0.0.1", port: port(listen.port, "listen.port", path) },
    publicUrl: originOf(raw.publicUrl, "publicUrl", path, true),
    plane: { url: planeUrl, credentialFile: file(plane.credentialFile, "plane.credentialFile") },
    repos,
    owner: { issuer: ownerIssuer, subject },
    oidc: { issuer: oidcIssuer, clientId, clientSecretFile: file(oidc.clientSecretFile, "oidc.clientSecretFile") },
    stateDb: file(raw.stateDb, "stateDb"),
    ...(devBearer ? { devBearer } : {}),
    trustCloudflareClientIp: raw.trustCloudflareClientIp === true,
    rateLimits: limits,
  };
}

/** An OIDC issuer identifier is an https URL (Google: https://accounts.google.com); loopback http is for the fake test issuer. */
function originOrUrl(value: unknown, field: string, path: string): string {
  if (typeof value !== "string") return fail(path, `${field} must be a URL string`);
  let url: URL;
  try { url = new URL(value); } catch { return fail(path, `${field} must be a URL`); }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname))) fail(path, `${field} must be https`);
  if (url.search || url.hash || url.username || url.password) fail(path, `${field} must have no query, fragment or credentials`);
  return value.replace(/\/$/, "");
}

export function loadConfig(path: string): McpConfig {
  const text = readFileSync(path, "utf8");
  const raw = path.endsWith(".json") ? JSON.parse(text) as unknown : parseYaml(text) as unknown;
  return parseConfig(raw, path, resolve(path, ".."));
}

export const resourceUrl = (config: Pick<McpConfig, "publicUrl">) => `${config.publicUrl}/mcp`;
