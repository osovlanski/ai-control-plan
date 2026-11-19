/**
 * The `aos` CLI's only way to reach the plane: its HTTP routes, with the same bearer credential
 * file Cockpit reads. The CLI never opens the database, writes config or calls an adapter
 * (design §E: "Neither client reads the DB, writes config or calls an adapter").
 */
import { redactSecrets } from "@agent-plane/core";
import { readApiEndpoint } from "../../api/src/config.js";
import { credentialPath, isActive, readCredential, type CredentialSecret } from "../../api/src/auth/credential-file.js";

export type Method = "GET" | "POST";

export interface PlaneClient {
  /** One request, no body. Resolves to the parsed JSON of a 2xx answer; throws `PlaneError` otherwise. */
  request<T>(method: Method, path: string): Promise<T>;
}

export class PlaneError extends Error {
  constructor(message: string, readonly status?: number) { super(message); this.name = "PlaneError"; }
}

/** The plane refuses a non-loopback bind (remote mode is not built), so a bearer never leaves this host. */
export function assertLoopbackOrigin(origin: string): URL {
  let url: URL;
  try { url = new URL(origin); } catch { throw new PlaneError(`Not a URL: ${JSON.stringify(origin)}`); }
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (url.protocol !== "http:" || !["127.0.0.1", "::1", "localhost"].includes(host)) {
    throw new PlaneError(`Refusing ${url.origin}: aos only talks to a plane on loopback (http://127.0.0.1:<port>)`);
  }
  if (url.pathname !== "/" || url.search || url.hash || url.username || url.password) {
    throw new PlaneError(`Refusing ${JSON.stringify(origin)}: give the origin only, e.g. http://127.0.0.1:4176`);
  }
  return url;
}

/** The newest active secret that holds `capability`, as `open-web` selects one. */
export function selectSecret(secrets: readonly CredentialSecret[], capability: string, now = new Date()): CredentialSecret | undefined {
  return secrets.filter((s) => isActive(s, now) && s.capabilities.includes(capability)).at(-1);
}

export function httpClient(origin: string, secret: string, fetchImpl: typeof fetch = fetch): PlaneClient {
  const base = assertLoopbackOrigin(origin).origin;
  return {
    async request<T>(method: Method, path: string): Promise<T> {
      let res: Response;
      try {
        res = await fetchImpl(`${base}${path}`, { method, headers: { authorization: `Bearer ${secret}`, accept: "application/json" } });
      } catch (e) {
        throw new PlaneError(`${method} ${path}: no answer from ${base} (${redactSecrets(e instanceof Error ? e.message : String(e))}). Is the plane running?`);
      }
      const text = await res.text();
      let body: unknown;
      try { body = text ? JSON.parse(text) : undefined; } catch { body = undefined; }
      if (!res.ok) {
        const detail = (body as { error?: unknown } | undefined)?.error;
        throw new PlaneError(`${method} ${path}: HTTP ${res.status}${typeof detail === "string" ? `: ${redactSecrets(detail)}` : ""}`, res.status);
      }
      if (body === undefined) throw new PlaneError(`${method} ${path}: HTTP ${res.status} with a body that is not JSON`, res.status);
      return body as T;
    },
  };
}

export interface ConnectOptions { api?: string; credential?: string; env?: NodeJS.ProcessEnv; fetchImpl?: typeof fetch; now?: () => Date }

/**
 * Resolves the plane's origin and credential without writing anything: `--api` / `AOS_API_URL`,
 * else the workspace config's `api.host:port`; `--credential` / `AOS_CREDENTIAL_FILE`, else the
 * workspace's `api-credential.json`. The origin is checked for loopback before the file is read.
 */
export function connect(capability: string, options: ConnectOptions = {}): PlaneClient {
  const env = options.env ?? process.env;
  const explicit = options.api ?? env.AOS_API_URL;
  const endpoint = explicit === undefined || (options.credential ?? env.AOS_CREDENTIAL_FILE) === undefined ? readApiEndpoint(env) : undefined;
  const origin = explicit ?? `http://${endpoint!.host.includes(":") ? `[${endpoint!.host}]` : endpoint!.host}:${endpoint!.port}`;
  assertLoopbackOrigin(origin);
  const path = options.credential ?? env.AOS_CREDENTIAL_FILE ?? credentialPath(endpoint!.dir);
  let secrets: CredentialSecret[];
  try { secrets = readCredential(path).secrets; } catch (e) { throw new PlaneError(e instanceof Error ? e.message : String(e)); }
  const secret = selectSecret(secrets, capability, options.now?.());
  if (!secret) throw new PlaneError(`No active credential in ${path} holds ${capability}; run: pnpm --filter @agent-plane/api rotate`);
  return httpClient(origin, secret.secret, options.fetchImpl);
}
