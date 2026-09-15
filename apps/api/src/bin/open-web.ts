import { createServer, type Server } from "node:http";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { loadConfig, type ResolvedConfig } from "../config.js";
import { CredentialStore, credentialPath } from "../auth/credential-file.js";
import { mintBootstrapToken } from "../auth/bootstrap-token.js";
import { OBSERVABILITY_CAPABILITIES, COMMAND_CAPABILITIES, registerSecret, redactSecrets } from "@agent-plane/core";

export interface OpenWebOptions {
  config?: ResolvedConfig;
  apiOrigin?: string;
  readOnly?: boolean;
  headless?: boolean;
  port?: number;
  waitSeconds?: number;
  openBrowser?: (origin: string) => void | Promise<void>;
}

export interface OpenWebListener {
  origin: string;
  server: Server;
  closed: Promise<void>;
}

function openSystemBrowser(origin: string): Promise<void> {
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", origin] : [origin];
  return new Promise((done, reject) => {
    const child = spawn(command, args, { detached: true, stdio: "ignore" });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) done();
      else reject(new Error(`${command} ${signal ? `received ${signal}` : `exited with status ${code}`}`));
    });
    child.unref();
  });
}

function integerOption(name: string, value: number, min: number, max: number): number {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer from ${min} to ${max}`);
  }
  return value;
}

export async function startOpenWeb(options: OpenWebOptions = {}): Promise<OpenWebListener> {
  const port = integerOption("--port", options.port ?? 0, 0, 65535);
  const waitSeconds = integerOption("--wait-seconds", options.waitSeconds ?? 300, 1, 900);
  const config = options.config ?? loadConfig();
  const requested = [...OBSERVABILITY_CAPABILITIES, ...(options.readOnly ? [] : COMMAND_CAPABILITIES)];
  const selectCredential = () => {
    const store = new CredentialStore(credentialPath(config.dir));
    const secret = store.active().filter((candidate) =>
      requested.every((capability) => candidate.capabilities.includes(capability)),
    ).at(-1);
    if (!secret) throw new Error("No active credential covers the requested browser capabilities");
    return secret;
  };
  selectCredential(); // Fail closed before binding; recheck after the operator's wait.

  const apiOrigin = options.apiOrigin ?? `http://${config.api.host}:${config.api.port}`;
  const apiUrl = new URL(apiOrigin);
  if (apiUrl.origin !== apiOrigin || !["http:", "https:"].includes(apiUrl.protocol)) {
    throw new Error("--origin must be an HTTP(S) origin without a path, credentials, query or fragment");
  }
  const nonce = randomBytes(16).toString("base64url");
  let served = false;
  let origin = "";
  let deadline = 0;
  const server = createServer((req, res) => {
    if (req.method !== "GET" || req.url !== "/" || served || Date.now() >= deadline) {
      res.writeHead(410, { "content-type": "text/plain", "cache-control": "no-store" });
      res.end("Gone");
      return;
    }
    // A fixed port must not make foreign-site navigation / DNS rebinding a launcher.
    if (req.headers.host !== new URL(origin).host || req.headers["sec-fetch-site"] === "cross-site") {
      res.writeHead(403, { "content-type": "text/plain", "cache-control": "no-store" });
      res.end("Forbidden");
      return;
    }
    served = true;
    res.once("finish", () => server.close());
    let token: string;
    try {
      const secret = selectCredential();
      // The wait budget is for arranging SSH. The signed token still lives only
      // for the existing (default 10-second) exchange window, starting at GET.
      token = mintBootstrapToken(secret, {
        aud: apiOrigin,
        lo: origin,
        cap: requested,
        exp: Math.floor(Date.now() / 1000) + config.api.auth.bootstrapTtlSeconds,
      });
      registerSecret(secret.secret);
      registerSecret(token);
    } catch {
      res.writeHead(403, { "content-type": "text/plain", "cache-control": "no-store" });
      res.end("Browser credential unavailable. Check browser capabilities and run open again.");
      return;
    }
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "connection": "close",
      "content-security-policy": `default-src 'none'; form-action ${apiOrigin}; script-src 'nonce-${nonce}'`,
    });
    res.end(`<!doctype html><form method="POST" action="${apiOrigin}/api/auth/bootstrap"><input type="hidden" name="token" value="${token}"></form><script nonce="${nonce}">document.forms[0].submit()</script>`);
  });
  const closed = new Promise<void>((done) => server.once("close", done));
  await new Promise<void>((done, reject) => {
    const onError = (error: NodeJS.ErrnoException) => reject(error.code === "EADDRINUSE"
      ? new Error(`Bootstrap port ${port} is already in use on 127.0.0.1; choose another --port or omit --port.`, { cause: error })
      : error);
    server.once("error", onError);
    server.listen(port, "127.0.0.1", () => { server.removeListener("error", onError); done(); });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Unable to bind launcher");
  origin = `http://127.0.0.1:${address.port}`;
  deadline = Date.now() + waitSeconds * 1000;
  const stop = () => { server.close(); server.closeAllConnections(); };
  const timer = setTimeout(() => {
    if (!served) process.stdout.write("Browser bootstrap expired; run open again.\n");
    stop();
  }, waitSeconds * 1000);
  timer.unref();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  server.once("close", () => {
    clearTimeout(timer);
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  });

  process.stdout.write(redactSecrets(`Browser bootstrap ready.\nOpen ${origin}\n\nFrom your local machine (replace <ssh-host> with your SSH host):\n  ssh -N -o ExitOnForwardFailure=yes -L 127.0.0.1:${address.port}:127.0.0.1:${address.port} <ssh-host>\n\nKeep the same local bootstrap port and use 127.0.0.1 in the browser.\nAlso forward the API (${apiUrl.port || (apiUrl.protocol === "https:" ? "443" : "80")}); development web uses 5176.\nExpires after ${waitSeconds} seconds or the first bootstrap page request.\nKeep this command running. The URL contains no token; the page issues a single-use token valid for ${config.api.auth.bootstrapTtlSeconds} seconds.\n`));
  const headless = options.headless || (!options.openBrowser && process.platform === "linux" && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY);
  if (!headless) {
    // Launcher failures must not tear down a valid listener. Never print a
    // child-process error message: injected launchers could include secrets.
    void Promise.resolve().then(() => (options.openBrowser ?? openSystemBrowser)(origin)).catch((error: unknown) => {
      if (!server.listening) return;
      const code = (error as NodeJS.ErrnoException | null)?.code;
      const reason = typeof code === "string" && /^[A-Z0-9_]+$/.test(code) ? ` (${code})` : "";
      process.stderr.write(`Browser launch unavailable${reason}; continuing in headless mode. Use the URL and SSH instructions above.\n`);
    });
  }
  return { origin, server, closed };
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: {
    headless: { type: "boolean" },
    "read-only": { type: "boolean" },
    origin: { type: "string" },
    port: { type: "string" },
    "wait-seconds": { type: "string" },
    help: { type: "boolean" },
  } });
  if (values.help) {
    process.stdout.write("Usage: pnpm --filter @agent-plane/api open [--headless] [--port 0..65535] [--wait-seconds 1..900] [--read-only] [--origin <api-origin>]\nDefault: random loopback port; 300-second wait; mint the short-lived token on first GET.\n");
    return;
  }
  const listener = await startOpenWeb({
    apiOrigin: values.origin,
    readOnly: values["read-only"],
    headless: values.headless,
    port: values.port === undefined ? undefined : Number(values.port),
    waitSeconds: values["wait-seconds"] === undefined ? undefined : Number(values["wait-seconds"]),
  });
  await listener.closed;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main().catch((error: unknown) => {
    process.stderr.write(redactSecrets(`${error instanceof Error ? error.message : "Unable to open browser bootstrap"}\n`));
    process.exitCode = 1;
  });
}
