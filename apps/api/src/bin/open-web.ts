import { createServer, type Server } from "node:http";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, type ResolvedConfig } from "../config.js";
import { CredentialStore, credentialPath } from "../auth/credential-file.js";
import { mintBootstrapToken } from "../auth/bootstrap-token.js";
import { OBSERVABILITY_CAPABILITIES, COMMAND_CAPABILITIES, registerSecret, redactSecrets } from "@agent-plane/core";

export interface OpenWebOptions {
  config?: ResolvedConfig;
  apiOrigin?: string;
  readOnly?: boolean;
  openBrowser?: (origin: string) => void;
}

export interface OpenWebListener {
  origin: string;
  server: Server;
  closed: Promise<void>;
}

function openSystemBrowser(origin: string): void {
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", origin] : [origin];
  spawn(command, args, { detached: true, stdio: "ignore" }).unref();
}

export async function startOpenWeb(options: OpenWebOptions = {}): Promise<OpenWebListener> {
  const config = options.config ?? loadConfig();
  const now = new Date();
  const store = new CredentialStore(credentialPath(config.dir));
  const requested = [...OBSERVABILITY_CAPABILITIES, ...(options.readOnly ? [] : COMMAND_CAPABILITIES)];
  const secret = store.active().filter((candidate) =>
    requested.every((capability) => candidate.capabilities.includes(capability)),
  ).at(-1);
  if (!secret) throw new Error("No active credential covers the requested browser capabilities");

  const apiOrigin = options.apiOrigin ?? `http://${config.api.host}:${config.api.port}`;
  const nonce = randomBytes(16).toString("base64url");
  let served = false;
  let token = "";
  const server = createServer((req, res) => {
    if (req.method !== "GET" || req.url !== "/" || served) {
      res.writeHead(410, { "content-type": "text/plain" });
      res.end("Gone");
      return;
    }
    served = true;
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "content-security-policy": `default-src 'none'; form-action ${apiOrigin}; script-src 'nonce-${nonce}'`,
    });
    res.end(`<!doctype html><form method="POST" action="${apiOrigin}/api/auth/bootstrap"><input type="hidden" name="token" value="${token}"></form><script nonce="${nonce}">document.forms[0].submit()</script>`);
    res.once("finish", () => server.close());
  });
  const closed = new Promise<void>((done) => server.once("close", done));
  await new Promise<void>((done, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", done);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Unable to bind launcher");
  const origin = `http://127.0.0.1:${address.port}`;
  token = mintBootstrapToken(secret, {
    aud: apiOrigin,
    lo: origin,
    cap: requested,
    exp: Math.floor(now.getTime() / 1000) + config.api.auth.bootstrapTtlSeconds,
  });
  registerSecret(secret.secret);
  registerSecret(token);
  process.stdout.write(redactSecrets(`Open ${origin}\n`));
  (options.openBrowser ?? openSystemBrowser)(origin);

  const timer = setTimeout(() => server.close(), 30_000);
  timer.unref();
  server.once("close", () => clearTimeout(timer));
  process.once("SIGINT", () => server.close());
  return { origin, server, closed };
}

async function main(): Promise<void> {
  const originIndex = process.argv.indexOf("--origin");
  const listener = await startOpenWeb({
    apiOrigin: originIndex >= 0 ? process.argv[originIndex + 1] : undefined,
    readOnly: process.argv.includes("--read-only"),
  });
  await listener.closed;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) void main();
